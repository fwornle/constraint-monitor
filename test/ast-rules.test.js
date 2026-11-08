/**
 * AST checks behind the regex rules (src/engines/ast-rules.js): what the code
 * DOES, whatever it is spelled like. Each "caught" case below is one the
 * regex rule misses; each "not counted" case is one a regex would wrongly hit
 * or that is legitimately different code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { countAst } from '../src/engines/ast-rules.js';

const count = (check, code, file = 'src/a.js') => countAst(code, file, [check])[check];

describe('console-log', () => {
  const caught = {
    'direct call': 'console.log("x")',
    'computed string': 'console["log"]("x")',
    'template key': 'console[`log`]("x")',
    'concatenated key': 'console["lo" + "g"]("x")',
    'key held in a const': 'const k = "lo" + "g"; console[k]("x")',
    alias: 'const c = console; c.log("x")',
    'alias of an alias, assigned later': 'let d; const c = console; d = c; d.log("x")',
    'method copied out': 'const l = console.log; l("x")',
    destructured: 'const { log } = console; log("x")',
    'destructured and renamed': 'const { log: say } = console; say("x")',
    'destructured with a computed key': 'const { ["lo" + "g"]: say } = console; say("x")',
    'through globalThis': 'globalThis.console.log("x")',
    'through window, computed': 'window["console"]["log"]("x")',
    'optional chaining': 'console?.log?.("x")',
    'parenthesised and comma': '(0, console).log("x")',
    'Reflect.get': 'Reflect.get(console, "log")("x")',
    'bound or called': 'console.log.call(null, "x"); console.log.bind(console)',
  };
  for (const [name, code] of Object.entries(caught)) {
    test(`caught: ${name}`, () => assert.ok(count('console-log', code) >= 1, code));
  }

  test('not counted: other methods, other objects, strings and comments', () => {
    assert.strictEqual(count('console-log', [
      'console.error("x"); console.warn("y"); console.info("z");',
      'logger.log("x"); this.console.log("x"); obj.console.log("x");',
      'const s = "console.log(x)"; // console.log(x)',
      '/* console["log"]("x") */',
    ].join('\n')), 0);
  });

  test('every read counts, so a second call is visible as an addition', () => {
    assert.strictEqual(count('console-log', 'console.log(1); console["log"](2); const c = console; c.log(3);'), 3);
  });

  test('TypeScript and TSX parse', () => {
    assert.strictEqual(count('console-log', 'const c = console as Console; c!.log<string>("x" as string);', 'src/a.ts'), 1);
    assert.strictEqual(count('console-log', 'export const A = () => <div onClick={() => console["log"]("x")} />;', 'src/a.tsx'), 1);
    assert.strictEqual(count('console-log', 'export const A = () => <div onClick={() => console.log("x")} />;', 'src/a.jsx'), 1);
  });

  test('a recoverable syntax error elsewhere does not hide the call', () => {
    assert.strictEqual(count('console-log', 'console["log"]("x");\nlet a; let a;\nreturn 1;\n'), 1);
  });

  test('an unparseable file counts nothing — the call that makes it parse is the one caught', () => {
    // A file that does not parse does not run. Judging is before/after, so
    // the edit that repairs it shows the call as ADDED (0 → 1).
    const broken = 'console["log"]("x");\nconst = ;\n';
    assert.deepStrictEqual(countAst(broken, 'src/a.js', ['console-log']), {});
    assert.strictEqual(count('console-log', broken.replace('const = ;', 'const z = 1;')), 1);
  });
});

describe('eval', () => {
  const caught = {
    direct: 'eval("1")',
    'indirect via comma': '(0, eval)("1")',
    'copied into a name': 'const e = eval; e("1")',
    'off globalThis': 'globalThis.eval("1")',
    'off window, computed': 'window["ev" + "al"]("1")',
    'Function constructor': 'new Function("return 1")()',
    'Function called': 'Function("return 1")()',
    'Function off globalThis': 'new globalThis.Function("return 1")',
  };
  for (const [name, code] of Object.entries(caught)) {
    test(`caught: ${name}`, () => assert.ok(count('eval', code) >= 1, code));
  }
  test('not counted: a property or method named eval, strings, comments', () => {
    assert.strictEqual(count('eval', [
      'model.eval(); const o = { eval: 1 }; class A { eval() {} }',
      'const s = "eval(x)"; // eval(x)',
    ].join('\n')), 0);
  });
});

describe('empty-catch', () => {
  test('caught: with a binding, without one, with a destructured binding', () => {
    assert.strictEqual(count('empty-catch', 'try { a() } catch (e) {}\ntry { a() } catch {}\ntry { a() } catch ({ message }) {}'), 3);
  });
  test('not counted: a comment says it is on purpose; a body that does something', () => {
    assert.strictEqual(count('empty-catch', 'try { a() } catch { /* best effort */ }\ntry { a() } catch (e) { report(e) }'), 0);
  });
});

describe('termination and cost', () => {
  test('a name reassigned between strings terminates (and resolves to nothing)', () => {
    // Regression: the binding fixed point flipped "a" ↔ "b" forever.
    assert.strictEqual(count('console-log', 'let k = "log"; k = "warn"; console[k]("x");'), 0);
    assert.strictEqual(count('console-log', 'let x = "a"; x = "b"; x = "a";'), 0);
  });
  test('a long alias chain resolves', () => {
    const chain = Array.from({ length: 200 }, (_, i) => `const a${i + 1} = a${i};`).join('\n');
    assert.strictEqual(count('console-log', `const a0 = console;\n${chain}\na200.log("x");`), 1);
  });
  test('a large ordinary file is quick', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `export function f${i}(x) { let s = "v${i}"; s = s + x; return s; }`).join('\n');
    const t = Date.now();
    assert.strictEqual(count('console-log', body), 0);
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t}ms`);
  });
});

describe('scope of the checks', () => {
  test('not a JS/TS file: nothing to count (the regex still applies)', () => {
    assert.deepStrictEqual(countAst('console["log"]("x")', 'docs/a.md', ['console-log']), {});
    assert.deepStrictEqual(countAst('console["log"]("x")', 'a.py', ['console-log']), {});
  });
  test('module extensions parse: .mjs, .cjs, .mts, .cts', () => {
    for (const f of ['a.mjs', 'a.cjs', 'a.mts', 'a.cts']) assert.strictEqual(count('console-log', 'console["log"](1)', f), 1, f);
  });
  test('an unknown check name is a broken guard, not a pass', () => {
    assert.throws(() => countAst('x', 'a.js', ['no-such-check']), /unknown ast check/);
  });
});
