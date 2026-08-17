/**
 * Grok / SuperGrok adapter — lists auth-slots; reauth via grok-oauth-reauth (EFG SOCKS default).
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const providerId = 'grok';
export const displayName = 'SuperGrok / xAI';

function slotsDir(ctx) {
  return process.env.GROK_AUTH_SLOTS_DIR || join(ctx.home, '.grok/auth-slots');
}

export async function listAccounts(ctx) {
  const dir = slotsDir(ctx);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      // slot file: map of key -> { email, refresh_token, ... }
      for (const [, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const email = String(v.email || '').toLowerCase();
        if (!email) continue;
        const hasRt = Boolean(v.refresh_token);
        const exp = v.expires_at || v.expiresAt;
        let tokenState = hasRt ? 'valid' : 'missing';
        if (exp && Number(exp) * (String(exp).length < 12 ? 1000 : 1) < Date.now()) {
          tokenState = 'expired';
        }
        rows.push({
          provider: providerId,
          accountId: email,
          email,
          label: f.replace(/\.json$/, ''),
          tokenState,
          active: false,
          utilization: null,
          proxy: { path: 'http://127.0.0.1:31845/v1', note: 'SuperGrok local proxy' },
          lastError: null,
          reauth: {
            engine: 'grok-oauth-reauth',
            residential: 'EFG SOCKS default socks5://127.0.0.1:1089 (GROK_REAUTH_SOCKS)',
          },
        });
      }
    } catch {
      /* skip bad slot */
    }
  }
  return rows;
}

export async function reauth(ctx, { accountId }) {
  const email = accountId;
  if (!email) return { ok: false, reason: 'email-required' };
  const bin = spawnSync('bash', ['-lc', 'command -v grok-oauth-reauth'], { encoding: 'utf8' });
  const path = (bin.stdout || '').trim();
  if (!path) return { ok: false, reason: 'grok-oauth-reauth-not-on-path' };
  if (ctx.dryRun) return { ok: true, reason: 'dry-run' };
  // Residential cascade is inside grok-oauth-reauth (EFG SOCKS unless GROK_REAUTH_DIRECT=1)
  const r = spawnSync(path, ['--email', email], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':1',
      GROK_REAUTH_SOCKS: process.env.GROK_REAUTH_SOCKS || 'socks5://127.0.0.1:1089',
    },
    timeout: 600000,
  });
  return {
    ok: r.status === 0,
    reason: r.status === 0 ? null : (r.stderr || r.stdout || 'reauth-failed').slice(-500),
  };
}

export async function switchTo() {
  const r = spawnSync('bash', ['-lc', 'command -v grok-rotate && grok-rotate switch'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { ok: r.status === 0, reason: r.status === 0 ? null : 'grok-rotate-switch-failed' };
}

export async function refresh() {
  const r = spawnSync(
    'bash',
    ['-lc', 'command -v host-token-keepalive >/dev/null && host-token-keepalive --force --grok-only || true'],
    { encoding: 'utf8', timeout: 120000 },
  );
  return { ok: true, reason: r.status === 0 ? null : 'keepalive-soft-fail' };
}

export async function utilization() {
  return {
    windows: [],
    source: 'unavailable',
    note: 'SuperGrok seat remaining not exposed as public remaining API; use slot tokenState',
  };
}
