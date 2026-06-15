#!/usr/bin/env node
/**
 * crs-token-feed.mjs — "rotator feeds CRS" (Linux/EC2).
 *
 * The hourly claude-token-refresh.service (refresh-tokens.mjs) is a NO-OP on
 * Linux (it reads the macOS `security` keychain, which doesn't exist here), and
 * nothing ever propagated fresh vault tokens into the local claude-relay-service
 * (CRS) pool — so CRS accounts silently rotted to status=error as their access
 * tokens expired (CRS stores no refresh tokens: hasRefresh=false on every acct).
 *
 * This feeder closes both gaps, contention-tolerantly:
 *   1. Read each account's token from the Linux file vault (~/.claude/.credentials.json).
 *   2. If expiring within BUFFER, best-effort OAuth refresh; persist the rotated
 *      refresh_token back to the file vault atomically. On HTTP 400 (refresh
 *      token already rotated by the Mac/daemon — cross-machine contention) we
 *      SKIP quietly — no browser re-auth (doomed headless) — and just propagate
 *      whatever fresh token the vault currently holds.
 *   3. PUT the fresh claudeAiOauth into the mapped CRS account + reset-status.
 *
 * Single refresher-of-record stays the existing pipeline; this is best-effort
 * top-up + the missing propagation. Runs via crs-token-feed.timer.
 *
 *   node crs-token-feed.mjs            # refresh-if-needed + propagate all
 *   node crs-token-feed.mjs --dry-run  # report only
 *   node crs-token-feed.mjs --status   # show vault vs CRS state
 */
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { foreignActiveKeys } from './account-leases.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const LOG_PATH = join(__dirname, 'rotation.log');
const FILE_VAULT = join(process.env.HOME || '', '.claude', '.credentials.json');
const CRS_BASE = process.env.CRS_BASE || 'http://127.0.0.1:3005';
const CRS_CONTAINER = process.env.CRS_CONTAINER || 'crs-claude-relay-1';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const BUFFER_MS = 2 * 3_600_000; // refresh if expiring within 2h
const INTER_DELAY_MS = 1_500;
const SAMRENDERS_EMAIL = process.env.CLAUDE_ROTATOR_SAMRENDERS_EMAIL || ['sam.renders', 'gmail.com'].join('@');

// vault key (label || email) -> CRS account name
const CRS_NAME_BY_KEY = {
  'chairman@heartfeldt.org': 'pool-chairman',
  'support@healify.ai': 'canary-support',
  heartfeldt: 'pool-heartfeldt-personal',
  'heartfeldt-team': 'pool-heartfeldt-team',
  'sam@samfeldt.com': 'pool-samfeldt',
  [SAMRENDERS_EMAIL]: 'pool-samrenders',
  'info@auroracapital.nl': 'pool-aurora',
  'sam@heartfeldt.foundation': 'pool-foundation',
  'sponsors@heartfeldt.org': 'canary-sponsors',
  'info@lifecycleinnovations.limited': 'canary-lifecycle',
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STATUS = args.includes('--status');

function log(msg) {
  const line = `[${new Date().toISOString()}] [crs-feed] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}
function accountKey(a) {
  return a.label || a.email;
}
function fvLoad() {
  try {
    return JSON.parse(readFileSync(FILE_VAULT, 'utf8'));
  } catch {
    return {};
  }
}
function fvSave(v) {
  const t = `${FILE_VAULT}.tmp.${process.pid}`;
  writeFileSync(t, JSON.stringify(v, null, 2));
  renameSync(t, FILE_VAULT);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oauthRefresh(refreshToken) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      return {
        ok: true,
        oauth: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token || refreshToken,
          expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000,
          subscriptionType: body.subscription_type,
          rateLimitTier: body.rate_limit_tier,
        },
      };
    }
    return { ok: false, status: res.status, error: body?.error?.message || body?.error?.type || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function crsLogin() {
  let pw = '';
  try {
    pw = execSync(
      `docker inspect ${CRS_CONTAINER} --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ADMIN_PASSWORD=//p'`,
      { timeout: 8000 },
    )
      .toString()
      .trim();
  } catch {}
  if (!pw) return null;
  try {
    const r = await fetch(`${CRS_BASE}/web/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cradmin', password: pw }),
    }).then((x) => x.json());
    const tok = r.token || r.data?.token;
    return tok ? { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` } : null;
  } catch {
    return null;
  }
}

