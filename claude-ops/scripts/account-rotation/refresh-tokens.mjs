#!/usr/bin/env node
/**
 * Proactive token refresher — uses OAuth refresh_token grant to get fresh
 * access tokens for all vault accounts before they expire.
 *
 * Doctrine: OAuth tokens must never become stale.
 *   - launchd every 15m (com.example.crs-rotation-refresh)
 *   - refresh when remaining TTL < 6h (see oauth-keep-alive-policy.mjs)
 *   - dead refresh_token → mark needsReauth for magic-link-autoloop
 *
 * Usage:
 *   node refresh-tokens.mjs           # Refresh tokens under keep-alive floor
 *   node refresh-tokens.mjs --force   # Refresh ALL tokens regardless of expiry
 *   node refresh-tokens.mjs --status  # Show token expiry times
 *   node refresh-tokens.mjs --dry-run # Show what would be refreshed without doing it
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { fetchWithProxyFallback } from './proxy-helper.mjs';
import { acquireRefreshLock } from './crs-refresh-lock.mjs';
import { foreignActiveKeys } from './account-leases.mjs';
import { propagateFreshTokenToPeer } from './crs-peer-propagate.mjs';
import { readRotationToken, reconcileRemoteRotationVault, writeRotationToken } from './rotation-vault.mjs';
import {
  REFRESH_WHEN_BELOW_MS,
  MIN_HEALTHY_TTL_MS,
  needsProactiveRefresh,
  freshnessLabel,
  remainingMs,
} from './oauth-keep-alive-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, 'state.json');
const LOG_PATH = join(__dirname, 'rotation.log');
const NEEDS_REAUTH_PATH = join(__dirname, '.crs-token-refresher-state.json');
const AUTOLOOP_STATE_PATH = join(__dirname, '.crs-magic-autoloop-state.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT = process.env.USER || 'claude-code';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
/** @deprecated use REFRESH_WHEN_BELOW_MS — kept name for log clarity */
const REFRESH_BUFFER_MS = REFRESH_WHEN_BELOW_MS;
const RETRY_DELAY_MS = 5_000; // Wait between retries
const MAX_RETRIES = 3;
const INTER_ACCOUNT_DELAY_MS = 1_500; // Delay between accounts to avoid rate limits

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] [refresh] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

// ── Keychain helpers ─────────────────────────────────────────────────────────

function accountKey(a) {
  return a.label || a.email;
}

function tokenService(account) {
  return `Claude-Rotation-${accountKey(account)}`;
}

