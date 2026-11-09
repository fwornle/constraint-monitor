/**
 * Result check (src/hooks/result-check.js): the rules judge what a call left
 * on disk, whatever wrote it, and a violating file is undone.
 *
 * Every test drives the real API against a throwaway git work tree with the
 * shipped rules file: beforeCall → (the "tool" changes files) → afterCall,
 * exactly as the pre/post hooks do.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeCall, afterCall, rulesAddedBy, lockAbandoned, stateDir, READ_ONLY_TOOLS } from '../src/hooks/result-check.js';
import { getEnforcer } from '../src/hooks/real-time-constraint-hook.js';

process.env.CLAUDE_CODE_HOOK = 'true';

const BAD = 'Fixed in 2026 by the team.\n'; // no-incremental-documentation on *.md
const GOOD = 'The service answers on port 8080.\n';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'result-check-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function repo() {
  const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'README.md'), GOOD);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { root, stateRoot: fs.mkdtempSync(path.join(TMP, 'state-')) };
}

const enforcer = getEnforcer();
let n = 0;
/** One call: before → effect → after. */
async function callRun({ root, stateRoot }, effect, { tool = 'Bash', params = { command: 'x' }, key = `k${n++}`, settleGrant = null, deliver = true } = {}) {
  const pre = await beforeCall({ cwd: root, key, toolName: tool, params, enforcer, stateRoot, settleGrant });
  if (pre.undone.length || pre.notices.length) return { pre, post: null };
  effect();
  const post = await afterCall({ cwd: root, key, toolName: tool, params, enforcer, stateRoot, settleGrant, deliver });
  return { pre, post };
}

describe('a file written by the shell is judged like a Write', () => {
  test('a new violating file is removed, kept aside, and the agent is told', async () => {
    const ws = repo();
    const { post } = await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD));
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
    assert.strictEqual(post.undone.length, 1);
    assert.deepStrictEqual(post.undone[0].rules, ['no-incremental-documentation']);
    assert.strictEqual(fs.readFileSync(post.undone[0].rejected, 'utf8'), BAD);
    assert.match(post.message, /UNDONE/);
    assert.match(post.message, /no-incremental-documentation/);
    assert.match(post.message, /NOTES\.md — removed/);
  });

  test('a compliant file stays', async () => {
    const ws = repo();
    const { post } = await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'NOTES.md'), GOOD));
    assert.strictEqual(post.message, '');
    assert.strictEqual(fs.readFileSync(path.join(ws.root, 'NOTES.md'), 'utf8'), GOOD);
  });

  test('a violation appended to a tracked file restores the file as it was', async () => {
    const ws = repo();
    await callRun(ws, () => fs.appendFileSync(path.join(ws.root, 'README.md'), BAD));
    assert.strictEqual(fs.readFileSync(path.join(ws.root, 'README.md'), 'utf8'), GOOD);
  });

  test('an untracked file the agent changes is restored to its untracked content', async () => {
    const ws = repo();
    fs.writeFileSync(path.join(ws.root, 'draft.md'), GOOD);
    await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'draft.md'), BAD));
    assert.strictEqual(fs.readFileSync(path.join(ws.root, 'draft.md'), 'utf8'), GOOD);
  });

  test('a file with violations from before is not blamed on a change that adds none', async () => {
    const ws = repo();
    fs.writeFileSync(path.join(ws.root, 'legacy.md'), BAD);
    await callRun(ws, () => fs.appendFileSync(path.join(ws.root, 'legacy.md'), GOOD));
    assert.strictEqual(fs.readFileSync(path.join(ws.root, 'legacy.md'), 'utf8'), BAD + GOOD);
  });

  test('a rule whitelist still applies (.planning notes may carry dates)', async () => {
    const ws = repo();
    fs.mkdirSync(path.join(ws.root, '.planning'));
    await callRun(ws, () => fs.writeFileSync(path.join(ws.root, '.planning', 'plan.md'), BAD));
    assert.ok(fs.existsSync(path.join(ws.root, '.planning', 'plan.md')));
  });

  test('a .js file written by the shell with console.log is undone too', async () => {
    const ws = repo();
    fs.mkdirSync(path.join(ws.root, 'src'));
    await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'src', 'app.js'), 'console.log("x");\n'));
    assert.ok(!fs.existsSync(path.join(ws.root, 'src', 'app.js')));
  });

  test('binary files, deletions and ignored files are not judged', async () => {
    const ws = repo();
    fs.mkdirSync(path.join(ws.root, 'ignored'));
    const { post } = await callRun(ws, () => {
      fs.writeFileSync(path.join(ws.root, 'blob.md'), Buffer.concat([Buffer.from(BAD), Buffer.from([0, 1, 2])]));
      fs.writeFileSync(path.join(ws.root, 'ignored', 'x.md'), BAD);
      fs.rmSync(path.join(ws.root, 'README.md'));
    });
    assert.strictEqual(post.message, '');
    assert.ok(fs.existsSync(path.join(ws.root, 'blob.md')));
  });
});

