#!/usr/bin/env node
// crs-priority-daemon.mjs — utilization-driven account prioritization for a
// claude-relay-service (CRS) pool.
//
// CRS load-balances Claude requests across many claude.ai accounts at once. Each
// account carries a `schedulable` flag; CRS only routes to schedulable accounts.
// This daemon flips that flag from LIVE signals so the pool AVOIDS near-maxed
// accounts (cutting 429/529s) and RE-ENABLES them once their windows recover —
// the relay-pool analogue of the keychain rotator's "rotate to the coolest
// account". One tick per invocation; a launchd/systemd timer drives the cadence
// (see scripts/install-crs-priority-agent.sh). The wrapper crs-priority-daemon.sh
// holds the single-flight lock.
//
// SIGNALS (real-time first — claudeUsage.* is often null/stale for pool accounts
// and must NEVER drive a re-enable on its own):
//   rateLimitStatus.isRateLimited / opusRateLimitStatus.isRateLimited  (hard cap hit)
//   overloadStatus.isOverloaded                                        (upstream 529)
//   sessionWindow.sessionWindowStatus                                  (allowed | allowed_warning | …)
//   claudeUsage.{fiveHour,sevenDay,sevenDayOpus}.utilization           (fresh secondary only)
//
// POLICY (configurable via crs.policy or $CRS_POLICY):
//   conservative (default) — deprioritize on fresh high utilization, sessionWindow
//   warnings, rate limits, and overload; FLOOR keeps minimum pool size; dedup by
//   organizationUuid (same claude.ai quota pool).
//   max-out — schedulable=TRUE for every account with a fresh OAuth token unless
//   CRS would get a hard error (genuine rate-limit or 529 after stale-cache scrub).
//   Util % and sessionWindow are telemetry only; dedup by login email.
//
// CONFIG (config.json "crs" block; every key overridable by env):
//   enabled, policy, baseUrl, adminUser, adminPasswordEnv, off5h, off7d, on5h, on7d,
//   floor, freshMinutes. Per-account crsAccountName (or crs.nameByVaultKey) maps vault
//   keys to CRS admin account names for token-feed + live quota lookup. Admin password
//   resolves from (1) $CRS_ADMIN_PASSWORD, (2) the configured env var, (3) credential-store.
//
// CLI:  (none)=one live tick · --dry-run=log decisions, no writes · --status=print
//       current schedulable + utilization table and exit · --once (alias for tick).

