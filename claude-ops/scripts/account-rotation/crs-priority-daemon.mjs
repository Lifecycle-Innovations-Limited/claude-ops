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

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
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

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-priority] ${m}`);

// ── config ───────────────────────────────────────────────────────────────────
const cfg = loadRotationConfig();
const C = cfg.crs || {};
const { vaultKeyByCrsName } = buildCrsNameMaps(cfg);
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

const BASE = crsBaseUrl(cfg);
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const OFF_5H = num(process.env.CRS_OFF_5H ?? C.off5h, 90);
const OFF_7D = num(process.env.CRS_OFF_7D ?? C.off7d, 95);
const ON_5H = num(process.env.CRS_ON_5H ?? C.on5h, 70);
const ON_7D = num(process.env.CRS_ON_7D ?? C.on7d, 85);
const FLOOR = num(process.env.CRS_FLOOR ?? C.floor, 3);
const FRESH_MIN = num(process.env.CRS_FRESH_MIN ?? C.freshMinutes, 15);
const CRS_POLICY = crsPolicy(cfg);
const TOKEN_MIN_FRESH_MS = num(process.env.CRS_TOKEN_MIN_FRESH_MS ?? C.tokenMinFreshMs, 5 * 60_000);
const STALE_RL_MAX_MINS = num(process.env.CRS_STALE_RL_MINUTES, 300);
const LIVE_USAGE_TTL_MS = num(process.env.CRS_LIVE_USAGE_TTL_MS, 90_000);
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
    const data = { u5: d?.five_hour?.utilization ?? null, u7: d?.seven_day?.utilization ?? null };
    liveUsageCache.set(email, { at: Date.now(), data });
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
    if (DRY) {
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
    const tokenExpiresAt = Number(a.tokenExpiresAt || a.expiresAt || 0);
    const staleToken =
      !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= 0 || tokenExpiresAt <= nowMs + TOKEN_MIN_FRESH_MS;
    const rl = genuineRateLimit(a, nowMs);
    const overloaded = genuineOverload(a, nowMs);

    let desired = true;
    let reason = `max-out (5h=${u5 ?? '?'} 7d=${u7 ?? '?'} sw=${sw ?? 'none'})`;
    if (staleToken) {
      desired = false;
      reason = tokenExpiresAt ? `stale-token ${new Date(tokenExpiresAt).toISOString()}` : 'stale-token missing-expiry';
    } else if (rl) {
      desired = false;
      reason = 'rate-limited (live)';
    } else if (overloaded) {
      desired = false;
      reason = 'overloaded(529 live)';
    }
    return { a, cur, desired, reason, soft: false, sw, u5: u5 ?? '?', rl, overloaded };
  });
}

function decideConservative(accts, nowMs) {
  const decisions = accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage;
    const updMs = cu.updatedAt ? Date.parse(cu.updatedAt) : NaN;
    const fresh = !!lu || (Number.isFinite(updMs) && (nowMs - updMs) / 60000 < FRESH_MIN);
    const u5 = lu?.u5 ?? cu.fiveHour?.utilization;
    const u7 = lu?.u7 ?? cu.sevenDay?.utilization;
    const u7o = cu.sevenDayOpus?.utilization;
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;
    const rl = genuineRateLimit(a, nowMs);
    const overloaded = genuineOverload(a, nowMs);

    const utilBreach = fresh && ((u5 ?? 0) >= OFF_5H || (u7 ?? 0) >= OFF_7D || (u7o ?? 0) >= OFF_7D);
    const utilClear = !fresh || ((u5 ?? 0) < ON_5H && (u7 ?? 0) < ON_7D && (u7o ?? 0) < ON_7D);

    let desired = cur;
    let reason = 'hold';
    let soft = false;
    if (rl) {
      desired = false;
      reason = 'rate-limited';
    } else if (overloaded) {
      desired = false;
      reason = 'overloaded(529)';
    } else if (sw && WARN_STATUSES.has(sw)) {
      desired = false;
      reason = `sessionWindow=${sw}`;
      soft = true;
    } else if (utilBreach) {
      desired = false;
      reason = `util 5h=${u5} 7d=${u7} 7dOpus=${u7o} ≥ off`;
      soft = true;
    } else if ((sw === 'allowed' || sw === null) && utilClear) {
      desired = true;
      reason = `healthy (sw=${sw ?? 'none'}${fresh ? `, 5h=${u5}` : ', usage stale/absent'})`;
    }
    return { a, cur, desired, reason, soft, sw, u5: u5 ?? '?', rl, overloaded };
  });

  let usable = decisions.filter((d) => d.desired && !d.rl && !d.overloaded).length;
  if (usable < FLOOR) {
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 50);
    const revertable = decisions
      .filter((d) => d.desired === false && d.soft && !d.rl && !d.overloaded)
      .sort((x, y) => unum(x) - unum(y));
    for (const d of revertable) {
      if (usable >= FLOOR) break;
      d.desired = true;
      d.reason = `FLOOR(${FLOOR}): held schedulable despite ${d.reason}`;
      usable++;
    }
    const final = decisions.filter((d) => d.desired && !d.rl && !d.overloaded).length;
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

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
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
  // Authoritative quota: query Anthropic /oauth/usage directly per account (parallel,
  // read-only). Falls back to CRS cache + sessionWindowStatus when a token is absent/stale.
  await Promise.all(
    accts.map(async (a) => {
      a._liveUsage = await liveUsage(accountVaultKey(a));
    }),
  );
  const liveN = accts.filter((a) => a._liveUsage).length;
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
  const off = decisions.filter((d) => !d.desired).map((d) => `${d.a.name}(${d.sw || (d.rl ? 'RL' : '?')})`);
  log(
    `tick: ${changed} change(s). live-quota=${liveN}/${decisions.length} schedulable=${on.length} [${on.join(',')}] | off=[${off.join(',')}]`,
  );
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
