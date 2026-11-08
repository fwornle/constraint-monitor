#!/usr/bin/env node

/**
 * Post-tool hook: judge what a tool call left on disk (result-check.js).
 *
 * Claude Code runs it on PostToolUse and PostToolUseFailure (a command that
 * writes a file and then fails still wrote it); the other agents' guard
 * plugins run it from their after-call event (coding/docker/agent-box/agents/).
 * Input is the same JSON the pre-tool hook gets.
 *
 * Exit 2 + stderr = files were undone; the message is what the model sees
 * (Claude Code feeds a post hook's exit-2 stderr back to it). Copilot never
 * shows a post hook's output to the model, so for copilot the message is kept
 * and the next pre-tool hook blocks with it instead.
 *
 * Fail-closed: if the check itself fails, the call stays in flight and the
 * next pre-tool hook judges it again (and blocks if it still cannot).
 */

import { resultCheckEnabled } from './result-check.js';
import { boxGuardConfig, settleWithGrants } from './box-grants.js';
import { toClaudeCall } from './agent-adapters.js';
import { readTranscriptTail, overridesFromTranscript, activeSkillsFromTranscript } from './session-transcript.js';

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TodoWrite']);

async function readStdin() {
  if (process.stdin.isTTY === true) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function report(message) {
  console.error(message);
  process.exit(2);
}

async function main() {
  process.env.CLAUDE_CODE_HOOK = 'true';
  if (!resultCheckEnabled()) process.exit(0);

  let hookInput;
  try {
    hookInput = JSON.parse(await readStdin());
  } catch {
    report('🔴 Result check received unparseable hook input; the next call re-checks what this one left.');
  }

  const agent = process.env.CODING_GUARD_AGENT || hookInput.agent || 'claude';
  const call = agent === 'claude'
    ? { tool_name: hookInput.tool_name, tool_input: hookInput.tool_input }
    : toClaudeCall(agent, hookInput.tool_name, hookInput.tool_input, hookInput.cwd || process.cwd());
  if (!call.tool_name || READ_ONLY_TOOLS.has(call.tool_name)) process.exit(0);

  const box = boxGuardConfig();
  const entries = readTranscriptTail(hookInput.transcript_path);
  const context = {
    constraintOverride: box ? [] : overridesFromTranscript(entries),
    activeSkills: activeSkillsFromTranscript(entries),
  };

  const { afterCall } = await import('./result-check.js');
  const { getEnforcer } = await import('./real-time-constraint-hook.js');
  const { message } = await afterCall({
    cwd: hookInput.cwd || process.cwd(),
    key: hookInput.tool_use_id,
    toolName: call.tool_name,
    params: call.tool_input || {},
    enforcer: getEnforcer(),
    context,
    settleGrant: box ? (rules, file, content) => settleWithGrants({ rules, toolName: 'Write', params: { file_path: file, content }, config: box, agent }) : null,
    deliver: agent !== 'copilot',
  });
  if (message) report(message);
  process.exit(0);
}

main().catch((error) => report(`🔴 Result check failed: ${error?.message ?? error}\nThe next call re-checks what this one left (fail-closed). Report this error to the user.`));