import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import {
  buildCrsNameMaps,
  crsBaseUrl,
  crsFileVaultPath,
  crsPolicy,
  loadRotationConfig,
  vaultLookupKeysForEmail,
} from './crs-pool-config.mjs';
import { liveUsageProvesRateLimitRecovery, liveUsageWorst } from './crs-priority-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..');
const CRED_STORE_CANDIDATES = [
  process.env.OPS_CREDENTIAL_STORE,
  join(homedir(), '.claude', 'plugins', 'cache', 'ops-marketplace', 'ops', 'current', 'lib', 'credential-store.sh'),
  join(homedir(), '.claude', 'plugins', 'marketplaces', 'ops-marketplace', 'claude-ops', 'lib', 'credential-store.sh'),
  join(PLUGIN_ROOT, 'lib', 'credential-store.sh'),
].filter(Boolean);
function credentialStorePath() {
  for (const p of CRED_STORE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return CRED_STORE_CANDIDATES[CRED_STORE_CANDIDATES.length - 1];
}
const EXEC_QUIET = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] };
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');
const MUTATIONS_ENABLED = !DRY && !STATUS;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-priority] ${m}`);

// ── config ───────────────────────────────────────────────────────────────────
const cfg = loadRotationConfig();
const C = cfg.crs || {};
const { vaultKeyByCrsName } = buildCrsNameMaps(cfg);
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

const BASE = crsBaseUrl(cfg);
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const ON_5H = num(process.env.CRS_ON_5H ?? C.on5h, 70);
const ON_7D = num(process.env.CRS_ON_7D ?? C.on7d, 85);
const FLOOR = num(process.env.CRS_FLOOR ?? C.floor, 3);
const FRESH_MIN = num(process.env.CRS_FRESH_MIN ?? C.freshMinutes, 15);
const CRS_POLICY = crsPolicy(cfg);
const VIABLE_CAP = num(process.env.CRS_VIABLE_CAP ?? cfg.rateLimits?.destinationMaxUtilPercent, 95);
const TOKEN_MIN_FRESH_MS = num(process.env.CRS_TOKEN_MIN_FRESH_MS ?? C.tokenMinFreshMs, 5 * 60_000);
const STALE_RL_MAX_MINS = num(process.env.CRS_STALE_RL_MINUTES, 300);
const LIVE_USAGE_TTL_MS = num(process.env.CRS_LIVE_USAGE_TTL_MS, 4 * 60_000);
const IS_LINUX = platform() === 'linux';
const IS_MACOS = !IS_LINUX;
const liveUsageCache = new Map();
const SHARED_USAGE_CACHE_PATH = join(__dirname, '.util-cache.json');
const LINUX_CRED_PATH = crsFileVaultPath(cfg);
const CRS_CONTAINER = process.env.CRS_CONTAINER || C.containerName || 'crs-claude-relay-1';
const MAGIC_LINK_COOLDOWN_MS = num(process.env.CRS_MAGIC_LINK_COOLDOWN_MS, 10 * 60_000); // 10m between same-account attempts
const MAX_MAGIC_LINKS_PER_TICK = 1;
const PRIORITY_MAGIC_LINK_AUTHORITY = process.env.CRS_PRIORITY_MAGIC_LINK_AUTHORITY === '1';
const MAGIC_LINK_STATE_PATH = join(__dirname, '.crs-magic-link-state.json');

function readSharedUsageCache() {
  try {
    return JSON.parse(readFileSync(SHARED_USAGE_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadSharedUsageCache() {
  const now = Date.now();
  for (const [key, value] of Object.entries(readSharedUsageCache())) {
    if (!value?.ts || now - value.ts >= LIVE_USAGE_TTL_MS) continue;
    liveUsageCache.set(key, {
      at: value.ts,
      data: {
        u5: value.data?.five_hour_pct ?? null,
        u7: value.data?.seven_day_pct ?? null,
        u7s: value.data?.seven_day_sonnet_pct ?? null,
        u7o: value.data?.seven_day_opus_pct ?? null,
        resets7: value.data?.resets_at_7d ?? null,
      },
    });
  }
}

function writeSharedUsageCache(key, data) {
  if (!MUTATIONS_ENABLED) return;
  try {
    const cache = readSharedUsageCache();
    cache[key] = {
      ts: Date.now(),
      data: {
        five_hour_pct: data.u5,
        seven_day_pct: data.u7,
        seven_day_sonnet_pct: data.u7s,
        seven_day_opus_pct: data.u7o,
        resets_at_5h: null,
        resets_at_7d: data.resets7,
      },
    };
    const temp = `${SHARED_USAGE_CACHE_PATH}.tmp.${process.pid}`;
    writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(temp, SHARED_USAGE_CACHE_PATH);
  } catch {}
}

loadSharedUsageCache();

function adminPasswordFromDocker() {
  if (!IS_LINUX) return null;
  try {
    const out = execFileSync(
      'docker',
      ['inspect', CRS_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      EXEC_QUIET,
    );
    const m = out.match(/^ADMIN_PASSWORD=(.+)$/m);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function adminPassword() {
  if (process.env.CRS_ADMIN_PASSWORD) return process.env.CRS_ADMIN_PASSWORD;
  const envName = C.adminPasswordEnv || process.env.CRS_ADMIN_PASSWORD_ENV;
  if (envName && process.env[envName]) return process.env[envName];
  const dockerPw = adminPasswordFromDocker();
  if (dockerPw) return dockerPw;
  try {
    const cred = credentialStorePath();
    const acct = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
    return execFileSync('bash', [cred, 'get', `CRS-Admin-${ADMIN_USER}`, acct], EXEC_QUIET).trim();
  } catch {}
  throw new Error(
    `CRS admin password unavailable — set $CRS_ADMIN_PASSWORD, or store it via:\n` +
      `  bash "${credentialStorePath()}" set CRS-Admin-${ADMIN_USER} "$USER" '<password>'`,
  );
}

// ── authoritative per-account quota (api.anthropic.com/api/oauth/usage) ────────
// CRS's cached claudeUsage is often null/stale, so for accurate prioritization we
// read each account's OAuth token from the credential store and query Anthropic's
// usage endpoint directly (read-only GET — does NOT rotate the token). Falls back
// to the cache/sessionWindowStatus when no token / 401 / timeout. Tokens live at
// `Claude-Rotation-<email>` (rotator schema); CRS account → token by subscription email.
const USAGE_TOKEN_SVC = process.env.CRS_USAGE_TOKEN_PREFIX || 'Claude-Rotation-';

function accountVaultKey(a) {
  return a.subscriptionInfo?.email || vaultKeyByCrsName[a.name] || null;
}

function vaultLookupKeys(email) {
  return vaultLookupKeysForEmail(email, cfg.accounts || []);
}

function readOauthTokenFromFileVault(email) {
  if (!email || !existsSync(LINUX_CRED_PATH)) return null;
  try {
    const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
    for (const key of vaultLookupKeys(email)) {
      const t = store[`${USAGE_TOKEN_SVC}${key}`]?.claudeAiOauth?.accessToken;
      if (t) return t;
    }
  } catch {}
  return null;
}

function readOauthToken(email) {
  if (!email) return null;
  const fileTok = readOauthTokenFromFileVault(email);
  if (fileTok) return fileTok;
  const acct = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
  const cred = credentialStorePath();
  for (const get of [
    () => execFileSync('bash', [cred, 'get', `${USAGE_TOKEN_SVC}${email}`, acct], EXEC_QUIET),
    () =>
      execFileSync(
        'security',
        ['find-generic-password', '-a', acct, '-s', `${USAGE_TOKEN_SVC}${email}`, '-w'],
        EXEC_QUIET,
      ),
  ]) {
    try {
      const j = JSON.parse(get().trim());
      const t = j?.claudeAiOauth?.accessToken;
      if (t) return t;
    } catch {}
  }
  for (const key of vaultLookupKeys(email)) {
    if (key === email) continue;
    for (const get of [
      () => execFileSync('bash', [cred, 'get', `${USAGE_TOKEN_SVC}${key}`, acct], EXEC_QUIET),
      () =>
        execFileSync(
          'security',
          ['find-generic-password', '-a', acct, '-s', `${USAGE_TOKEN_SVC}${key}`, '-w'],
          EXEC_QUIET,
        ),
    ]) {
      try {
        const j = JSON.parse(get().trim());
        const t = j?.claudeAiOauth?.accessToken;
        if (t) return t;
      } catch {}
    }
  }
  return null;
}

function accountTokenFresh(a, now = Date.now()) {
  const tokenExp = Number(a.tokenExpiresAt || a.expiresAt || 0);
  return Number.isFinite(tokenExp) && tokenExp > now + TOKEN_MIN_FRESH_MS;
}

function rateLimitLooksStale(a, now = Date.now()) {
  if (a.status === 'error') return true; // error state is always stale for rate-limit/cooldown data

  const inspect = (st, resetAtFallback) => {
    if (!st?.isRateLimited) return false;
    // Check rateLimitEndAt first — it's the authoritative reset timestamp
    // from the CRS (set with reason="authoritative_reset").
    const resetAt = st.rateLimitEndAt || st.resetAt || resetAtFallback;
    const resetMs = resetAt ? Date.parse(resetAt) : NaN;
    const mins = st.minutesRemaining ?? null;
    // If there's a valid reset timestamp and it's in the past, the rate limit has expired.
    if (Number.isFinite(resetMs) && resetMs <= now) return true;
    if (mins === 0) return true;
    // If rateLimitEndAt is set and is in the future, the rate limit is genuine — never clear it.
    if (Number.isFinite(resetMs) && resetMs > now) return false;
    // No mins > STALE_RL_MAX_MINS check — minutesRemaining alone can't distinguish
    // between stale data (should be cleared) and genuine long-lived rate limits (82h).
    // Check rateLimitedAt age as staleness signal instead.
    const limitedAt = st.rateLimitedAt ? Date.parse(st.rateLimitedAt) : NaN;
    if (Number.isFinite(limitedAt) && !Number.isFinite(resetMs) && now - limitedAt > STALE_RL_MAX_MINS * 60_000)
      return true;
    if (accountTokenFresh(a, now) && typeof mins === 'number' && mins > 60) return true;
    return false;
  };

  if (inspect(a.rateLimitStatus, a.rateLimitResetAt)) return true;
  if (inspect(a.opusRateLimitStatus, a.opusRateLimitStatus?.resetAt)) return true;

  const ov = a.overloadStatus;
  if (ov?.isOverloaded) {
    const resetMs = ov.resetAt ? Date.parse(ov.resetAt) : NaN;
    if (Number.isFinite(resetMs) && resetMs <= now) return true;
    if (accountTokenFresh(a, now)) return true;
  }
  return false;
}
async function liveUsage(email) {
  if (!email) return null;
  const cached = liveUsageCache.get(email);
  if (cached && Date.now() - cached.at < LIVE_USAGE_TTL_MS) return cached.data;
  const token = readOauthToken(email);
  if (!token) return null;
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return cached?.data ?? null;
    const d = await r.json();
    const data = {
      u5: d?.five_hour?.utilization ?? null,
      u7: d?.seven_day?.utilization ?? null,
      u7s: d?.seven_day_sonnet?.utilization ?? null,
      u7o: d?.seven_day_opus?.utilization ?? null,
      resets7: d?.seven_day?.resets_at ?? null, // ISO string — used for exact re-enable scheduling
    };
    liveUsageCache.set(email, { at: Date.now(), data });
    writeSharedUsageCache(email, data);
    return data;
  } catch {
    return cached?.data ?? null;
  }
}

function genuineRateLimit(a, now = Date.now()) {
  const flagged = !!a.rateLimitStatus?.isRateLimited || !!a.opusRateLimitStatus?.isRateLimited;
  return flagged && !rateLimitLooksStale(a, now);
}

function genuineOverload(a, now = Date.now()) {
  if (!a.overloadStatus?.isOverloaded) return false;
  const resetMs = a.overloadStatus.resetAt ? Date.parse(a.overloadStatus.resetAt) : NaN;
  if (Number.isFinite(resetMs) && resetMs <= now) return false;
  if (accountTokenFresh(a, now)) {
    const mins = a.overloadStatus.minutesRemaining;
    if (typeof mins === 'number' && mins > STALE_RL_MAX_MINS) return false;
  }
  return true;
}

// ── http ─────────────────────────────────────────────────────────────────────
async function jfetch(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, opts);
  const txt = await r.text();
  let body;
  try {
    body = JSON.parse(txt);
  } catch {
    body = txt;
  }
  return { status: r.status, body };
}

async function login() {
  const r = await jfetch('/web/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: adminPassword() }),
  });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login failed (HTTP ${r.status})`);
  return { Authorization: `Bearer ${r.body.token}`, 'Content-Type': 'application/json' };
}

