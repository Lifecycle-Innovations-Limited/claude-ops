#!/usr/bin/env node
// crs-429-cooldown.mjs — per-account cooldown driven by real Anthropic API 429s.
//
// OPT-IN. Does nothing (exits 0) unless crs.cooldownEnabled is true (or
// $CRS_COOLDOWN_ENABLED=1) — installing this plugin never silently starts a new
// daemon. Enable it alongside crs-priority-daemon.mjs when you run a self-hosted
// claude-relay-service (CRS) pool and want a fast, real-signal-only cooldown watcher
// that runs on a tighter cadence than the priority daemon.
//
// Two signals, in priority order — both are things Anthropic (or CRS observing
// Anthropic) actually told us, never a speculative/utilization-based guess:
//   1. rateLimitStatus.isRateLimited = true on the account record (CRS derived
//      this from a real upstream response on an actual inference call).
//   2. (optional) tail of today's CRS relay error log for 429 lines mentioning the
//      account name — a faster lead signal than #1 while CRS's own record catches
//      up. Reads from crs.logDir (or $CRS_LOG_DIR); a no-op on a fresh install
//      since that directory won't exist yet (this reconciler never assumes a
//      real CRS deployment's log layout).
//
// State is owned exclusively by THIS reconciler (own file, atomic write, single-
// flight lock via crs-reconciler-state.mjs) so that:
//   - a process restart does not release a held account early;
//   - crs-priority-daemon.mjs (which owns utilization-based scheduling) can run on
//     its own cadence without clobbering this reconciler's cooldown record, and
//     vice versa. See crs-reconciler-state.mjs for why that separation exists.
//
// Cron/timer cadence: run this more often than crs-priority-daemon.mjs (e.g. every
// 1 minute vs every 5) since it exists to react to a live 429 fast.
//
// CONFIG (config.json "crs" block; every key overridable by env — see
// config.example.json for the full annotated schema):
//   cooldownEnabled        default false — must be true (or $CRS_COOLDOWN_ENABLED=1)
//   baseUrl, adminUser, adminPasswordEnv, containerName  — shared with the other
//                                                           CRS reconcilers
//   stateDir               default: <plugin-data-dir>/account-rotation. This
//                          reconciler's own state file lives at
//                          <stateDir>/crs-429-state.json (never shared with any
//                          other reconciler's state file).
//   manualDisableEnabled   default true — set false to skip the manual-disable
//                          allow-list check entirely
//   manualDisablePath      default: <stateDir>/crs-manual-disable.json (optional
//                          allow-list of account ids/names to always leave alone)
//   logDir                 default: <plugin-data-dir>/account-rotation/crs-logs.
//                          This reconciler reads claude-relay-error-<date>.log
//                          from here for its optional lead signal. Unset -> that
//                          signal is disabled
//                          (rateLimitStatus alone is still a real Anthropic signal
//                          and is sufficient on its own).
//   logTzOffset            default: "+00:00" — offset appended to naive log
//                          timestamps before Date.parse; must match your CRS
//                          host's log timezone if it isn't UTC.
//   errorLogWindowMs       default: 300000 (5m) — how far back to scan the log
//   errorLogCooldownMs     default: 300000 (5m) — cooldown granted on a log hit
//
// CLI: (none)=one tick · --dry-run=log decisions, no writes · --status=print
//      current held/live accounts and exit.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { loadJsonState, saveJsonStateAtomic, withOwnStateLock } from './crs-reconciler-state.mjs';
import { crsBaseUrl, loadRotationConfig, resolveCrsAdminPassword } from './crs-pool-config.mjs';
import { resolveAccountsBackend } from './ops-accounts-backend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-429] ${m}`);

const cfg = loadRotationConfig();
const C = cfg.crs || {};

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(v ?? '')
      .trim()
      .toLowerCase(),
  );
}

const ENABLED = truthy(process.env.CRS_COOLDOWN_ENABLED) || C.cooldownEnabled === true;

const BASE = crsBaseUrl(cfg);
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

function expandHome(p) {
  return p ? p.replace(/^~(?=$|\/)/, homedir()) : p;
}

const PLUGIN_DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const DEFAULT_STATE_DIR = join(PLUGIN_DATA_DIR, 'account-rotation');
const STATE_DIR = expandHome(process.env.CRS_STATE_DIR || C.stateDir) || DEFAULT_STATE_DIR;

const STATE_PATH = expandHome(process.env.CRS_COOLDOWN_STATE_PATH) || join(STATE_DIR, 'crs-429-state.json');
const MANUAL_DISABLE_ENABLED = C.manualDisableEnabled !== false;
const MANUAL_DISABLE_PATH =
  expandHome(process.env.CRS_MANUAL_DISABLE_PATH || C.manualDisablePath) || join(STATE_DIR, 'crs-manual-disable.json');
