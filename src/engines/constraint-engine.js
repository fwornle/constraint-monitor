import { logger } from '../utils/logger.js';
import { QdrantDatabase } from '../databases/qdrant-client.js';
import { DuckDBAnalytics } from '../databases/duckdb-client.js';
import fs from 'fs';
import path from 'path';

export class ConstraintEngine {
  constructor(configManager) {
    this.configManager = configManager; // Use the provided ConfigManager
    this.constraints = new Map();
    this.violations = [];
    this.qdrant = null;
    this.analytics = null;
    this.fileWatcher = null;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.databases=true] - connect Qdrant + analytics.
   *   The PreToolUse hook passes false: a regex check needs neither, and a
   *   hung Qdrant (300 s client timeout) outlived the hook and let the call
   *   through unchecked.
   */
  async initialize({ databases = true } = {}) {
    try {
      // Import ConfigManager if not provided in constructor
      if (!this.configManager) {
        const { ConfigManager } = await import('../utils/config-manager.js');
        this.configManager = new ConfigManager();
      }
      
      // Load constraints from YAML configuration
      await this.loadConstraintsFromConfig();
      
      if (!databases) {
        logger.info('Constraint Engine initialized with', this.constraints.size, 'constraints (no databases)');
        return;
      }

      // Initialize databases if available
      try {
        this.qdrant = new QdrantDatabase();
        await this.qdrant.initialize();
        logger.info('Qdrant database initialized successfully');
      } catch (error) {
        logger.warn('Qdrant database not available:', error.message);
        this.qdrant = null;
      }

      try {
        this.analytics = new DuckDBAnalytics({ path: ':memory:' });
        await this.analytics.initialize();
        logger.info('Analytics database initialized');
      } catch (error) {
        logger.warn('Analytics database not available:', error.message);
      }

      logger.info('Constraint Engine initialized with', this.constraints.size, 'constraints');
    } catch (error) {
      logger.error('Failed to initialize Constraint Engine:', error);
      throw error;
    }
  }

  async loadConstraintsFromConfig() {
    // Load constraints from YAML configuration via ConfigManager
    const constraints = this.configManager.getConstraints();
    
    logger.info(`Loading ${constraints.length} constraints from configuration`);
    
    for (const constraint of constraints) {
      // Validate constraint structure
      if (!constraint.id || !constraint.pattern || !constraint.message) {
        logger.warn('Invalid constraint definition:', constraint);
        continue;
      }
      
      // Set defaults for missing properties
      constraint.severity = constraint.severity || 'warning';
      constraint.enabled = constraint.enabled !== false; // Default to true
      constraint.suggestion = constraint.suggestion || '';
      
      // Store in constraints map
      this.constraints.set(constraint.id, constraint);
      
      logger.debug(`Loaded constraint: ${constraint.id} (${constraint.severity}) - ${constraint.message}`);
    }
    
    const enabledCount = Array.from(this.constraints.values()).filter(c => c.enabled).length;
    logger.info(`Constraint loading complete: ${this.constraints.size} total, ${enabledCount} enabled`);
  }

  async reloadConfiguration() {
    try {
      logger.info('Reloading constraint configuration');
      this.constraints.clear();
      await this.loadConstraintsFromConfig();
      logger.info('Constraint configuration reloaded successfully');
    } catch (error) {
      logger.error('Failed to reload constraint configuration:', error);
      throw error;
    }
  }