describe('the shell bypasses of the per-call check (hook-adversarial todos) are closed', () => {
  const sh = (root, script) => () => execFileSync('bash', ['-c', script], { cwd: root, stdio: 'pipe' });

  test('console.log written through a Bash redirect', async () => {
    const ws = repo();
    await callRun(ws, sh(ws.root, 'mkdir -p src && echo \'console.log("x")\' > src/app.js'));
    assert.ok(!fs.existsSync(path.join(ws.root, 'src', 'app.js')));
  });

  test('a parallel file made with cp instead of Write', async () => {
    const ws = repo();
    fs.mkdirSync(path.join(ws.root, 'src'));
    fs.writeFileSync(path.join(ws.root, 'src', 'parser.js'), 'export const p = 1;\n');
    await callRun(ws, sh(ws.root, 'cp src/parser.js src/parser-v2.js'));
    assert.ok(!fs.existsSync(path.join(ws.root, 'src', 'parser-v2.js')));
    assert.ok(fs.existsSync(path.join(ws.root, 'src', 'parser.js')));
  });

  test('content smuggled through base64', async () => {
    const ws = repo();
    const b64 = Buffer.from(BAD).toString('base64');
    await callRun(ws, sh(ws.root, `echo ${b64} | base64 -d > NOTES.md`));
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
  });

  test('obfuscated console.log written by the shell (judged on the parsed file)', async () => {
    const ws = repo();
    await callRun(ws, sh(ws.root, `mkdir -p src && printf '%s\\n' 'const c = console; c["lo" + "g"]("x");' > src/app.js`));
    assert.ok(!fs.existsSync(path.join(ws.root, 'src', 'app.js')));
  });

  test('a script the agent wrote and then ran', async () => {
    const ws = repo();
    await callRun(ws, sh(ws.root, `printf '%s\\n' "require('fs').writeFileSync('NOTES.md', 'Upd' + 'ated in 2025.')" > /tmp/w-${process.pid}.js && node /tmp/w-${process.pid}.js`));
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
  });
});

