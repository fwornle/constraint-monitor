/**
 * Overrides inside the agent box: signed grants from the host guard daemon.
 *
 * On the host, an override is `OVERRIDE_CONSTRAINT: <id>` in a prompt the
 * human typed (session-transcript.js). Inside the box that is worthless: the
 * transcript is writable by the agent, and a "typed" prompt can be injected
 * with `tmux send-keys`. So in box mode the transcript grants nothing, and a
 * blocked rule passes only when the host guard (coding/scripts/
 * coding-guard-daemon.mjs) holds a grant the user approved with one of their
 * factors, signed with a key the box never sees. This module verifies those
 * grants with the PUBLIC key and, when there is none, files the request the
 * user approves in their host browser.
 *
 * Every input that decides "allowed" comes from where the agent cannot write:
 *   CODING_GUARD_MODE / CODING_GUARD_KEYS  set INLINE in the root-owned
 *       managed hook command (an inherited env var would be the agent's: it
 *       can start a nested `claude` with any environment it likes)
 *   <keys>/guard-public.pem, <keys>/guard.json  the host guard's public dir,
 *       mounted read-only (the URL is read from here, not from the env, so a
 *       fake daemon cannot replay old grants)
 *   os.hostname()  the box session (`docker run --hostname`; a non-root
 *       process cannot change it)
 *
 * Plan: coding/.planning/guardrail-hardening.md (Phase 1, item 4).
 */

import { readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

/** Where grants.mjs sits: the coding repo on the host, /opt/coding-guard in the box. */
const GRANTS_LIB = new URL('../../../../lib/guard/grants.mjs', import.meta.url);
const HTTP_TIMEOUT_MS = 5000;

/** Box-mode settings, or null when the hook runs on the host. */
export function boxGuardConfig(env = process.env) {
  if (env.CODING_GUARD_MODE !== 'box') return null;
  return { keysDir: env.CODING_GUARD_KEYS || '/etc/coding-guard' };
}

/** The text an approver should see: what the call would actually do. */
export function callExcerpt(toolName, params = {}) {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    const parts = [params.content ?? params.new_string ?? ''];
    if (Array.isArray(params.edits)) parts.push(...params.edits.map((e) => e?.new_string ?? ''));
    return parts.filter(Boolean).join('\n…\n');
  }
  if (toolName === 'NotebookEdit') return params.new_source ?? '';
  if (toolName === 'Bash') return params.command ?? '';
  return JSON.stringify(params, null, 2);
}

/** The file a grant is bound to; null (= any file) for tools without one. */
export function callFile(params = {}) {
  return params.file_path || params.notebook_path || null;
}

class GuardUnavailable extends Error {}

/**
 * The host guard as seen from the box. Throws GuardUnavailable when the keys
 * or the endpoint are missing — no key, no override.
 */
export async function openGuard({ keysDir, session = hostname(), fetchImpl = fetch, now = Date.now } = {}) {
  let publicPem;
  let url;
  try {
    publicPem = readFileSync(join(keysDir, 'guard-public.pem'), 'utf8');
    url = JSON.parse(readFileSync(join(keysDir, 'guard.json'), 'utf8')).url;
  } catch (err) {
    throw new GuardUnavailable(`host guard keys not mounted at ${keysDir} (${err.code || err.message})`);
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new GuardUnavailable(`no guard URL in ${keysDir}/guard.json`);
  const { verifyGrant, grantCovers } = await import(GRANTS_LIB);

  async function http(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${url}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GuardUnavailable(`host guard unreachable at ${url} (${err.cause?.code || err.message})`);
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  return {
    url,
    session,
    /**
     * Settle the blocking rules of one call. Rules covered by a verified
     * grant pass; a one-call grant is spent first (the daemon is the one
     * that knows whether it already was). Non-call grants are preferred so
     * a 15-minute approval does not burn a pending one-call grant.
     * Returns { uncovered: [rule], used: [grant id] }.
     */
    async settle(rules, file) {
      const t = now();
      const { status, data } = await http('GET', `/grants?session=${encodeURIComponent(session)}`);
      if (status !== 200) throw new GuardUnavailable(`host guard answered ${status} for grants (${data.error ?? 'no detail'})`);
      const valid = (Array.isArray(data.grants) ? data.grants : []).filter((g) => verifyGrant(g, publicPem));
      const rank = (g) => (g.payload.scope === 'call' ? 1 : 0);
      const uncovered = [];
      const used = [];
      for (const rule of rules) {
        const g = valid.filter((x) => grantCovers(x, { rule, session, file, now: t })).sort((a, b) => rank(a) - rank(b))[0];
        if (!g) {
          uncovered.push(rule);
          continue;
        }
        if (g.payload.scope === 'call') {
          const spent = await http('POST', `/grants/${encodeURIComponent(g.payload.id)}/consume`, { session });
          if (spent.status !== 200 || spent.data?.grant?.payload?.id !== g.payload.id) {
            uncovered.push(rule);
            continue;
          }
        }
        used.push(g.payload.id);
      }
      return { uncovered, used };
    },
    /** Ask the user. Returns the pending request (the daemon reuses an open one). */
    async request({ rule, agent = 'claude', tool, file, excerpt, reason }) {
      const { status, data } = await http('POST', '/requests', { rule, session, agent, tool, file, excerpt, reason });
      if (status === 201 || status === 200) return data.request;
      throw new GuardUnavailable(`host guard refused the override request (${status}: ${data.error ?? 'no detail'})`);
    },
  };
}

/**
 * The hook's whole box-mode decision for one blocked call:
 * { allow: true } or { allow: false, message } — the message is shown to the
 * agent, which must relay the approval link to the user.
 */
export async function settleWithGrants({ rules, toolName, params, config, agent = 'claude', guardOptions = {} }) {
  const file = callFile(params);
  let guard;
  try {
    guard = await openGuard({ keysDir: config.keysDir, ...guardOptions });
    const { uncovered } = await guard.settle(rules, file);
    if (uncovered.length === 0) return { allow: true };
    const requests = [];
    for (const rule of uncovered) {
      requests.push(await guard.request({
        rule, agent, tool: toolName, file, excerpt: callExcerpt(toolName, params), reason: params.description ?? null,
      }));
    }
    return {
      allow: false,
      message: [
        '🔐 Only the user can override this, on the host. Override requested:',
        ...requests.map((r) => `   ${r.rule}: ${r.approve}`),
        'Tell the user which rule blocked you, why you need the exception, and give them the link.',
        'They approve it in their browser (Touch ID, phone, security key or password).',
        'Then repeat the same call. Or change the call so it complies — usually the better fix.',
      ].join('\n'),
    };
  } catch (err) {
    if (!(err instanceof GuardUnavailable)) throw err;
    return {
      allow: false,
      message: `🔐 No override is possible right now: ${err.message}.\n` +
        'Comply with the rule, or ask the user to check the host guard (coding guard status).',
    };
  }
}