async function main() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const H = await crsLogin();
  if (!H) {
    log('CRS login failed (relay down or no admin pw) — aborting');
    process.exit(1);
  }
  const acctsResp = await fetch(`${CRS_BASE}/admin/claude-accounts`, { headers: H }).then((r) => r.json());
  const byName = Object.fromEntries((acctsResp.data || acctsResp.accounts || acctsResp).map((a) => [a.name, a]));
  const now = Date.now();
  // Contention guard: never refresh an account the OTHER host holds the lease on
  // (refresh tokens are single-use; double-refresh → 400s on the other machine).
  let foreign = new Set();
  try {
    foreign = new Set(foreignActiveKeys());
  } catch (e) {
    log(`lease check failed (${e.message}) — proceeding propagate-only`);
  }
  if (foreign.size) log(`foreign-leased (refresh-skipped): ${[...foreign].join(', ')}`);

  if (STATUS) {
    for (const a of config.accounts) {
      const key = accountKey(a);
      const crsName = CRS_NAME_BY_KEY[key];
      const e = fvLoad()[`Claude-Rotation-${key}`]?.claudeAiOauth;
      const min = e?.expiresAt ? Math.floor((e.expiresAt - now) / 60000) : 'n/a';
      const crs = byName[crsName];
      console.log(
        `  ${key} -> ${crsName || '?'}: vault_min=${min} crs=${crs ? crs.status + '/sched=' + crs.schedulable : 'MISSING'}`,
      );
    }
    return;
  }

  let refreshed = 0,
    propagated = 0,
    skipped = 0,
    missing = 0;
  for (let i = 0; i < config.accounts.length; i++) {
    const a = config.accounts[i];
    const key = accountKey(a);
    const crsName = CRS_NAME_BY_KEY[key];
    if (!crsName || !byName[crsName]) {
      missing++;
      continue;
    }
    const crs = byName[crsName];

    const vault = fvLoad();
    const entry = vault[`Claude-Rotation-${key}`]?.claudeAiOauth;
    if (!entry?.accessToken) {
      log(`${key}: no vault token — skip`);
      skipped++;
      continue;
    }

    let oauth = entry;
    const expiring = !oauth.expiresAt || oauth.expiresAt < now + BUFFER_MS;
    if (expiring && foreign.has(key)) {
      log(`${key}: expiring but foreign-leased — refresh deferred to owner host, propagating current token`);
    } else if (expiring && oauth.refreshToken && !DRY) {
      if (i > 0) await sleep(INTER_DELAY_MS);
      const r = await oauthRefresh(oauth.refreshToken);
      if (r.ok) {
        oauth = { ...oauth, ...r.oauth, scopes: oauth.scopes || [] };
        vault[`Claude-Rotation-${key}`] = {
          claudeAiOauth: oauth,
          mcpOAuth: vault[`Claude-Rotation-${key}`]?.mcpOAuth || {},
        };
        fvSave(vault);
        refreshed++;
        log(`${key}: refreshed (min_left=${Math.floor((oauth.expiresAt - now) / 60000)})`);
      } else if (r.status === 400) {
        log(`${key}: refresh 400 (rotated elsewhere) — propagating existing vault token`);
      } else {
        log(`${key}: refresh failed (${r.error}) — propagating existing vault token`);
      }
    }

    // propagate whatever fresh token we have (don't push already-expired)
    if ((oauth.expiresAt || 0) < now + 60_000) {
      log(`${key}: vault token expired, no refresh — CRS left as-is`);
      skipped++;
      continue;
    }
    if (DRY) {
      log(`${key}: [dry] would PUT -> ${crsName}`);
      continue;
    }
    try {
      const put = await fetch(`${CRS_BASE}/admin/claude-accounts/${crs.id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ claudeAiOauth: oauth, schedulable: true }),
      });
      if (put.ok) {
        if (crs.status === 'error')
          await fetch(`${CRS_BASE}/admin/claude-accounts/${crs.id}/reset-status`, { method: 'POST', headers: H }).catch(
            () => {},
          );
        propagated++;
      } else {
        log(`${key}: CRS PUT ${put.status}`);
      }
    } catch (e) {
      log(`${key}: CRS PUT error ${e.message}`);
    }
  }
  log(`feed complete: ${refreshed} refreshed, ${propagated} propagated, ${skipped} skipped, ${missing} unmapped`);
}
main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