describe('what is and is not attributed to the call', () => {
  test("a file tool's own target was judged by the per-call check and is left alone", async () => {
    const ws = repo();
    const file = path.join(ws.root, 'NOTES.md');
    // Stands in for a Write the user granted: the pre-call check let it through.
    await callRun(ws, () => fs.writeFileSync(file, BAD), { tool: 'Write', params: { file_path: file, content: BAD } });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), BAD);
  });

  test('a file tool does not shield OTHER files it did not name', async () => {
    const ws = repo();
    const file = path.join(ws.root, 'NOTES.md');
    await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'OTHER.md'), BAD), { tool: 'Write', params: { file_path: file, content: GOOD } });
    assert.ok(!fs.existsSync(path.join(ws.root, 'OTHER.md')));
  });

  test('edits made while no call is in flight (the user, between turns) are never judged', async () => {
    const ws = repo();
    await callRun(ws, () => {});
    fs.writeFileSync(path.join(ws.root, 'USER.md'), BAD); // the user, in their editor
    const { post } = await callRun(ws, () => {});
    assert.strictEqual(post.message, '');
    assert.ok(fs.existsSync(path.join(ws.root, 'USER.md')));
  });

  test('a call whose after-event never came is judged by the next call, which is blocked to say so', async () => {
    const ws = repo();
    await beforeCall({ cwd: ws.root, key: 'lost', toolName: 'Bash', params: {}, enforcer, stateRoot: ws.stateRoot });
    fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD); // e.g. `printf … > NOTES.md; false`
    const next = await beforeCall({ cwd: ws.root, key: 'next', toolName: 'Bash', params: {}, enforcer, stateRoot: ws.stateRoot });
    assert.strictEqual(next.undone.length, 1);
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
    // The blocked call was not registered: its post never comes.
    const state = JSON.parse(fs.readFileSync(path.join(ws.stateRoot, fs.readdirSync(ws.stateRoot)[0], 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.inflight.map((c) => c.key), ['lost']);
  });

  test('an agent whose post output is never shown hears it at its next call (copilot)', async () => {
    const ws = repo();
    const { post } = await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD), { deliver: false });
    assert.strictEqual(post.message, '');
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
    const next = await beforeCall({ cwd: ws.root, key: 'n', toolName: 'Bash', params: {}, enforcer, stateRoot: ws.stateRoot });
    assert.strictEqual(next.notices.length, 1);
    assert.match(next.notices[0], /NOTES\.md/);
  });

  test('outside a git work tree there is nothing to compare, and nothing breaks', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'plain-'));
    const pre = await beforeCall({ cwd: dir, key: 'p', toolName: 'Bash', params: {}, enforcer, stateRoot: dir });
    assert.deepStrictEqual([pre.undone, pre.notices, pre.root], [[], [], null]);
  });
});

describe('box grants', () => {
  test('a signed grant for the rule and file keeps the file', async () => {
    const ws = repo();
    const asked = [];
    const settleGrant = async (rules, file) => { asked.push([rules, path.basename(file)]); return { allow: true }; };
    await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD), { settleGrant });
    assert.deepStrictEqual(asked, [[['no-incremental-documentation'], 'NOTES.md']]);
    assert.ok(fs.existsSync(path.join(ws.root, 'NOTES.md')));
  });

  test('without a grant the file is undone and the approval link is in the message', async () => {
    const ws = repo();
    const settleGrant = async () => ({ allow: false, message: '🔐 Override requested:\n   no-incremental-documentation: http://guard/approve/1' });
    const { post } = await callRun(ws, () => fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD), { settleGrant });
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
    assert.match(post.message, /approve\/1/);
  });
});

test('rulesAddedBy counts matches, so a second violation in a file that had one is caught', async () => {
  const added = await rulesAddedBy({ enforcer, absPath: '/ws/a.md', before: BAD, after: BAD + 'Updated in 2025.\n' });
  assert.deepStrictEqual(added.map((v) => v.constraint_id), ['no-incremental-documentation']);
});

describe('the hooks end to end (stdin JSON, as an agent runs them)', () => {
  const PRE = path.join(HERE, '..', 'src', 'hooks', 'pre-tool-hook-wrapper.js');
  const POST = path.join(HERE, '..', 'src', 'hooks', 'post-tool-hook.js');
  const run = (hook, input, env = {}) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CODING_GUARD_RESULTS: 'on', CODING_GUARD_MODE: '', ...env },
  });

  test('pre allows the shell write, post undoes it and exits 2 with the reason', () => {
    const ws = repo();
    const call = { tool_name: 'Bash', tool_input: { command: 'printf "%s" "$X" > NOTES.md' }, tool_use_id: 'e2e-1', cwd: ws.root, session_id: 's' };
    const pre = run(PRE, call);
    assert.strictEqual(pre.status, 0, pre.stderr);
    fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD);
    const post = run(POST, { ...call, hook_event_name: 'PostToolUse' });
    assert.strictEqual(post.status, 2);
    assert.match(post.stderr, /no-incremental-documentation/);
    assert.ok(!fs.existsSync(path.join(ws.root, 'NOTES.md')));
  });

  test('off by default on the host: the post hook does nothing', () => {
    const ws = repo();
    fs.writeFileSync(path.join(ws.root, 'NOTES.md'), BAD);
    const post = run(POST, { tool_name: 'Bash', tool_input: { command: 'x' }, cwd: ws.root }, { CODING_GUARD_RESULTS: '' });
    assert.strictEqual(post.status, 0);
    assert.ok(fs.existsSync(path.join(ws.root, 'NOTES.md')));
  });
});

