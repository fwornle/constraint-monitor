#!/usr/bin/env node

/**
 * Constraint Monitor Dashboard Server
 * HTTP server for serving the dashboard and providing API endpoints
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import cors from 'cors';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { ConfigManager } from './utils/config-manager.js';
import { StatusGenerator } from './status/status-generator.js';
import { ConstraintEngine } from './engines/constraint-engine.js';
import { logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load port configuration from centralized .env.ports file
 */
function loadPortConfiguration() {
    const portsFilePath = join(__dirname, '../../../.env.ports');
    const config = {
        dashboardPort: 3030,
        apiPort: 3031
    };

    try {
        const portsFileContent = readFileSync(portsFilePath, 'utf8');
        const lines = portsFileContent.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('CONSTRAINT_DASHBOARD_PORT=')) {
                config.dashboardPort = parseInt(trimmed.split('=')[1]) || 3030;
            } else if (trimmed.startsWith('CONSTRAINT_API_PORT=')) {
                config.apiPort = parseInt(trimmed.split('=')[1]) || 3031;
            }
        }

        logger.info('Loaded port configuration from .env.ports', config);
        return config;
    } catch (error) {
        logger.warn('Could not load centralized port configuration, using defaults', {
            error: error.message,
            portsFile: portsFilePath,
            defaultConfig: config
        });
        return config;
    }
}

class DashboardServer {
    constructor(port = 3031, dashboardPort = 3030) {
        this.port = port;
        this.dashboardPort = dashboardPort;
        this.app = express();
        this.server = null;

        // Initialize configuration management
        this.config = new ConfigManager();

        // Initialize status generator
        this.statusGenerator = new StatusGenerator(this.config);

        // Initialize constraint engine with the same ConfigManager
        this.constraintEngine = new ConstraintEngine(this.config);

        // Single canonical violations store: the bind-mounted .mcp-sync file
        // that host hooks also write to. Previously this server merged from
        // 6 different paths (most container-local), so the dashboard showed
        // stale entries that no longer reflected the host config.
        const codingRoot = process.env.CODING_REPO || join(__dirname, '../../../..');
        this.violationsFile = join(codingRoot, '.mcp-sync', 'violation-history.json');
        this.violations = [];

        // Initialize constraint engine
        this.constraintEngine.initialize().catch(error => {
            logger.error('Failed to initialize constraint engine:', error);
        });

        // Load existing violations on startup
        this.loadViolations().catch(error => {
            logger.warn('Could not load existing violations:', error.message);
        });

        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        // Enable CORS for all origins
        this.app.use(cors());

        // Parse JSON bodies
        this.app.use(express.json());

        // Redirect to professional dashboard running on Next.js
        this.app.get('/', (req, res) => {
            res.redirect(`http://localhost:${this.dashboardPort}`);
        });

        this.app.get('/dashboard', (req, res) => {
            res.redirect(`http://localhost:${this.dashboardPort}`);
        });

        // Logging middleware
        this.app.use((req, res, next) => {
            logger.info(`${req.method} ${req.path}`, {
                ip: req.ip,
                userAgent: req.get('User-Agent')
            });
            next();
        });
    }

    setupRoutes() {
        // API Routes
        this.app.get('/api/status', this.handleGetStatus.bind(this));
        this.app.get('/api/constraints', this.handleGetConstraints.bind(this));
        this.app.get('/api/violations', this.handleGetViolations.bind(this));
        this.app.post('/api/violations', this.handlePostViolations.bind(this));
        this.app.get('/api/activity', this.handleGetActivity.bind(this));
        this.app.get('/api/health', this.handleHealthCheck.bind(this));
        this.app.get('/api/system-health', this.handleSystemHealth.bind(this));
        this.app.get('/api/projects', this.handleGetProjects.bind(this));

        // Project selection endpoint
        this.app.post('/api/projects/select', this.handleSelectProject.bind(this));

        // Constraint management
        this.app.post('/api/constraints/:id/toggle', this.handleToggleConstraint.bind(this));
        this.app.post('/api/violations/:id/resolve', this.handleResolveViolation.bind(this));
        this.app.post('/api/constraints/check', this.handleConstraintCheck.bind(this));

        // Health Verifier routes
        this.app.get('/api/health-verifier/status', this.handleGetHealthStatus.bind(this));
        this.app.get('/api/health-verifier/report', this.handleGetHealthReport.bind(this));
        this.app.post('/api/health-verifier/verify', this.handleTriggerVerification.bind(this));

        // Error handling
        this.app.use(this.handleError.bind(this));
    }

