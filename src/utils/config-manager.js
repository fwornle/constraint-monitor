import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse, stringify } from 'yaml';
import { logger } from './logger.js';

export class ConfigManager {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    const defaultConfig = {
      constraints: {
        enabled: true,
        configFile: './constraints.yaml',
        autoUpdate: true
      },
      databases: {
        qdrant: {
          host: process.env.QDRANT_HOST || 'localhost',
          port: parseInt(process.env.QDRANT_PORT) || 6333,
          collection: 'constraint_violations'
        },
        analytics: {
          path: process.env.ANALYTICS_DB_PATH || ':memory:',
          enabled: true
        }
      },
      monitoring: {
        enabled: true,
        interval: 1000,
        maxViolations: 100
      },
      api: {
        groq: {
          apiKey: process.env.GROQ_API_KEY,
          model: 'llama-3.3-70b-versatile'
        }
      }
    };

    // Try to load project-specific config
    const configPaths = [
      './constraint-monitor.json',
      './.constraint-monitor.json'
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const projectConfig = JSON.parse(readFileSync(configPath, 'utf8'));
          logger.info(`Loaded config from ${configPath}`);
          return this.mergeConfig(defaultConfig, projectConfig);
        } catch (error) {
          logger.warn(`Failed to load config from ${configPath}:`, error.message);
        }
      }
    }

    // Try to load from environment
    if (process.env.CONSTRAINT_MONITOR_CONFIG) {
      try {
        const envConfig = JSON.parse(process.env.CONSTRAINT_MONITOR_CONFIG);
        return this.mergeConfig(defaultConfig, envConfig);
      } catch (error) {
        logger.warn('Failed to parse CONSTRAINT_MONITOR_CONFIG:', error.message);
      }
    }

    logger.info('Using default configuration');
    return defaultConfig;
  }

  mergeConfig(defaultConfig, userConfig) {
    // Deep merge configuration objects
    const merged = { ...defaultConfig };
    
    for (const [key, value] of Object.entries(userConfig)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        merged[key] = { ...merged[key], ...value };
      } else {
        merged[key] = value;
      }
    }
    
    return merged;
  }

  get(path, defaultValue) {
    const keys = path.split('.');
    let current = this.config;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return defaultValue;
      }
    }
    
    return current;
  }

  set(path, value) {
    const keys = path.split('.');
    let current = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  /**
   * Resolve the canonical constraint config location.
   *
   * Single source of truth: CONSTRAINT_CONFIG_PATH env var, else
   * $CODING_REPO/config/constraints/constraint-monitor.yaml. It lives in its
   * own directory so the container can bind-mount the DIRECTORY: a
   * single-file bind mount keeps the old inode when the host replaces the
   * file (git checkout), and the container then reads a deleted file.
   * No cwd-walking, no fallbacks
   * to other config files — when the file is missing we want to fail
   * loudly, not silently load a different (stale) constraint set.
   *
   * Returns the resolved absolute path, or null only if neither env var
   * is set and no caller-provided default exists.
   */
  findProjectConfig() {
    const explicit = process.env.CONSTRAINT_CONFIG_PATH;
    if (explicit) {
      if (!existsSync(explicit)) {
        throw new Error(
          `CONSTRAINT_CONFIG_PATH is set to ${explicit} but the file does not exist. ` +
          `Refusing to fall back to a different config — fix the path or unset the env var.`
        );
      }
      return explicit;
    }

    const codingRepo = process.env.CODING_REPO;
    if (codingRepo) {
      const path = join(codingRepo, 'config', 'constraints', 'constraint-monitor.yaml');
      if (!existsSync(path)) {
        throw new Error(
          `CODING_REPO=${codingRepo} but ${path} does not exist. ` +
          `The constraint-monitor needs a single canonical config/constraints/constraint-monitor.yaml — ` +
          `create the file or set CONSTRAINT_CONFIG_PATH explicitly.`
        );
      }
      return path;
    }

    return null;
  }

  /**
   * Per-project config path. Other repos keep theirs at
   * <project>/.constraint-monitor.yaml; the coding repo's own config IS the
   * canonical one, which lives under config/constraints/ — without this, the
   * first per-project read for coding would write a root copy that shadows it.
   */
  projectConfigPathFor(projectPath) {
    const codingRepo = process.env.CODING_REPO;
    if (codingRepo && resolve(projectPath) === resolve(codingRepo)) {
      return this.findProjectConfig();
    }
    return join(projectPath, '.constraint-monitor.yaml');
  }

  /**
   * Get enforcement settings from the constraint config file
   * Returns the enforcement section with enabled flag, blocking levels, etc.
   */
  getEnforcementSettings() {
    const configPath = this.findProjectConfig();
    if (!configPath) {
      throw new Error(
        'No constraint config found. Set CONSTRAINT_CONFIG_PATH or CODING_REPO ' +
        'so the manager can locate config/constraints/constraint-monitor.yaml.'
      );
    }
    const content = readFileSync(configPath, 'utf8');
    const data = parse(content);
    return {
      enabled: data.enforcement?.enabled ?? true,
      blocking_levels: data.enforcement?.blocking_levels ?? ['critical', 'error'],
      warning_levels: data.enforcement?.warning_levels ?? ['warning'],
      info_levels: data.enforcement?.info_levels ?? ['info'],
      fail_open: data.enforcement?.fail_open ?? true
    };
  }

  getConstraints() {
    const configPath = this.findProjectConfig();
    if (!configPath) {
      throw new Error(
        'No constraint config found. Set CONSTRAINT_CONFIG_PATH or CODING_REPO ' +
        'so the manager can locate config/constraints/constraint-monitor.yaml.'
      );
    }

    const content = readFileSync(configPath, 'utf8');
    const data = parse(content);
    logger.info(`Loaded constraints from ${configPath}`);
    return data.constraints || [];
  }

  getDefaultConstraints() {
    return [
      {
        id: 'no-console-log',
        pattern: 'console\\.log',
        message: 'Use Logger.log() instead of console.log for better log management',
        severity: 'warning',
        enabled: true,
        suggestion: 'Replace with: Logger.log(\'info\', \'category\', message)'
      },
      {
        id: 'no-var-declarations',
        pattern: '\\bvar\\s+',
        message: 'Use \'let\' or \'const\' instead of \'var\'',
        severity: 'warning',
        enabled: true,
        suggestion: 'Use \'let\' for mutable variables, \'const\' for immutable'
      },
      {
        id: 'proper-error-handling',
        pattern: 'catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}',
        message: 'Empty catch blocks should be avoided',
        severity: 'error',
        enabled: true,
        suggestion: 'Add proper error handling or at minimum log the error'
      },
      {
        id: 'no-hardcoded-secrets',
        pattern: '(api[_-]?key|password|secret|token)\\s*[=:]\\s*[\'"][^\'\"]{8,}[\'"]',
        message: 'Potential hardcoded secret detected',
        severity: 'critical',
        enabled: true,
        suggestion: 'Use environment variables or secure key management'
      },
      {
        id: 'no-eval-usage',
        pattern: '\\beval\\s*\\(',
        message: 'eval() usage detected - security risk',
        severity: 'critical',
        enabled: true,
        suggestion: 'Avoid eval() - use safer alternatives for dynamic code execution'
      },
      {
        id: 'proper-function-naming',
        pattern: 'function\\s+[a-z]',
        message: 'Function names should start with a verb (camelCase)',
        severity: 'info',
        enabled: true,
        suggestion: 'Use descriptive verb-based names: getUserData(), processResults()'
      }
    ];
  }

  getConstraintGroups() {
    const configPath = this.findProjectConfig();
    if (!configPath) {
      throw new Error(
        'No constraint config found. Set CONSTRAINT_CONFIG_PATH or CODING_REPO ' +
        'so the manager can locate config/constraints/constraint-monitor.yaml.'
      );
    }
    const content = readFileSync(configPath, 'utf8');
    const data = parse(content);
    return data.constraint_groups || [];
  }

  getConstraintsWithGroups() {
    const constraints = this.getConstraints();
    const groups = this.getConstraintGroups();
    
    // Create group lookup
    const groupMap = groups.reduce((acc, group) => {
      acc[group.id] = group;
      return acc;
    }, {});
    
    // Group constraints by their group ID
    const constraintsByGroup = constraints.reduce((acc, constraint) => {
      const groupId = constraint.group || 'ungrouped';
      if (!acc[groupId]) {
        acc[groupId] = {
          group: groupMap[groupId] || {
            id: groupId,
            name: groupId === 'ungrouped' ? 'Ungrouped Constraints' : groupId,
            description: 'Constraints without specific group assignment',
            icon: '📋',
            color: '#9E9E9E'
          },
          constraints: []
        };
      }
      acc[groupId].constraints.push(constraint);
      return acc;
    }, {});
    
    return {
      groups: Object.values(constraintsByGroup),
      total_constraints: constraints.length,
      total_groups: Object.keys(constraintsByGroup).length,
      enabled_constraints: constraints.filter(c => c.enabled).length
    };
  }

  getConstraintSettings() {
    const configPath = this.findProjectConfig();
    if (!configPath) {
      throw new Error(
        'No constraint config found. Set CONSTRAINT_CONFIG_PATH or CODING_REPO ' +
        'so the manager can locate config/constraints/constraint-monitor.yaml.'
      );
    }
    const content = readFileSync(configPath, 'utf8');
    const data = parse(content);
    return data.settings || this.getDefaultSettings();
  }

  getDefaultConstraintGroups() {
    return [
      {
        id: 'code_quality',
        name: 'Code Quality Standards',
        description: 'Basic code quality and best practices',
        icon: '🔧',
        color: '#4CAF50'
      },
      {
        id: 'security',
        name: 'Security Requirements',
        description: 'Security-focused constraints and vulnerability prevention',
        icon: '🔒',
        color: '#F44336'
      },
      {
        id: 'architecture',
        name: 'Architecture Guidelines',
        description: 'Development practices and architectural standards',
        icon: '🏗️',
        color: '#2196F3'
      }
    ];
  }

  getDefaultSettings() {
    return {
      compliance: {
        excellent_threshold: 9.0,
        good_threshold: 7.0,
        warning_threshold: 5.0
      },
      risk_levels: {
        critical_violations_for_high_risk: 1,
        error_violations_for_medium_risk: 3,
        warning_violations_for_low_risk: 10
      },
      monitoring: {
        cache_timeout: 5000,
        max_history: 1000,
        auto_cleanup: true
      },
      groups: {
        show_empty_groups: false,
        collapse_disabled_groups: true,
        sort_by_severity: true
      }
    };
  }

  // Per-project configuration methods
  getProjectConstraints(projectPath) {
    if (!projectPath) {
      logger.warn('No project path provided, using global constraints');
      return this.getConstraints();
    }

    // Look for project-specific configuration
    const projectConfigPath = this.projectConfigPathFor(projectPath);
    
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, 'utf8');
        const data = parse(content);
        logger.info(`Loaded project-specific constraints from ${projectConfigPath}`);
        return data.constraints || [];
      } catch (error) {
        logger.error(`Failed to parse project constraints from ${projectConfigPath}`, { error: error.message });
      }
    }

    // Fallback to global constraints but create project-specific copy
    logger.info(`No project-specific constraints found for ${projectPath}, creating from global template`);
    return this.createProjectConstraints(projectPath);
  }

  getProjectConstraintGroups(projectPath) {
    if (!projectPath) {
      return this.getConstraintGroups();
    }

    const projectConfigPath = this.projectConfigPathFor(projectPath);
    
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, 'utf8');
        const data = parse(content);
        return data.constraint_groups || [];
      } catch (error) {
        logger.error(`Failed to parse project groups from ${projectConfigPath}`, { error: error.message });
      }
    }

    // Return global groups (they're template-only and don't need per-project copies)
    return this.getConstraintGroups();
  }

  getProjectConstraintsWithGroups(projectPath) {
    const constraints = this.getProjectConstraints(projectPath);
    const groups = this.getProjectConstraintGroups(projectPath);
    
    // Create group lookup
    const groupMap = groups.reduce((acc, group) => {
      acc[group.id] = group;
      return acc;
    }, {});
    
    // Group constraints by their group ID
    const constraintsByGroup = constraints.reduce((acc, constraint) => {
      const groupId = constraint.group || 'ungrouped';
      if (!acc[groupId]) {
        acc[groupId] = {
          group: groupMap[groupId] || {
            id: groupId,
            name: groupId === 'ungrouped' ? 'Ungrouped Constraints' : groupId,
            description: 'Constraints without specific group assignment',
            icon: '📋',
            color: '#9E9E9E'
          },
          constraints: []
        };
      }
      acc[groupId].constraints.push(constraint);
      return acc;
    }, {});
    
    return {
      groups: Object.values(constraintsByGroup),
      total_constraints: constraints.length,
      total_groups: Object.keys(constraintsByGroup).length,
      enabled_constraints: constraints.filter(c => c.enabled).length
    };
  }

  createProjectConstraints(projectPath) {
    // Get global constraints as template
    const globalConstraints = this.getConstraints();
    const globalGroups = this.getConstraintGroups();
    const globalSettings = this.getConstraintSettings();

    // Create project-specific configuration
    const projectConfig = {
      constraint_groups: globalGroups,
      constraints: globalConstraints,
      settings: globalSettings
    };

    // Save to project-specific file
    const projectConfigPath = this.projectConfigPathFor(projectPath);
    
    try {
      const yamlContent = stringify(projectConfig, {
        indent: 2,
        lineWidth: 120,
        minContentWidth: 20,
        keepUndefined: false
      });
      
      writeFileSync(projectConfigPath, yamlContent, 'utf8');
      logger.info(`Created project-specific constraints at ${projectConfigPath}`);
      
      return globalConstraints;
    } catch (error) {
      logger.error(`Failed to create project constraints for ${projectPath}`, { error: error.message });
      return globalConstraints;
    }
  }

  updateProjectConstraint(projectPath, constraintId, enabled) {
    if (!projectPath) {
      logger.error('Cannot update constraint: no project path provided');
      return false;
    }

    const projectConfigPath = this.projectConfigPathFor(projectPath);
    
    // Ensure project config exists
    if (!existsSync(projectConfigPath)) {
      this.createProjectConstraints(projectPath);
    }

    try {
      // Read current configuration
      const content = readFileSync(projectConfigPath, 'utf8');
      const data = parse(content);
      
      // Find and update the constraint
      const constraintIndex = data.constraints.findIndex(c => c.id === constraintId);
      
      if (constraintIndex === -1) {
        logger.error(`Constraint ${constraintId} not found in project config ${projectConfigPath}`);
        return false;
      }
      
      // Update the enabled status
      data.constraints[constraintIndex].enabled = enabled;
      
      // Write back to file
      const updatedContent = stringify(data, {
        indent: 2,
        lineWidth: 120,
        minContentWidth: 20,
        keepUndefined: false
      });
      
      writeFileSync(projectConfigPath, updatedContent, 'utf8');
      
      logger.info(`Updated constraint ${constraintId} to ${enabled ? 'enabled' : 'disabled'} in ${projectConfigPath}`);
      return true;
      
    } catch (error) {
      logger.error(`Failed to update constraint ${constraintId} in ${projectPath}`, { error: error.message });
      return false;
    }
  }
}