#!/usr/bin/env node

/**
 * Constraint Monitor CLI
 *
 * The agent-facing entry point to constraint checking. Replaces the former
 * `constraint-monitor` MCP server, whose four tools cost ~1.5 KB of JSON schema
 * in every context window whether or not they were ever called.
 *
 * Runs in-process on the host — deliberately NOT through the SSE server on
 * :3849 — so it uses the exact same code path as the PreToolUse/UserPromptSubmit
 * hooks and keeps working when the coding-services container is down.
 *
 * Output is compact by default and machine-readable under --json.
 */

// Set before the dynamic imports below: utils/logger.js decides at import time
// whether to attach a Console transport, and a CLI must not narrate over its
// own output. --verbose opts back in.
const argv = process.argv.slice(2);
if (!argv.includes('--verbose')) {
  process.env.CONSTRAINT_MONITOR_CLI = '1';
}

const { ConstraintEngine } = await import('./engines/constraint-engine.js');
const { StatusGenerator } = await import('./status/status-generator.js');
const { ConfigManager } = await import('./utils/config-manager.js');
const { readFileSync } = await import('node:fs');

const USAGE = `constraints — check code and actions against this project's constraint rules

Usage:
  constraints check [--file <path>] [--content <text>] [--type code|action|file]
  constraints status [--session <id>]
  constraints violations [--limit <n>] [--session <id>]
  constraints update <rules.json|->
  constraints list [--enabled-only]

Common flags:
  --json      emit the raw payload instead of the compact summary
  --verbose   let the engine log to stderr (off by default)
  -h, --help  this text

Notes:
  * 'check' takes content from --content, else stdin, else --file. stdin outranks
    --file so piped content can still carry a path label for path-scoped rules.
  * 'check' exits 1 when it finds an error/critical violation, 0 otherwise,
    so it composes in shell gates:  constraints check --file x.ts || exit 1
  * Rules live in $CODING_REPO/config/constraints/constraint-monitor.yaml.
`;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function emit(payload, asJson, renderCompact) {
  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(renderCompact(payload) + '\n');
  }
}

const SEVERITY_MARK = {
  critical: '🛑',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️'
};

function renderCheck(result) {
  if (!result.violations.length) {
    return `✅ clean — ${result.total_constraints} constraints checked, compliance ${result.compliance}/10`;
  }
  const lines = result.violations.map((v) => {
    const mark = SEVERITY_MARK[v.severity] || '•';
    const where = v.file_path ? ` (${v.file_path})` : '';
    const hits = v.matches ? ` ×${v.matches}` : '';
    return `${mark} ${v.constraint_id}${hits}${where}\n   ${v.message}`;
  });
  if (result.suggestions?.length) {
    lines.push('', 'Suggestions:', ...result.suggestions.map((s) => `  → ${s}`));
  }
  lines.push('', `compliance ${result.compliance}/10 · risk ${result.risk} · ${result.violated_constraints}/${result.total_constraints} violated`);
  return lines.join('\n');
}

function renderStatus(status) {
  const health = status.healthy ? '✅ operational' : '🛑 degraded';
  return [
    `${health} · compliance ${status.compliance}/10 · risk ${status.risk}`,
    `active violations: ${status.violations} · session: ${status.session_id}`,
    `last check: ${status.last_check}`
  ].join('\n');
}

function renderViolations(history) {
  if (!history.violations.length) {
    return `no violations recorded (${history.total} total in store)`;
  }
  const lines = history.violations.map((v) => {
    const mark = SEVERITY_MARK[v.severity] || '•';
    return `${mark} ${v.detected_at || '?'} ${v.constraint_id} — ${v.message}`;
  });
  lines.push('', `showing ${history.violations.length} of ${history.total}; most common: ${history.metrics?.most_common_violation ?? 'n/a'}`);
  return lines.join('\n');
}

function renderUpdate(result) {
  return `updated ${result.updated.length} constraint(s): ${result.updated.join(', ') || '(none)'} · ${result.active} now active`;
}

function renderList(constraints) {
  if (!constraints.length) return 'no constraints defined';
  return constraints
    .map((c) => `${c.enabled === false ? '○' : '●'} ${c.id} [${c.severity || 'warning'}] — ${c.message}`)
    .join('\n');
}

async function main() {
  const { flags, positional } = parseFlags(argv);
  const command = positional[0];

  if (!command || flags.help) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }

  const asJson = flags.json === true;

  const config = new ConfigManager();
  const engine = new ConstraintEngine(config);
  await engine.initialize();

  switch (command) {
    case 'check': {
      const filePath = typeof flags.file === 'string' ? flags.file : undefined;

      // Precedence: --content, then stdin, then --file. stdin outranks --file so
      // that piped content can still carry a path label for the path-scoped rules
      // (`constraints check --file src/x.ts < edited-buffer`), which is how an
      // editor or hook wants to call this.
      let content = typeof flags.content === 'string' ? flags.content : null;
      if (content === null) {
        const piped = await readStdin();
        if (piped) content = piped;
      }
      if (content === null && filePath) {
        try {
          content = readFileSync(filePath, 'utf8');
        } catch (error) {
          process.stderr.write(`constraints: cannot read ${filePath}: ${error.message}\n`);
          process.exit(2);
        }
      }
      if (!content) {
        process.stderr.write('constraints check: no content — pass --content, --file, or pipe on stdin\n');
        process.exit(2);
      }

      const result = await engine.checkConstraints({
        content,
        type: typeof flags.type === 'string' ? flags.type : 'code',
        filePath
      });
      emit(result, asJson, renderCheck);

      const blocking = result.violations.some(
        (v) => v.severity === 'error' || v.severity === 'critical'
      );
      process.exit(blocking ? 1 : 0);
      break;
    }

    case 'status': {
      const statusGenerator = new StatusGenerator(config);
      await statusGenerator.initialize();
      const status = await statusGenerator.generateStatus(
        typeof flags.session === 'string' ? flags.session : undefined
      );
      emit(status, asJson, renderStatus);
      break;
    }

    case 'violations': {
      const history = await engine.getViolationHistory({
        limit: flags.limit ? Number(flags.limit) : 10,
        sessionId: typeof flags.session === 'string' ? flags.session : undefined
      });
      emit(history, asJson, renderViolations);
      break;
    }

    case 'update': {
      const source = positional[1];
      if (!source) {
        process.stderr.write('constraints update: needs a rules JSON file, or - for stdin\n');
        process.exit(2);
      }
      const raw = source === '-' ? await readStdin() : readFileSync(source, 'utf8');
      let rules;
      try {
        rules = JSON.parse(raw);
      } catch (error) {
        process.stderr.write(`constraints update: invalid JSON — ${error.message}\n`);
        process.exit(2);
      }
      if (!Array.isArray(rules)) rules = rules.constraints;
      if (!Array.isArray(rules)) {
        process.stderr.write('constraints update: expected an array of rules, or {"constraints": [...]}\n');
        process.exit(2);
      }
      const result = await engine.updateConstraints(rules);
      emit(result, asJson, renderUpdate);
      break;
    }

    case 'list': {
      let constraints = Array.from(engine.constraints.values());
      if (flags['enabled-only']) constraints = constraints.filter((c) => c.enabled !== false);
      emit(constraints, asJson, renderList);
      break;
    }

    default:
      process.stderr.write(`constraints: unknown command '${command}'\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`constraints: ${error.message}\n`);
  process.exit(2);
});