    /**
     * Fetch the canonical health-coordinator's /health/state. Single source
     * of truth for project + session status across the dashboard. Returns
     * null on probe failure — callers fall back to process.cwd().
     */
    async _fetchCoordinatorState() {
        const coordinatorUrl = process.env.HEALTH_COORDINATOR_URL || 'http://host.docker.internal:3034';
        try {
            const upstream = await fetch(`${coordinatorUrl}/health/state`, {
                signal: AbortSignal.timeout(2000)
            });
            if (!upstream.ok) return null;
            return await upstream.json();
        } catch {
            return null;
        }
    }

    /**
     * Build the (projectName → {path, freshestBeat, sessions}) map from
     * the coordinator's state.lsl entries. Used by both
     * getCurrentProjectPath and handleGetProjects so the project shape is
     * consistent everywhere.
     */
    _projectsFromState(state) {
        const byProject = new Map();
        const lslEntries = (state && state.lsl && typeof state.lsl === 'object') ? state.lsl : {};
        for (const entry of Object.values(lslEntries)) {
            const name = entry && entry.projectName;
            if (!name) continue;
            const existing = byProject.get(name) || { path: entry.projectPath, freshestBeat: 0, sessions: 0 };
            existing.freshestBeat = Math.max(existing.freshestBeat, entry.lastBeat || 0);
            existing.sessions += 1;
            if (!existing.path && entry.projectPath) existing.path = entry.projectPath;
            byProject.set(name, existing);
        }
        return byProject;
    }

    async getCurrentProjectPath(req) {
        try {
            // First try to get project from query parameter or request header
            const requestedProject = req.query.project || req.headers['x-project-name'];

            const state = await this._fetchCoordinatorState();
            if (!state) {
                logger.warn('Could not reach health-coordinator, using current working directory');
                return process.cwd();
            }

            const projects = this._projectsFromState(state);

            // If specific project requested, use that
            if (requestedProject && projects.has(requestedProject)) {
                const projectPath = projects.get(requestedProject).path;
                logger.info(`Using requested project: ${requestedProject}`, { path: projectPath });
                return projectPath;
            }

            // Fallback: find project with most recent session activity
            const ranked = [...projects.entries()]
                .filter(([, info]) => info.freshestBeat > 0)
                .sort(([, a], [, b]) => b.freshestBeat - a.freshestBeat);

            if (ranked.length > 0) {
                const [projectName, projectInfo] = ranked[0];
                logger.info(`Using most recently active project: ${projectName}`, { path: projectInfo.path });
                return projectInfo.path;
            }

            logger.warn('No active projects found in coordinator state, using current working directory');
            return process.cwd();

        } catch (error) {
            logger.error('Failed to determine current project path', { error: error.message });
            return process.cwd();
        }
    }

