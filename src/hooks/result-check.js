/**
 * Result check: judge what a tool call LEFT ON DISK, not how it was worded.
 *
 * The PreToolUse rules read the text of a call. The same file can be written
 * in endless spellings the text check never sees — `printf … > f`, a heredoc,
 * `cp`, a script, base64 — so a rule on `.md` content (no-temporal-language
 * and friends) was trivially bypassed through the shell. Here the rules run
 * against the files themselves, with the same engine, filters, whitelists and
 * grants as the per-call check, presented as the Write that produced them.
 *
 * Mechanism (git, so it is cheap and exact):
 *   - Before a call that can write, the hook makes sure there is a BASE: the
 *     whole working tree as a git tree object (a throwaway index seeded from
 *     the real one for its stat cache, `git add -A`, `git write-tree`; objects
 *     go to a private object dir, so the repo's own store is never touched).
 *   - After the call (and before the next one, as the backstop for an agent
 *     or an outcome that fires no after-call event) the tree is snapshotted
 *     again and `git diff-tree` names exactly the files that changed.
 *   - Each changed text file is checked; a rule counts only when the call ADDED
 *     matches (more than the base version had), so editing a file with legacy
 *     violations is not blamed on the agent.
 *   - A violating file is UNDONE: restored to its base content (a new file is
 *     removed). The rejected version is kept under the state dir. In the box a
 *     signed grant for the rule and file keeps it instead, and a missing grant
 *     files the request, as for a blocked call.
 *   - The new state becomes the base. When no call is in flight any more the
 *     base is dropped, so what the user edits between turns is never judged.
 *
 * Limits (the CI push gate, scripts/guard-check-diff.mjs, is the authoritative
 * check for all of them): files git ignores, files inside submodules, files
 * over MAX_FILE_BYTES and binary files are not checked; a background process
 * that writes after the last hook of a session is not seen; the state dir is
 * writable by the agent's uid, so an agent that rewrites the base in the same
 * command can hide its change (a git tree id cannot be forged, but it can be
 * replaced).
 *
 * Plan: coding/.planning/guardrail-hardening.md (Phase 2).
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Where the hook keeps its state (1777 in the box image, like box-calls.jsonl). */
export const STATE_ROOT = fileURLToPath(new URL('../../logs/results/', import.meta.url));
export const MAX_FILE_BYTES = 1_000_000;
/** An in-flight call older than this never got its after-call event (crash, denial). */
export const STALE_MS = 30 * 60_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_STALE_MS = 60_000;

/** Tools whose own target file the per-call check already judged in full. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Result check is on in the box (or explicitly on the host). */
export function resultCheckEnabled(env = process.env) {
  return env.CODING_GUARD_MODE === 'box' || env.CODING_GUARD_RESULTS === 'on';
}

// ---------------------------------------------------------------- git

function git(root, args, { env = {}, input } = {}) {
  return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', '-C', root, ...args], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/tmp', ...env },
    encoding: input === undefined ? 'utf8' : undefined,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The work tree the call ran in, or null when it is not in a git repo. */
export function workspaceRoot(cwd) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    return top || null;
  } catch {
    return null;
  }
}

function repoObjectsDir(root) {
  const p = git(root, ['rev-parse', '--git-path', 'objects']).trim();
  return isAbsolute(p) ? p : resolve(root, p);
}

function realIndexPath(root) {
  const p = git(root, ['rev-parse', '--git-path', 'index']).trim();
  return isAbsolute(p) ? p : resolve(root, p);
}

/** git env that reads the repo's objects but writes only to our own object dir. */
function objectEnv(root, dir) {
  const objects = join(dir, 'objects');
  mkdirSync(objects, { recursive: true });
  return { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjectsDir(root) };
}

/** The whole working tree (tracked + untracked, minus ignored) as a tree id. */
export function snapshot(root, dir) {
  const env = objectEnv(root, dir);
  const index = join(dir, `index-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const real = realIndexPath(root);
    if (existsSync(real)) copyFileSync(real, index);
    git(root, ['add', '-A', '--', '.'], { env: { ...env, GIT_INDEX_FILE: index } });
    return git(root, ['write-tree'], { env: { ...env, GIT_INDEX_FILE: index } }).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Files that differ between two trees: [{ path, oldMode, newMode, oldSha, newSha, status }]. */
export function changedFiles(root, dir, base, cur) {
  if (base === cur) return [];
  const out = git(root, ['diff-tree', '-r', '-z', '--no-renames', base, cur], { env: objectEnv(root, dir) });
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(parts[i]);
    if (!m) continue;
    files.push({ oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4], status: m[5], path: parts[i + 1] });
  }
  return files;
}

const ZERO = /^0+$/;

function blob(root, dir, sha) {
  return git(root, ['cat-file', 'blob', sha], { env: objectEnv(root, dir), input: '' });
}

function blobSize(root, dir, sha) {
  return Number(git(root, ['cat-file', '-s', sha], { env: objectEnv(root, dir) }).trim());
}

// ---------------------------------------------------------------- state

/** One state dir per work tree. */
export function stateDir(root, stateRoot = STATE_ROOT) {
  const dir = join(stateRoot, createHash('sha256').update(root).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readState(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    return { base: typeof s.base === 'string' ? s.base : null, inflight: Array.isArray(s.inflight) ? s.inflight : [], notices: Array.isArray(s.notices) ? s.notices : [] };
  } catch {
    return { base: null, inflight: [], notices: [] };
  }
}

function writeState(dir, state) {
  const tmp = join(dir, `state.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(dir, 'state.json'));
}

