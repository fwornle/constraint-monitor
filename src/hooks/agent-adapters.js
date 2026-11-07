/**
 * One tool-call shape for every agent the box runs.
 *
 * The rules are written against Claude Code's tool names and fields
 * (`tool_filter: [Write, Edit, MultiEdit, Bash]`, `file_path`, `content`,
 * `new_string`). The other agents call the same hook through their own guard
 * plugin (coding/docker/agent-box/agents/) and send their native call; this
 * maps it, so a rule means the same thing whichever agent wrote the file.
 *
 * Shapes, as observed from each CLI's hook payload (agent box, 2026-11-07):
 *   copilot   Claude-format plugin hook: Bash{command} Write{path,file_text}
 *             Edit{path,old_str,new_str}
 *   opencode  tool.execute.before: bash{command} write{filePath,content}
 *             edit{filePath,oldString,newString} patch/apply_patch{patchText}
 *   pi        tool_call: bash{command} write{path,content}
 *             edit{path,edits:[{oldText,newText}]} — paths relative to cwd
 *
 * Plan: coding/.planning/guardrail-hardening.md (Phase 1, item 5).
 */

import { isAbsolute, resolve } from 'path';

/** Native tool name → Claude tool name, per agent. Unlisted names pass through. */
const TOOL_NAMES = {
  opencode: {
    bash: 'Bash', write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', patch: 'Edit', apply_patch: 'Edit',
    read: 'Read', glob: 'Glob', grep: 'Grep', list: 'LS', todowrite: 'TodoWrite',
  },
  pi: { bash: 'Bash', write: 'Write', edit: 'MultiEdit', read: 'Read', grep: 'Grep', find: 'Glob', ls: 'LS' },
};

const first = (...values) => values.find((v) => typeof v === 'string');

/**
 * Claude-shaped { tool_name, tool_input } for `agent`'s native call. Paths
 * come out absolute (against `cwd`), so a grant bound to a file and a rule's
 * file_pattern see the same path whatever the agent sent.
 */
export function toClaudeCall(agent, toolName, input = {}, cwd = process.cwd()) {
  const name = TOOL_NAMES[agent]?.[toolName] ?? toolName;
  const p = input && typeof input === 'object' ? input : {};
  const out = { ...p };

  const file = first(p.file_path, p.filePath, p.path, p.notebook_path);
  if (file !== undefined && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(name)) {
    out.file_path = isAbsolute(file) ? file : resolve(cwd, file);
  }
  const content = first(p.content, p.file_text);
  if (content !== undefined) out.content = content;
  const newString = first(p.new_string, p.new_str, p.newString, p.newText, p.patchText);
  if (newString !== undefined) out.new_string = newString;
  const oldString = first(p.old_string, p.old_str, p.oldString, p.oldText);
  if (oldString !== undefined) out.old_string = oldString;
  if (Array.isArray(p.edits)) {
    out.edits = p.edits.map((e) => ({
      old_string: first(e?.old_string, e?.oldText, e?.oldString) ?? '',
      new_string: first(e?.new_string, e?.newText, e?.newString) ?? '',
    }));
  }
  return { tool_name: name, tool_input: out };
}