  async checkConstraints(options) {
    const { content, type, filePath } = options;
    const suggestions = [];

    // Debug logging
    logger.info(`Checking constraints for ${filePath}`, {
      contentLength: content?.length,
      totalConstraints: this.constraints.size,
      constraintIds: Array.from(this.constraints.keys())
    });

    // Check all constraints in parallel for maximum performance
    const constraintChecks = Array.from(this.constraints.entries()).map(async ([id, constraint]) => {
      if (!constraint.enabled) {
        logger.debug(`Skipping disabled constraint: ${id}`);
        return null;
      }

      // Check if file matches any exception patterns
      if (constraint.exceptions && Array.isArray(constraint.exceptions)) {
        for (const exception of constraint.exceptions) {
          if (this.matchesPath(filePath, exception.path)) {
            logger.debug(`Skipping constraint ${id} for ${filePath} (matches exception: ${exception.path})`);
            return null;
          }
        }
      }

      // Check if file matches any whitelist patterns
      if (constraint.whitelist && Array.isArray(constraint.whitelist)) {
        for (const whitelistPattern of constraint.whitelist) {
          if (this.matchesPath(filePath, whitelistPattern)) {
            logger.debug(`Skipping constraint ${id} for ${filePath} (matches whitelist: ${whitelistPattern})`);
            return null;
          }
        }
      }

      try {
        // Extract inline flags from pattern (e.g., (?i) for case-insensitive)
        let pattern = constraint.pattern;
        let extractedFlags = '';

        // Check for (?i) inline flag and extract it
        if (pattern.startsWith('(?i)')) {
          pattern = pattern.substring(4);
          extractedFlags += 'i';
        }

        // Build regex flags - always include 'g' for global matching, plus any constraint-specific or extracted flags
        const flags = 'g' + (constraint.flags || '') + extractedFlags;
        const regex = new RegExp(pattern, flags);

        // Check if constraint should apply to file path only (not content)
        // 'filename' is an older spelling of 'file_path' still used in the rules file;
        // treating it as content made path rules match file bodies instead.
        const pathOnly = constraint.applies_to === 'file_path' || constraint.applies_to === 'filename';
        const targetText = pathOnly ? (filePath || '') : content;
        const matches = targetText.match(regex);

        logger.debug(`Testing constraint ${id}`, {
          pattern: constraint.pattern,
          appliesTo: constraint.applies_to || 'content',
          targetLength: targetText?.length,
          matches: matches ? matches.length : 0,
          firstMatch: matches ? matches[0] : null
        });

        if (matches) {
          // Regex match is authoritative. We deliberately do NOT call an LLM
          // to second-guess the regex — that path was masking real violations
          // when the LLM judged ambiguous cases as "not really a violation".
          // If the rule needs to be more selective, tighten the regex or add
          // exceptions/whitelists/file_pattern instead.
          const violation = {
            constraint_id: id,
            message: constraint.message,
            severity: constraint.severity,
            matches: matches.length,
            pattern: constraint.pattern,
            file_path: filePath,
            detected_at: new Date().toISOString()
          };

          logger.info(`Violation confirmed: ${id}`, {
            matches: matches.length,
            severity: constraint.severity
          });

          if (constraint.suggestion) {
            suggestions.push(constraint.suggestion);
          }

          return violation;
        }

        return null;
      } catch (error) {
        // A rule that cannot be evaluated is a broken guard, not a pass.
        logger.error(`Error checking constraint ${id}:`, error);
        throw new Error(`constraint '${id}' could not be evaluated: ${error.message}`);
      }
    });

    // Wait for all constraint checks to complete in parallel
    const results = await Promise.allSettled(constraintChecks);

    const broken = results.filter(result => result.status === 'rejected');
    if (broken.length > 0) {
      throw new Error(broken.map(result => result.reason.message).join('; '));
    }

    // Extract violations from settled promises (filter out nulls)
    const violations = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);

    // Calculate compliance score
    const totalConstraints = this.constraints.size;
    const violatedConstraints = violations.length;
    const compliance = totalConstraints > 0 ?
      ((totalConstraints - violatedConstraints) / totalConstraints) * 10 : 10;

    // Assess risk level
    const criticalViolations = violations.filter(v => v.severity === 'critical').length;
    const errorViolations = violations.filter(v => v.severity === 'error').length;

    let risk = 'low';
    if (criticalViolations > 0) risk = 'critical';
    else if (errorViolations > 2) risk = 'high';
    else if (violations.length > 5) risk = 'medium';

    logger.info(`Constraint check complete`, {
      violations: violations.length,
      compliance: Math.round(compliance * 10) / 10,
      risk
    });