async function getAccounts(auth) {
  const r = await jfetch('/admin/claude-accounts', { headers: auth });
  if (r.status !== 200) throw new Error(`GET claude-accounts failed (HTTP ${r.status})`);
  const list = Array.isArray(r.body) ? r.body : r.body.data || r.body.accounts || [];
  return list.filter((a) => a.platform === 'claude' && a.isActive !== false);
}

async function clearStaleCooldowns(auth, accts) {
  const now = Date.now();
  let cleared = 0;
  for (const a of accts) {
    if (!rateLimitLooksStale(a, now)) continue;
    const mins = a.rateLimitStatus?.minutesRemaining ?? '?';
    if (!MUTATIONS_ENABLED) {
      log(`[dry] clear stale RL ${a.name} (mins=${mins})`);
      cleared++;
      continue;
    }
    const res = await jfetch(`/admin/claude-accounts/${a.id}/reset-status`, { method: 'POST', headers: auth });
    if (res.status >= 200 && res.status < 300) {
      cleared++;
      log(`${a.name}: cleared stale RL/error cache (was mins=${mins})`);
    }
  }
  return cleared;
}

async function recoverSchedulableAfterClear(auth, accts) {
  const now = Date.now();
  let enabled = 0;
  for (const a of accts) {
    if (a.schedulable !== false) continue;
    if (a.rateLimitStatus?.isRateLimited || a.opusRateLimitStatus?.isRateLimited) continue;
    if (a.overloadStatus?.isOverloaded) continue;
    if (!MUTATIONS_ENABLED) {
      log(`[dry] re-enable ${a.name} after stale clear`);
      enabled++;
      continue;
    }
    const put = await jfetch(`/admin/claude-accounts/${a.id}/toggle-schedulable`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ schedulable: true }),
    });
    if (put.status >= 200 && put.status < 300) {
      enabled++;
      log(`${a.name}: re-enabled schedulable after stale-cache recovery`);
    }
  }
  return enabled;
}