/** Parallel calls run their hooks at the same time; the state is one file. */
async function withLock(dir, fn) {
  const lock = join(dir, 'lock');
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch { /* gone already */ }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`result check: state lock busy (${lock})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

// ---------------------------------------------------------------- judging

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function countByRule(violations) {
  const m = new Map();
  for (const v of violations) m.set(v.constraint_id, (m.get(v.constraint_id) || 0) + (v.matches || 1));
  return m;
}

/**
 * The blocking rules a change ADDS to one file. `before` is null for a new
 * file. Same evaluation as a Write of the whole file by the per-call check.
 */
export async function rulesAddedBy({ enforcer, absPath, before, after, context = {} }) {
  const config = await enforcer.loadConfig();
  if (!config.enforcement?.enabled) return [];
  const judge = async (text) => {
    const res = await enforcer.checkConstraintsDirectly(`${text}\n${absPath}`, 'tool_call', {
      filePath: absPath, toolName: 'Write', activeSkills: context.activeSkills || {}, fileText: text,
    });
    return (res.violations || []).filter((v) => enforcer.shouldBlockViolation(v, context.constraintOverride));
  };
  const now = await judge(after);
  if (now.length === 0) return [];
  const was = before === null ? new Map() : countByRule(await judge(before));
  const added = [];
  for (const [rule, n] of countByRule(now)) if (n > (was.get(rule) || 0)) added.push(rule);
  const suggestion = (rule) => enforcer.engine?.constraints?.get(rule)?.suggestion;
  return added.map((rule) => ({ suggestion: suggestion(rule), ...now.find((v) => v.constraint_id === rule) }));
}

function keepRejected(dir, relPath, content) {
  const rejected = join(dir, 'rejected');
  mkdirSync(rejected, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${relPath.replace(/[\\/]/g, '__')}`;
  const file = join(rejected, name);
  writeFileSync(file, content);
  return file;
}

function restore(root, dir, change) {
  const abs = join(root, change.path);
  if (ZERO.test(change.oldSha)) {
    rmSync(abs, { force: true });
    return 'removed (it did not exist before the call)';
  }
  mkdirSync(dirname(abs), { recursive: true });
  // A symlink or directory now in its place is replaced by the file it was.
  try { if (statSync(abs).isDirectory()) rmSync(abs, { recursive: true, force: true }); } catch { /* absent */ }
  try { unlinkSync(abs); } catch { /* absent */ }
  writeFileSync(abs, blob(root, dir, change.oldSha));
  if (change.oldMode === '100755') chmodSync(abs, 0o755);
  return 'restored to its content before the call';
}

/**
 * Judge every change since the base and undo the violating files.
 * `settleGrant(rules, absPath, content)` → { allow, message } (box: signed
 * grants), or null to undo without asking.
 * Returns [{ file, rules, violations, action, rejected, grantMessage }].
 */
async function judgeChanges({ root, dir, base, cur, exclude, enforcer, context, settleGrant }) {
  const undone = [];
  for (const change of changedFiles(root, dir, base, cur)) {
    if (change.status === 'D') continue; // deleting cannot add a violation
    if (!change.newMode.startsWith('100')) continue; // symlinks, gitlinks (submodules)
    const absPath = join(root, change.path);
    if (exclude.has(absPath)) continue;
    if (blobSize(root, dir, change.newSha) > MAX_FILE_BYTES) continue;
    const afterBuf = blob(root, dir, change.newSha);
    if (isBinary(afterBuf)) continue;
    const beforeBuf = ZERO.test(change.oldSha) ? null : blob(root, dir, change.oldSha);
    const before = beforeBuf && !isBinary(beforeBuf) ? beforeBuf.toString('utf8') : null;
    const after = afterBuf.toString('utf8');
    const violations = await rulesAddedBy({ enforcer, absPath, before, after, context });
    if (violations.length === 0) continue;
    const rules = [...new Set(violations.map((v) => v.constraint_id))];
    let grantMessage = null;
    if (settleGrant) {
      const verdict = await settleGrant(rules, absPath, after);
      if (verdict.allow) continue;
      grantMessage = verdict.message;
    }
    const rejected = keepRejected(dir, change.path, afterBuf);
    const action = restore(root, dir, change);
    undone.push({ file: absPath, rules, violations, action, rejected, grantMessage });
  }
  return undone;
}

