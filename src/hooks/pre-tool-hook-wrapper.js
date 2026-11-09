#!/usr/bin/env node

/**
 * Pre-Tool Hook Wrapper for Claude Code
 *
 * Called by Claude Code before every tool call (PreToolUse, matcher '*').
 * Exit 0 = allow (silently), exit 2 = block (stderr is fed back to the model).
 *
 * FAIL-CLOSED: once enforcement is configured, any failure inside the guard
 * blocks the call. The previous fail-open behaviour meant a missing
 * CODING_REPO, a slow config load or a hung Qdrant silently disabled every
 * rule — indistinguishable from "no violations". Read-only tools stay
 * allowed while the guard is broken so the cause can still be diagnosed.
 *
 * Overrides and skill activations come from the session transcript (see
 * session-transcript.js), never from files or tool parameters the agent can
 * write. In the agent box (CODING_GUARD_MODE=box, set by the managed hook
 * command) the transcript grants NO override: only a grant the user signed
 * on the host counts (box-grants.js), and a blocked call files the request.
 */

import { writeSync } from 'fs';
import { readTranscriptTail, overridesFromTranscript, activeSkillsFromTranscript } from './session-transcript.js';
import { boxGuardConfig, recordBoxCall, settleWithGrants } from './box-grants.js';
import { toClaudeCall } from './agent-adapters.js';
import { resultCheckEnabled, READ_ONLY_TOOLS } from './result-check.js';


const GUARD_BROKEN_HINT =
  'The constraint guard itself failed, so this call is blocked (fail-closed).\n' +
  'Do not try to work around the guard. Report this error to the user.\n' +
  'The user can bypass it for one turn with OVERRIDE_CONSTRAINT: guard-error in their prompt, ' +
  'or start a session with CODING_FEATURE_CONSTRAINTS=off.';

/** In the box the bypass for a broken guard is a grant for this pseudo-rule. */
const GUARD_ERROR_RULE = 'guard-error';

async function readStdin() {
  if (process.stdin.isTTY === true) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Block the call. Claude Code shows stderr of an exit-2 hook to the model.
 * Copilot does not: for exit 2 it shows only "hook exited with code 2", so the
 * rule and the approval link would be lost — it takes the reason from a JSON
 * deny on stdout with exit 0 instead (any other failure of the hook still
 * denies there).
 */
const COPILOT = process.env.CODING_GUARD_AGENT === 'copilot';
// Copilot ALLOWS when stdout is not exactly the decision JSON, so a stray
// log line before it would turn a block into an allow. Everything else this
// process prints goes to stderr; only block() writes to fd 1.
if (COPILOT) process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);

function block(message) {
  if (COPILOT) {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
    }));
    process.exit(0);
  }
  console.error(message);
  process.exit(2);
}

function detectProject(params) {
  const filePath = params?.file_path || params?.path || params?.filePath || params?.notebook_path || '';
  if (filePath.includes('/curriculum-alignment/')) return 'curriculum-alignment';
  if (filePath.includes('/nano-degree/')) return 'nano-degree';
  return 'coding';
}