async function clearRecoveredRateLimits(auth, accts) {
  let cleared = 0;
  for (const a of accts) {
    if (!liveUsageProvesRateLimitRecovery(a, VIABLE_CAP)) continue;
    const worst = liveUsageWorst(a._liveUsage);
    if (!MUTATIONS_ENABLED) {
      log(`[dry] clear recovered RL ${a.name} (live max=${worst}%)`);
      continue;
    }
    const res = await jfetch(`/admin/claude-accounts/${a.id}/reset-status`, {
      method: 'POST',
      headers: auth,
    });
    if (res.status >= 200 && res.status < 300) {
      cleared++;
      log(`${a.name}: cleared recovered host-local RL (live max=${worst}%)`);
    }
  }
  return cleared;
}

// ── policy ───────────────────────────────────────────────────────────────────
function hardHoldReason(a, nowMs) {
  const status = String(a.status || '');
  if (['blocked', 'auth_repair', 'error'].includes(status)) return `hard-status ${status}`;
  const weeklyEndMs = a.weeklyRateLimitEndAt ? Date.parse(a.weeklyRateLimitEndAt) : NaN;
  if (Number.isFinite(weeklyEndMs) && weeklyEndMs > nowMs) {
    return `weekly-exhausted until ${a.weeklyRateLimitEndAt?.slice(0, 16)}`;
  }
  return null;
}

