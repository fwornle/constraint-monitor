#!/usr/bin/env node

/**
 * Real-Time Constraint Enforcement Hook
 * 
 * This hook intercepts every user prompt and tool call to check for constraint violations
 * BEFORE execution. If violations are detected, it blocks execution and requires correction.
 * 
 * Usage: Called by Claude Code hook system on every interaction
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class RealTimeConstraintEnforcer {
  constructor() {
    this.projectPath = process.env.PWD || process.cwd();
    this.constraintConfigPath = this.findConstraintConfig();
    this.config = this.loadConfig();
    // Direct constraint engine integration - no HTTP calls needed
  }

  findConstraintConfig() {
    // Look for project-specific config first, then global. The coding repo
    // has no project-level file: its config IS the global one, kept under
    // config/constraints/ so the container can mount the directory.
    const codingRepo = process.env.CODING_REPO || '';
    const projectConfig = join(this.projectPath, '.constraint-monitor.yaml');
    const globalConfig = join(codingRepo, 'config', 'constraints', 'constraint-monitor.yaml');
    const isCodingRepo = codingRepo && resolve(this.projectPath) === resolve(codingRepo);

    if (!isCodingRepo && existsSync(projectConfig)) {
      return projectConfig;
    } else if (existsSync(globalConfig)) {
      return globalConfig;
    }
    return null;
  }

  loadConfig() {
    if (!this.constraintConfigPath) {
      return { enforcement: { enabled: false } };
    }

    try {
      // Use the existing constraint engine to load config
      const configScript = join(__dirname, '../config/load-constraints.js');
      const result = execSync(`node "${configScript}" "${this.constraintConfigPath}"`, {
        encoding: 'utf8',
        timeout: 3000
      });
      const config = JSON.parse(result);

      // Add default enforcement settings if not present
      if (!config.enforcement) {
        config.enforcement = {
          enabled: true,
          blocking_levels: ['critical', 'error'],
          warning_levels: ['warning'],
          info_levels: ['info'],
          fail_open: true
        };
      }

      return config;
    } catch (error) {
      logger.error('⚠️ Failed to load constraint config:', error.message);
      return { enforcement: { enabled: false } };
    }
  }

  async checkConstraintsDirectly(content, type, context = {}) {
    try {
      // Use the constraint engine directly instead of HTTP API calls
      const { ConstraintEngine } = await import('../engines/constraint-engine.js');
      const { ConfigManager } = await import('../utils/config-manager.js');

      const configManager = new ConfigManager();
      const constraintEngine = new ConstraintEngine(configManager);
      await constraintEngine.initialize();

      const result = await constraintEngine.checkConstraints({
        content,
        type,
        filePath: context.filePath
      });

      // Filter violations based on tool_filter and file_pattern from constraint config
      if (result.violations) {
        result.violations = result.violations.filter(violation => {
          // Get the constraint config to check tool_filter and file_pattern
          const constraintConfig = constraintEngine.constraints?.get(violation.constraint_id);

          if (constraintConfig) {
            // Check tool_filter - if specified, only apply to listed tools
            if (constraintConfig.tool_filter && Array.isArray(constraintConfig.tool_filter)) {
              if (context.toolName && !constraintConfig.tool_filter.includes(context.toolName)) {
                logger.debug(`✅ Skipping ${violation.constraint_id} - tool ${context.toolName} not in tool_filter`);
                return false; // Filter out this violation
              }
            }

            // Check file_pattern - if specified, only apply to matching files
            if (constraintConfig.file_pattern && context.filePath) {
              try {
                const fileRegex = new RegExp(constraintConfig.file_pattern);
                if (!fileRegex.test(context.filePath)) {
                  logger.debug(`✅ Skipping ${violation.constraint_id} - file ${context.filePath} doesn't match pattern`);
                  return false; // Filter out this violation
                }
              } catch (e) {
                // Invalid regex, keep the violation
              }
            }
          }

          // Check if this is a skill-required constraint
          const skillRequiredConstraints = [
            'plantuml-modification-requires-skill',
            'documentation-style-skill-required',
            'no-ascii-art-in-docs'
          ];

          if (skillRequiredConstraints.includes(violation.constraint_id)) {
            // Check if documentation-style skill is active
            if (context.activeSkills && context.activeSkills['documentation-style']) {
              logger.info(`✅ Skipping ${violation.constraint_id} - documentation-style skill is active`);
              return false; // Filter out this violation
            }
          }

          return true; // Keep this violation
        });
      }

      return result;
    } catch (error) {
      // Re-throw — let the caller surface the engine failure rather than
      // silently returning "no violations". Hiding engine errors here
      // historically masked bugs (config split-brain, missing config, etc.)
      // and made it look like the constraint system was working when it
      // wasn't running at all.
      logger.error('🔴 Constraint engine error:', error.message);
      throw error;
    }
  }

  getProjectName() {
    const segments = this.projectPath.split('/');
    return segments[segments.length - 1] || 'unknown';
  }

  shouldBlockViolation(violation, constraintOverride = null) {
    const blockingLevels = this.config.enforcement?.blocking_levels || ['critical', 'error'];

    // Check if this violation has a user-initiated override
    if (constraintOverride) {
      const overrideList = Array.isArray(constraintOverride)
        ? constraintOverride
        : [constraintOverride];

      if (overrideList.includes(violation.constraint_id)) {
        // Log the override for audit trail
        logger.info(`🔓 CONSTRAINT OVERRIDE: User-initiated override for constraint '${violation.constraint_id}'`);
        return false; // Don't block this violation
      }
    }

    return blockingLevels.includes(violation.severity);
  }

  formatViolationMessage(violations, constraintOverride = null) {
    const blockingViolations = violations.filter(v => this.shouldBlockViolation(v, constraintOverride));

    // Check if any violations were overridden
    const overriddenViolations = violations.filter(v => {
      if (!constraintOverride) return false;
      const overrideList = Array.isArray(constraintOverride) ? constraintOverride : [constraintOverride];
      return overrideList.includes(v.constraint_id) && this.config.enforcement?.blocking_levels?.includes(v.severity);
    });

    if (blockingViolations.length === 0) {
      // If we have overridden violations, log them for user awareness
      if (overriddenViolations.length > 0) {
        const overriddenIds = overriddenViolations.map(v => v.constraint_id).join(', ');
        logger.info(`✅ Tool allowed with constraint override(s): ${overriddenIds}`);
      }
      return null; // No blocking violations
    }

    const lines = [
      '🚫 **CONSTRAINT VIOLATION DETECTED - EXECUTION BLOCKED**',
      '',
      'The following constraint violations must be corrected before proceeding:',
      ''
    ];

    blockingViolations.forEach((violation, index) => {
      // Include constraint_id in the message so users can easily request overrides
      const constraintId = violation.constraint_id ? ` [${violation.constraint_id}]` : '';
      lines.push(`**${index + 1}. ${violation.severity.toUpperCase()}${constraintId}: ${violation.message}**`);
      if (violation.suggestion) {
        lines.push(`   💡 Suggestion: ${violation.suggestion}`);
      }
      if (violation.pattern) {
        lines.push(`   🔍 Pattern: \`${violation.pattern}\``);
      }
      lines.push('');
    });

    lines.push('Please modify your request to comply with these constraints and try again.');
    lines.push('To override a constraint, include in your prompt: OVERRIDE_CONSTRAINT: <constraint-id>');
    lines.push('');
    lines.push('📊 View detailed constraint information: http://localhost:3030');

    return lines.join('\n');
  }

  async enforcePromptConstraints(prompt, context = {}) {
    if (!this.config.enforcement?.enabled) {
      return { allowed: true };
    }

    const checkResult = await this.checkConstraintsDirectly(prompt, 'prompt', context);

    // Log ALL violations to dashboard BEFORE deciding whether to block
    if (checkResult.violations && checkResult.violations.length > 0) {
      await this.logViolationsToStorage(checkResult.violations, context, 'prompt');
    }

    const blockingMessage = this.formatViolationMessage(checkResult.violations || []);

    if (blockingMessage) {
      return {
        allowed: false,
        reason: 'constraint_violation',
        message: blockingMessage,
        violations: checkResult.violations
      };
    }

    return { allowed: true, compliance: checkResult.compliance };
  }

  async enforceToolConstraints(toolCall, context = {}) {
    if (!this.config.enforcement?.enabled) {
      return { allowed: true };
    }

    // Extract the actual content from tool calls for constraint checking
    let contentToCheck = '';
    const params = toolCall.parameters || toolCall.arguments || {};

    // For Write/Edit tool calls, check the content being written
    if (['Write', 'Edit', 'MultiEdit'].includes(toolCall.name)) {
      contentToCheck = params.content || params.new_string || '';
      // IMPORTANT: DO NOT check old_string - it may contain violations we're trying to fix!
      // Only check new_string (what's being written) to avoid deadlocks

      // For MultiEdit, check all new_string values (not old_string)
      if (params.edits && Array.isArray(params.edits)) {
        params.edits.forEach(edit => {
          contentToCheck += '\n' + (edit.new_string || '');
        });
      }

      // SPECIAL CASE: For file path constraints, also check the file path
      if (params.file_path) {
        contentToCheck += '\n' + params.file_path;
      }
    } else if (toolCall.name === 'Bash') {
      // SPECIAL CASE: For Bash tool calls, extract just the command for constraint checking
      // This allows command-specific constraints like no-ukb-bash-command to work properly
      contentToCheck = params.command || params.script || '';
      // Also include description for context
      if (params.description) {
        contentToCheck += '\n// ' + params.description;
      }
    } else {
      // For other tools, serialize the entire call
      contentToCheck = JSON.stringify({
        tool: toolCall.name,
        parameters: params,
        context: context
      }, null, 2);
    }

    // CRITICAL: Add file path and tool name to context so constraint engine can filter properly
    // Also pass activeSkills from context so skill-required constraints can be skipped if skill is active
    const contextWithFilePath = {
      ...context,
      filePath: params.file_path,
      toolName: toolCall.name,
      activeSkills: context.activeSkills || {}
    };
    const checkResult = await this.checkConstraintsDirectly(contentToCheck, 'tool_call', contextWithFilePath);

    // Log ALL violations to dashboard BEFORE deciding whether to block
    if (checkResult.violations && checkResult.violations.length > 0) {
      await this.logViolationsToStorage(checkResult.violations, { ...context, filePath: params.file_path }, 'tool_call');
    }

    // Pass constraint override from context to violation formatting
    const blockingMessage = this.formatViolationMessage(checkResult.violations || [], context.constraintOverride);

    if (blockingMessage) {
      return {
        allowed: false,
        reason: 'constraint_violation',
        message: blockingMessage,
        violations: checkResult.violations
      };
    }

    return { allowed: true, compliance: checkResult.compliance };
  }

  async logViolationsToStorage(violations, context, type) {
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      const path = await import('path');
      // Derive coding root from this file's location (5 levels up from src/hooks/)
      const codingRoot = process.env.CODING_TOOLS_PATH || process.env.CODING_REPO || path.resolve(__dirname, '../../../../..');
      const violationStoragePath = path.join(codingRoot, '.mcp-sync', 'violation-history.json');

      // Read existing violations
      let existingData = { violations: [] };
      try {
        const content = readFileSync(violationStoragePath, 'utf8');
        existingData = JSON.parse(content);
      } catch (error) {
        logger.info('Creating new violation storage...');
      }

      // Add each violation with full context
      // Use project from context, or detect from working directory
      const projectName = context.project || this.getProjectName();

      for (const violation of violations) {
        const loggedViolation = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          timestamp: new Date().toISOString(),
          sessionId: context.sessionId || `live-session-${Date.now()}`,
          constraint_id: violation.constraint_id,
          message: violation.message,
          severity: violation.severity,
          tool: type === 'prompt' ? 'live-prompt-hook' : 'live-tool-hook',
          context: projectName,
          project: projectName,
          repository: projectName,
          source: 'main',
          file_path: context.filePath || violation.file_path || 'unknown',
          matches: violation.matches || 1,
          detected_at: new Date().toISOString(),
          pattern: violation.pattern
        };

        existingData.violations.push(loggedViolation);
        logger.info(`📝 LOGGED TO DASHBOARD [${projectName}]: ${violation.constraint_id} (${violation.severity})`);
      }

      // Write back to storage
      writeFileSync(violationStoragePath, JSON.stringify(existingData, null, 2));
    } catch (error) {
      logger.error('❌ Failed to log violations to storage:', error);
    }
  }
}

// Hook entry points for Claude Code integration
const enforcer = new RealTimeConstraintEnforcer();

/**
 * Pre-prompt hook: Called before Claude processes any user prompt
 */
