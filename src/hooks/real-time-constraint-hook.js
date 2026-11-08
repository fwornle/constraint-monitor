#!/usr/bin/env node

/**
 * Real-Time Constraint Enforcement Hook
 * 
 * This hook intercepts every tool call to check for constraint violations
 * BEFORE execution. If violations are detected, it blocks execution and requires correction.
 * 
 * Usage: Called by Claude Code hook system on every interaction
 */

import { readFileSync } from 'fs';
import { dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);

const MAX_PARSE_BYTES = 1_000_000;

/**
 * The target file before and after an Edit / MultiEdit, so `ast:` rules can
 * count what the edit ADDS to a parsed file (a fragment is not a program).
 * Null when it cannot be worked out — an old_string not in the file means the
 * edit fails anyway; the regex still judges the fragment.
 */
export function editedFile(toolName, params) {
  if (!['Edit', 'MultiEdit'].includes(toolName) || typeof params?.file_path !== 'string') return null;
  let before;
  try {
    before = readFileSync(params.file_path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return null;
    before = '';
  }
  if (before.length > MAX_PARSE_BYTES) return null;
  const edits = toolName === 'MultiEdit'
    ? (Array.isArray(params.edits) ? params.edits : [])
    : [{ old_string: params.old_string, new_string: params.new_string, replace_all: params.replace_all }];
  let after = before;
  for (const e of edits) {
    const from = typeof e?.old_string === 'string' ? e.old_string : '';
    const to = typeof e?.new_string === 'string' ? e.new_string : '';
    if (from === '') {
      if (after !== '') return null;
      after = to;
      continue;
    }
    if (!after.includes(from)) return null;
    after = e.replace_all ? after.split(from).join(to) : after.replace(from, () => to);
  }
  return { before, after };
}

function wholeFile(toolName, params) {
  if (toolName === 'Write') return typeof params.content === 'string' ? { fileText: params.content } : {};
  const edited = editedFile(toolName, params);
  return edited ? { fileText: edited.after, fileTextBefore: edited.before } : {};
}
const __dirname = dirname(__filename);

/**
 * Tools whose input IS content that lands somewhere (a file body, a shell
 * command). A rule without a tool_filter applies to these only. Applying
 * rules to the serialized input of every other tool (Read paths, Agent
 * prompts, sub-agent hand-backs) produced blocks on calls that change
 * nothing, which reads as random and trains agents to rephrase until a call
 * gets through.
 */
export const CONTENT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

class RealTimeConstraintEnforcer {
  constructor() {
    this.config = null;
  }

  /**
   * Enforcement settings come from the canonical rules file only (the same
   * file the rules come from). A project-level .constraint-monitor.yaml used
   * to be able to set enforcement.enabled:false for its repo. Any failure
   * here throws, and the hook wrapper blocks (fail-closed).
   */
  async loadConfig() {
    if (this.config) return this.config;
    const { ConfigManager } = await import('../utils/config-manager.js');
    this.config = { enforcement: new ConfigManager().getEnforcementSettings() };
    return this.config;
  }

  /** One engine per process: the result check evaluates several files per call. */
  async getEngine() {
    if (!this.engine) {
      const { ConstraintEngine } = await import('../engines/constraint-engine.js');
      const { ConfigManager } = await import('../utils/config-manager.js');
      const engine = new ConstraintEngine(new ConfigManager());
      await engine.initialize({ databases: false });
      this.engine = engine;
    }
    return this.engine;
  }

  async checkConstraintsDirectly(content, type, context = {}) {
    try {
      // Use the constraint engine directly instead of HTTP API calls
      const constraintEngine = await this.getEngine();

      const result = await constraintEngine.checkConstraints({
        content,
        type,
        filePath: context.filePath,
        // The whole file, when the caller has it: `ast:` rules parse it.
        fileText: context.fileText,
        fileTextBefore: context.fileTextBefore,
      });

      // Filter violations based on tool_filter and file_pattern from constraint config
      if (result.violations) {
        result.violations = result.violations.filter(violation => {
          // Get the constraint config to check tool_filter and file_pattern
          const constraintConfig = constraintEngine.constraints?.get(violation.constraint_id);

          if (constraintConfig) {
            // Check tool_filter - if specified, only apply to listed tools.
            // A user prompt has no toolName, so a tool-scoped rule never applies to it
            // (pasted terminal output tripped no-ascii-art-in-docs on its ─── separators).
            if (constraintConfig.tool_filter && Array.isArray(constraintConfig.tool_filter)) {
              if (!context.toolName || !constraintConfig.tool_filter.includes(context.toolName)) {
                logger.debug(`✅ Skipping ${violation.constraint_id} - tool ${context.toolName} not in tool_filter`);
                return false; // Filter out this violation
              }
            } else if (type === 'tool_call' && !CONTENT_TOOLS.includes(context.toolName)) {
              return false; // unscoped rules apply to content-writing tools only
            }

            // Check file_pattern - if specified, only apply to matching files.
            // A prompt is not a file, so a file-scoped rule never applies to it.
            if (constraintConfig.file_pattern && type === 'prompt') {
              return false;
            }
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
    return basename(process.cwd()) || 'unknown';
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

  formatViolationMessage(violations, constraintOverride = null, { boxMode = false } = {}) {
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
      if (violation.detected_by === 'ast') {
        lines.push(`   🔍 Found in the parsed code (\`${violation.ast}\` check) — a computed, aliased or destructured form the pattern \`${violation.pattern}\` does not spell out`);
      } else if (violation.pattern) {
        lines.push(`   🔍 Pattern: \`${violation.pattern}\``);
      }
      lines.push('');
    });

    lines.push('Please modify your request to comply with these constraints and try again.');
    // In the agent box only a signed grant overrides; the wrapper says how.
    if (!boxMode) lines.push('To override a constraint, include in your prompt: OVERRIDE_CONSTRAINT: <constraint-id>');
    lines.push('');
    lines.push('📊 View detailed constraint information: http://localhost:3030');

    return lines.join('\n');
  }

  async enforceToolConstraints(toolCall, context = {}) {
    await this.loadConfig();
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
    } else if (toolCall.name === 'NotebookEdit') {
      contentToCheck = (params.new_source || '') + '\n' + (params.notebook_path || '');
    } else if (toolCall.name === 'Bash') {
      // The command only. The description is narration that never executes,
      // and checking it blocked calls for how they were described.
      contentToCheck = params.command || params.script || '';
    } else {
      // Other tools: only rules that name the tool in tool_filter apply.
      contentToCheck = JSON.stringify(params, null, 2);
    }

    // CRITICAL: Add file path and tool name to context so constraint engine can filter properly
    // Also pass activeSkills from context so skill-required constraints can be skipped if skill is active
    const contextWithFilePath = {
      ...context,
      filePath: params.file_path || params.notebook_path,
      // `ast:` rules parse whole files: a Write's content, or the file an
      // Edit / MultiEdit would leave (counting only what the edit adds).
      ...wholeFile(toolCall.name, params),
      toolName: toolCall.name,
      activeSkills: context.activeSkills || {}
    };
    const checkResult = await this.checkConstraintsDirectly(contentToCheck, 'tool_call', contextWithFilePath);

    // Log ALL violations to dashboard BEFORE deciding whether to block
    if (checkResult.violations && checkResult.violations.length > 0) {
      await this.logViolationsToStorage(checkResult.violations, { ...context, filePath: params.file_path }, 'tool_call');
    }

    // Pass constraint override from context to violation formatting
    const blockingMessage = this.formatViolationMessage(checkResult.violations || [], context.constraintOverride,
      { boxMode: context.boxMode === true });

    if (blockingMessage) {
      const rules = (checkResult.violations || [])
        .filter(v => this.shouldBlockViolation(v, context.constraintOverride))
        .map(v => v.constraint_id);
      return {
        allowed: false,
        reason: 'constraint_violation',
        message: blockingMessage,
        violations: checkResult.violations,
        rules: [...new Set(rules)]
      };
    }

    return { allowed: true, compliance: checkResult.compliance };
  }

  async logViolationsToStorage(violations, context, type) {
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      const path = await import('path');
      // Derive coding root from this file's location (5 levels up from src/hooks/)
      const codingRoot = process.env.CODING_TOOLS_PATH || process.env.CODING_REPO || path.resolve(__dirname, '../../../..');
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

/** The shared enforcer (result-check.js judges files on disk with the same rules). */
export function getEnforcer() {
  return enforcer;
}

/**
 * Pre-tool hook: called before any tool execution. Throws a
 * "CONSTRAINT VIOLATION" error to block — carrying the blocking rule ids in
 * `error.rules`, which the box looks up in signed grants; any other error
 * propagates so the wrapper can fail closed instead of silently allowing the call.
 */
export async function preToolHook(toolCall, context = {}) {
  const result = await enforcer.enforceToolConstraints(toolCall, context);
  if (!result.allowed) {
    const error = new Error(result.message);
    error.rules = result.rules;
    throw error;
  }
  return { continue: true, compliance: result.compliance };
}

// CLI support for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, content] = process.argv;
  const testTool = { name: 'Write', parameters: { file_path: '/tmp/x.js', content: content || 'var x = 1;' } };
  preToolHook(testTool, { toolName: 'Write' }).then(result => {
    console.error('Tool check result:', result);
  }).catch(error => {
    console.error('Tool blocked:', error.message);
  });
}