function readKeychain(svc = KEYCHAIN_SERVICE, acct = KEYCHAIN_ACCOUNT) {
  // macOS `security -g` writes the "password:" line to stderr, not stdout —
  // spawnSync (not execFileSync) so both streams are readable regardless of
  // exit code, no shell needed to merge them the way `2>&1` did.
  const r = spawnSync('security', ['find-generic-password', '-s', svc, '-a', acct, '-g'], {
    timeout: 5000,
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/^password: "?(.*?)"?$/m);
  if (!m) throw new Error(`No keychain entry ${svc}/${acct}`);
  return m[1].replace(/\\"/g, '"');
}

function writeKeychain(json, svc = KEYCHAIN_SERVICE, acct = KEYCHAIN_ACCOUNT) {
  try {
    execFileSync('security', ['add-generic-password', '-U', '-s', svc, '-a', acct, '-w', json], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || error)
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/-w\s+\{.*$/s, '-w [REDACTED]')
      .slice(0, 240);
    throw new Error(`Keychain update failed for ${svc}/${acct}: ${detail}`);
  }
}

function readStoredToken(account) {
  try {
    return readRotationToken(accountKey(account));
  } catch {
    return null;
  }
}

function writeStoredToken(account, json) {
  writeRotationToken(accountKey(account), json);
}

function syncStoredTokenToCrs(account) {
  if (process.env.CLAUDE_ROTATION_SKIP_CRS_SYNC === '1') return;
  const key = accountKey(account);
  try {
    const out = execSync(`node "${join(__dirname, 'sync-crs-account.mjs')}" ${JSON.stringify(key)} 2>&1`, {
      timeout: 45_000,
    })
      .toString()
      .trim();
    log(out.split('\n').slice(-1)[0] || `${key}: CRS sync complete`);
  } catch (err) {
    log(`${key}: ⚠ CRS sync failed — ${String(err.message || err).slice(0, 180)}`);
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ── Token helpers ────────────────────────────────────────────────────────────

function parseToken(tokenJson) {
  try {
    return JSON.parse(tokenJson);
  } catch {
    return null;
  }
}

function getExpiry(tokenJson) {
  return parseToken(tokenJson)?.claudeAiOauth?.expiresAt || null;
}

function needsRefresh(tokenJson, force) {
  return needsProactiveRefresh(tokenJson, Date.now(), force);
}

/** Mark account for always-on magic-link-autoloop; clear its autoloop cooldown. */
function markNeedsReauth(key, reason) {
  try {
    let state = {};
    if (existsSync(NEEDS_REAUTH_PATH)) {
      state = JSON.parse(readFileSync(NEEDS_REAUTH_PATH, 'utf8'));
    }
    const id = key.replace(/[^a-zA-Z0-9@._-]/g, '-');
    state[id] = {
      name: key,
      needsReauth: true,
      lastFailAt: Date.now(),
      reason: String(reason || 'refresh failed').slice(0, 200),
    };
    const tmp = NEEDS_REAUTH_PATH + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, NEEDS_REAUTH_PATH);
  } catch (e) {
    log(`${key}: ⚠ could not write needsReauth state — ${String(e.message || e).slice(0, 80)}`);
  }
  // Clear magic-loop cooldown so next tick can pick this account immediately
  try {
    if (!existsSync(AUTOLOOP_STATE_PATH)) return;
    const s = JSON.parse(readFileSync(AUTOLOOP_STATE_PATH, 'utf8'));
    if (s[key]) {
      delete s[key].blockedUntil;
      s[key].dispatchedAt = 0;
      s[key].reason = 'refresh-http-400';
      const tmp = AUTOLOOP_STATE_PATH + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, AUTOLOOP_STATE_PATH);
    }
  } catch {}
}

function clearNeedsReauth(key) {
  try {
    if (!existsSync(NEEDS_REAUTH_PATH)) return;
    const state = JSON.parse(readFileSync(NEEDS_REAUTH_PATH, 'utf8'));
    let changed = false;
    for (const [id, entry] of Object.entries(state)) {
      if (entry?.name === key || id === key) {
        delete state[id];
        changed = true;
      }
    }
    if (changed) {
      const tmp = NEEDS_REAUTH_PATH + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, NEEDS_REAUTH_PATH);
    }
  } catch {}
}

// ── OAuth token refresh ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function refreshOAuthToken(refreshToken) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithProxyFallback(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      });

      const body = await res.json();

      if (res.ok && body.access_token) {
        return {
          ok: true,
          accessToken: body.access_token,
          refreshToken: body.refresh_token || refreshToken,
          expiresIn: body.expires_in,
          expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000,
          subscriptionType: body.subscription_type,
          rateLimitTier: body.rate_limit_tier,
        };
      }

      // patch 048-429: respect Retry-After header on 429s before falling back
      // to backoff. Anthropic returns seconds-in-Retry-After when present.
      if (res.status === 429) {
        const retryAfterHeader = res.headers && (res.headers.get?.('retry-after') || res.headers['retry-after']);
        const retryAfterMs = retryAfterHeader
          ? /\d+/i.test(String(retryAfterHeader))
            ? Math.min(15 * 60_000, Math.max(2_000, parseInt(String(retryAfterHeader), 10) * 1000 + 2000))
            : 60_000
          : null;
        const delay = retryAfterMs ?? RETRY_DELAY_MS * attempt;
        log(
          `  429 Too Many Requests (attempt ${attempt}/${MAX_RETRIES}) — waiting ${Math.round(delay / 1000)}s (Retry-After=${retryAfterHeader ?? 'n/a'})...`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(delay);
          continue;
        }
        return { ok: false, error: `429 after ${MAX_RETRIES} retries (Retry-After=${retryAfterHeader})` };
      }

      if (body?.error?.type === 'rate_limit_error') {
        const delay = RETRY_DELAY_MS * attempt;
        log(`  Rate limited (attempt ${attempt}/${MAX_RETRIES}) — waiting ${delay / 1000}s...`);
        if (attempt < MAX_RETRIES) {
          await sleep(delay);
          continue;
        }
        return { ok: false, error: 'Rate limited after all retries' };
      }

      // Other error — don't retry
      return { ok: false, error: body?.error?.message || `HTTP ${res.status}` };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

// ── Status command ───────────────────────────────────────────────────────────

function showStatus() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const state = readState();
  const now = Date.now();
  console.log('\n=== Token Expiry Status (keep-alive) ===\n');
  console.log(
    `  policy: refresh when <${(REFRESH_WHEN_BELOW_MS / 3_600_000).toFixed(0)}h left · healthy floor ≥${(MIN_HEALTHY_TTL_MS / 3_600_000).toFixed(0)}h\n`,
  );
  let healthy = 0;
  let unhealthy = 0;
  for (const a of config.accounts) {
    const key = accountKey(a);
    const token = readStoredToken(a);
    const active = state.activeAccount === key ? ' (ACTIVE)' : '';
    if (!token) {
      console.log(`  ${key}: ❌ NO TOKEN${active}`);
      unhealthy++;
      continue;
    }
    const rem = remainingMs(token, now);
    const hoursLeft = (rem / 3_600_000).toFixed(1);
    const label = freshnessLabel(token, now);
    const icon = label === 'FRESH' ? '✅' : label === 'REFRESH_SOON' ? '🟡' : label === 'EXPIRING' ? '⚠️ ' : '❌';
    if (label === 'FRESH' || label === 'REFRESH_SOON') healthy++;
    else unhealthy++;
    console.log(`  ${key}: ${icon} ${label} (${hoursLeft}h remaining)${active}`);
  }
  console.log(`\n  summary: ${healthy} keep-alive-ok · ${unhealthy} need refresh/reauth\n`);
}