export async function prePromptHook(prompt, context = {}) {
  try {
    const result = await enforcer.enforcePromptConstraints(prompt, context);
    
    if (!result.allowed) {
      // Block execution by throwing an error with the violation message
      throw new Error(result.message);
    }
    
    return { continue: true, compliance: result.compliance };
  } catch (error) {
    if (error.message.includes('CONSTRAINT VIOLATION')) {
      throw error; // Re-throw constraint violations to block execution
    }
    
    // Log other errors but don't block
    logger.error('⚠️ Constraint hook error:', error.message);
    return { continue: true };
  }
}

/**
 * Pre-tool hook: Called before any tool execution
 */
export async function preToolHook(toolCall, context = {}) {
  try {
    const result = await enforcer.enforceToolConstraints(toolCall, context);
    
    if (!result.allowed) {
      // Block tool execution by throwing an error
      throw new Error(result.message);
    }
    
    return { continue: true, compliance: result.compliance };
  } catch (error) {
    if (error.message.includes('CONSTRAINT VIOLATION')) {
      throw error; // Re-throw constraint violations to block execution
    }
    
    // Log other errors but don't block
    logger.error('⚠️ Tool constraint hook error:', error.message);
    return { continue: true };
  }
}

// CLI support for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, action, content] = process.argv;
  
  if (action === 'test-prompt') {
    const testPrompt = content || 'console.error("test")';
    prePromptHook(testPrompt).then(result => {
      console.error('Prompt check result:', result);
    }).catch(error => {
      console.error('Prompt blocked:', error.message);
    });
  } else if (action === 'test-tool') {
    const testTool = { name: 'Write', parameters: { content: 'var x = 1;' } };
    preToolHook(testTool).then(result => {
      console.error('Tool check result:', result);
    }).catch(error => {
      console.error('Tool blocked:', error.message);
    });
  } else {
    console.error('Usage: node real-time-constraint-hook.js [test-prompt|test-tool] [content]');
  }
}