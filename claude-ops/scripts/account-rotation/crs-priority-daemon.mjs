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
// POLICY:
//   DEPRIORITIZE (schedulable=false) when any of:
//     rate-limited | overloaded | sessionWindowStatus∈WARN | FRESH util ≥ OFF_*
//   RE-ENABLE (schedulable=true) only when ALL of:
//     not rate-limited & not overloaded & sessionWindowStatus∈{allowed,absent}
//     & (util stale/absent OR all util < ON_*)
//   else hold (hysteresis band). FLOOR keeps ≥N usable accounts (soft-offs are
//   reverted lowest-util-first; hard rate-limited/overloaded are never reverted).
//
// CONFIG (config.json "crs" block; every key overridable by env):
//   enabled, baseUrl, adminUser, adminPasswordEnv, off5h, off7d, on5h, on7d,
//   floor, freshMinutes. Admin password resolves from (1) $CRS_ADMIN_PASSWORD,
//   (2) the configured env var, (3) credential-store `CRS-Admin-<adminUser>`.
//
// CLI:  (none)=one live tick · --dry-run=log decisions, no writes · --status=print
//       current schedulable + utilization table and exit · --once (alias for tick).

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..');
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-priority] ${m}`);

// ── config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  const candidates = [
    process.env.CRS_CONFIG,
    join(DATA_DIR, 'account-rotation', 'config.json'),
    join(homedir(), '.claude', 'plugins', 'data', 'ops', 'account-rotation', 'config.json'),
    join(PLUGIN_ROOT, 'scripts', 'account-rotation', 'config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return { crs: {}, ...JSON.parse(readFileSync(p, 'utf8')) };
    } catch {}
  }
  return { crs: {} };
}
const cfg = loadConfig();
const C = cfg.crs || {};
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

// CRS_BASE is normally exported by the .sh wrapper after it probes the live host
// port (:3005 or :3000). config.json "crs".baseUrl overrides next; the literal is
// only a last resort and matches this fleet's published port (...:3005->3000).
const BASE = process.env.CRS_BASE || C.baseUrl || 'http://127.0.0.1:3005';
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const OFF_5H = num(process.env.CRS_OFF_5H ?? C.off5h, 90);
const OFF_7D = num(process.env.CRS_OFF_7D ?? C.off7d, 95);
const ON_5H = num(process.env.CRS_ON_5H ?? C.on5h, 70);
const ON_7D = num(process.env.CRS_ON_7D ?? C.on7d, 85);
const FLOOR = num(process.env.CRS_FLOOR ?? C.floor, 3);
const FRESH_MIN = num(process.env.CRS_FRESH_MIN ?? C.freshMinutes, 15);

function adminPassword() {
  if (process.env.CRS_ADMIN_PASSWORD) return process.env.CRS_ADMIN_PASSWORD;
  const envName = C.adminPasswordEnv || process.env.CRS_ADMIN_PASSWORD_ENV;
  if (envName && process.env[envName]) return process.env[envName];
  // credential-store: service CRS-Admin-<adminUser>, account $USER
  try {
    const cred = join(PLUGIN_ROOT, 'lib', 'credential-store.sh');
    const acct = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
    return execFileSync('bash', [cred, 'get', `CRS-Admin-${ADMIN_USER}`, acct], { encoding: 'utf8' }).trim();
  } catch {}
  throw new Error(
    `CRS admin password unavailable — set $CRS_ADMIN_PASSWORD, or store it via:\n` +
      `  bash "${join(PLUGIN_ROOT, 'lib', 'credential-store.sh')}" set CRS-Admin-${ADMIN_USER} "$USER" '<password>'`,
  );
}

// ── authoritative per-account quota (api.anthropic.com/api/oauth/usage) ────────
// CRS's cached claudeUsage is often null/stale, so for accurate prioritization we
// read each account's OAuth token from the credential store and query Anthropic's
// usage endpoint directly (read-only GET — does NOT rotate the token). Falls back
// to the cache/sessionWindowStatus when no token / 401 / timeout. Tokens live at
// `Claude-Rotation-<email>` (rotator schema); CRS account → token by subscription email.
const USAGE_TOKEN_SVC = process.env.CRS_USAGE_TOKEN_PREFIX || 'Claude-Rotation-';
function readOauthToken(email) {
  if (!email) return null;
  const acct = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
  // try credential-store first (cross-platform), then macOS security directly
  for (const get of [
    () =>
      execFileSync(
        'bash',
        [join(PLUGIN_ROOT, 'lib', 'credential-store.sh'), 'get', `${USAGE_TOKEN_SVC}${email}`, acct],
        { encoding: 'utf8' },
      ),
    () =>
      execFileSync('security', ['find-generic-password', '-a', acct, '-s', `${USAGE_TOKEN_SVC}${email}`, '-w'], {
        encoding: 'utf8',
      }),
  ]) {
    try {
      const j = JSON.parse(get().trim());
      const t = j?.claudeAiOauth?.accessToken;
      if (t) return t;
    } catch {}
  }
  return null;
}
async function liveUsage(email) {
  const token = readOauthToken(email);
  if (!token) return null;
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null; // 401 (stale token) / 429 → fall back to cache + sessionWindowStatus
    const d = await r.json();
    return { u5: d?.five_hour?.utilization ?? null, u7: d?.seven_day?.utilization ?? null };
  } catch {
    return null;
  }
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

// ── policy ───────────────────────────────────────────────────────────────────
const WARN_STATUSES = new Set(['allowed_warning', 'warning', 'blocked', 'exceeded', 'limited', 'stopped']);

function decide(accts) {
  const nowMs = Date.now();
  const decisions = accts.map((a) => {
    const cu = a.claudeUsage || {};
    const lu = a._liveUsage; // authoritative direct-from-Anthropic /oauth/usage, or null
    const updMs = cu.updatedAt ? Date.parse(cu.updatedAt) : NaN;
    const fresh = !!lu || (Number.isFinite(updMs) && (nowMs - updMs) / 60000 < FRESH_MIN);
    const u5 = lu?.u5 ?? cu.fiveHour?.utilization;
    const u7 = lu?.u7 ?? cu.sevenDay?.utilization;
    const u7o = cu.sevenDayOpus?.utilization; // oauth/usage doesn't split opus — keep cache
    const rl = !!a.rateLimitStatus?.isRateLimited || !!a.opusRateLimitStatus?.isRateLimited;
    const overloaded = !!a.overloadStatus?.isOverloaded;
    const sw = a.sessionWindow?.sessionWindowStatus || null;
    const cur = a.schedulable !== false;

    const utilBreach = fresh && ((u5 ?? 0) >= OFF_5H || (u7 ?? 0) >= OFF_7D || (u7o ?? 0) >= OFF_7D);
    const utilClear = !fresh || ((u5 ?? 0) < ON_5H && (u7 ?? 0) < ON_7D && (u7o ?? 0) < ON_7D);

    let desired = cur,
      reason = 'hold',
      soft = false;
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

  // FLOOR: never starve the pool via SOFT deprioritizations
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

  // DEDUP — accounts sharing an organizationUuid are the SAME claude.ai quota pool
  // (e.g. two CRS pool entries for one account). Leaving both schedulable makes CRS
  // double-load that single account → it saturates twice as fast. Keep only ONE
  // schedulable per uuid (healthiest: sw=allowed, then lowest known util); force the
  // rest off. Team-vs-personal seats have DIFFERENT uuids, so they are NOT deduped.
  const byUuid = {};
  for (const d of decisions) {
    const uuid = d.a.subscriptionInfo?.organizationUuid;
    if (!uuid || !d.desired) continue;
    (byUuid[uuid] ||= []).push(d);
  }
  for (const [uuid, group] of Object.entries(byUuid)) {
    if (group.length < 2) continue;
    const unum = (d) => (typeof d.u5 === 'number' ? d.u5 : 50);
    group.sort((x, y) => (x.sw === 'allowed' ? 0 : 1) - (y.sw === 'allowed' ? 0 : 1) || unum(x) - unum(y));
    for (const d of group.slice(1)) {
      d.desired = false;
      d.reason = `dedup: same org ${uuid.slice(0, 8)} as ${group[0].a.name} (one quota pool)`;
    }
  }
  return decisions;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (C.enabled === false && !STATUS && !DRY) {
    log('crs.enabled=false — skipping tick');
    return;
  }
  const auth = await login();
  const accts = await getAccounts(auth);
  if (!accts.length) {
    log('no active claude accounts');
    return;
  }
  // Authoritative quota: query Anthropic /oauth/usage directly per account (parallel,
  // read-only). Falls back to CRS cache + sessionWindowStatus when a token is absent/stale.
  await Promise.all(
    accts.map(async (a) => {
      a._liveUsage = await liveUsage(a.subscriptionInfo?.email);
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
