/**
 * The box hook records every tool call it sees (box-grants.js recordBoxCall);
 * the red-team test reads the record to tell a declining agent from a held one.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordBoxCall } from '../src/hooks/box-grants.js';

test('one JSON line per call, with the tool and the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-calls-'));
  const file = path.join(dir, 'box-calls.jsonl');
  try {
    recordBoxCall({ agent: 'claude', toolName: 'Write', params: { file_path: '/ws/a.md', content: 'x' } }, file);
    recordBoxCall({ agent: 'pi', toolName: 'Bash', params: { command: 'ls' } }, file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => [l.agent, l.tool, l.file]), [['claude', 'Write', '/ws/a.md'], ['pi', 'Bash', null]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable log never throws', () => {
  assert.doesNotThrow(() => recordBoxCall({ agent: 'claude', toolName: 'Read', params: {} }, '/nonexistent/dir/box-calls.jsonl'));
});
