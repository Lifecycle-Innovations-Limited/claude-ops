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
  const nameByVault = cfg?.crs?.nameByVaultKey || {};

  if (Array.isArray(accounts) && accounts.length) {
    for (const a of accounts) {
      const email = (a.email || a.id || '').toLowerCase();
      if (!email) continue;
      const label = a.label || nameByVault[email] || null;
      rows.push({
        provider: providerId,
        accountId: email,
        email,
        label,
        tokenState: tokenStateFor(a.label || email, vault),
        active: false,
        utilization: null,
        crs: label ? { name: nameByVault[a.label] || nameByVault[email] || null } : null,
        lastError: null,
      });
    }
  } else {
    // vault-key map only
    for (const [vaultKey, crsName] of Object.entries(nameByVault)) {
      rows.push({
        provider: providerId,
        accountId: vaultKey,
        email: vaultKey.includes('@') ? vaultKey : null,
        label: crsName,
        tokenState: tokenStateFor(vaultKey, vault),
        active: false,
        utilization: null,
        crs: { name: crsName },
        lastError: null,
      });
    }
  }
  return rows;
}

export async function reauth(ctx, { accountId }) {
  const email = accountId;
  if (!email) return { ok: false, reason: 'email-required' };
  const magic = join(rotationDir(ctx), 'rotate-magic.mjs');
  if (!existsSync(magic)) {
    return { ok: false, reason: 'rotate-magic-missing' };
  }
  if (ctx.dryRun) return { ok: true, reason: 'dry-run' };
  const r = spawnSync(process.execPath, [magic, '--to', email, '--force'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ctx.pluginRoot },
    timeout: 120000,
  });
  return {
    ok: r.status === 0,
    reason: r.status === 0 ? null : (r.stderr || r.stdout || '').slice(-400),
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
  return { windows: [], source: 'unavailable', note: 'use crs-live-status / priority daemon' };
}
