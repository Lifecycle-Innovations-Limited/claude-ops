/**
 * 401 self-healing for Claude OAuth vault tokens.
 *
 * Linux: refresh + preserve vault; wait for Mac push (no browser OAuth).
 * macOS: refresh → magic-link subprocess → optional delete if CLAUDE_ROTATION_DESTRUCTIVE_401=1
 */

import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchWithProxyFallback } from './proxy-helper.mjs';
import { acquireRefreshLock } from './crs-refresh-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow — public OAuth client ID
const IS_LINUX = process.platform === 'linux';

function defaultAccountKey(a) {
  return a.label || a.email;
}

function parseRefreshToken(tokenJson) {
  try {
    return JSON.parse(tokenJson)?.claudeAiOauth?.refreshToken || null;
  } catch {
    return null;
  }
}

async function refreshOAuthToken(refreshToken) {
  try {
    const res = await fetchWithProxyFallback(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (res.ok && body.access_token) {
      return {
        ok: true,
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshToken,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000,
        subscriptionType: body.subscription_type,
        rateLimitTier: body.rate_limit_tier,
      };
    }
    const errMsg = body?.error?.message || body?.error?.type || `HTTP ${res.status}`;
    return { ok: false, error: errMsg, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function refreshStoredAccountToken(account, deps) {
  const key = deps.accountKey(account);
  const releaseRefreshLock = acquireRefreshLock(key);
  if (!releaseRefreshLock) {
    deps.log(`[auth-repair] ${key}: refresh lock held — another refresh path owns this account right now`);
    return { ok: false, reason: 'refresh_lock_held' };
  }
  try {
    const tokenJson = deps.readStoredToken(account);
    if (!tokenJson) return { ok: false, reason: 'no_token' };

    const refreshToken = parseRefreshToken(tokenJson);
    if (!refreshToken) return { ok: false, reason: 'no_refresh_token' };

    const result = await refreshOAuthToken(refreshToken);
    if (!result.ok) {
      deps.log(`[auth-repair] ${key}: refresh failed — ${result.error}`);
      return { ok: false, reason: 'refresh_failed', error: result.error, status: result.status };
    }

    let parsed;
    try {
      parsed = JSON.parse(tokenJson);
    } catch {
      return { ok: false, reason: 'parse_failed' };
    }

    parsed.claudeAiOauth = parsed.claudeAiOauth || {};
    parsed.claudeAiOauth.accessToken = result.accessToken;
    parsed.claudeAiOauth.refreshToken = result.refreshToken;
    parsed.claudeAiOauth.expiresAt = result.expiresAt;
    if (result.subscriptionType) parsed.claudeAiOauth.subscriptionType = result.subscriptionType;
    if (result.rateLimitTier) parsed.claudeAiOauth.rateLimitTier = result.rateLimitTier;

    deps.writeStoredToken(account, JSON.stringify(parsed));
    deps.syncStoredTokenToCrs?.(account);

    const hoursLeft = ((result.expiresAt - Date.now()) / 3_600_000).toFixed(1);
    deps.log(`[auth-repair] ${key}: refreshed (${hoursLeft}h remaining)`);
    return { ok: true };
  } finally {
    releaseRefreshLock();
  }
}

function tryMagicLinkRepair(account, deps) {
  const key = deps.accountKey(account);
  const rotateScript = join(deps.rotateScriptDir || __dirname, 'rotate.mjs');
  deps.log(`[auth-repair] ${key}: attempting magic-link re-auth via rotate.mjs...`);
  try {
    const out = execFileSync(
      process.execPath,
      [rotateScript, '--to', key, '--magic-link', '--force', '--allow-exhausted'],
      {
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    const tail = out.split('\n').slice(-4).join(' | ');
    if (tail) deps.log(`[auth-repair] ${key}: magic-link output: ${tail}`);
  } catch (err) {
    deps.log(`[auth-repair] ${key}: magic-link failed — ${String(err.message || err).slice(0, 200)}`);
    return { ok: false };
  }

  const tokenJson = deps.readStoredToken(account);
  if (!tokenJson) return { ok: false };
  try {
    const accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
    return { ok: Boolean(accessToken) };
  } catch {
    return { ok: false };
  }
}

/**
 * Attempt to repair a vault token after a 401 on usage/profile probes.
 * @returns {{ repaired: boolean, authFailed: boolean, deleted: boolean, preserved: boolean }}
 */
export async function repairAccountOn401(account, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  const accountKey = deps.accountKey || defaultAccountKey;
  const readStoredToken = deps.readStoredToken;
  const writeStoredToken = deps.writeStoredToken;
  const deleteStoredToken = deps.deleteStoredToken;

  if (!readStoredToken || !writeStoredToken) {
    throw new Error('repairAccountOn401 requires readStoredToken and writeStoredToken');
  }

  const d = {
    log,
    accountKey,
    readStoredToken,
    writeStoredToken,
    deleteStoredToken,
    syncStoredTokenToCrs: deps.syncStoredTokenToCrs,
    rotateScriptDir: deps.rotateScriptDir || __dirname,
  };

  const key = accountKey(account);
  log(`[auth-repair] ${key}: usage returned 401 — attempting repair`);

  const refreshed = await refreshStoredAccountToken(account, d);
  if (refreshed.ok) {
    return { repaired: true, authFailed: false, deleted: false, preserved: false };
  }

  if (account.autoAuthDisabled !== true) {
    const magic = tryMagicLinkRepair(account, d);
    if (magic.ok) {
      d.syncStoredTokenToCrs?.(account);
      return { repaired: true, authFailed: false, deleted: false, preserved: false };
    }
  } else {
    log(`[auth-repair] ${key}: autoAuthDisabled — skipping magic-link`);
  }

  if (IS_LINUX) {
    log(`[auth-repair] ${key}: automatic magic-link repair failed on Linux — vault entry preserved`);
    return { repaired: false, authFailed: true, deleted: false, preserved: true };
  }

  if (process.env.CLAUDE_ROTATION_DESTRUCTIVE_401 === '1' && deleteStoredToken) {
    log(`[auth-repair] ${key}: repair exhausted — deleting vault entry (CLAUDE_ROTATION_DESTRUCTIVE_401=1)`);
    deleteStoredToken(account);
    return { repaired: false, authFailed: true, deleted: true, preserved: false };
  }

  log(`[auth-repair] ${key}: repair failed — vault entry preserved`);
  return { repaired: false, authFailed: true, deleted: false, preserved: true };
}

/**
 * Fetch OAuth usage; on 401 optionally repair once and retry.
 */
export async function probeUsageWithRepair(account, deps = {}) {
  const readStoredToken = deps.readStoredToken;
  if (!readStoredToken) throw new Error('probeUsageWithRepair requires readStoredToken');

  async function probeOnce() {
    const tokenJson = readStoredToken(account);
    if (!tokenJson) return { ok: false, reason: 'no_token' };
    const accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
    if (!accessToken) return { ok: false, reason: 'no_access_token' };

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(deps.timeoutMs || 10_000),
    });

    if (res.status === 401) return { ok: false, status: 401, authFailed: true };
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data, status: res.status };
  }

  let result = await probeOnce();
  if (result.ok || result.status !== 401) return result;

  const allowRepair = deps.allowRepair !== false;
  if (!allowRepair) return result;

  const repair = await repairAccountOn401(account, deps);
  if (!repair.repaired) return { ...result, repair };

  result = await probeOnce();
  return { ...result, repair };
}