// Unset by default: the error-log lead signal is opt-in extra sensitivity, not a
// required capability. rateLimitStatus alone (signal #1) is a real Anthropic
// signal and is sufficient on its own.
// Defaults to a real (likely-absent-on-a-fresh-install) path rather than a null
// "disabled" sentinel: scanErrorLog() below no-ops safely via existsSync() when
// the directory/file isn't there, so this stays a safe no-op until you actually
// point your CRS deployment's error-log directory at it.
const DEFAULT_LOG_DIR = join(DEFAULT_STATE_DIR, 'crs-logs');
const ERROR_LOG_DIR = expandHome(process.env.CRS_LOG_DIR || C.logDir) || DEFAULT_LOG_DIR;
const ERROR_LOG_WINDOW_MS = num(process.env.CRS_ERROR_LOG_WINDOW_MS ?? C.errorLogWindowMs, 5 * 60_000);
const ERROR_LOG_COOLDOWN_MS = num(process.env.CRS_ERROR_LOG_COOLDOWN_MS ?? C.errorLogCooldownMs, 5 * 60_000);
const ERROR_LOG_TZ = process.env.CRS_LOG_TZ_OFFSET || C.logTzOffset || '+00:00';

const jfetch = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  const txt = await r.text();
  let body;
  try {
    body = JSON.parse(txt);
  } catch {
    body = txt;
  }
  return { status: r.status, body };
};

async function login() {
  const password = resolveCrsAdminPassword(cfg, { adminUser: ADMIN_USER });
  if (!password) throw new Error('CRS admin password unavailable (set $CRS_ADMIN_PASSWORD or see crs-pool-config.mjs)');
  const r = await jfetch('/web/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password }),
  });
  if (r.status !== 200 || !r.body?.token) throw new Error('login failed HTTP ' + r.status);
  return 'Bearer ' + r.body.token;
}

async function getAccounts(auth) {
  const r = await jfetch('/admin/claude-accounts', { headers: { Authorization: auth } });
  if (r.status !== 200) throw new Error('GET accounts failed HTTP ' + r.status);
  const list = Array.isArray(r.body) ? r.body : r.body.data || r.body.accounts || [];
  return list.filter((a) => a.platform === 'claude' && a.isActive !== false);
}

const toggle = async (auth, id, schedulable, metadata = {}) =>
  jfetch('/admin/claude-accounts/' + id + '/toggle-schedulable', {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedulable, ...metadata }),
  });

const parseTs = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

function loadManualDisable() {
  if (!MANUAL_DISABLE_ENABLED) return new Set();
  try {
    if (!existsSync(MANUAL_DISABLE_PATH)) return new Set();
    const o = JSON.parse(readFileSync(MANUAL_DISABLE_PATH, 'utf8'));
    return new Set(Array.isArray(o) ? o : Object.keys(o));
  } catch {
    return new Set();
  }
}