// ── Single-account refresh (exported for daemon.mjs / other in-process callers) ──
//
// This is the one place that performs an OAuth refresh_token grant for a single
// account, under the fleet-wide per-account lock. daemon.mjs delegates to this
// (behind ROTATOR_OWNS_CRS_REFRESH=1) instead of refreshing tokens itself, so
// there is exactly one code path that can rotate a refresh_token and invalidate
// whatever copy CRS or another host is holding.
//
// Returns { refreshed, reason }. `refreshed` is only true when a new access
// token was actually written to the vault (and, if this is the active
// keychain account, merged into the active keychain too).
export async function refreshOneAccount(account, { force = false } = {}) {
  const key = accountKey(account);

  if (account.disabled === true) {
    return { refreshed: false, reason: 'disabled' };
  }

  // Refresh tokens are single-use: never refresh an account another host's
  // lease says is currently active there, or we invalidate the copy it's
  // holding mid-session. (Same guard crs-token-feed.mjs used to apply.)
  try {
    if (foreignActiveKeys(log).has(key)) {
      return { refreshed: false, reason: 'foreign-leased' };
    }
  } catch (e) {
    log(`${key}: foreign-lease check failed (${e.message}) — proceeding`);
  }

  const tokenJson = readStoredToken(account);
  if (!tokenJson) {
    return { refreshed: false, reason: 'no stored token' };
  }

  if (!needsRefresh(tokenJson, force)) {
    return { refreshed: false, reason: 'fresh' };
  }

  const releaseRefreshLock = acquireRefreshLock(key);
  if (!releaseRefreshLock) {
    return { refreshed: false, reason: 'refresh lock held' };
  }

  try {
    const parsed = parseToken(tokenJson);
    const oauthData = parsed?.claudeAiOauth;
    if (!oauthData?.refreshToken) {
      return { refreshed: false, reason: 'no refreshToken in stored token' };
    }

    const result = await refreshOAuthToken(oauthData.refreshToken);

    if (!result.ok) {
      if (result.error && result.error.includes('400')) {
        log(`${key}: refresh grant failed (HTTP 400) — marking needsReauth for magic-link-autoloop`);
        markNeedsReauth(key, result.error);
      } else if (result.error && /401|invalid|revoked/i.test(result.error)) {
        markNeedsReauth(key, result.error);
      }
      return { refreshed: false, reason: `refresh failed — ${result.error}` };
    }

    const updated = {
      claudeAiOauth: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        scopes: oauthData.scopes || [],
        subscriptionType: result.subscriptionType || oauthData.subscriptionType,
        rateLimitTier: result.rateLimitTier || oauthData.rateLimitTier,
      },
      mcpOAuth: {},
    };

    writeStoredToken(account, JSON.stringify(updated));
    syncStoredTokenToCrs(account);
    clearNeedsReauth(key);
    const newHoursLeft = ((result.expiresAt - Date.now()) / 3_600_000).toFixed(1);
    log(`${key}: ✓ refreshed (${newHoursLeft}h remaining)`);

    // Refresh tokens are single-use: hand the freshly-minted one to the peer
    // host while we still hold the lock, so its next cycle doesn't 400 on a
    // now-stale refresh token. (Moved here from crs-token-feed.mjs's own
    // refresh path, which this function now supersedes.)
    try {
      propagateFreshTokenToPeer(key, updated.claudeAiOauth, { log });
    } catch (e) {
      log(`${key}: peer propagation error ${e.message}`);
    }

    const state = readState();
    if (state.activeAccount === key) {
      try {
        const currentActive = readKeychain();
        const currentParsed = parseToken(currentActive);
        if (currentParsed?.mcpOAuth) {
          updated.mcpOAuth = { ...updated.mcpOAuth, ...currentParsed.mcpOAuth };
        }
        writeKeychain(JSON.stringify(updated));
        log(`${key}: ✓ also updated active keychain with mcpOAuth preserved`);
      } catch (err) {
        log(`${key}: ⚠ vault updated but active keychain update failed — ${err.message}`);
      }
    }

    return { refreshed: true, reason: 'refreshed' };
  } finally {
    releaseRefreshLock();
  }
}