function decideMaxOut(accts, nowMs) {
  return accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage;
    const updMs = cu.updatedAt ? Date.parse(cu.updatedAt) : NaN;
    const cuFresh = Number.isFinite(updMs) && (nowMs - updMs) / 60000 < FRESH_MIN;
    // Only use claudeUsage as fallback when actually fresh
    const u5 = lu?.u5 ?? (cuFresh ? cu.fiveHour?.utilization : null);
    const u7 = lu?.u7 ?? (cuFresh ? cu.sevenDay?.utilization : null);
    const u7s = lu?.u7s ?? (cuFresh ? cu.sevenDaySonnet?.utilization : null);
    const u7o = lu?.u7o ?? (cuFresh ? cu.sevenDayOpus?.utilization : null);
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;
    const tokenExpiresAt = Number(a.tokenExpiresAt || a.expiresAt || 0);
    const staleToken =
      !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= 0 || tokenExpiresAt <= nowMs + TOKEN_MIN_FRESH_MS;
    const liveKnown = typeof u5 === 'number' && typeof u7 === 'number';
    const worst = liveKnown ? Math.max(u5, u7, ...[u7s, u7o].filter((value) => typeof value === 'number')) : null;
    const rl = genuineRateLimit(a, nowMs);
    const overloaded = genuineOverload(a, nowMs);
    const status = String(a.status || '');
    const hardStatus = ['blocked', 'auth_repair', 'error'].includes(status);

    let desired = true;
    let reason = `max-out (5h=${u5 ?? '?'} 7d=${u7 ?? '?'} sonnet7d=${u7s ?? '?'} opus7d=${u7o ?? '?'} sw=${sw ?? 'none'})`;
    if (hardStatus) {
      desired = false;
      reason = `hard-status ${status}`;
    } else if (!liveKnown) {
      // Missing telemetry is not quota exhaustion. Preserve the last known
      // schedulability until a live quota sample or a hard auth/token state
      // proves the account unusable; this prevents 429/query gaps from
      // shrinking the pool and making viable/schedulable counts diverge.
      desired = cur;
      reason = staleToken
        ? tokenExpiresAt
          ? `stale-token ${new Date(tokenExpiresAt).toISOString()}`
          : 'stale-token missing-expiry'
        : 'live usage unavailable — preserving schedulability';
    } else if (worst >= VIABLE_CAP) {
      desired = false;
      reason = `not viable: max(5h=${u5},7d=${u7},sonnet7d=${u7s ?? '?'},opus7d=${u7o ?? '?'}) >= ${VIABLE_CAP}%`;
    } else if (rl) {
      reason = 'rate-limited, staying schedulable — CRS retry handles cooldown';
    } else if (overloaded) {
      reason = 'overloaded(529), staying schedulable — CRS retry handles cooldown';
    }
    return { a, cur, desired, reason, soft: false, sw, u5: u5 ?? '?', rl, overloaded };
  });
}

function decideConservative(accts, nowMs) {
  const decisions = accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage;
    const updMs = cu.updatedAt ? Date.parse(cu.updatedAt) : NaN;
    const cuFresh = Number.isFinite(updMs) && (nowMs - updMs) / 60000 < FRESH_MIN;
    const fresh = !!lu || cuFresh;
    // Only use claudeUsage as fallback when it's actually fresh (<FRESH_MIN).
    // Stale cache (hours/days old) must never gate scheduling decisions.
    const u5 = lu?.u5 ?? (cuFresh ? cu.fiveHour?.utilization : null);
    const u7 = lu?.u7 ?? (cuFresh ? cu.sevenDay?.utilization : null);
    const u7o = lu?.u7o ?? (cuFresh ? cu.sevenDayOpus?.utilization : null);
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;
    const rl = genuineRateLimit(a, nowMs);
    const overloaded = genuineOverload(a, nowMs);
    const weeklyEndMs = a.weeklyRateLimitEndAt ? Date.parse(a.weeklyRateLimitEndAt) : NaN;
    const weeklyActive = Number.isFinite(weeklyEndMs) && weeklyEndMs > nowMs;
    const hardHold = hardHoldReason(a, nowMs);

    let desired = true;
    let reason = 'active';
    let soft = false;
    if (hardHold) {
      desired = false;
      reason = hardHold;
      soft = false;
    } else if (weeklyActive) {
      desired = false;
      reason = `weekly-exhausted until ${a.weeklyRateLimitEndAt?.slice(0, 16)}`;
      soft = false;
    } else if (rl) {
      reason = `rate-limited, staying schedulable — CRS retry handles cooldown`;
    } else if (overloaded) {
      reason = `overloaded(529), staying schedulable — CRS retry handles cooldown`;
    }
    return { a, cur, desired, reason, soft, sw, u5: u5 ?? '?', rl, overloaded };
  });

  let usable = decisions.filter((d) => d.desired && !d.overloaded).length;
  if (usable < FLOOR) {
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 50);
    const revertable = decisions
      .filter((d) => d.desired === false && d.soft && !d.overloaded)
      .sort((x, y) => unum(x) - unum(y));
    for (const d of revertable) {
      if (usable >= FLOOR) break;
      d.desired = true;
      d.reason = `FLOOR(${FLOOR}): held schedulable despite ${d.reason}`;
      usable++;
    }
    const final = decisions.filter((d) => d.desired && !d.overloaded).length;
    if (final < FLOOR)
      log(`WARNING: only ${final} usable account(s) (< floor ${FLOOR}) — pool is capacity-constrained`);
  }

  const byUuid = {};
  for (const d of decisions) {
    const uuid = d.a.subscriptionInfo?.organizationUuid;
    if (!uuid || !d.desired) continue;
    const bucket = byUuid[uuid] || (byUuid[uuid] = []);
    bucket.push(d);
  }
  for (const group of Object.values(byUuid)) {
    if (group.length < 2) continue;
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 50);
    group.sort((x, y) => (x.sw === 'allowed' ? 0 : 1) - (y.sw === 'allowed' ? 0 : 1) || unum(x) - unum(y));
    for (const d of group.slice(1)) {
      d.desired = false;
      d.reason = `dedup: same org ${group[0].a.subscriptionInfo.organizationUuid.slice(0, 8)} as ${group[0].a.name}`;
    }
  }
  return decisions;
}

