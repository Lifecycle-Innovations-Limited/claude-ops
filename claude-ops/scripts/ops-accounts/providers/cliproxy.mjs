/**
 * CLIProxyAPI adapter — reports local multi-provider proxy accounts.
 * Reads the proxy's auth-dir (flat JSON files, one per account) and reports
 * inventory only. No secrets are read into output: file names carry
 * provider+email; token payloads are never printed.
 *
 * Env overrides: CLIPROXYAPI_HOME, CLIPROXYAPI_AUTH_DIR.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export const providerId = 'cliproxy';
export const displayName = 'CLIProxyAPI (local multi-provider proxy)';

function authDir(ctx) {
  if (process.env.CLIPROXYAPI_AUTH_DIR) return process.env.CLIPROXYAPI_AUTH_DIR;
  const configHome = process.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
  const home = process.env.CLIPROXYAPI_HOME || join(configHome, 'cliproxyapi');
  return join(home, 'auths');
}

function parseFileName(name) {
  // <provider>-<label>.json ; provider prefixes: claude, codex, xai, antigravity, gemini
  const m = name.match(/^([a-z0-9]+)-(.+)\.json$/i);
  if (!m) return null;
  return { backend: m[1], label: m[2] };
}

export async function listAccounts(ctx) {
  const dir = authDir(ctx);
  if (!existsSync(dir)) {
    return [
      {
        provider: providerId,
        accountId: 'cliproxy-not-installed',
        email: null,
        label: 'auth-dir missing',
        tokenState: 'missing',
        active: false,
        utilization: null,
        lastError: null,
        note: 'CLIProxyAPI not installed (optional backend; set CLIPROXYAPI_HOME)',
        reauth: { status: 'unavailable' },
      },
    ];
  }
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = parseFileName(f);
    if (!p) continue;
    const st = statSync(join(dir, f));
    const email = p.label.includes('@') ? p.label.split('-')[0] : null;
    out.push({
      provider: providerId,
      accountId: `${p.backend}:${p.label}`,
      email,
      label: p.backend,
      tokenState: 'valid', // presence-only check; proxy dropouts surface as request failures
      active: true,
      utilization: null,
      lastError: null,
      note: `last write ${st.mtime.toISOString()}`,
      reauth: { status: 'manual', note: `cliproxy login flow for ${p.backend}` },
    });
  }
  return out;
}

export async function utilization(ctx) {
  const dir = authDir(ctx);
  if (!existsSync(dir)) return null;
  const counts = {};
  for (const f of readdirSync(dir)) {
    const p = parseFileName(f);
    if (!p) continue;
    counts[p.backend] = (counts[p.backend] || 0) + 1;
  }
  return { accounts_by_backend: counts, note: 'pool-level util comes from the proxy management API (out of scope)' };
}

export async function reauth(_ctx, accountId) {
  const backend = (accountId || '').split(':')[0] || 'claude';
  return {
    ok: false,
    reason: 'manual-browser-flow',
    handoff: `Run the CLIProxyAPI ${backend} login flow (browser) — see SERVICE.md in the proxy dir.`,
  };
}
