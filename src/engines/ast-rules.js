/**
 * AST checks behind the regex rules (Phase 2 of .planning/guardrail-hardening.md:
 * "check results, not wording").
 *
 * A regex sees spelling. The no-console-log pattern misses a computed member
 * (`console["log"]`), an alias (`const c = console; c.log`) and a destructure
 * (`const { log } = console`), all of which run exactly the same. These checks
 * parse the WHOLE file and count what the code does. A rule opts in with
 * `ast: <check>` in the rules file; the engine then counts
 * max(regex matches, AST matches), so the AST only ever adds what the regex
 * missed (it never drops a regex hit, e.g. one in a comment).
 *
 * Only whole files are parsed — a Write, or the file the result check reads
 * back from disk. An Edit fragment is not a program; it stays regex-only at
 * call time, and the result check judges the file it produced.
 *
 * Deliberately not a scope analysis: a name bound to `console` (or to a string)
 * anywhere in the file counts everywhere. That over-reports a shadowed name in
 * a nested scope, which only ever errs towards blocking, and costs nothing for
 * code that is not playing games.
 */
import { parse } from '@babel/parser';

export const AST_CHECKS = ['console-log', 'eval', 'empty-catch'];

const JS_FILE = /\.(m|c)?(j|t)sx?$/i;
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'comments', 'tokens',
  'leadingComments', 'trailingComments', 'innerComments', 'errors']);
const MAX_PASSES = 64;
const LOG = 'log';
const EVAL = 'eval';

/** Parser plugins for a file name, or null when it is not JS/TS. */
function pluginsFor(filePath) {
  const m = JS_FILE.exec(filePath || '');
  if (!m) return null;
  const ts = m[2].toLowerCase() === 't';
  const jsx = filePath.toLowerCase().endsWith('x') || !ts;
  return [...(ts ? ['typescript'] : []), ...(jsx ? ['jsx'] : []), 'decorators-legacy'];
}

/** The program AST, or null when the file is not JS/TS or does not parse at all. */
export function parseFile(text, filePath) {
  const plugins = pluginsFor(filePath);
  if (!plugins) return null;
  try {
    return parse(text, {
      sourceType: 'unambiguous',
      // A recoverable syntax error elsewhere still gets the calls counted. An
      // unrecoverable one yields no tree (below) — and no running code; the
      // call that repairs the file is then judged 0 → n, so breaking a file
      // is no way past the check.
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowUndeclaredExports: true,
      plugins,
    });
  } catch {
    // Not even recoverable: the regex still applies; nothing for the AST to add.
    return null;
  }
}

/** Depth-first walk: visit(node, parent, key). */
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, visit, node, k);
    else if (v && typeof v.type === 'string') walk(v, visit, node, k);
  }
}

/** Strip wrappers that do not change the value: (x), x!, x as T, (a, x). */
function unwrap(node) {
  let n = node;
  for (;;) {
    if (!n) return n;
    if (n.type === 'ParenthesizedExpression' || n.type === 'TSNonNullExpression'
      || n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSTypeAssertion') n = n.expression;
    else if (n.type === 'SequenceExpression') n = n.expressions[n.expressions.length - 1];
    else return n;
  }
}

/**
 * Names bound to a value of interest, to a fixed point: `const c = console`,
 * `let d; d = c`, `const k = 'lo' + 'g'`.
 */
class Bindings {
  constructor(ast) {
    this.strings = new Map();
    this.consoles = new Set(['console']);
    const pairs = [];
    walk(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) pairs.push([n.id.name, n.init]);
      if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier') pairs.push([n.left.name, n.right]);
    });
    // Monotone, so it terminates: `consoles` only grows, and a string binding
    // only moves unknown → value → AMBIGUOUS (a name assigned two different
    // strings, `let x = 'a'; x = 'b'`), never back. Flipping between values
    // instead would loop forever. MAX_PASSES is a backstop, not the stop rule.
    this.ambiguous = new Set();
    for (let changed = true, pass = 0; changed && pass < MAX_PASSES; pass++) {
      changed = false;
      for (const [name, value] of pairs) {
        if (!this.consoles.has(name) && this.isConsole(value)) { this.consoles.add(name); changed = true; }
        if (this.ambiguous.has(name)) continue;
        const s = this.string(value);
        if (s === null) continue;
        if (!this.strings.has(name)) { this.strings.set(name, s); changed = true; }
        else if (this.strings.get(name) !== s) { this.strings.delete(name); this.ambiguous.add(name); changed = true; }
      }
    }
  }

  /** The constant string an expression evaluates to, or null. */
  string(node) {
    const n = unwrap(node);
    if (!n) return null;
    if (n.type === 'StringLiteral') return n.value;
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked ?? '').join('');
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      const a = this.string(n.left);
      const b = a === null ? null : this.string(n.right);
      return b === null ? null : a + b;
    }
    if (n.type === 'Identifier' && this.strings.has(n.name)) return this.strings.get(n.name);
    return null;
  }

  /** The property name a member access reads: `.x`, `["x"]`, `[k]`. */
  property(member) {
    if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
    return this.string(member.property);
  }

  isMember(n) {
    return n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression';
  }

  /** `globalThis.x`, `window["x"]`: the global named x, else null. */
  globalProperty(node) {
    const n = unwrap(node);
    if (!n || !this.isMember(n)) return null;
    const obj = unwrap(n.object);
    return obj?.type === 'Identifier' && GLOBAL_OBJECTS.has(obj.name) ? this.property(n) : null;
  }

  isConsole(node) {
    const n = unwrap(node);
    if (!n) return false;
    if (n.type === 'Identifier') return this.consoles.has(n.name);
    return this.globalProperty(n) === 'console';
  }
}

