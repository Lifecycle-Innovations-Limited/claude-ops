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
// LIVE QUOTA POLLER (60-120s): hybrid header-derived (CRS rateLimit* from relay
// upstream headers) + targeted /oauth/usage probe per account (throttled, cached).
// Clears stale cooldowns on rateLimitResetAt expiry. Feeds live headroom back
// to CRS scheduler via account PUT for accurate LB/concurrency.
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
//   floor, freshMinutes, weeklyReconcile. Per-account crsAccountName (or
//   crs.nameByVaultKey) maps vault keys to CRS admin account names for token-feed +
//   live quota lookup. Admin password resolves from (1) $CRS_ADMIN_PASSWORD, (2) the
//   configured env var, (3) credential-store.
//
// WEEKLY-CAP RECONCILIATION (crs.weeklyReconcile, default on; $CRS_WEEKLY_RECONCILE=0
// to disable): some CRS deployments persist a weeklyRateLimitEndAt timestamp on an
// account once a genuine 7-day cap is hit, and hold schedulable=false until it
// passes. That timestamp can go stale (wrong upstream reset, clock skew, a reset
// that already happened) and park a perfectly usable account. Each tick this daemon
// reconciles the persisted hold against live utilization: if the account's real 7d
// utilization has dropped back under `on7d`, the hold is cleared even though the
// timestamp hasn't passed yet. It also records a hold when live utilization proves a
// genuine breach of `off7d` and the source data included an authoritative reset time.
// Entirely a no-op on accounts/deployments that never set weeklyRateLimitEndAt.
//
// FLOOR (crs.floor / $CRS_FLOOR, default 2): minimum number of accounts the
// conservative policy will keep schedulable even if that means reverting some
// soft (utilization/sessionWindow) deprioritizations. Tune this to your own pool
// size — the default is a conservative floor for a small pool, not a target.
//
// BACKEND (crs.backend / $CRS_PRIORITY_BACKEND): crs (default) | local (file seat-state).
// CLI:  (none)=one live tick · --dry-run=log decisions, no writes · --status=print
//       current schedulable + utilization table and exit · --once (alias for tick).

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
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
import { resolveAccountsBackend, dualWriteEnabled, mergeSeatsIntoState } from './ops-accounts-backend.mjs';

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
// Dual-mode: backend=crs | local | auto (OPS_ACCOUNTS_BACKEND)
const SEAT_STATE_PATH = process.env.CRS_SEAT_STATE_PATH || join(DATA_DIR, 'seat-state', 'claude-priority.json');
const OPS_SEAT_STATE_PATH =
  process.env.OPS_ACCOUNTS_STATE_PATH || join(DATA_DIR, 'account-rotation', 'seat-state.json');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-priority] ${m}`);

// ── config ───────────────────────────────────────────────────────────────────
const cfg = loadRotationConfig();
const C = cfg.crs || {};
const BACKEND_WANT = resolveAccountsBackend({
  env: process.env,
  cfgBackend: process.env.CRS_PRIORITY_BACKEND || C.backend || 'auto',
});
// local|file → local tick; crs → CRS only; auto → CRS with local fallback
const BACKEND = BACKEND_WANT === 'local' ? 'local' : BACKEND_WANT === 'crs' ? 'crs' : 'auto';

const { vaultKeyByCrsName } = buildCrsNameMaps(cfg);
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

const BASE = crsBaseUrl(cfg);
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const OFF_5H = num(process.env.CRS_OFF_5H ?? C.off5h, 90);
const OFF_7D = num(process.env.CRS_OFF_7D ?? C.off7d, 95);
const ON_5H = num(process.env.CRS_ON_5H ?? C.on5h, 70);
const ON_7D = num(process.env.CRS_ON_7D ?? C.on7d, 85);
// Minimum-schedulable-accounts safety margin. Default is intentionally small and
// generic — set crs.floor (or $CRS_FLOOR) to whatever fraction makes sense for your
// own pool size; do not assume this default fits a large fleet.
const FLOOR = num(process.env.CRS_FLOOR ?? C.floor, 2);
const FRESH_MIN = num(process.env.CRS_FRESH_MIN ?? C.freshMinutes, 15);
const CRS_POLICY = crsPolicy(cfg);
const TOKEN_MIN_FRESH_MS = num(process.env.CRS_TOKEN_MIN_FRESH_MS ?? C.tokenMinFreshMs, 5 * 60_000);
const STALE_RL_MAX_MINS = num(process.env.CRS_STALE_RL_MINUTES, 300);
const LIVE_USAGE_TTL_MS = num(process.env.CRS_LIVE_USAGE_TTL_MS, 90_000);
// Opt-in-by-default, safe-no-op guard: only touches accounts that already carry a
// weeklyRateLimitEndAt field, so a fresh install with no such field never sees this
// reconciler do anything. Set crs.weeklyReconcile=false / $CRS_WEEKLY_RECONCILE=0
// to disable outright.
const WEEKLY_RECONCILE = process.env.CRS_WEEKLY_RECONCILE === '0' ? false : C.weeklyReconcile !== false;
const IS_LINUX = platform() === 'linux';
const liveUsageCache = new Map();
const LINUX_CRED_PATH = crsFileVaultPath(cfg);
const CRS_CONTAINER = process.env.CRS_CONTAINER || C.containerName || 'crs-claude-relay-1';

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

// ── live per-account quota poller (hybrid header + targeted probe) ──────────────
// 60-120s friendly: CRS /admin accounts gives header-derived rateLimitStatus etc;
// we do targeted read-only /oauth/usage probe (via stored OAuth) for u5/u7 headroom.
// Hybrid: body + response headers. TTL + throttle. Falls back to cache on error.
// Never drives re-enable from stale; feeds headroom to scheduler after collection.
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
  if (a.status === 'error' && accountTokenFresh(a, now)) return true;

  const inspect = (st, resetAtFallback) => {
    if (!st?.isRateLimited) return false;
    const resetAt = st.resetAt || resetAtFallback;
    const resetMs = resetAt ? Date.parse(resetAt) : NaN;
    const mins = st.minutesRemaining ?? null;
    if (Number.isFinite(resetMs) && resetMs <= now) return true;
    if (mins === 0) return true;
    if (typeof mins === 'number' && mins > STALE_RL_MAX_MINS) return true;
    if (accountTokenFresh(a, now) && typeof mins === 'number' && mins > 60) return true;
    return false;
  };

  // Explicit: clear stale cooldowns when rateLimitResetAt (or embedded resetAt) has passed
  if (resetAtPassed(a.rateLimitStatus, a.rateLimitResetAt, now)) return true;
  if (resetAtPassed(a.opusRateLimitStatus, a.opusRateLimitStatus?.resetAt, now)) return true;

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

function resetAtPassed(st, fallback, now = Date.now()) {
  const resetAt = st?.resetAt || fallback;
  if (!resetAt) return false;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) && ms <= now;
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
    // Hybrid: body (utilization) + headers (rate reset signals when present)
    const headers = {};
    r.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const d = await r.json();
    const data = {
      u5: d?.five_hour?.utilization ?? null,
      u7: d?.seven_day?.utilization ?? null,
      resets5: d?.five_hour?.resets_at ?? null,
      // ISO string when the API supplies it — used by the weekly-cap reconciler
      // below to record/clear an authoritative reset time.
      resets7: d?.seven_day?.resets_at ?? null,
      // capture any reset header for hybrid RL detection if body alone insufficient
      resetHeader: headers['retry-after'] || headers['anthropic-ratelimit-unified-tokens-reset'] || null,
    };
    liveUsageCache.set(email, { at: Date.now(), data });
    return data;
  } catch {
    return cached?.data ?? null;
  }
}

function authenticationUnavailable(a) {
  const status = String(a.status || '').toLowerCase();
  const detail = [a.lastError, a.error, a.errorMessage, a.statusMessage, a.statusReason].filter(Boolean).join(' ');
  return (
    status === 'auth_repair' ||
    /\b(401|403)\b|authentication[_ -]?error|invalid (api )?key|invalid.*token|revoked/i.test(detail)
  );
}

function genuineRateLimit(a, now = Date.now()) {
  const flagged = !!a.rateLimitStatus?.isRateLimited || !!a.opusRateLimitStatus?.isRateLimited;
  return flagged && !rateLimitLooksStale(a, now);
}

function liveQuotaExhaustion(a, now = Date.now()) {
  const usage = a._liveUsage;
  if (!usage) return null;
  const windows = [
    { name: '5h', utilization: usage.u5, resetsAt: usage.resets5 },
    { name: '7d', utilization: usage.u7, resetsAt: usage.resets7 },
  ].filter(({ utilization, resetsAt }) => {
    const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
    return typeof utilization === 'number' && utilization >= 100 && Number.isFinite(resetMs) && resetMs > now;
  });
  if (!windows.length) return null;
  const resetAt = new Date(Math.min(...windows.map(({ resetsAt }) => Date.parse(resetsAt)))).toISOString();
  return { windows: windows.map(({ name }) => name), resetAt };
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

// A persisted weekly-cap hold (see WEEKLY-CAP RECONCILIATION above). Unlike the
// soft utilization/sessionWindow signals, this is treated as a hard hold — the
// FLOOR safety margin never reverts it, since it represents a genuine 7-day
// exhaustion, not a heuristic guess.
function weeklyCapActive(a, now = Date.now()) {
  const endMs = a.weeklyRateLimitEndAt ? Date.parse(a.weeklyRateLimitEndAt) : NaN;
  return Number.isFinite(endMs) && endMs > now;
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
    const resetPassed =
      resetAtPassed(a.rateLimitStatus, a.rateLimitResetAt, now) ||
      resetAtPassed(a.opusRateLimitStatus, a.opusRateLimitStatus?.resetAt, now);
    if (DRY) {
      log(`[dry] clear stale RL ${a.name} (mins=${mins}${resetPassed ? ', resetAt passed' : ''})`);
      cleared++;
      continue;
    }
    const res = await jfetch(`/admin/claude-accounts/${a.id}/reset-status`, { method: 'POST', headers: auth });
    if (res.status >= 200 && res.status < 300) {
      cleared++;
      log(
        `${a.name}: cleared stale RL/error cache (was mins=${mins}${resetPassed ? ' — rateLimitResetAt passed' : ''})`,
      );
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
    if (!accountTokenFresh(a, now)) continue;
    if (DRY) {
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

// Feed live headroom (from targeted quota probe) back into CRS account record.
// This supplies the scheduler with fresh per-account utilization/headroom so
// load-balancing, concurrency caps, and selection use authoritative 5h/7d numbers
// instead of stale claudeUsage cache.
async function feedLiveHeadroom(auth, a, lu) {
  if (!lu || DRY) return false;
  const update = {
    claudeUsage: {
      fiveHour: { utilization: lu.u5 ?? null, updatedAt: new Date().toISOString() },
      sevenDay: { utilization: lu.u7 ?? null, updatedAt: new Date().toISOString() },
    },
  };
  try {
    const r = await jfetch(`/admin/claude-accounts/${a.id}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify(update),
    });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// ── policy ───────────────────────────────────────────────────────────────────