    return {
      violations,
      suggestions,
      compliance: Math.round(compliance * 10) / 10,
      risk,
      total_constraints: totalConstraints,
      violated_constraints: violatedConstraints
    };
  }

  /**
   * Validate post-edit constraints (e.g., PNG generation after PUML edits)
   * @param {string} filePath - Path to the edited file
   * @returns {Promise<Array>} - Array of violations
   */
  async validatePostFileEdit(filePath) {
    const violations = [];

    // Find constraints with post_file_edit validation_type
    for (const [id, constraint] of this.constraints.entries()) {
      if (!constraint.enabled || constraint.validation_type !== 'post_file_edit') {
        continue;
      }

      // Check if file pattern matches
      if (constraint.file_pattern) {
        const regex = new RegExp(constraint.file_pattern);
        if (!regex.test(filePath)) {
          continue;
        }
      }

      try {
        // Handle file timestamp comparison check
        if (constraint.check_type === 'file_timestamp_comparison') {
          const dirname = path.dirname(filePath);
          const basename = path.basename(filePath, path.extname(filePath));

          // Build PNG path from pattern
          let pngPath = constraint.png_path_pattern || '{{dirname}}/{{basename}}.png';
          pngPath = pngPath
            .replace('{{dirname}}', dirname)
            .replace('{{basename}}', basename);

          // Check if PNG exists
          if (!fs.existsSync(pngPath)) {
            violations.push({
              constraint_id: id,
              message: constraint.message
                .replace('{{file_path}}', filePath)
                .replace('{{png_path}}', pngPath)
                .replace('{{dirname}}', dirname)
                .replace('{{basename}}', basename),
              severity: constraint.severity,
              file_path: filePath,
              expected_png: pngPath,
              detected_at: new Date().toISOString(),
              reason: 'PNG file does not exist'
            });
            continue;
          }

          // Check timestamps
          const pumlStat = fs.statSync(filePath);
          const pngStat = fs.statSync(pngPath);

          const ageDiffMs = pumlStat.mtime.getTime() - pngStat.mtime.getTime();
          const maxAgeMs = (constraint.max_age_seconds || 120) * 1000;

          if (ageDiffMs > maxAgeMs) {
            violations.push({
              constraint_id: id,
              message: constraint.message
                .replace('{{file_path}}', filePath)
                .replace('{{png_path}}', pngPath)
                .replace('{{dirname}}', dirname)
                .replace('{{basename}}', basename),
              severity: constraint.severity,
              file_path: filePath,
              expected_png: pngPath,
              puml_modified: pumlStat.mtime.toISOString(),
              png_modified: pngStat.mtime.toISOString(),
              age_diff_seconds: Math.floor(ageDiffMs / 1000),
              detected_at: new Date().toISOString(),
              reason: 'PNG file is outdated (older than PUML modification)'
            });
          }
        }
      } catch (error) {
        logger.error(`Error validating post-edit constraint ${id}:`, error);
      }
    }

    return violations;
  }

  async getViolationHistory(options) {
    const { limit = 10, sessionId } = options;
    
    // In a real implementation, this would query persistent storage
    const recentViolations = this.violations
      .filter(v => !sessionId || v.sessionId === sessionId)
      .slice(-limit);

    return {
      violations: recentViolations,
      total: this.violations.length,
      metrics: {
        average_compliance: 8.5,
        most_common_violation: 'no-console-log',
        improvement_trend: 'stable'
      }
    };
  }

  /**
   * Check if a file path matches a glob pattern
   * @param {string} filePath - The file path to check
   * @param {string} pattern - The glob pattern (supports ** and *)
   * @returns {boolean} - True if the path matches the pattern
   */
  matchesPath(filePath, pattern) {
    if (!filePath || !pattern) return false;

    // Normalize paths
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Convert glob pattern to regex
    // ** matches any number of directories
    // * matches anything except /
    let regexPattern = normalizedPattern
      .replace(/\*\*/g, '{{DOUBLESTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{DOUBLESTAR}}/g, '.*')
      .replace(/\?/g, '[^/]');

    // Add anchors
    regexPattern = '^' + regexPattern + '$';

    const regex = new RegExp(regexPattern);
    return regex.test(normalizedPath);
  }

  async updateConstraints(newConstraints) {
    const updated = [];

    for (const constraint of newConstraints) {
      if (!constraint.id || !constraint.pattern || !constraint.message) {
        logger.warn('Invalid constraint definition:', constraint);
        continue;
      }

      // Set defaults
      constraint.severity = constraint.severity || 'warning';
      constraint.enabled = constraint.enabled !== false;

      this.constraints.set(constraint.id, constraint);
      updated.push(constraint.id);
    }

    logger.info(`Updated ${updated.length} constraints`);

    return {
      updated,
      active: Array.from(this.constraints.values()).filter(c => c.enabled).length
    };
  }

  // NOTE: File watching approach has been deprecated in favor of pre-tool hook prevention
  // Real-time constraint enforcement now happens through Claude Code hook system
  // See: /src/hooks/real-time-constraint-hook.js and Real Time Guardrails specification

  async startFileWatcher(options = {}) {
    logger.warn('File watcher is deprecated. Real-time enforcement now uses Claude Code hooks.');
    logger.info('Constraint enforcement active through pre-tool and pre-prompt hooks.');
    return;
  }

  async stopFileWatcher() {
    logger.info('File watcher functionality deprecated - no action needed');
    return;
  }

  getFileWatcherStatus() {
    return {
      isRunning: false,
      deprecated: true,
      message: 'Real-time enforcement active through Claude Code hooks'
    };
  }
}

// NOTE: FileWatcher class removed as part of deprecating post-hoc file monitoring approach
// Real-time constraint enforcement now happens through Claude Code pre-tool hooks
// See Real Time Guardrails specification Task 8 - this is the correct architectural approach