async function processToolHook() {
  // Hooks MUST be silent on stdout; the shared logger checks this flag.
  process.env.CLAUDE_CODE_HOOK = 'true';

  const raw = await readStdin();
  if (!raw) {
    block('🔴 Constraint guard received no hook input — blocked (fail-closed).');
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    block('🔴 Constraint guard received unparseable hook input — blocked (fail-closed).');
  }

  // Claude Code passes tool parameters in "tool_input" (docs/CLAUDE-CODE-HOOK-FORMAT.md).
  // Other agents' guard plugins send their native call; CODING_GUARD_AGENT is
  // set inline by that plugin's command, never taken from the agent's env.
  const agent = process.env.CODING_GUARD_AGENT || hookInput.agent || 'claude';
  const call = agent === 'claude'
    ? { tool_name: hookInput.tool_name, tool_input: hookInput.tool_input }
    : toClaudeCall(agent, hookInput.tool_name, hookInput.tool_input, hookInput.cwd || process.cwd());
  const toolName = call.tool_name;
  const toolParams = call.tool_input;
  if (!toolName || !toolParams || typeof toolParams !== 'object') {
    block(`🔴 Constraint guard could not identify the tool call (tool_name=${toolName}) — blocked (fail-closed).`);
  }

  const box = boxGuardConfig();
  if (box) recordBoxCall({ agent, toolName, params: toolParams });
  const entries = readTranscriptTail(hookInput.transcript_path);
  const constraintOverride = box ? [] : overridesFromTranscript(entries);

  const context = {
    timestamp: Date.now(),
    source: 'claude-code-tool-hook',
    workingDirectory: hookInput.cwd || process.cwd(),
    sessionId: hookInput.session_id || 'unknown',
    toolName,
    project: detectProject(toolParams),
    constraintOverride,
    boxMode: box !== null,
    activeSkills: activeSkillsFromTranscript(entries),
  };

  /**
   * The call is allowed by the rules. Before it runs: judge what earlier calls
   * left on disk (result-check.js) and register this one, so its own result
   * is judged after it. Anything undone blocks this call, so the agent hears
   * about it; a failure of the check blocks too (fail-closed).
   */
  const allow = async ({ checkResults = true } = {}) => {
    if (checkResults && resultCheckEnabled() && !READ_ONLY_TOOLS.has(toolName)) {
      const { beforeCall } = await import('./result-check.js');
      const { getEnforcer } = await import('./real-time-constraint-hook.js');
      const { undone, notices } = await beforeCall({
        cwd: context.workingDirectory, key: hookInput.tool_use_id, toolName, params: toolParams,
        enforcer: getEnforcer(), context,
        settleGrant: box ? (rules, file, content) => settleWithGrants({ rules, toolName: 'Write', params: { file_path: file, content }, config: box, agent }) : null,
      });
      if (undone.length || notices.length) {
        const { formatUndone } = await import('./result-check.js');
        block([...notices, formatUndone(undone)].filter(Boolean).join('\n\n') +
          '\n\nThis call was not run, so you see the above first. Repeat it if it is still needed.');
      }
    }
    process.exit(0);
  };

  /** Box: allow when signed grants cover every rule, else block with the request link. */
  const settleInBox = async (rules, message) => {
    const verdict = await settleWithGrants({ rules, toolName, params: toolParams, config: box, agent });
    // A grant for a broken guard also lets the call past a broken result check.
    if (verdict.allow) await allow({ checkResults: !rules.includes(GUARD_ERROR_RULE) });
    block(`${message}\n\n${verdict.message}`);
  };

  try {
    const { preToolHook } = await import('./real-time-constraint-hook.js');

    const toolCall = { name: toolName, parameters: toolParams, input: toolParams };
    const result = await preToolHook(toolCall, context);
    if (result.continue) await allow();
    block(`❌ Tool ${toolName} blocked by constraints`);
  } catch (error) {
    if (error.message?.includes('CONSTRAINT VIOLATION')) {
      if (box && error.rules?.length) await settleInBox(error.rules, error.message);
      block(error.message);
    }
    if (READ_ONLY_TOOLS.has(toolName) || constraintOverride.includes(GUARD_ERROR_RULE)) {
      console.error(`⚠️ Constraint guard error (allowed: ${READ_ONLY_TOOLS.has(toolName) ? 'read-only tool' : 'user override'}): ${error.message}`);
      process.exit(0);
    }
    if (box) await settleInBox([GUARD_ERROR_RULE], `🔴 Constraint guard error: ${error.message}\nThe guard failed, so this call is blocked (fail-closed). Report this error to the user.`);
    block(`🔴 Constraint guard error: ${error.message}\n${GUARD_BROKEN_HINT}`);
  }
}

// An escaped rejection would exit 1, which Claude Code treats as "allow".
processToolHook().catch((error) => block(`🔴 Constraint guard error: ${error?.message ?? error}\n${boxGuardConfig() ? 'Blocked (fail-closed). Report this error to the user.' : GUARD_BROKEN_HINT}`));