// ── Main refresh logic (CLI entrypoint only) ────────────────────────────────

const args = process.argv.slice(2);
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  try {
    const reconciled = reconcileRemoteRotationVault();
    if (!reconciled.skipped && (reconciled.pulled > 0 || reconciled.pushed > 0)) {
      log(`remote vault reconciled: ${reconciled.pulled} pulled, ${reconciled.pushed} pushed`);
    }
  } catch (error) {
    log(`remote vault reconciliation unavailable — ${String(error.message || error).slice(0, 180)}`);
  }

  if (args.includes('--status')) {
    showStatus();
    process.exit(0);
  }

  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const state = readState();
  const ROTATING_LOCK = join(__dirname, '.rotating');
  const MAGIC_LINK_TIMEOUT_MS = Number(process.env.CLAUDE_ROT_MAGIC_TOTAL_TIMEOUT_MS || 720_000);

  function pidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** True when another rotate/reauth already holds the fleet lock. */
  function rotationInProgress() {
    try {
      if (!existsSync(ROTATING_LOCK)) return false;
      const raw = JSON.parse(readFileSync(ROTATING_LOCK, 'utf8'));
      return pidAlive(Number(raw?.pid || 0));
    } catch {
      return false;
    }
  }

  /** Prefer re-authing accounts with headroom; skip 7d-exhausted waste. */
  function magicLinkPriority(account) {
    const key = accountKey(account);
    const u = state.accounts?.[key]?.lastUtilization || {};
    const now = Date.now();
    const pct7 = Number(u.pct7);
    const reset7Ms = Number(u.reset7) > 0 ? Number(u.reset7) * 1000 : 0;
    const weekly = Number.isFinite(pct7) && !(reset7Ms && reset7Ms < now) ? pct7 : 50;
    // Lower score = better magic-link candidate (headroom first).
    return weekly;
  }

  function shouldSkipMagicLinkForUtil(account) {
    const key = accountKey(account);
    const u = state.accounts?.[key]?.lastUtilization || {};
    const now = Date.now();
    const pct7 = Number(u.pct7);
    const reset7Ms = Number(u.reset7) > 0 ? Number(u.reset7) * 1000 : 0;
    if (Number.isFinite(pct7) && pct7 >= 95 && !(reset7Ms && reset7Ms < now)) {
      return `7d util ${pct7}% exhausted — re-auth deferred (cannot use until weekly reset)`;
    }
    return null;
  }

  // Process accounts with freshest tokens first for refresh grant; when picking
  // the single magic-link attempt, prefer headroom (low weekly util) over exhausted.
  const accountsOrdered = [...config.accounts].sort((a, b) => {
    const ea = getExpiry(readStoredToken(a)) || 0;
    const eb = getExpiry(readStoredToken(b)) || 0;
    // Still-fresh first (skip quickly), then expired by magic-link priority.
    const aFresh = ea > Date.now();
    const bFresh = eb > Date.now();
    if (aFresh !== bFresh) return aFresh ? -1 : 1;
    if (aFresh) return ea - eb; // soonest expiry first among fresh
    return magicLinkPriority(a) - magicLinkPriority(b);
  });

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  let magicLinkAttempted = false;

  for (let i = 0; i < accountsOrdered.length; i++) {
    const account = accountsOrdered[i];
    const key = accountKey(account);

    // Skip accounts disabled in config — their token is intentionally not
    // maintained (e.g. dead refresh token needing manual re-auth). Without this,
    // a disabled account with a stale token triggers the HTTP-400 → magic-link
    // browser re-auth path every hour (~180s of doomed browser automation).
    if (account.disabled === true) {
      log(`${key}: disabled — skipping`);
      skipped++;
      continue;
    }

    try {
      if (foreignActiveKeys(log).has(key)) {
        log(`${key}: foreign-leased (active on another host) — skipping`);
        skipped++;
        continue;
      }
    } catch (e) {
      log(`${key}: foreign-lease check failed (${e.message}) — proceeding`);
    }

    const tokenJson = readStoredToken(account);

    if (!tokenJson) {
      log(`${key}: no stored token — skipping`);
      skipped++;
      continue;
    }

    if (!needsRefresh(tokenJson, force)) {
      const exp = getExpiry(tokenJson);
      const hoursLeft = ((exp - Date.now()) / 3_600_000).toFixed(1);
      log(`${key}: fresh (${hoursLeft}h remaining) — skipping`);
      skipped++;
      continue;
    }

    const exp = getExpiry(tokenJson);
    const hoursLeft = exp ? ((exp - Date.now()) / 3_600_000).toFixed(1) : '?';
    log(`${key}: needs refresh (${hoursLeft}h remaining)${dryRun ? ' [DRY RUN]' : ''}...`);

    if (dryRun) {
      continue;
    }

    const releaseRefreshLock = acquireRefreshLock(key);
    if (!releaseRefreshLock) {
      log(`${key}: refresh lock held or fleet lock unavailable — skipping`);
      skipped++;
      continue;
    }

    try {
      // Rate limit courtesy: delay between accounts
      if (i > 0) {
        await sleep(INTER_ACCOUNT_DELAY_MS);
      }

      const parsed = parseToken(tokenJson);
      const oauthData = parsed?.claudeAiOauth;
      if (!oauthData?.refreshToken) {
        log(`${key}: no refreshToken in stored token — skipping`);
        failed++;
        continue;
      }

      const result = await refreshOAuthToken(oauthData.refreshToken);

      if (!result.ok) {
        log(`${key}: ✗ refresh failed — ${result.error}`);

        // HTTP 400 = dead refresh_token. Browser re-auth is owned by the always-on
        // magic-link-autoloop (com.example.crs-magic-link-autoloop) — never spawn a
        // competing headed OAuth from the hourly refresher (2026-07-16 thrash).
        // Opt-in only: CLAUDE_ROTATION_REFRESH_MAGIC_LINK=1 for emergency one-shots.
        if (result.error && result.error.includes('400')) {
          if (account.autoAuthDisabled === true) {
            log(`${key}: unattended re-auth disabled — leaving token for manual recovery`);
          } else if (process.env.CLAUDE_ROTATION_REFRESH_MAGIC_LINK === '1' && !magicLinkAttempted) {
            const utilSkip = shouldSkipMagicLinkForUtil(account);
            if (utilSkip) {
              log(`${key}: ${utilSkip}`);
            } else if (rotationInProgress()) {
              log(`${key}: rotation lock held — deferring magic-link re-auth`);
            } else {
              magicLinkAttempted = true;
              log(
                `${key}: refresh token invalid — CLAUDE_ROTATION_REFRESH_MAGIC_LINK=1 → magic-link (timeout ${Math.round(MAGIC_LINK_TIMEOUT_MS / 1000)}s)...`,
              );
              try {
                const reAuthResult = execFileSync(
                  process.execPath,
                  [join(__dirname, 'rotate.mjs'), '--to', key, '--magic-link', '--force'],
                  { timeout: MAGIC_LINK_TIMEOUT_MS, encoding: 'utf8' },
                );
                log(`${key}: magic link re-auth output: ${reAuthResult.split('\n').slice(-3).join(' | ')}`);
                const reAuthedToken = readStoredToken(account);
                if (reAuthedToken) {
                  const reParsed = parseToken(reAuthedToken);
                  if (reParsed?.claudeAiOauth?.accessToken) {
                    log(`${key}: ✓ re-authed via magic link`);
                    refreshed++;
                    continue;
                  }
                }
                log(`${key}: magic link re-auth did not produce a valid token`);
              } catch (err) {
                log(`${key}: magic link re-auth failed — ${err.message}`);
              }
            }
          } else {
            log(`${key}: refresh grant failed (HTTP 400) — marking needsReauth for magic-link-autoloop`);
            markNeedsReauth(key, result.error);
          }
        } else if (result.error && /401|invalid|revoked/i.test(result.error)) {
          markNeedsReauth(key, result.error);
        }

        failed++;
        continue;
      }

      // Build updated token
      const updated = {
        claudeAiOauth: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          scopes: oauthData.scopes || [],
          subscriptionType: result.subscriptionType || oauthData.subscriptionType,
          rateLimitTier: result.rateLimitTier || oauthData.rateLimitTier,
        },
        mcpOAuth: {},
      };

      // Save to vault
      writeStoredToken(account, JSON.stringify(updated));
      syncStoredTokenToCrs(account);
      clearNeedsReauth(key);
      const newHoursLeft = ((result.expiresAt - Date.now()) / 3_600_000).toFixed(1);
      log(`${key}: ✓ refreshed (${newHoursLeft}h remaining)`);

      // If this is the currently active account, update the active keychain too
      if (state.activeAccount === key) {
        try {
          const currentActive = readKeychain();
          const currentParsed = parseToken(currentActive);
          // Always merge mcpOAuth from the running session — drop the Object.keys>0 guard
          // which silently skipped preservation when a prior rotation had already zeroed the
          // field, causing CC to lose all MCP OAuth tokens (giga, Amplitude, higgsfield) on
          // the next session launch and forcing interactive reauth every session.
          if (currentParsed?.mcpOAuth) {
            updated.mcpOAuth = { ...updated.mcpOAuth, ...currentParsed.mcpOAuth };
          }
          writeKeychain(JSON.stringify(updated));
          log(`${key}: ✓ also updated active keychain with mcpOAuth preserved`);
        } catch (err) {
          log(`${key}: ⚠ vault updated but active keychain update failed — ${err.message}`);
        }
      }

      refreshed++;
    } finally {
      releaseRefreshLock();
    }
  }

  log(`Token refresh complete: ${refreshed} refreshed, ${failed} failed, ${skipped} skipped`);

  // Show final status if anything was refreshed
  if (refreshed > 0 || failed > 0) {
    showStatus();
  }
} // end isMain
