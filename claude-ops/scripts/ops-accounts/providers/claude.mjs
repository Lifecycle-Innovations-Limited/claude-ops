/**
 * Claude adapter — wraps account-rotation config + optional rotate --status.
 * No secrets in AccountRow.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const providerId = 'claude';
export const displayName = 'Claude Max';

function rotationDir(ctx) {
  return join(ctx.pluginRoot, 'scripts', 'account-rotation');
}

function loadConfig(ctx) {
  const candidates = [
    join(ctx.home, '.claude/scripts/account-rotation/config.json'),
    join(rotationDir(ctx), 'config.json'),
    join(rotationDir(ctx), 'config.example.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      /* next */
    }
  }
  return null;
}

function tokenStateFor(email, vaultPath) {
  if (!existsSync(vaultPath)) return 'missing';
  try {
    const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
    const key = `Claude-Rotation-${email}`;
    const entry = vault[key]?.claudeAiOauth || vault[key];
    if (!entry?.accessToken && !entry?.refreshToken) return 'missing';
    const exp = entry.expiresAt || entry.expiry || entry.expires;
    if (exp && Number(exp) * (String(exp).length < 12 ? 1000 : 1) < Date.now()) {
      return 'expired';
    }
    return 'valid';
  } catch {
    return 'missing';
  }
}

export async function listAccounts(ctx) {
  const cfg = loadConfig(ctx);
  const vault = join(ctx.home, '.claude/.credentials.json');
  const rows = [];
  const accounts = cfg?.accounts || [];

  for (const a of Array.isArray(accounts) ? accounts : []) {
    const email = (a.email || a.id || '').toLowerCase();
    if (!email) continue;
    rows.push({
      provider: providerId,
      accountId: email,
      email,
      label: a.label || null,
      tokenState: tokenStateFor(a.label || email, vault),
      active: false,
      utilization: null,
      lastError: null,
    });
  }
  return rows;
}

export async function reauth(ctx, { accountId }) {
  const email = accountId;
  if (!email) return { ok: false, reason: 'email-required' };
  return {
    ok: false,
    reason: 'direct-claude-reauth-disabled-use-staged-enrollment',
  };
}

export async function switchTo(ctx, { accountId }) {
  return {
    ok: false,
    reason: `use rotate.mjs --rotate or /ops:rotate rotate-now --to ${accountId || '<email>'}`,
  };
}

export async function refresh(ctx) {
  const rot = join(rotationDir(ctx), 'rotate.mjs');
  if (!existsSync(rot)) return { ok: false, reason: 'rotate-missing' };
  // status only — no thrash
  const r = spawnSync(process.execPath, [rot, '--status'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { ok: r.status === 0, reason: r.status === 0 ? null : 'status-failed' };
}

export async function utilization() {
  return { windows: [], source: 'unavailable', note: 'use `ops-accounts util claude` or /ops:ops-fleet' };
}
