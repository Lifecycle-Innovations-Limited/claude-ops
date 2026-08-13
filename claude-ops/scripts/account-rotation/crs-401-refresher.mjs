#!/usr/bin/env node
// crs-401-refresher.mjs — retired CRS server-side token refresher.
//
// Non-status execution fails closed. The authoritative recovery path is
// refresh-tokens.mjs for identity-verified vault refresh followed by
// crs-token-feed.mjs for identity-verified pool publication. The old direct CRS
// refresh endpoint could not verify which account identity it activated.
//
// CLI: --status remains available for inspecting legacy state during migration.

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { loadJsonState, saveJsonStateAtomic, withOwnStateLock } from './crs-reconciler-state.mjs';
import { crsBaseUrl, loadRotationConfig, resolveCrsAdminPassword } from './crs-pool-config.mjs';
import { resolveAccountsBackend } from './ops-accounts-backend.mjs';
import { retryAfterDelayMs } from './retry-after.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);

const cfg = loadRotationConfig();
const C = cfg.crs || {};
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(v ?? '')
      .trim()
      .toLowerCase(),
  );
}

const ENABLED = truthy(process.env.CRS_TOKEN_REFRESH_ENABLED) || C.tokenRefreshEnabled === true;

const BASE = crsBaseUrl(cfg);
const ADMIN_USER = process.env.CRS_ADMIN_USER || C.adminUser || 'cradmin';
const REFRESH_WINDOW_MS = num(process.env.CRS_REFRESH_WINDOW_MS ?? C.tokenRefreshWindowMs, 30 * 60_000);

function expandHome(p) {
  return p ? p.replace(/^~(?=$|\/)/, homedir()) : p;
}

const PLUGIN_DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_DIR = expandHome(process.env.CRS_STATE_DIR || C.stateDir) || join(PLUGIN_DATA_DIR, 'account-rotation');
const STATE_PATH = expandHome(process.env.CRS_401_STATE_PATH) || join(STATE_DIR, 'crs-401-state.json');
// Read-only: another reconciler's (e.g. crs-429-cooldown.mjs) own state file, so a
// successful token refresh doesn't re-enable an account that's genuinely rate-limited.
const COOLDOWN_STATE_PATH = expandHome(process.env.CRS_COOLDOWN_STATE_PATH || C.cooldownStatePath) || null;
// This script's OWN operational text log — distinct from crs.logDir (which is the CRS
// relay's error-log directory that crs-429-cooldown.mjs reads from). Env-only override
// to avoid any config-key overlap with that unrelated concept.
const LOG_DIR = expandHome(process.env.CRS_401_LOG_DIR) || join(homedir(), '.claude', 'logs');
const LOG_PATH = join(LOG_DIR, 'crs-401-refresher.log');