function countConsoleLog(ast, b) {
  let count = 0;
  walk(ast, (n) => {
    // Any read of the log method: direct, computed, through an alias or a global.
    if (b.isMember(n) && b.isConsole(n.object) && b.property(n) === LOG) count++;
    // Destructured out of console: const { log } = console, or a computed key.
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.init && b.isConsole(n.init)) {
      for (const p of n.id.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const key = p.computed ? b.string(p.key) : (p.key.name ?? p.key.value);
        if (key === LOG) count++;
      }
    }
    // Reflect.get(console, 'log')
    if (n.type === 'CallExpression' && b.isMember(n.callee) && unwrap(n.callee.object)?.name === 'Reflect'
      && b.property(n.callee) === 'get' && n.arguments.length >= 2
      && b.isConsole(n.arguments[0]) && b.string(n.arguments[1]) === LOG) count++;
  });
  return count;
}

/** Is this Identifier a reference to a value (not a property name, key, label or declaration)? */
function isReference(parent, key) {
  if (!parent) return true;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty'
    || parent.type === 'ClassMethod' || parent.type === 'TSPropertySignature') && key === 'key' && !parent.computed) return false;
  if ((parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && key === 'id') return false;
  if (parent.type.startsWith('Import') || parent.type.startsWith('Export')) return false;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
  return true;
}

function countEval(ast, b) {
  let count = 0;
  walk(ast, (n, parent, key) => {
    // Every reference to the global: called, called indirectly via a comma
    // expression, or copied into another name.
    if (n.type === 'Identifier' && n.name === EVAL && isReference(parent, key)) count++;
    // Read off a global object: globalThis.<it>, window["<it>"].
    if (b.isMember(n) && b.globalProperty(n) === EVAL) count++;
    // The Function constructor, called or with new: the same thing by another name.
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const callee = unwrap(n.callee);
      if ((callee?.type === 'Identifier' && callee.name === 'Function') || b.globalProperty(callee) === 'Function') count++;
    }
  });
  return count;
}

function countEmptyCatch(ast) {
  let count = 0;
  walk(ast, (n) => {
    // Same line as eslint's no-empty: a comment inside says "on purpose".
    if (n.type === 'CatchClause' && n.body.body.length === 0 && !(n.body.innerComments?.length)) count++;
  });
  return count;
}

const COUNTERS = {
  'console-log': countConsoleLog,
  eval: countEval,
  'empty-catch': (ast) => countEmptyCatch(ast),
};

/**
 * Count each named check in one file. Returns { check: count } — empty when the
 * file is not JS/TS or does not parse. An unknown check name throws: a rule
 * that names a check that does not exist is a broken guard, not a pass.
 */
export function countAst(text, filePath, checks) {
  for (const c of checks) if (!COUNTERS[c]) throw new Error(`unknown ast check '${c}' (known: ${AST_CHECKS.join(', ')})`);
  const ast = parseFile(text, filePath);
  if (!ast) return {};
  const b = new Bindings(ast);
  const out = {};
  for (const c of checks) out[c] = COUNTERS[c](ast, b);
  return out;
}