// === optional signal #2: tail today's CRS relay error log for 429 lines =====
function scanErrorLog(nowMs) {
  if (!ERROR_LOG_DIR) return new Map();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const logPath = join(ERROR_LOG_DIR, `claude-relay-error-${today}.log`);
  if (!existsSync(logPath)) return new Map();
  let lines;
  try {
    lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return new Map();
  }
  const recent = new Map(); // account name -> latest hit ts (ms)
  const windowStart = nowMs - ERROR_LOG_WINDOW_MS;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const m = e.msg || '';
      if (!m.includes('error status: 429')) continue;
      const rawTs = String(e.ts || '').replace(' ', 'T');
      const t = Date.parse(ERROR_LOG_TZ && !/[Zz]|[+-]\d\d:?\d\d$/.test(rawTs) ? rawTs + ERROR_LOG_TZ : rawTs);
      if (!Number.isFinite(t) || t < windowStart) continue;
      const acc = m.match(/Account:\s*([^\s"]+)/);
      if (!acc) continue;
      const cur = recent.get(acc[1]);
      if (!cur || t > cur) recent.set(acc[1], t);
    } catch {}
  }
  return recent;
}

async function tick() {
  const auth = await login();
  const accts = await getAccounts(auth);
  const state = loadJsonState(STATE_PATH, log);
  const nowMs = Date.now();
  const errorLogHits = scanErrorLog(nowMs);
  const manualDisable = loadManualDisable();

  if (STATUS) {
    const held = Object.entries(state).filter(([, s]) => s.cooldownUntil > nowMs);
    console.log(`CRS 429-cooldown @ ${BASE} — ${accts.length} claude accounts, ${held.length} held`);
    for (const [id, s] of held) {
      console.log(`  ${s.name || id}: held until ${new Date(s.cooldownUntil).toISOString()} (${s.reason})`);
    }
    return;
  }

  const changes = [];
  for (const a of accts) {
    if (manualDisable.has(a.id) || manualDisable.has(a.name)) continue;
    const cur = a.schedulable !== false;
    const rl = a.rateLimitStatus?.isRateLimited === true;
    const rlMin = Math.max(a.rateLimitStatus?.minutesRemaining || 0, 0);
    const rlEnd = parseTs(a.rateLimitStatus?.rateLimitEndAt);
    const persistedRedisHoldEnd = parseTs(a.rateLimitEndAt || a.rateLimitStatus?.rateLimitEndAt);
    const rateLimitReason = a.rateLimitReason || a.rateLimitStatus?.reason || null;
    const transient429 = rateLimitReason === 'transient_default_cooldown';
    const errLogHit = errorLogHits.get(a.name);

    // Trust only real upstream signals here (never claudeUsage.*.utilization —
    // that cache is fine for crs-priority-daemon.mjs's global health checks but
    // lags live state by minutes and must not drive a per-account hold).
    let cooldownUntil = 0;
    let reason = null;
    if (rl && !transient429) {
      const t = rlEnd && rlEnd > nowMs ? rlEnd : nowMs + Math.max(rlMin, 1) * 60_000;
      cooldownUntil = Math.max(cooldownUntil, t);
      reason = `api-rl ${Math.max(rlMin, 1)}m remaining${rateLimitReason ? ` (${rateLimitReason})` : ''}`;
    }
    if (errLogHit && rl && rateLimitReason && !transient429) {
      const t = errLogHit + ERROR_LOG_COOLDOWN_MS;
      if (t > cooldownUntil) {
        cooldownUntil = t;
        reason = `429 in error log @ ${new Date(errLogHit).toISOString()}`;
      }
    }

    const prevHeld = state[a.id]?.cooldownUntil || 0;

    if (cooldownUntil > nowMs) {
      state[a.id] = { name: a.name, cooldownUntil, reason };
      const holdMissingInRedis = !persistedRedisHoldEnd || persistedRedisHoldEnd < cooldownUntil - 1000;
      if (cur || holdMissingInRedis) {
        if (DRY) {
          changes.push({ name: a.name, action: cur ? '[dry]OFF' : '[dry]HOLD', reason, http: '-' });
        } else {
          const r = await toggle(auth, a.id, false, {
            rateLimitEndAt: new Date(cooldownUntil).toISOString(),
            rateLimitReason: reason || 'api-rl',
          });
          changes.push({
            name: a.name,
            action: cur ? 'OFF' : 'HOLD',
            reason: `cooldown until ${new Date(cooldownUntil).toISOString().slice(11, 19)} (${reason})`,
            http: r.status,
          });
        }
      }
    } else if (prevHeld > nowMs) {
      // Persisted hold still wins — releasing before the recorded upstream
      // reset just re-hammers the same account.
      state[a.id] = { name: a.name, cooldownUntil: prevHeld, reason: state[a.id]?.reason || 'persisted-api-rl-bench' };
      const holdMissingInRedis = !persistedRedisHoldEnd || persistedRedisHoldEnd < prevHeld - 1000;
      if ((cur || holdMissingInRedis) && !DRY) {
        const r = await toggle(auth, a.id, false, {
          rateLimitEndAt: new Date(prevHeld).toISOString(),
          rateLimitReason: state[a.id]?.reason || 'persisted-api-rl-bench',
        });
        changes.push({
          name: a.name,
          action: cur ? 'OFF' : 'HOLD',
          reason: `persisted cooldown until ${new Date(prevHeld).toISOString().slice(11, 19)}`,
          http: r.status,
        });
      } else if ((cur || holdMissingInRedis) && DRY) {
        changes.push({ name: a.name, action: '[dry]HOLD', reason: 'persisted cooldown', http: '-' });
      }
    } else if (prevHeld && prevHeld <= nowMs) {
      delete state[a.id];
      if (!cur) {
        if (DRY) {
          changes.push({ name: a.name, action: '[dry]ON', reason: 'cooldown expired', http: '-' });
        } else {
          const r = await toggle(auth, a.id, true);
          changes.push({ name: a.name, action: 'ON', reason: 'cooldown expired', http: r.status });
        }
      }
    }
  }

  if (!DRY) saveJsonStateAtomic(STATE_PATH, state);
  const held = Object.values(state).filter((s) => s.cooldownUntil > nowMs);
  const live = accts.length - held.length;
  log(
    `tick: ${changes.length} change(s). live=${live}/${accts.length} | held=[${held
      .map((h) => `${h.name}@${new Date(h.cooldownUntil).toISOString().slice(11, 19)}`)
      .join(',')}]`,
  );
  for (const c of changes) log(`  ${c.name}: ${c.action} (${c.reason || ''}) [HTTP ${c.http}]`);
}

async function main() {
  const backend = resolveAccountsBackend({ env: process.env, cfgBackend: C.backend });
  if (backend === 'local') {
    log('backend=local — CRS 429 cooldown no-op (use seat-policy-tick / exhaustedUntil on seat-state)');
    return;
  }
  if (!ENABLED && !STATUS) {
    log('crs.cooldownEnabled is not true (and $CRS_COOLDOWN_ENABLED!=1) — skipping tick (opt-in required)');
    return;
  }
  const outcome = await withOwnStateLock(STATE_PATH, tick, log);
  if (outcome.skipped) log('skipped tick: previous run still holds the state lock');
}

main().catch((e) => {
  const message = e?.message || String(e);
  if (
    message === 'fetch failed' ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT')
  ) {
    log('WARN transient CRS fetch failure; skipping this tick');
    process.exit(0);
  }
  log('ERROR: ' + message);
  process.exit(1);
});
