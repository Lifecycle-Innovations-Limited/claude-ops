/**
 * OpenAI / Codex adapter — status from ~/.codex + optional codex-rotate.
 * Reauth not automated in phase 0 (honest unavailable).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const providerId = 'openai';
export const displayName = 'OpenAI / Codex';

export async function listAccounts(ctx) {
  const rows = [];
  const auth = join(ctx.home, '.codex/auth.json');
  const config = join(ctx.home, '.codex/config.toml');
  let tokenState = 'missing';
  let email = null;
  if (existsSync(auth)) {
    try {
      const a = JSON.parse(readFileSync(auth, 'utf8'));
      // never dump tokens — only presence
      const has =
        Boolean(a.OPENAI_API_KEY) ||
        Boolean(a.tokens?.access_token) ||
        Boolean(a.access_token) ||
        Boolean(a.refresh_token);
      tokenState = has ? 'valid' : 'missing';
      email = a.account?.email || a.email || null;
    } catch {
      tokenState = 'missing';
    }
  }
  rows.push({
    provider: providerId,
    accountId: email || 'codex-default',
    email,
    label: 'codex',
    tokenState,
    active: true,
    utilization: null,
    lastError: null,
    configPresent: existsSync(config),
    reauth: { status: 'unavailable', note: 'use ChatGPT OAuth / codex login; no plugin cascade yet' },
  });
  return rows;
}

export async function reauth() {
  return {
    ok: false,
    reason: 'openai-reauth-not-automated-phase0',
    handoff: 'Run `codex login` or host codex-rotate if installed',
  };
}

export async function refresh() {
  const r = spawnSync('bash', ['-lc', 'command -v codex-rotate >/dev/null && codex-rotate status || true'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { ok: true, reason: 'status-only' };
}

export async function utilization() {
  return {
    windows: [],
    source: 'unavailable',
    note: 'ChatGPT Codex remaining via app usage dashboard or CLI /status (session auth)',
  };
}