const ts = () => new Date().toISOString();
function log(msg) {
  const line = `${ts().slice(11, 19)} [crs-401] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

async function jfetch(path, opts = {}) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30_000), ...opts });
  const txt = await r.text();
  let body;
  try {
    body = JSON.parse(txt);
  } catch {
    body = txt;
  }
  return { status: r.status, body };
}

let adminToken = null;
async function ensureAdmin() {
  if (adminToken) return adminToken;
  const pw = resolveCrsAdminPassword(cfg, { adminUser: ADMIN_USER });
  if (!pw) throw new Error('CRS admin password unavailable (set $CRS_ADMIN_PASSWORD or see crs-pool-config.mjs)');
  const r = await jfetch('/web/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: pw }),
  });
  if (r.status !== 200 || !r.body?.token) throw new Error(`admin login failed (HTTP ${r.status})`);
  adminToken = 'Bearer ' + r.body.token;
  return adminToken;
}

async function listClaudeAccounts(auth) {
  const r = await jfetch('/admin/claude-accounts', { headers: { Authorization: auth } });
  const list = Array.isArray(r.body) ? r.body : r.body?.data || r.body?.accounts || [];
  return list.filter((a) => a.platform === 'claude' && a.isActive !== false);
}

function tokenExpiryMs(a) {
  const v = a.tokenExpiresAt ?? a.expiresAt ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function futureMs(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 10_000_000_000 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function authoritativeRateLimited(a, nowMs) {
  const status = a.rateLimitStatus || {};
  const end = futureMs(status.rateLimitEndAt || a.rateLimitEndAt || a.weeklyRateLimitEndAt);
  const reason = status.reason || a.rateLimitReason;
  return Boolean(
    (status.isRateLimited === true || a.rateLimitStatus?.isRateLimited === 'true') &&
    end > nowMs &&
    String(reason || '').includes('authoritative_reset'),
  );
}

function hardHeld(a, nowMs) {
  const status = String(a.status || '');
  if (['blocked', 'auth_repair', 'error'].includes(status)) return true;
  return (
    futureMs(
      a.rateLimitEndAt || a.rateLimitStatus?.rateLimitEndAt || a.rateLimitStatus?.resetAt || a.weeklyRateLimitEndAt,
    ) > nowMs
  );
}

// Read-only view of another reconciler's cooldown state (e.g. crs-429-cooldown.mjs).
// Never written here — only consulted so a successful token refresh doesn't flip a
// genuinely rate-limited account back to schedulable=true out from under it.
function externallyHeld(accountId, nowMs) {
  if (!COOLDOWN_STATE_PATH || !existsSync(COOLDOWN_STATE_PATH)) return false;
  try {
    const other = JSON.parse(readFileSync(COOLDOWN_STATE_PATH, 'utf8'));
    const entry = other?.[accountId];
    return Boolean(entry?.cooldownUntil > nowMs);
  } catch {
    return false;
  }
}

async function refreshAccount(auth, a) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  let lastStatus = null;
  let lastRetryAfter = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(BASE + `/admin/claude-accounts/${a.id}/refresh`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const retryAfterHdr = r.headers.get('retry-after');
    lastStatus = r.status;
    lastRetryAfter = retryAfterHdr;
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const delayMs = retryAfterDelayMs(retryAfterHdr) ?? 30_000;
      log(
        `  ${a.name}: refresh 429 (attempt ${attempt}/${MAX_RETRIES}) — waiting ${Math.round(delayMs / 1000)}s (Retry-After=${retryAfterHdr ?? 'n/a'})...`,
      );
      await new Promise((r2) => setTimeout(r2, delayMs));
      continue;
    }
    const txt = await r.text();
    let body;
    try {
      body = JSON.parse(txt);
    } catch {
      body = txt;
    }
    const ok = r.status === 200 && (body?.success === true || body?.data?.success === true || body?.data?.accessToken);
    const err =
      body?.message || body?.error?.message || body?.error || (typeof body === 'string' ? body.slice(0, 120) : '');
    if (r.status === 200 || attempt === MAX_RETRIES) {
      return { ok, status: r.status, err, retryAfter: lastRetryAfter };
    }
    lastErr = err;
    await new Promise((r2) => setTimeout(r2, 5_000));
  }
  return { ok: false, status: lastStatus ?? 0, err: lastErr ?? 'max retries', retryAfter: lastRetryAfter };
}

async function setSchedulable(auth, a, value) {
  const r = await jfetch(`/admin/claude-accounts/${a.id}/toggle-schedulable`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedulable: value }),
  });
  return r.status === 200;
}

async function tick() {
  const nowMs = Date.now();
  const state = loadJsonState(STATE_PATH, log);
  const auth = await ensureAdmin();
  const accounts = await listClaudeAccounts(auth);

  if (STATUS) {
    console.log(`CRS token status @ ${BASE} — ${accounts.length} claude accounts`);
    for (const a of accounts) {
      const exp = tokenExpiryMs(a);
      const mins = exp ? Math.round((exp - nowMs) / 60_000) : null;
      const flag = state[a.id]?.needsReauth ? ' NEEDS-REAUTH' : '';
      const limited = authoritativeRateLimited(a, nowMs) ? ' AUTH-RATE-LIMITED' : '';
      console.log(
        `  ${a.name.padEnd(26)} sched=${String(a.schedulable !== false).padEnd(5)} exp_in=${mins === null ? '-' : mins + 'm'}${flag}${limited}`,
      );
    }
    return;
  }

  const targets = accounts.filter((a) => {
    if (hardHeld(a, nowMs)) return false;
    if (ONLY) return a.name === ONLY || a.id === ONLY;
    const exp = tokenExpiryMs(a);
    const expiringSoon = !exp || exp <= nowMs + REFRESH_WINDOW_MS;
    const sidelined = a.schedulable === false;
    const authLimited = authoritativeRateLimited(a, nowMs);
    return expiringSoon || sidelined || authLimited;
  });

  if (!targets.length) {
    log(`tick: 0 refresh needed (${accounts.length} accounts all fresh > ${REFRESH_WINDOW_MS / 60000}m)`);
    if (!DRY) saveJsonStateAtomic(STATE_PATH, state);
    return;
  }

  let refreshed = 0;
  let revived = 0;
  let dead = 0;
  for (const a of targets) {
    const exp = tokenExpiryMs(a);
    const mins = exp ? Math.round((exp - nowMs) / 60_000) : null;
    const authLimited = authoritativeRateLimited(a, nowMs);
    if (DRY) {
      log(
        `[dry] would ${authLimited ? 'sideline auth-rate-limited' : 'refresh'} ${a.name} (exp_in=${mins === null ? '-' : mins + 'm'}, sched=${a.schedulable !== false})`,
      );
      continue;
    }
    if (authLimited) {
      if (a.schedulable !== false) {
        const off = await setSchedulable(auth, a, false);
        log(
          `${a.name}: authoritative rate limit until ${a.rateLimitStatus?.rateLimitEndAt || a.rateLimitEndAt} — ${off ? 'SIDELINED' : 'sideline FAILED'}`,
        );
      } else {
        log(`${a.name}: authoritative rate limit already sidelined`);
      }
      continue;
    }
    const res = await refreshAccount(auth, a);
    if (res.ok) {
      refreshed++;
      delete state[a.id];
      if (a.schedulable === false && externallyHeld(a.id, Date.now())) {
        log(`${a.name}: refreshed but leaving sidelined — held by another reconciler's cooldown (rate-limited)`);
      } else if (a.schedulable === false && !hardHeld(a, Date.now())) {
        const on = await setSchedulable(auth, a, true);
        if (on) {
          revived++;
          log(`${a.name}: refreshed + revived (schedulable=true)`);
        } else {
          log(`${a.name}: refreshed but re-enable failed`);
        }
      } else {
        log(`${a.name}: refreshed (exp_in was ${mins === null ? '-' : mins + 'm'})`);
      }
    } else {
      dead++;
      state[a.id] = {
        name: a.name,
        needsReauth: true,
        lastFailAt: nowMs,
        reason: `refresh HTTP ${res.status}: ${res.err}`.slice(0, 160),
      };
      // A schedulable account with a dead refresh_token AND an expired/near-expired
      // access token actively 401s live traffic. Sideline it to protect the pool; a
      // human/magic-link re-auth revives it, and the next tick re-enables on a
      // successful refresh. We only sideline confirmed-dead + expiring tokens, never
      // a transient failure on a still-fresh token.
      const expired = !exp || exp <= nowMs + REFRESH_WINDOW_MS;
      if (expired && a.schedulable !== false) {
        const off = await setSchedulable(auth, a, false);
        log(
          `${a.name}: refresh FAILED (HTTP ${res.status}: ${res.err}) — dead token, ${off ? 'SIDELINED' : 'sideline FAILED'}, needs full re-auth`,
        );
      } else {
        log(`${a.name}: refresh FAILED (HTTP ${res.status}: ${res.err}) — needs full re-auth`);
      }
    }
  }

  const needsReauth = Object.values(state)
    .filter((s) => s?.needsReauth)
    .map((s) => s.name);
  log(
    `tick: refreshed=${refreshed} revived=${revived} dead=${dead}` +
      (needsReauth.length ? ` | needs-reauth: ${needsReauth.join(', ')}` : ''),
  );
  if (!DRY) saveJsonStateAtomic(STATE_PATH, state);
}

async function main() {
  if (!STATUS) throw new Error('CRS_401_REFRESHER_RETIRED_USE_VERIFIED_TOKEN_FEED');
  const backend = resolveAccountsBackend({ env: process.env, cfgBackend: C.backend });
  if (backend === 'local') {
    log('backend=local — CRS 401 refresher no-op (vault refresh is rotate.mjs / keychain keepalive)');
    return;
  }
  if (!ENABLED && !STATUS) {
    log('crs.tokenRefreshEnabled is not true (and $CRS_TOKEN_REFRESH_ENABLED!=1) — skipping tick (opt-in required)');
    return;
  }
  const outcome = await withOwnStateLock(STATE_PATH, tick, log);
  if (outcome.skipped) log('skipped tick: previous run still holds the state lock');
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
