/**
 * Each agent's native tool call maps onto the Claude shape the rules are
 * written against. Payloads below are as captured from each CLI's hook in the
 * agent box (2026-11-07).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { toClaudeCall } from '../src/hooks/agent-adapters.js';

describe('copilot (Claude-format plugin hook)', () => {
  test('Write{path,file_text} → Write{file_path,content}', () => {
    const c = toClaudeCall('copilot', 'Write', { path: '/ws/a.js', file_text: 'x' });
    assert.strictEqual(c.tool_name, 'Write');
    assert.strictEqual(c.tool_input.file_path, '/ws/a.js');
    assert.strictEqual(c.tool_input.content, 'x');
  });
  test('Edit{path,old_str,new_str} → Edit{file_path,old_string,new_string}', () => {
    const c = toClaudeCall('copilot', 'Edit', { path: '/ws/a.js', old_str: 'a', new_str: 'b' });
    assert.deepStrictEqual([c.tool_name, c.tool_input.file_path, c.tool_input.old_string, c.tool_input.new_string], ['Edit', '/ws/a.js', 'a', 'b']);
  });
  test('Bash keeps its command', () => {
    assert.strictEqual(toClaudeCall('copilot', 'Bash', { command: 'ls' }).tool_input.command, 'ls');
  });
});

describe('opencode (tool.execute.before)', () => {
  test('write{filePath,content} → Write', () => {
    const c = toClaudeCall('opencode', 'write', { filePath: '/ws/n.md', content: 'x' });
    assert.deepStrictEqual([c.tool_name, c.tool_input.file_path, c.tool_input.content], ['Write', '/ws/n.md', 'x']);
  });
  test('edit{filePath,oldString,newString} → Edit', () => {
    const c = toClaudeCall('opencode', 'edit', { filePath: '/ws/a.js', oldString: 'a', newString: 'b' });
    assert.deepStrictEqual([c.tool_name, c.tool_input.old_string, c.tool_input.new_string], ['Edit', 'a', 'b']);
  });
  test('a patch is checked as an edit of its text', () => {
    const c = toClaudeCall('opencode', 'apply_patch', { patchText: '+console.log(1)' });
    assert.deepStrictEqual([c.tool_name, c.tool_input.new_string], ['Edit', '+console.log(1)']);
  });
  test('bash → Bash, read → Read', () => {
    assert.strictEqual(toClaudeCall('opencode', 'bash', { command: 'ls' }).tool_name, 'Bash');
    assert.strictEqual(toClaudeCall('opencode', 'read', { filePath: '/ws/a' }).tool_name, 'Read');
  });
});

describe('pi (tool_call)', () => {
  test('relative paths become absolute against the cwd', () => {
    const c = toClaudeCall('pi', 'write', { path: 'notes.txt', content: 'x' }, '/ws');
    assert.deepStrictEqual([c.tool_name, c.tool_input.file_path], ['Write', '/ws/notes.txt']);
  });
  test('edit{path,edits:[{oldText,newText}]} → MultiEdit with every new text', () => {
    const c = toClaudeCall('pi', 'edit', { path: 'a.js', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }, '/ws');
    assert.strictEqual(c.tool_name, 'MultiEdit');
    assert.deepStrictEqual(c.tool_input.edits.map((e) => e.new_string), ['b', 'd']);
  });
  test('edit with a single oldText/newText still carries the new text', () => {
    const c = toClaudeCall('pi', 'edit', { path: 'a.js', oldText: 'a', newText: 'b' }, '/ws');
    assert.strictEqual(c.tool_input.new_string, 'b');
  });
});

describe('unknown tools', () => {
  test('pass through under their own name (unscoped rules apply to content tools only)', () => {
    assert.strictEqual(toClaudeCall('opencode', 'webfetch', { url: 'x' }).tool_name, 'webfetch');
  });
});
