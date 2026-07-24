#!/usr/bin/env node
// crs-token-refresher.mjs — explicit LAST-RESORT fallback for CRS account
// OAuth-token auto-heal. Do not promote this back to a primary/parallel
// refresh path — refresh-tokens.mjs is the single refresh authority for both
// the keychain vault and CRS-mapped accounts (see NOTES-rotation-consistency.md).
//
// This file exists only for the case where the vault has no valid token for
// a CRS-pool account (e.g. the vault mirror is stale or the account isn't in
// config.json at all) but CRS's own server-side copy might still refresh.
// It takes the same per-account refresh lock refresh-tokens.mjs uses, keyed
// by vault account key when resolvable (falls back to the CRS account name
// when it isn't), so it can never race a vault-based refresh for the same
// underlying Anthropic account.
//
// Gap this fills (root cause of the 2026-07-07 outage): on the Mac,
// `refresh-tokens.mjs` refreshes only the keychain vault, and
// `crs-priority-daemon.mjs` only sidelines stale-token accounts. Nothing
// refreshed the CRS *redis* pool's OAuth access tokens, so once they expired
// every completion returned Anthropic `authentication_error` 401s and live
// sessions got no response.
//
// This closes that gap headlessly (no browser) by using CRS's built-in
// server-side refresh_token grant endpoint:
//   POST /admin/claude-accounts/:id/refresh
//
// Each tick:
//   1. Admin-login to CRS.
//   2. List claude accounts.
//   3. For any account whose access token is expired or expires within
//      REFRESH_WINDOW_MS, OR that is currently sidelined (schedulable=false),
//      call the refresh endpoint.
//   4. On success -> ensure schedulable=true (revive) and clear needs-reauth.
//      On failure (dead refresh_token) -> record needs-reauth; leave for the
//      magic-link re-auth path / human. (We do NOT hard-disable here; the
//      priority daemon owns scheduling. We only revive, never sideline healthy.)
//   5. Append a one-line summary to the log + persist state.
//
// Flags: --once (default; single tick), --dry-run (no writes), --status.

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { acquireRefreshLock } from './crs-refresh-lock.mjs';
import { buildCrsNameMaps, loadRotationConfig } from './crs-pool-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run') || process.env.CRS_DRY === '1';
const STATUS = args.has('--status');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);

const BASE = process.env.CRS_BASE_URL || 'http://127.0.0.1:3005';
const CRS_CONTAINER = process.env.CRS_CONTAINER || 'crs-local-fallback-claude-relay-1';
const ADMIN_USER = process.env.CRS_ADMIN_USER || 'cradmin';
const REFRESH_WINDOW_MS = Number(process.env.CRS_REFRESH_WINDOW_MS || 30 * 60_000); // refresh if expiring within 30m
const STATE_PATH = join(__dirname, '.crs-token-refresher-state.json');
const LOG_DIR = join(homedir(), '.claude', 'logs');
const LOG_PATH = join(LOG_DIR, 'crs-token-refresher.log');

const ts = () => new Date().toISOString();
function log(msg) {
  const line = `${ts().slice(11, 19)} [crs-refresh] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
  } catch {}
}

function loadState() {
  try {
    return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}
function saveState(s) {
  if (DRY) return;
  try {
    const tmp = STATE_PATH + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, STATE_PATH);
  } catch (e) {
    log(`state save failed: ${e.message}`);
  }
}

// Admin password: (1) $CRS_ADMIN_PASSWORD, else (2) docker exec into the relay
// container's env. Mirrors crs-priority-daemon.mjs. No secret is stored on disk.
function adminPassword() {
  if (process.env.CRS_ADMIN_PASSWORD) return process.env.CRS_ADMIN_PASSWORD;
  const dockerBins = [process.env.DOCKER_BIN, '/opt/homebrew/bin/docker', '/usr/local/bin/docker', 'docker'].filter(
    Boolean,
  );
  for (const bin of dockerBins) {
    try {
      const out = execFileSync(bin, ['exec', CRS_CONTAINER, 'printenv', 'ADMIN_PASSWORD'], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {}
  }
  throw new Error('CRS admin password unavailable (set $CRS_ADMIN_PASSWORD or ensure docker exec works)');
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
  const pw = adminPassword();
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

async function refreshAccount(auth, a) {
  // patch 048-429: include Retry-After in response so caller can backoff
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
      const delayMs = retryAfterHdr
        ? Math.min(15 * 60_000, Math.max(2_000, parseInt(retryAfterHdr, 10) * 1000 + 2000))
        : 30_000;
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

async function main() {
  const nowMs = Date.now();
  const state = loadState();
  const auth = await ensureAdmin();
  const accounts = await listClaudeAccounts(auth);
  const { vaultKeyByCrsName } = buildCrsNameMaps(loadRotationConfig());
  const lockKeyFor = (a) => vaultKeyByCrsName[a.name] || `crs-name:${a.name}`;

  if (STATUS) {
    console.log(`CRS token status @ ${BASE} — ${accounts.length} claude accounts`);
    for (const a of accounts) {
      const exp = tokenExpiryMs(a);
      const mins = exp ? Math.round((exp - nowMs) / 60_000) : null;
      const flag = state[a.id]?.needsReauth ? ' NEEDS-REAUTH' : '';
      const limited = authoritativeRateLimited(a, nowMs) ? ' AUTH-RATE-LIMITED' : '';
      console.log(
        `  ${a.name.padEnd(26)} sched=${String(a.schedulable !== false).padEnd(5)} exp_in=${
          mins === null ? '-' : mins + 'm'
        }${flag}${limited}`,
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
    saveState(state);
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
    const lockKey = lockKeyFor(a);
    const releaseLock = acquireRefreshLock(lockKey);
    if (!releaseLock) {
      log(`${a.name}: refresh lock held (${lockKey}) — another refresh path owns this account this cycle, skipping`);
      continue;
    }
    let res;
    try {
      res = await refreshAccount(auth, a);
    } finally {
      releaseLock();
    }
    if (res.ok) {
      refreshed++;
      delete state[a.id];
      if (a.schedulable === false && !hardHeld(a, Date.now())) {
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
      // access token actively 401s live traffic. Sideline it to protect the pool
      // (the priority daemon would normally do this, but it can be on activate-all
      // hold). A human/magic-link re-auth revives it; the next tick re-enables on
      // a successful refresh. We only sideline confirmed-dead + expiring tokens,
      // never a transient failure on a still-fresh token.
      const expired = !exp || exp <= nowMs + REFRESH_WINDOW_MS;
      if (expired && a.schedulable !== false) {
        const off = await setSchedulable(auth, a, false);
        log(
          `${a.name}: refresh FAILED (HTTP ${res.status}: ${res.err}) — dead token, ${
            off ? 'SIDELINED' : 'sideline FAILED'
          }, needs full re-auth`,
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
  saveState(state);
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