const WARN_STATUSES = new Set(['allowed_warning', 'warning', 'blocked', 'exceeded', 'limited', 'stopped']);

function decideMaxOut(accts, nowMs) {
  return accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage;
    const u5 = lu?.u5 ?? cu.fiveHour?.utilization;
    const u7 = lu?.u7 ?? cu.sevenDay?.utilization;
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;
    const unavailable = authenticationUnavailable(a);
    const quota = liveQuotaExhaustion(a, nowMs);
    const rl = Boolean(quota);
    const overloaded = genuineOverload(a, nowMs);

    let desired = true;
    let reason = `max-out (5h=${u5 ?? '?'} 7d=${u7 ?? '?'} sw=${sw ?? 'none'})`;
    if (unavailable) {
      desired = false;
      reason = 'authentication unavailable; staged re-auth required';
    } else if (quota) {
      desired = false;
      reason = `quota exhausted (${quota.windows.join('+')}); auto-reschedule ${quota.resetAt}`;
    } else if (overloaded) {
      reason = 'overloaded(529), staying schedulable';
    }
    return {
      a,
      cur,
      desired,
      reason,
      soft: false,
      sw,
      u5: u5 ?? '?',
      u7: u7 ?? '?',
      unavailable,
      rl,
      overloaded,
      quota,
    };
  });
}