function dedupByLogin(decisions) {
  const byLogin = {};
  for (const d of decisions) {
    const login = accountVaultKey(d.a);
    if (!login || !d.desired) continue;
    const bucket = byLogin[login] || (byLogin[login] = []);
    bucket.push(d);
  }
  for (const [login, group] of Object.entries(byLogin)) {
    if (group.length < 2) continue;
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 100);
    group.sort((x, y) => unum(x) - unum(y));
    for (const d of group.slice(1)) {
      d.desired = false;
      d.reason = `dedup: same login ${login} as ${group[0].a.name}`;
    }
  }
  return decisions;
}

function decide(accts) {
  const nowMs = Date.now();
  if (CRS_POLICY === 'max-out' || CRS_POLICY === 'maxout') {
    return decideMaxOut(accts, nowMs);
  }
  return decideConservative(accts, nowMs);
}

// ── main ─────────────────────────────────────────────────────────────────────
// ── reset watcher ─────────────────────────────────────────────────────────────
// Re-enables accounts whose 7-day quota window has reset according to:
//   1. weeklyRateLimitEndAt stored in CRS (set by relay when it receives the
//      authoritative retry-after header from Anthropic)
//   2. live resets_at from /oauth/usage (stored in _liveUsage.resets7)
// Called every daemon tick — cheap because it's just a timestamp comparison.
async function reEnableResetAccounts(auth, accts) {
  const now = Date.now();
  let reenabled = 0;
  for (const a of accts) {
    if (a.schedulable !== false) continue; // already on
    if (hardHoldReason(a, now)) continue;

    // Source 1: weeklyRateLimitEndAt written by CRS relay from retry-after header
    const weeklyEndMs = a.weeklyRateLimitEndAt ? Date.parse(a.weeklyRateLimitEndAt) : NaN;
    const weeklyExpired = Number.isFinite(weeklyEndMs) && weeklyEndMs <= now;

    // Source 2: live resets_at from /oauth/usage (most authoritative)
    const liveResets7 = a._liveUsage?.resets7;
    const liveResetMs = liveResets7 ? Date.parse(liveResets7) : NaN;
    const liveExpired = Number.isFinite(liveResetMs) && liveResetMs <= now;

    // Source 3: live u7 below threshold — quota genuinely recovered
    const liveU7 = a._liveUsage?.u7;
    const liveRecovered = typeof liveU7 === 'number' && liveU7 < ON_7D;

    if (!weeklyExpired && !liveExpired && !liveRecovered) continue;

    const reason = liveRecovered
      ? `live u7=${liveU7}% < on-threshold ${ON_7D}%`
      : liveExpired
        ? `live resets_at=${liveResets7} passed`
        : `weeklyRateLimitEndAt=${a.weeklyRateLimitEndAt} passed`;

    if (!MUTATIONS_ENABLED) {
      log(`[dry] reset-watcher: would re-enable ${a.name} (${reason})`);
      continue;
    }
    const put = await jfetch(`/admin/claude-accounts/${a.id}/toggle-schedulable`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ schedulable: true }),
    });
    log(`reset-watcher: re-enabled ${a.name} → schedulable=true (${reason}) [HTTP ${put.status}]`);
    reenabled++;
  }
  return reenabled;
}