describe('the state lock survives a killed hook (2026-11-09)', () => {
  // The agent harness kills a hook on its timeout (30 s); `finally` never runs,
  // so the lock and the snapshot's temp index outlived it and every later call
  // waited 20 s and failed closed until the lock aged out at 60 s.
  const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
  const host = os.hostname();

  test('a lock whose holder is dead on this host is abandoned at once; a live holder is not', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'lock-'));
    const lock = path.join(dir, 'lock');
    fs.writeFileSync(lock, `${deadPid()} ${host}`);
    assert.strictEqual(lockAbandoned(lock), true);
    fs.writeFileSync(lock, `${process.pid} ${host}`);
    assert.strictEqual(lockAbandoned(lock), false);
  });

  test('a lock from another host, or not written yet, falls back to its age', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'lock-'));
    const lock = path.join(dir, 'lock');
    fs.writeFileSync(lock, `1 some-other-host`);
    assert.strictEqual(lockAbandoned(lock), false);
    assert.strictEqual(lockAbandoned(lock, { now: Date.now() + 61_000 }), true);
    fs.writeFileSync(lock, '');
    assert.strictEqual(lockAbandoned(lock), false);
    assert.strictEqual(lockAbandoned(path.join(dir, 'gone')), false);
  });

  test('a call after a killed hook proceeds at once and sweeps its orphaned index', async () => {
    const ws = repo();
    const dir = stateDir(ws.root, ws.stateRoot);
    fs.mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    fs.writeFileSync(path.join(dir, 'lock'), `${dead} ${host}`);
    fs.writeFileSync(path.join(dir, `index-${dead}-0877fcce`), 'x');
    fs.writeFileSync(path.join(dir, `index-${process.pid}-0877fcce`), 'x'); // a live snapshot's: kept
    const t = Date.now();
    const { post } = await callRun(ws, () => {});
    assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
    assert.strictEqual(post.message, '');
    assert.ok(!fs.existsSync(path.join(dir, 'lock')));
    assert.ok(!fs.existsSync(path.join(dir, `index-${dead}-0877fcce`)));
    assert.ok(fs.existsSync(path.join(dir, `index-${process.pid}-0877fcce`)));
  });

  test('end to end: a hook SIGKILLed while holding the lock does not block the next call', async () => {
    const ws = repo();
    const dir = stateDir(ws.root, ws.stateRoot);
    // Child: register a call (sets the base), change a file, then judge it with
    // an enforcer that never answers — it holds the lock until killed.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { beforeCall, afterCall } from ${JSON.stringify(new URL('../src/hooks/result-check.js', import.meta.url).href)};
      const hang = { loadConfig: () => new Promise(() => { setInterval(() => {}, 1000); }) };
      const a = { cwd: ${JSON.stringify(ws.root)}, key: 'c', toolName: 'Bash', params: { command: 'x' }, stateRoot: ${JSON.stringify(ws.stateRoot)} };
      await beforeCall({ ...a, enforcer: hang });
      fs.writeFileSync(${JSON.stringify(path.join(ws.root, 'new.md'))}, 'x');
      await afterCall({ ...a, enforcer: hang });
    `], { stdio: 'ignore' });
    const lock = path.join(dir, 'lock');
    for (let i = 0; i < 200 && !(fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === `${child.pid} ${host}`); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), `${child.pid} ${host}`, 'the child holds the lock and names itself');
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    assert.ok(fs.existsSync(lock), 'the killed hook left its lock behind');
    const t = Date.now();
    await callRun(ws, () => {});
    assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
    assert.ok(!fs.existsSync(lock));
  });
});

describe('read-only tools skip the result check', () => {
  test('tools that cannot write are listed; writers and unknown (MCP) tools are not', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'Agent', 'TaskStop', 'WebFetch', 'Skill']) assert.ok(READ_ONLY_TOOLS.has(t), t);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Monitor', 'mcp__x__y']) assert.ok(!READ_ONLY_TOOLS.has(t), t);
  });
});