function decideConservative(accts, nowMs) {
  const decisions = accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage;
    const u5 = lu?.u5 ?? cu.fiveHour?.utilization;
    const u7 = lu?.u7 ?? cu.sevenDay?.utilization;
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;
    const unavailable = authenticationUnavailable(a);
    const quota = liveQuotaExhaustion(a, nowMs);
    const rl = Boolean(quota);
    const overloaded = genuineOverload(a, nowMs);

    let desired = true;
    let reason = 'scheduled unless live quota is exhausted';
    let soft = false;
    if (unavailable) {
      desired = false;
      reason = 'authentication unavailable; staged re-auth required';
    } else if (quota) {
      desired = false;
      reason = `quota exhausted (${quota.windows.join('+')}); auto-reschedule ${quota.resetAt}`;
    } else if (overloaded) {
      reason = 'overloaded(529), staying schedulable';
    }
    return { a, cur, desired, reason, soft, sw, u5: u5 ?? '?', u7: u7 ?? '?', unavailable, rl, overloaded, quota };
  });

  let usable = decisions.filter((d) => d.desired && !d.unavailable && !d.rl && !d.overloaded).length;
  if (usable < FLOOR) {
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 50);
    const revertable = decisions
      .filter((d) => d.desired === false && d.soft && !d.unavailable && !d.rl && !d.overloaded)
      .sort((x, y) => unum(x) - unum(y));
    for (const d of revertable) {
      if (usable >= FLOOR) break;
      d.desired = true;
      d.reason = `FLOOR(${FLOOR}): held schedulable despite ${d.reason}`;
      usable++;
    }
    const final = decisions.filter((d) => d.desired && !d.unavailable && !d.rl && !d.overloaded).length;
    if (final < FLOOR)
      log(`WARNING: only ${final} usable account(s) (< floor ${FLOOR}) — pool is capacity-constrained`);
  }

  const byUuid = {};
  for (const d of decisions) {
    const uuid = d.a.subscriptionInfo?.organizationUuid;
    if (!uuid || !d.desired) continue;
    (byUuid[uuid] ||= []).push(d);
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
    (byLogin[login] ||= []).push(d);
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
    return dedupByLogin(decideMaxOut(accts, nowMs));
  }
  return decideConservative(accts, nowMs);
}