    async handleGetStatus(req, res) {
        try {
            const status = await this.statusGenerator.generateStatus();

            res.json({
                status: 'success',
                data: {
                    compliance_score: status.compliance || 8.5,
                    active_violations: status.violations || 0,
                    risk_level: status.risk || 'low',
                    interventions: status.interventions || 0,
                    healthy: status.healthy !== false,
                    last_updated: new Date().toISOString()
                }
            });
        } catch (error) {
            logger.error('Failed to get status', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve status',
                error: error.message
            });
        }
    }

    async handleGetConstraints(req, res) {
        try {
            // Get current project path for per-project constraints
            const projectPath = await this.getCurrentProjectPath(req);

            // Check if grouped data is requested
            const includeGroups = req.query.grouped === 'true';

            if (includeGroups) {
                // Return grouped constraints with metadata (project-specific)
                const groupedData = this.config.getProjectConstraintsWithGroups(projectPath);
                const settings = this.config.getConstraintSettings();

                res.json({
                    status: 'success',
                    data: {
                        constraints: groupedData.groups.map(groupData => ({
                            group: groupData.group,
                            constraints: groupData.constraints.map(constraint => ({
                                id: constraint.id,
                                groupId: constraint.group,
                                pattern: constraint.pattern,
                                message: constraint.message,
                                severity: constraint.severity,
                                enabled: constraint.enabled !== false,
                                suggestion: constraint.suggestion || null
                            }))
                        })),
                        metadata: {
                            total_constraints: groupedData.total_constraints,
                            total_groups: groupedData.total_groups,
                            enabled_constraints: groupedData.enabled_constraints,
                            settings: settings,
                            project_path: projectPath
                        }
                    }
                });
            } else {
                // Return flat constraints list (legacy format, project-specific)
                const constraints = this.config.getProjectConstraints(projectPath);

                res.json({
                    status: 'success',
                    data: constraints.map(constraint => ({
                        id: constraint.id,
                        groupId: constraint.group,
                        pattern: constraint.pattern,
                        message: constraint.message,
                        severity: constraint.severity,
                        enabled: constraint.enabled !== false,
                        suggestion: constraint.suggestion || null
                    })),
                    meta: {
                        project_path: projectPath
                    }
                });
            }
        } catch (error) {
            logger.error('Failed to get constraints', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve constraints',
                error: error.message
            });
        }
    }

    async handleGetViolations(req, res) {
        try {
            const requestedProject = req.query.project || req.headers['x-project-name'];
            const limit = parseInt(req.query.limit) || 0; // Changed from 50 to 0 (no default limit)

            // Read violations from SELF-CONTAINED storage (ELIMINATING parallel version)
            await this.loadViolations();
            let violations = [...this.violations];

            // Filter violations by project if requested
            if (requestedProject) {
                logger.info(`Filtering violations for project: ${requestedProject}`, {
                    totalViolations: violations.length,
                    project: requestedProject,
                    requestedLimit: limit
                });

                violations = violations.filter(v =>
                    v.context === requestedProject ||
                    v.repository === requestedProject
                );

                logger.info(`Filtered violations result`, {
                    remainingViolations: violations.length,
                    project: requestedProject
                });
            }

            // Apply limit
            if (limit > 0) {
                violations = violations.slice(-limit);
            }

            // Calculate statistics
            const severityBreakdown = violations.reduce((acc, v) => {
                acc[v.severity] = (acc[v.severity] || 0) + 1;
                return acc;
            }, {});

            const responseData = {
                violations: violations,
                live_session: {
                    active_count: violations.filter(v => {
                        const hourAgo = Date.now() - (60 * 60 * 1000);
                        return new Date(v.timestamp).getTime() > hourAgo;
                    }).length,
                    compliance_score: this.calculateComplianceScore(violations),
                    trends: violations.length > 0 ? 'violations_detected' : 'stable',
                    most_recent: violations[violations.length - 1] || null
                },
                statistics: {
                    total_count: violations.length,
                    severity_breakdown: severityBreakdown,
                    project_filter: requestedProject || 'all',
                    requested_limit: limit
                }
            };

            res.json({
                status: 'success',
                data: responseData.violations,
                meta: {
                    total: responseData.statistics.total_count,
                    live_session: responseData.live_session,
                    statistics: responseData.statistics,
                    source: 'self_contained_storage',
                    filtered_by: requestedProject || 'none',
                    limit_applied: limit
                }
            });

        } catch (error) {
            logger.error('Failed to get violations', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve violations',
                error: error.message
            });
        }
    }

    async handlePostViolations(req, res) {
        try {
            const { violations } = req.body;

            if (!violations || !Array.isArray(violations)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'violations array is required'
                });
            }

            if (violations.length === 0) {
                return res.json({
                    status: 'success',
                    message: 'No violations to store',
                    data: { stored: 0 }
                });
            }

            // Get project path from request or detect current project
            const projectPath = await this.getCurrentProjectPath(req);
            
            // Use project/context from request body or first violation, fallback to 'file-watcher'
            const project = req.body.project || violations[0]?.context || 'file-watcher';
            const tool = req.body.tool || violations[0]?.source || 'api';

            logger.info(`Storing ${violations.length} violations`, {
                project,
                projectPath,
                tool,
                violations: violations.map(v => ({
                    id: v.constraint_id,
                    severity: v.severity,
                    context: v.context,
                    filePath: v.file_path
                }))
            });

            // Use the existing persistViolations method
            await this.persistViolations(violations, {
                project,
                projectPath,
                tool,
                filePath: violations[0]?.file_path || 'unknown'
            });

            res.json({
                status: 'success',
                message: `Successfully stored ${violations.length} violations`,
                data: {
                    stored: violations.length,
                    project,
                    projectPath
                }
            });

        } catch (error) {
            logger.error('Failed to store violations', {
                error: error.message,
                stack: error.stack
            });

            res.status(500).json({
                status: 'error',
                message: 'Failed to store violations',
                error: error.message
            });
        }
    }

    calculateComplianceScore(violations) {
        if (!violations || violations.length === 0) {
            return 10.0;
        }

        // Simple compliance calculation based on violation count and severity
        const criticalCount = violations.filter(v => v.severity === 'critical').length;
        const errorCount = violations.filter(v => v.severity === 'error').length;
        const warningCount = violations.filter(v => v.severity === 'warning').length;

        // Calculate score reduction based on severity weights
        const scoreReduction = (criticalCount * 3) + (errorCount * 2) + (warningCount * 1);
        const maxReduction = Math.min(scoreReduction * 0.5, 9.0); // Cap at 90% reduction

        return Math.max(1.0, 10.0 - maxReduction);
    }

    async persistViolations(violations, metadata = {}) {
        try {
            // Store violations to SELF-CONTAINED storage (ELIMINATING parallel version dependency)
            const violationsWithMetadata = violations.map(violation => ({
                ...violation,
                id: violation.id || `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                timestamp: violation.timestamp || new Date().toISOString(),
                project: metadata.project || 'unknown',
                tool: metadata.tool || 'api',
                session_id: metadata.sessionId || 'api-store',
                context: violation.context || metadata.project || 'unknown',
                repository: violation.repository || metadata.project || 'unknown',
                status: 'active',
                source: metadata.source || 'api'
            }));

            // Add violations to in-memory storage
            this.violations.push(...violationsWithMetadata);

            // Write to self-contained file storage
            await this.saveViolations();

            logger.info(`Persisted ${violations.length} violations to self-contained storage`, {
                project: metadata.project,
                tool: metadata.tool,
                violationIds: violations.map(v => v.constraint_id),
                totalViolations: this.violations.length
            });

        } catch (error) {
            logger.error('Failed to persist violations:', error);
        }
    }

    async loadViolations() {
        try {
            // CONSOLIDATED VIOLATION LOADING - collecting all historical violations
            // Single source of truth: the bind-mounted .mcp-sync file that
            // host hooks write to. No multi-source merging — that masked stale
            // data from container-local copies that diverged from the host.
            if (!existsSync(this.violationsFile)) {
                logger.warn(`Violations file ${this.violationsFile} does not exist yet`);
                this.violations = [];
                return;
            }

            const data = readFileSync(this.violationsFile, 'utf8');
            const parsed = JSON.parse(data);
            const arr = Array.isArray(parsed) ? parsed : (parsed.violations || []);
            this.violations = arr.sort((a, b) => {
                const timeA = new Date(a.timestamp || 0).getTime();
                const timeB = new Date(b.timestamp || 0).getTime();
                return timeA - timeB;
            });

            logger.info(`Loaded ${this.violations.length} violations from ${this.violationsFile}`);
        } catch (error) {
            logger.error('Failed to load violations:', error);
            this.violations = [];
        }
    }

    async saveViolations() {
        try {
            // Persist as { violations: [...] } to match the format the host hook
            // writes — keeps the file round-tripable.
            writeFileSync(this.violationsFile, JSON.stringify({ violations: this.violations }, null, 2));
            logger.debug(`Saved ${this.violations.length} violations to ${this.violationsFile}`);
        } catch (error) {
            logger.error('Failed to save violations:', error);
        }
    }

    async handleGetActivity(req, res) {
        try {
            // Return basic activity data for now
            res.json({
                status: 'success',
                data: {
                    recent_activity: [],
                    statistics: {
                        total_checks: 0,
                        violations_found: 0,
                        last_check: new Date().toISOString()
                    }
                }
            });
        } catch (error) {
            logger.error('Failed to get activity', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve activity',
                error: error.message
            });
        }
    }

    async handleHealthCheck(req, res) {
        try {
            // FUNCTIONAL ENFORCEMENT CHECK: Actually test the constraint system works
            const enforcementStatus = await this.testEnforcementHealth();

            const status = {
                status: enforcementStatus.healthy ? 'healthy' : 'unhealthy',
                timestamp: new Date().toISOString(),
                services: {
                    api: 'operational',
                    constraint_engine: this.constraintEngine ? 'operational' : 'degraded',
                    file_watcher: this.constraintEngine?.getFileWatcherStatus().isRunning ? 'operational' : 'stopped'
                },
                enforcement: enforcementStatus,
                version: '1.0.0'
            };

            // Return 503 if enforcement is broken (so health checks catch it)
            if (!enforcementStatus.healthy) {
                return res.status(503).json(status);
            }

            res.json(status);
        } catch (error) {
            logger.error('Health check failed', { error: error.message });
            res.status(500).json({
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * FUNCTIONAL TEST: Actually verify constraint enforcement is working
     * This catches bugs like stdout/stderr issues that break config loading
     */
    async testEnforcementHealth() {
        try {
            const { execSync } = await import('child_process');
            const testScript = join(__dirname, 'config/load-constraints.js');
            const configPath = process.env.CONSTRAINT_CONFIG_PATH ||
                               join(__dirname, '../../../config/constraints/constraint-monitor.yaml');

            // Test 1: Config loads successfully (catches stdout/stderr bugs)
            let configLoaded = false;
            let configError = null;
            let constraintCount = 0;
            let enabledCount = 0;

            try {
                const result = execSync(`node "${testScript}" "${configPath}"`, {
                    encoding: 'utf8',
                    timeout: 3000
                });
                const config = JSON.parse(result);
                configLoaded = true;
                constraintCount = config.constraints?.length || 0;
                enabledCount = config.constraints?.filter(c => c.enabled).length || 0;
            } catch (err) {
                configError = err.message;
            }

            // Test 2: Enforcement is enabled in config
            const enforcementEnabled = this.config?.getEnforcementSettings()?.enabled ?? false;

            // Test 3: At least one constraint is enabled
            const hasEnabledConstraints = enabledCount > 0;

            // Overall health
            const healthy = configLoaded && enforcementEnabled && hasEnabledConstraints;

            return {
                healthy,
                checks: {
                    config_loads: { passed: configLoaded, error: configError },
                    enforcement_enabled: { passed: enforcementEnabled },
                    has_constraints: { passed: hasEnabledConstraints, count: constraintCount, enabled: enabledCount }
                },
                message: healthy
                    ? `Enforcement active with ${enabledCount}/${constraintCount} constraints enabled`
                    : configError || 'Enforcement disabled or no constraints loaded'
            };
        } catch (error) {
            return {
                healthy: false,
                checks: {},
                message: `Enforcement test failed: ${error.message}`
            };
        }
    }

    async handleSystemHealth(req, res) {
        try {
            const health = await this.gatherSystemStatus();
            res.json({
                status: 'success',
                data: health,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('Failed to get system health', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve system health',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    async handleGetProjects(req, res) {
        try {
            // Get projects from the canonical health-coordinator's
            // /health/state. lsl_by_project gives the per-project rollup;
            // lsl entries give the path + freshest session beat.
            let projects = [];
            const state = await this._fetchCoordinatorState();
            if (state && typeof state.lsl_by_project === 'object') {
                const byProject = this._projectsFromState(state);
                projects = Object.entries(state.lsl_by_project).map(([name, rollup]) => {
                    const info = byProject.get(name) || { path: null, freshestBeat: 0 };
                    return {
                        name,
                        path: info.path,
                        status: rollup === 'healthy' ? 'active' : 'degraded',
                        lastActivity: info.freshestBeat || null,
                    };
                });
            }

            // Add current project as fallback
            if (projects.length === 0) {
                projects.push({
                    name: 'current',
                    path: process.cwd(),
                    status: 'active',
                    lastActivity: Date.now()
                });
            }

            res.json({
                status: 'success',
                data: projects
            });
        } catch (error) {
            logger.error('Failed to get projects', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve projects',
                error: error.message
            });
        }
    }

    async handleSelectProject(req, res) {
        try {
            const { projectName } = req.body;

            if (!projectName) {
                return res.status(400).json({
                    status: 'error',
                    message: 'projectName is required'
                });
            }

            logger.info(`Project selection requested: ${projectName}`);

            res.json({
                status: 'success',
                message: `Project ${projectName} selected`,
                data: { selectedProject: projectName }
            });
        } catch (error) {
            logger.error('Failed to select project', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to select project',
                error: error.message
            });
        }
    }

    async handleToggleConstraint(req, res) {
        try {
            const { id } = req.params;
            const { enabled } = req.body;

            // Get the project path (from query param or active project)
            const projectPath = await this.getCurrentProjectPath(req);

            logger.info(`Toggle constraint ${id} to ${enabled ? 'enabled' : 'disabled'} for project ${projectPath}`);

            // Actually update the YAML file
            const success = this.config.updateProjectConstraint(projectPath, id, enabled);

            if (!success) {
                return res.status(500).json({
                    status: 'error',
                    message: `Failed to update constraint ${id} in configuration file`,
                    error: 'Configuration update failed'
                });
            }

            res.json({
                status: 'success',
                message: `Constraint ${id} ${enabled ? 'enabled' : 'disabled'}`,
                data: { constraintId: id, enabled, projectPath }
            });
        } catch (error) {
            logger.error('Failed to toggle constraint', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to toggle constraint',
                error: error.message
            });
        }
    }

    async handleResolveViolation(req, res) {
        try {
            const { id } = req.params;

            logger.info(`Resolving violation ${id}`);

            res.json({
                status: 'success',
                message: `Violation ${id} resolved`,
                data: { violationId: id, resolved: true }
            });
        } catch (error) {
            logger.error('Failed to resolve violation', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to resolve violation',
                error: error.message
            });
        }
    }

    async handleConstraintCheck(req, res) {
        try {
            const { content, filePath, type = 'code' } = req.body;

            if (!content) {
                return res.status(400).json({
                    status: 'error',
                    message: 'content is required'
                });
            }

            const result = await this.constraintEngine.checkConstraints({
                content,
                type,
                filePath: filePath || 'manual-check'
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (error) {
            logger.error('Failed to check constraints', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to check constraints',
                error: error.message
            });
        }
    }

    async gatherSystemStatus() {
        const health = {
            overall_status: 'healthy',
            coordinator: { status: 'unknown', pid: null, uptime: null },
            watchdog: { status: 'unknown', last_check: null },
            projects: [],
            services: {
                dashboard: { status: 'operational', port: this.dashboardPort },
                api: { status: 'operational', port: this.port }
            }
        };

        // Single source of truth: the canonical health-coordinator's
        // /health/state HTTP endpoint. We derive BOTH coordinator liveness
        // and the per-project transcript-monitor status from one response.
        //
        // host.docker.internal:3034 is injected by docker-compose so this
        // works from inside the container.
        //
        // The legacy .global-lsl-registry.json reader is gone — it was
        // fossilized after Phase 33-14 retired global-service-coordinator.
        const coordinatorUrl = process.env.HEALTH_COORDINATOR_URL || 'http://host.docker.internal:3034';
        let state = null;
        try {
            const probeStart = Date.now();
            const upstream = await fetch(`${coordinatorUrl}/health/state`, {
                signal: AbortSignal.timeout(2000)
            });
            if (upstream.ok) {
                state = await upstream.json();
                const generatedAt = state.generated_at ? Date.parse(state.generated_at) : 0;
                const beatAge = generatedAt > 0 ? Date.now() - generatedAt : null;
                // /health/state is regenerated every 5s tick on the host; 30s
                // window catches a ~6-tick gap before flagging degraded.
                const heartbeatFresh = beatAge !== null && beatAge < 30000;
                health.coordinator = {
                    status: heartbeatFresh ? 'operational' : (beatAge !== null ? 'degraded' : 'unknown'),
                    uptime: state.coordinator_uptime_s,
                    generated_at: state.generated_at,
                    heartbeatAgeSeconds: beatAge !== null ? Math.floor(beatAge / 1000) : null,
                    livenessSignal: heartbeatFresh ? 'http_endpoint' : 'none',
                    probeLatencyMs: Date.now() - probeStart,
                };
            } else {
                health.coordinator = {
                    status: 'degraded',
                    upstream: `HTTP ${upstream.status}`,
                    livenessSignal: 'none',
                };
            }
        } catch (err) {
            health.coordinator = {
                status: 'unknown',
                error: err && err.message,
                livenessSignal: 'none',
            };
        }

        // Projects list — derive from state.lsl_by_project (the per-project
        // rollup) enriched with lastBeat freshness from state.lsl entries
        // (Record<sid:project, entry>; one entry per active session).
        //
        // A project is `active` when its rollup says 'healthy' AND at least
        // one session entry has beaten within the last 60s.
        if (state && typeof state.lsl_by_project === 'object') {
            const lslEntries = (state.lsl && typeof state.lsl === 'object') ? state.lsl : {};
            // Group entries by trailing :<projectName> in their sid:project key.
            const entriesByProject = new Map();
            for (const [sidProject, entry] of Object.entries(lslEntries)) {
                const projectName = entry && entry.projectName;
                if (!projectName) continue;
                if (!entriesByProject.has(projectName)) entriesByProject.set(projectName, []);
                entriesByProject.get(projectName).push({ sidProject, ...entry });
            }
            health.projects = Object.entries(state.lsl_by_project).map(([name, rollup]) => {
                const entries = entriesByProject.get(name) || [];
                const freshestBeat = entries.reduce((max, e) => Math.max(max, e.lastBeat || 0), 0);
                const beatAge = freshestBeat > 0 ? Date.now() - freshestBeat : null;
                const heartbeatFresh = beatAge !== null && beatAge < 60_000;
                const rollupHealthy = rollup === 'healthy';
                return {
                    name,
                    status: rollupHealthy && heartbeatFresh ? 'active' : 'degraded',
                    rollup,
                    sessions: entries.length,
                    freshestBeat: freshestBeat || null,
                    beatAgeSeconds: beatAge !== null ? Math.floor(beatAge / 1000) : null,
                    livenessSignal: heartbeatFresh ? 'heartbeat' : 'none',
                };
            });
        }

        const hasUnhealthyCoordinator = health.coordinator.status !== 'operational';
        const hasUnhealthyProjects = health.projects.some(p => p.status !== 'active');

        if (hasUnhealthyCoordinator) {
            health.overall_status = 'critical';
        } else if (hasUnhealthyProjects) {
            health.overall_status = 'degraded';
        } else {
            health.overall_status = 'healthy';
        }

        logger.debug('System health status calculated', {
            overall: health.overall_status,
            coordinatorStatus: health.coordinator.status,
            coordinatorSignal: health.coordinator.livenessSignal,
            projectCount: health.projects.length,
            hasUnhealthyCoordinator,
            hasUnhealthyProjects
        });

        try {

            const watchdogLogPath = join(__dirname, '../../../.logs/system-watchdog.log');
            if (existsSync(watchdogLogPath)) {
                const stats = statSync(watchdogLogPath);
                health.watchdog = {
                    status: 'operational',
                    last_check: stats.mtime,
                    log_size: stats.size
                };
            }
        } catch (error) {
            logger.error('Error collecting system health:', error);
            health.overall_status = 'degraded';
            health.error = error.message;
        }

        return health;
    }

    checkProcessAlive(pid) {
        if (!pid) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get current health verifier status (Phase 33: reverse-proxy to the
     * host health-coordinator). Closes the silent-breakage leak documented
     * in 33-RESEARCH §8 (this file used to read .health/verification-status.json
     * directly, which post-cutover no longer exists).
     */
    async handleGetHealthStatus(req, res) {
        const url = process.env.HEALTH_COORDINATOR_URL || 'http://host.docker.internal:3034';
        try {
            const upstream = await fetch(`${url}/health/state`);
            if (!upstream.ok) {
                return res.status(503).json({
                    status: 'success',
                    data: {
                        status: 'unknown',
                        overallStatus: 'unknown',
                        upstream: `HTTP ${upstream.status}`
                    }
                });
            }
            const state = await upstream.json();
            // Reshape into the constraint-dashboard's existing envelope.
            const overallStatus = (state && state.container && state.container.healthcheck) || 'unknown';
            res.json({
                status: 'success',
                data: {
                    status: overallStatus === 'healthy' ? 'healthy' :
                            overallStatus === 'unhealthy' ? 'unhealthy' : 'unknown',
                    overallStatus,
                    generated_at: state && state.generated_at,
                    services: (state && state.services) || [],
                    lsl_by_project: (state && state.lsl_by_project) || {}
                }
            });
        } catch (err) {
            // SPEC R6: never 'healthy' on exception. Surface 'unknown'.
            logger.error('Failed to get health status', { error: err.message });
            res.status(503).json({
                status: 'success',
                data: {
                    status: 'unknown',
                    overallStatus: 'unknown',
                    upstream: 'unreachable',
                    error: err.message
                }
            });
        }
    }

    /**
     * Get detailed health verification report (Phase 33: reverse-proxy).
     * Reshapes coordinator state into the constraint-dashboard's existing
     * `{ checks, violations }` envelope.
     */
    async handleGetHealthReport(req, res) {
        const url = process.env.HEALTH_COORDINATOR_URL || 'http://host.docker.internal:3034';
        try {
            const upstream = await fetch(`${url}/health/state`);
            if (!upstream.ok) {
                return res.status(503).json({
                    status: 'success',
                    data: {
                        overallStatus: 'unknown',
                        checks: [],
                        violations: [],
                        upstream: `HTTP ${upstream.status}`
                    }
                });
            }
            const state = await upstream.json();
            const checks = [];
            const violations = [];

            if (state && state.container) {
                const c = state.container.healthcheck || 'unknown';
                checks.push({ name: 'container', status: c, source: 'docker.healthcheck' });
                if (c === 'unhealthy') violations.push({ kind: 'container', severity: 'critical', detail: c });
            }
            if (state && Array.isArray(state.services)) {
                for (const svc of state.services) {
                    if (!svc || !svc.name) continue;
                    checks.push({ name: `service.${svc.name}`, status: svc.status || 'unknown', last_seen: svc.last_seen });
                    if (svc.status && svc.status !== 'running') {
                        violations.push({ kind: `service.${svc.name}`, severity: 'high', detail: svc.status });
                    }
                }
            }
            if (state && state.databases && state.databases.status) {
                checks.push({ name: 'databases', status: state.databases.status });
                if (state.databases.status !== 'healthy') {
                    violations.push({ kind: 'databases', severity: 'high', detail: state.databases.status });
                }
            }

            res.json({
                status: 'success',
                data: {
                    checks,
                    violations,
                    generated_at: state && state.generated_at
                }
            });
        } catch (err) {
            logger.error('Failed to get health report', { error: err.message });
            res.status(503).json({
                status: 'success',
                data: {
                    overallStatus: 'unknown',
                    checks: [],
                    violations: [],
                    upstream: 'unreachable',
                    error: err.message
                }
            });
        }
    }

    /**
     * Trigger a health verification run
     */
    async handleTriggerVerification(req, res) {
        try {
            const { execSync } = await import('child_process');
            const codingRoot = process.env.CODING_REPO || join(__dirname, '../../..');
            const verifierScript = join(codingRoot, 'scripts/health-verifier.js');

            if (!existsSync(verifierScript)) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Health verifier script not found'
                });
            }

            // Run verification in background
            execSync(`node "${verifierScript}" verify > /dev/null 2>&1 &`, {
                cwd: codingRoot,
                timeout: 1000
            });

            res.json({
                status: 'success',
                message: 'Health verification triggered',
                data: {
                    triggered_at: new Date().toISOString()
                }
            });
        } catch (error) {
            logger.error('Failed to trigger verification', { error: error.message });
            res.status(500).json({
                status: 'error',
                message: 'Failed to trigger health verification',
                error: error.message
            });
        }
    }

    handleError(err, req, res, next) {
        logger.error('Unhandled error in dashboard server', {
            error: err.message,
            stack: err.stack,
            url: req.url,
            method: req.method
        });

        res.status(500).json({
            status: 'error',
            message: 'Internal server error'
        });
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.server = createServer(this.app);

            this.server.listen(this.port, (error) => {
                if (error) {
                    logger.error('Failed to start dashboard server', { error: error.message, port: this.port });
                    reject(error);
                } else {
                    logger.info('Dashboard server started', {
                        port: this.port,
                        dashboardUrl: `http://localhost:${this.dashboardPort}`,
                        apiUrl: `http://localhost:${this.port}/api`
                    });
                    resolve();
                }
            });
        });
    }

    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.info('Dashboard server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    getServerInfo() {
        return {
            port: this.port,
            dashboardUrl: `http://localhost:${this.dashboardPort}`,
            apiUrl: `http://localhost:${this.port}/api`,
            running: this.server && this.server.listening
        };
    }
}

// Start the server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const portConfig = loadPortConfiguration();
    const server = new DashboardServer(portConfig.apiPort, portConfig.dashboardPort);

    server.start().catch(error => {
        logger.error('Failed to start dashboard server:', error);
        process.exit(1);
    });

    // Handle shutdown signals
    const shutdown = (signal) => {
        logger.info(`Received ${signal}, shutting down dashboard server...`);
        server.stop().then(() => {
            logger.info('Dashboard server shutdown complete');
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { DashboardServer };