function loadMagicLinkState() {
  try {
    return existsSync(MAGIC_LINK_STATE_PATH) ? JSON.parse(readFileSync(MAGIC_LINK_STATE_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}
function saveMagicLinkState(s) {
  if (!MUTATIONS_ENABLED) return;
  try {
    mkdirSync(dirname(MAGIC_LINK_STATE_PATH), { recursive: true });
    const tmp = MAGIC_LINK_STATE_PATH + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, MAGIC_LINK_STATE_PATH);
  } catch {}
}

function accountVaultEmail(a) {
  return accountVaultKey(a) || a.email || a.name;
}

async function dispatchMagicLinkForStale(accts, decisions) {
  if (!IS_MACOS) return;
  const state = loadMagicLinkState();
  const nowMs = Date.now();
  const candidates = accts
    .map((a) => {
      const key = accountVaultKey(a);
      if (!key) return null;
      const decision = decisions?.find((d) => d.a.id === a.id);
      const tokenExp = Number(a.tokenExpiresAt || a.expiresAt || 0);
      const tokenStale = !Number.isFinite(tokenExp) || tokenExp <= 0 || tokenExp <= nowMs + TOKEN_MIN_FRESH_MS;
      const noLiveData = !a._liveUsage;
      const last = state[key];
      const dispatchedRecently = last && nowMs - last.dispatchedAt < MAGIC_LINK_COOLDOWN_MS;
      if (dispatchedRecently) return null;
      if (!tokenStale) return null; // fresh token, skip magic-link
      return { a, key, reason: tokenStale ? 'token-expired' : 'no-live-data', need: a._needsReauth || noLiveData };
    })
    .filter(Boolean);

  if (!candidates.length) return 0;
  for (const c of candidates.slice(0, MAX_MAGIC_LINKS_PER_TICK)) {
    const email = accountVaultEmail(c.a);
    log(`magic-link: dispatching for ${c.a.name} (${c.reason})`);
    if (!MUTATIONS_ENABLED) {
      log(`[dry] magic-link: would spawn rotate.mjs --magic-link --to ${email}`);
      state[c.key] = { dispatchedAt: nowMs, email, reason: c.reason };
      continue;
    }
    const rotatePath = join(__dirname, 'rotate.mjs');
    const child = spawn(process.execPath, [rotatePath, '--magic-link', '--force', '--to', email], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        CRS_DRY: undefined,
        CLAUDE_ROTATION_MAGIC_LINK_AUTO: '1',
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH || ''}`,
        CLAUDE_ROT_MAGIC_POLL_MS: process.env.CLAUDE_ROT_MAGIC_POLL_MS || '180000',
        CLAUDE_ROT_MAGIC_POLL_INTERVAL_MS: process.env.CLAUDE_ROT_MAGIC_POLL_INTERVAL_MS || '2500',
        CLAUDE_ROT_MAGIC_AUTHORIZE_WAIT_MS: process.env.CLAUDE_ROT_MAGIC_AUTHORIZE_WAIT_MS || '45000',
      },
    });
    child.unref();
    const pid = child.pid;
    child.stdout.on('data', (d) => log(`magic-link[${pid}]: ${d.toString().trim()}`));
    child.stderr.on('data', (d) => log(`magic-link[${pid}]: ${d.toString().trim()}`));
    child.on('error', (e) => log(`magic-link[${pid}]: spawn error ${e.message}`));
    child.on('exit', (code) => log(`magic-link[${pid}]: exited code=${code}`));
    state[c.key] = { dispatchedAt: nowMs, email, reason: c.reason, pid };
  }
  saveMagicLinkState(state);
  return candidates.slice(0, MAX_MAGIC_LINKS_PER_TICK).length;
}

async function main() {
  // patch 048-throttle: simple p-limit-style batched concurrency.
  async function pLimitUsage(accts) {
    const CONCURRENCY = Number(process.env.CRS_PRIORITY_CONCURRENCY || 4);
    let i = 0;
    async function worker() {
      while (i < accts.length) {
        const a = accts[i++];
        a._liveUsage = await liveUsage(accountVaultKey(a));
      }
    }
    const workers = [];
    for (let k = 0; k < Math.min(CONCURRENCY, accts.length); k++) workers.push(worker());
    await Promise.all(workers);
  }

  const holdPath = join(homedir(), '.claude', 'state', 'crs-activate-all-hold');
  if (existsSync(holdPath) && !STATUS && !DRY) {
    log('activate-all hold active — skipping disable tick (remove ~/.claude/state/crs-activate-all-hold to resume)');
    return;
  }
  if (C.enabled === false && !STATUS && !DRY) {
    log('crs.enabled=false — skipping tick');
    return;
  }
  const auth = await login();
  let accts = await getAccounts(auth);
  if (!accts.length) {
    log('no active claude accounts');
    return;
  }
  const cleared = await clearStaleCooldowns(auth, accts);
  if (cleared) {
    accts = await getAccounts(auth);
    log(`stale-cooldown: cleared ${cleared} account(s), reloaded pool`);
    const reenabled = await recoverSchedulableAfterClear(auth, accts);
    if (reenabled) {
      accts = await getAccounts(auth);
      log(`stale-cooldown: re-enabled ${reenabled} schedulable account(s)`);
    }
  }
  // Authoritative quota: query Anthropic /oauth/usage directly per account.
  // patch 048-throttle: batched concurrency (4 at a time) to stay well under
  // the per-IP rate limit while still parallelizing the read-only calls.
  await pLimitUsage(accts);
  const liveN = accts.filter((a) => a._liveUsage).length;
  const liveUsageById = new Map(accts.map((a) => [a.id, a._liveUsage]));
  const recovered = await clearRecoveredRateLimits(auth, accts);
  if (recovered) {
    accts = await getAccounts(auth);
    for (const a of accts) a._liveUsage = liveUsageById.get(a.id) || null;
    log(`live-quota: cleared ${recovered} recovered rate-limit hold(s)`);
  }

  // Reconcile the persisted weekly hold against fresh live usage. A historical
  // retry-after must not keep an account disabled after /oauth/usage proves the
  // weekly window has headroom again.
  if (MUTATIONS_ENABLED) {
    for (const a of accts) {
      const resets7 = a._liveUsage?.resets7;
      const u7 = a._liveUsage?.u7;
      if (typeof u7 !== 'number') continue;
      if (u7 >= 90 && resets7 && !a.weeklyRateLimitEndAt) {
        await jfetch(`/admin/claude-accounts/${a.id}`, {
          method: 'PUT',
          headers: auth,
          body: JSON.stringify({ weeklyRateLimitEndAt: resets7 }),
        }).catch(() => {});
        a.weeklyRateLimitEndAt = resets7;
      } else if (u7 < ON_7D && a.weeklyRateLimitEndAt) {
        await jfetch(`/admin/claude-accounts/${a.id}`, {
          method: 'PUT',
          headers: auth,
          body: JSON.stringify({ weeklyRateLimitEndAt: null }),
        }).catch(() => {});
        log(`${a.name}: cleared stale weekly hold (live u7=${u7}% < ${ON_7D}%)`);
        a.weeklyRateLimitEndAt = null;
      }
    }
  }

  // The policy decision below owns both enable and disable transitions. A
  // separate reset-watcher mutation caused duplicate logins to flap true then
  // false every tick before login de-duplication was applied.
  const decisions = decide(accts);

  // Auto-magic-link for accounts with stale tokens / no live usage data
  // (Mac-only; Linux handles token refresh differently.)
  const magicLinks = PRIORITY_MAGIC_LINK_AUTHORITY ? await dispatchMagicLinkForStale(accts, decisions) : 0;
  if (magicLinks > 0) log(`magic-link: ${magicLinks} dispatch(s) this tick`);

  if (STATUS) {
    console.log(`CRS pool @ ${BASE} — ${decisions.filter((d) => d.cur).length}/${decisions.length} schedulable`);
    for (const d of decisions.sort((a, b) => (a.cur === b.cur ? 0 : a.cur ? -1 : 1))) {
      const flags = [d.rl && 'RL', d.overloaded && 'OVERLOAD', d.sw].filter(Boolean).join(' ');
      console.log(
        `  ${d.cur ? '●' : '○'} ${d.a.name.padEnd(26)} sched=${d.cur} 5h=${String(d.u5).padStart(3)}%  ${flags}`,
      );
    }
    return;
  }

  let changed = 0;
  for (const d of decisions) {
    if (d.desired === d.cur) continue;
    changed++;
    if (!MUTATIONS_ENABLED) {
      log(`[dry] ${d.a.name}: ${d.cur}→${d.desired} (${d.reason})`);
      continue;
    }
    const put = await jfetch(`/admin/claude-accounts/${d.a.id}/toggle-schedulable`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ schedulable: d.desired }),
    });
    log(`${d.a.name}: schedulable ${d.cur}→${d.desired} (${d.reason}) [HTTP ${put.status}]`);
  }
  const on = decisions.filter((d) => d.desired).map((d) => d.a.name);
  const off = decisions.filter((d) => !d.desired).map((d) => `${d.a.name}(${d.sw || (d.rl ? 'RL' : '?')})`);
  log(
    `tick: ${changed} change(s). live-quota=${liveN}/${decisions.length} schedulable=${on.length} [${on.join(',')}] | off=[${off.join(',')}]`,
  );
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
