/**
 * Session transcript reader for the PreToolUse hook.
 *
 * Overrides and skill activations used to live in $TMPDIR state files keyed
 * by ppid. Any process running as the user — including the agent's own Bash
 * tool — could write those files, so an agent could grant itself an override
 * with one `echo`. The session transcript (`transcript_path` in the hook
 * input) is written by Claude Code itself and records WHO produced each
 * entry: a prompt the human typed carries `turnOrigin: "human"` and
 * `promptSource: "typed"`; tool results, sub-agent hand-backs and system
 * notifications carry other markers. Reading authority from there removes
 * the forgeable side channel.
 *
 * Residual (Phase 1 of .planning/guardrail-hardening.md): the transcript file
 * is still user-owned, so an agent can append a forged entry, and a prompt
 * typed via `tmux send-keys` is indistinguishable from the human's. Both need
 * a privilege boundary, not a better parser.
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs';

/** How much of the transcript tail is parsed. Long turns with big tool
 * outputs can push the current prompt far back; 8 MB covers that without
 * reading a 100 MB transcript on every tool call. Not finding the prompt in
 * the window means "no override" — the safe direction. */
export const TAIL_BYTES = 8 * 1024 * 1024;

export const SKILL_TTL_MS = 30 * 60 * 1000;

const OVERRIDE_RE = /OVERRIDE_CONSTRAINT:\s*([a-zA-Z0-9_-]+)/g;

/**
 * Parse the last `maxBytes` of a JSONL transcript. The first line of the
 * window is usually cut mid-record and is dropped; unparseable lines are
 * skipped. Returns [] when the file cannot be read.
 */
export function readTranscriptTail(path, maxBytes = TAIL_BYTES) {
  if (!path) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // partial or corrupt line — skip
      }
    }
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Plain text of a user entry, or null when it is a tool result. */
function userText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
}

/** True only for a prompt the human typed into the session. */
export function isHumanPrompt(entry) {
  return (
    entry?.type === 'user' &&
    entry.isMeta !== true &&
    entry.isSidechain !== true &&
    entry.turnOrigin === 'human' &&
    entry.promptSource === 'typed' &&
    userText(entry) !== null
  );
}

/**
 * Constraint ids the human overrode for the CURRENT turn: the
 * `OVERRIDE_CONSTRAINT: <id>` lines of the most recent human prompt. An
 * override lasts exactly one turn — the next prompt replaces it.
 */
export function overridesFromTranscript(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isHumanPrompt(entries[i])) continue;
    const text = userText(entries[i]);
    return [...text.matchAll(OVERRIDE_RE)].map((m) => m[1]);
  }
  return [];
}

/**
 * Skills invoked in the last `ttlMs`, by name: a Skill tool call the model
 * made, or a `/skill` slash command the human typed. Text from tool results
 * and peer messages never counts, so quoting a command tag in a file or a
 * report does not activate a skill.
 */
export function activeSkillsFromTranscript(entries, now = Date.now(), ttlMs = SKILL_TTL_MS) {
  const active = {};
  const mark = (name, ts) => {
    const at = Date.parse(ts);
    if (!name || Number.isNaN(at) || now - at > ttlMs) return;
    const prev = active[name];
    if (!prev || prev.invokedAt < at) active[name] = { invokedAt: at, expiresAt: at + ttlMs };
  };

  for (const entry of entries) {
    if (entry?.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
          mark(block.input.skill, entry.timestamp);
        }
      }
    } else if (entry?.type === 'user' && entry.turnOrigin !== 'peer' && entry.isSidechain !== true) {
      const text = userText(entry);
      if (!text) continue;
      for (const m of text.matchAll(/<command-name>\/?([\w:.-]+)<\/command-name>/g)) {
        mark(m[1], entry.timestamp);
      }
    }
  }
  return active;
}