/** What the agent is told when its result was undone. */
export function formatUndone(undone) {
  if (undone.length === 0) return '';
  const lines = [
    '🚫 **CONSTRAINT VIOLATION IN THE RESULT — UNDONE**',
    '',
    'Your last tool call left files on disk that break the rules. The check reads the files',
    'themselves, so the way they were written (shell, script, copy) does not matter.',
    '',
  ];
  for (const u of undone) {
    lines.push(`• ${u.file} — ${u.action}`);
    for (const v of u.violations) {
      lines.push(`  ${v.severity.toUpperCase()} [${v.constraint_id}]: ${v.message}`);
      if (v.suggestion) lines.push(`  💡 ${v.suggestion}`);
    }
    lines.push(`  The rejected version is saved at ${u.rejected}`);
    if (u.grantMessage) lines.push('', u.grantMessage.split('\n').map((l) => `  ${l}`).join('\n'));
    lines.push('');
  }
  lines.push('Write the file so that it complies. Do not try another way to get the same content onto disk.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- hook API

function liveInflight(state, now) {
  return state.inflight.filter((c) => now - c.t < STALE_MS);
}

/**
 * Settle everything since the base, under the lock. Returns the undone files
 * and leaves `state.base` at the judged (post-undo) tree.
 */
async function settle({ root, dir, state, exclude, enforcer, context, settleGrant }) {
  if (!state.base) return [];
  const cur = snapshot(root, dir);
  const undone = await judgeChanges({ root, dir, base: state.base, cur, exclude, enforcer, context, settleGrant });
  state.base = undone.length ? snapshot(root, dir) : cur;
  return undone;
}

function ownFile(toolName, params) {
  if (!FILE_TOOLS.has(toolName)) return null;
  return params?.file_path || params?.notebook_path || null;
}

/**
 * Before a call that can write. Settles what earlier calls left (the
 * backstop for a call whose after-call event never came), then registers this
 * call as in flight. Returns { undone, notices }: when either is non-empty
 * the call is NOT registered and must be blocked with formatUndone() and the
 * notices, since the agent has not seen them yet.
 */
export async function beforeCall({ cwd, key, toolName, params, enforcer, context = {}, settleGrant = null, stateRoot = STATE_ROOT, now = Date.now() }) {
  const root = workspaceRoot(cwd);
  if (!root) return { undone: [], notices: [], root: null };
  const dir = stateDir(root, stateRoot);
  return withLock(dir, async () => {
    const state = readState(dir);
    state.inflight = liveInflight(state, now);
    if (state.inflight.length === 0) state.base = null;
    const exclude = new Set(state.inflight.map((c) => c.file).filter(Boolean));
    const undone = await settle({ root, dir, state, exclude, enforcer, context, settleGrant });
    const notices = state.notices;
    state.notices = [];
    if (undone.length || notices.length) {
      // This call is blocked so the agent sees what was undone; it never runs.
      if (state.inflight.length === 0) state.base = null;
      writeState(dir, state);
      return { undone, notices, root };
    }
    if (!state.base) state.base = snapshot(root, dir);
    state.inflight.push({ key: key || `anon-${now}-${randomBytes(3).toString('hex')}`, t: now, tool: toolName, file: ownFile(toolName, params) });
    writeState(dir, state);
    return { undone, notices, root };
  });
}

/**
 * After a call (success or failure). Judges what it left, undoes violations,
 * and retires the call. `deliver: false` (an agent whose after-call output
 * the model never sees) keeps the message for the next beforeCall instead.
 * Returns { undone, message }.
 */
export async function afterCall({ cwd, key, toolName, params, enforcer, context = {}, settleGrant = null, deliver = true, stateRoot = STATE_ROOT, now = Date.now() }) {
  const root = workspaceRoot(cwd);
  if (!root) return { undone: [], message: '' };
  const dir = stateDir(root, stateRoot);
  return withLock(dir, async () => {
    const state = readState(dir);
    state.inflight = liveInflight(state, now);
    const own = ownFile(toolName, params);
    const exclude = new Set([...state.inflight.map((c) => c.file), own].filter(Boolean));
    const undone = await settle({ root, dir, state, exclude, enforcer, context, settleGrant });
    // Retire this call: by key, else (an agent without call ids) the oldest of the same tool.
    let i = key ? state.inflight.findIndex((c) => c.key === key) : -1;
    if (i < 0) i = state.inflight.findIndex((c) => c.tool === toolName);
    if (i >= 0) state.inflight.splice(i, 1);
    if (state.inflight.length === 0) state.base = null;
    const message = formatUndone(undone);
    if (message && !deliver) state.notices.push(message);
    writeState(dir, state);
    return { undone, message: deliver ? message : '' };
  });
}