// ── local seat-state backend (backend=local) ─────────────────────────────────
function loadSeatStateFile() {
  try {
    if (!existsSync(SEAT_STATE_PATH)) return { seats: {}, updatedAt: null };
    return JSON.parse(readFileSync(SEAT_STATE_PATH, 'utf8'));
  } catch {
    return { seats: {}, updatedAt: null };
  }
}

function writeSeatStateFile(payload) {
  mkdirSync(dirname(SEAT_STATE_PATH), { recursive: true });
  writeFileSync(SEAT_STATE_PATH, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
}

/** Build synthetic CRS-shaped accounts from rotation config vault keys. */
function loadLocalAccounts() {
  const prev = loadSeatStateFile();
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const out = [];
  for (const a of accounts) {
    if (!a || typeof a !== 'object') continue;
    if (a.disabled || a.autoAuthDisabled) continue;
    const email = a.email || a.label;
    if (!email || typeof email !== 'string') continue;
    const key = email.trim().toLowerCase();
    const tok = readOauthToken(key);
    const prevSeat = prev.seats?.[key] || {};
    let expiresAt = 0;
    if (tok?.expiresAt) expiresAt = Date.parse(tok.expiresAt);
    else if (tok?.expiry_date) expiresAt = Number(tok.expiry_date);
    else if (tok?.expires_at) expiresAt = Date.parse(tok.expires_at);
    else expiresAt = Number(prevSeat.tokenExpiresAt || 0);
    out.push({
      id: key,
      name: key,
      email: key,
      schedulable: prevSeat.schedulable !== false,
      tokenExpiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      claudeUsage: prevSeat.claudeUsage || null,
      sessionWindow: prevSeat.sessionWindow || null,
      rateLimitStatus: prevSeat.rateLimitStatus || null,
      overloadStatus: prevSeat.overloadStatus || null,
      weeklyRateLimitEndAt: prevSeat.weeklyRateLimitEndAt || null,
      subscriptionInfo: prevSeat.subscriptionInfo || null,
      _local: true,
    });
  }
  return out;
}

function persistLocalDecisions(decisions) {
  const seats = {};
  for (const d of decisions) {
    const key = accountVaultKey(d.a);
    seats[key] = {
      schedulable: d.desired,
      reason: d.reason,
      u5: d.u5,
      sw: d.sw,
      tokenExpiresAt: d.a.tokenExpiresAt || null,
      claudeUsage: d.a._liveUsage
        ? {
            fiveHour: { utilization: d.a._liveUsage.u5 ?? null, updatedAt: new Date().toISOString() },
            sevenDay: { utilization: d.a._liveUsage.u7 ?? null, updatedAt: new Date().toISOString() },
            updatedAt: new Date().toISOString(),
          }
        : d.a.claudeUsage || null,
      updatedAt: new Date().toISOString(),
    };
  }
  const payload = {
    backend: 'local',
    updatedAt: new Date().toISOString(),
    seatStatePath: SEAT_STATE_PATH,
    seats,
  };
  if (!DRY) writeSeatStateFile(payload);
  return payload;
}

async function runLocalTick() {
  log(`backend=local seat-state=${SEAT_STATE_PATH}`);
  let accts = loadLocalAccounts();
  if (!accts.length) {
    log('no local accounts (config.accounts empty or all disabled)');
    return;
  }
  let liveN = 0;
  for (const a of accts) {
    const key = accountVaultKey(a);
    a._liveUsage = await liveUsage(key);
    if (a._liveUsage) liveN++;
    await new Promise((r) => setTimeout(r, 150));
  }
  const decisions = decide(accts);
  if (STATUS) {
    console.log(
      `LOCAL seats @ ${SEAT_STATE_PATH} — ${decisions.filter((d) => d.cur).length}/${decisions.length} schedulable`,
    );
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
    if (DRY) log(`[dry] ${d.a.name}: ${d.cur}→${d.desired} (${d.reason})`);
    else log(`${d.a.name}: schedulable ${d.cur}→${d.desired} (${d.reason}) [local]`);
  }
  persistLocalDecisions(decisions);
  const on = decisions.filter((d) => d.desired).map((d) => d.a.name);
  const off = decisions.filter((d) => !d.desired).map((d) => d.a.name);
  log(
    `tick(local): ${changed} change(s). live-quota=${liveN}/${decisions.length} schedulable=${on.length} [${on.join(',')}] | off=[${off.join(',')}] wrote=${!DRY}`,
  );
}

/** Mirror CRS decisions into provider-shaped seat-state (ops-accounts dual-write). */
function dualWriteFromCrsDecisions(decisions) {
  if (!dualWriteEnabled()) return;
  if (DRY) {
    log(`[dry] dual-write ${decisions.length} decision(s) → ${OPS_SEAT_STATE_PATH}`);
    return;
  }
  try {
    let state = { version: 1, providers: {} };
    if (existsSync(OPS_SEAT_STATE_PATH)) {
      try {
        state = JSON.parse(readFileSync(OPS_SEAT_STATE_PATH, 'utf8'));
      } catch {
        /* keep empty */
      }
    }
    const seats = decisions.map((d) => {
      const email = d.a?.subscriptionInfo?.email || vaultKeyByCrsName[d.a?.name] || d.a?.name || null;
      const u5 = d.u5;
      const u7 = d.a?._liveUsage?.u7;
      return {
        email,
        schedulable: d.desired !== false,
        util5h: typeof u5 === 'number' ? u5 : null,
        util7d: typeof u7 === 'number' ? u7 : null,
      };
    });
    const next = mergeSeatsIntoState(state, seats, { provider: 'claude' });
    mkdirSync(dirname(OPS_SEAT_STATE_PATH), { recursive: true });
    const tmp = OPS_SEAT_STATE_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, OPS_SEAT_STATE_PATH);
    log(`dual-write: mirrored ${seats.filter((s) => s.email).length} seat(s) → ${OPS_SEAT_STATE_PATH}`);
  } catch (e) {
    log(`dual-write skipped: ${e.message}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`backend want=${BACKEND_WANT}`);
  if (BACKEND_WANT === 'local' || BACKEND === 'local' || BACKEND === 'file') {
    await runLocalTick();
    return;
  }
  try {
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
    // Live per-account quota poller (60-120s cadence): hybrid of CRS-provided
    // rateLimitStatus / sessionWindow / overload (populated from upstream response
    // headers in the relay) + targeted /oauth/usage probe for precise u5/u7 headroom.
    // Throttled sequential probes keep it polite under 60-120s window; feeds headroom
    // to scheduler after.
    let liveN = 0;
    for (const a of accts) {
      const key = accountVaultKey(a);
      a._liveUsage = await liveUsage(key);
      if (a._liveUsage) liveN++;
      // Throttle ~150ms between probes (fits 60-120s hybrid header+probe cadence for ~13 accts)
      await new Promise((r) => setTimeout(r, 150));
    }
    // Feed fresh headroom/utilization from targeted probes into CRS so scheduler
    // (unifiedClaudeScheduler etc) sees live quota headroom for selection/LB.
    let fed = 0;
    for (const a of accts) {
      if (a._liveUsage && (await feedLiveHeadroom(auth, a, a._liveUsage))) fed++;
    }
    if (fed) log(`headroom feed: updated ${fed} account(s) in CRS for scheduler`);

    // Weekly-cap reconciliation (see WEEKLY-CAP RECONCILIATION in the header comment).
    // Safe no-op on any account/deployment that never sets weeklyRateLimitEndAt.
    if (WEEKLY_RECONCILE && !DRY && !STATUS) {
      for (const a of accts) {
        const u7 = a._liveUsage?.u7;
        const resets7 = a._liveUsage?.resets7;
        if (typeof u7 !== 'number') continue;
        if (u7 >= 100 && resets7 && !a.weeklyRateLimitEndAt) {
          const put = await jfetch(`/admin/claude-accounts/${a.id}`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ weeklyRateLimitEndAt: resets7 }),
          }).catch(() => null);
          if (put && put.status >= 200 && put.status < 300) {
            a.weeklyRateLimitEndAt = resets7;
            log(`${a.name}: recorded weekly-cap hold until ${resets7} (live 7d=${u7}%)`);
          }
        } else if (u7 < ON_7D && a.weeklyRateLimitEndAt) {
          const put = await jfetch(`/admin/claude-accounts/${a.id}`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ weeklyRateLimitEndAt: null }),
          }).catch(() => null);
          if (put && put.status >= 200 && put.status < 300) {
            log(`${a.name}: cleared stale weekly-cap hold (live 7d=${u7}% < ${ON_7D}%)`);
            a.weeklyRateLimitEndAt = null;
          }
        }
      }
    }

    const decisions = decide(accts);

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
      if (DRY) {
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
    const off = decisions
      .filter((d) => !d.desired)
      .map((d) => `${d.a.name}(${d.unavailable ? 'AUTH' : d.sw || (d.rl ? 'RL' : '?')})`);
    if (!on.length) log('WARNING: all active Claude accounts unavailable; leaving pool honestly unschedulable');
    log(
      `tick: ${changed} change(s). live-quota=${liveN}/${decisions.length} schedulable=${on.length} [${on.join(',')}] | off=[${off.join(',')}]`,
    );
    dualWriteFromCrsDecisions(decisions);
  } catch (e) {
    if (BACKEND_WANT === 'crs') {
      log(`ERROR: ${e.message}`);
      process.exit(1);
    }
    log(`CRS unavailable (${e.message}) — falling back to local seat-state`);
    await runLocalTick();
  }
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
