#!/usr/bin/env node
/**
 * crs-token-feed.mjs — propagate rotation vault tokens into a local CRS pool.
 *
 * On headless Linux hosts the macOS keychain refresh path is unavailable; this
 * feeder reads ~/.claude/.credentials.json (or crs.fileVaultPath), optionally
 * refreshes expiring tokens, and PUTs claudeAiOauth into mapped CRS accounts.
 *
 * Map each rotator account to a CRS admin account name via crsAccountName in
 * config.json (or crs.nameByVaultKey). Runs via crs-token-feed.timer when installed.
 *
 *   node crs-token-feed.mjs            # refresh-if-needed + propagate all
 *   node crs-token-feed.mjs --dry-run  # report only
 *   node crs-token-feed.mjs --status   # show vault vs CRS state
 */
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { foreignActiveKeys } from './account-leases.mjs';
import { assertCrsInvariant } from './route-state.mjs';
import { acquireRefreshLock } from './crs-refresh-lock.mjs';
import {
  buildCrsNameMaps,
  crsBaseUrl,
  crsFileVaultPath,
  loadRotationConfig,
  resolveConfigPath,
} from './crs-pool-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, 'rotation.log');
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const BUFFER_MS = 2 * 3_600_000; // refresh if expiring within 2h
const INTER_DELAY_MS = 1_500;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STATUS = args.includes('--status');

function log(msg) {
  const line = `[${new Date().toISOString()}] [crs-feed] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
function accountKey(a) { return a.label || a.email; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeVaultOps(fileVaultPath) {
  return {
    load() {
      try { return JSON.parse(readFileSync(fileVaultPath, 'utf8')); } catch { return {}; }
    },
    save(v) {
      const t = `${fileVaultPath}.tmp.${Date.now()}`;
      writeFileSync(t, JSON.stringify(v, null, 2));
      renameSync(t, fileVaultPath);
    },
  };
}

async function oauthRefresh(refreshToken) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      return { ok: true, oauth: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshToken,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000,
        subscriptionType: body.subscription_type,
        rateLimitTier: body.rate_limit_tier,
      } };
    }
    return { ok: false, status: res.status, error: body?.error?.message || body?.error?.type || `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function crsLogin(crsBase, crsContainer, adminUser = 'cradmin') {
  let pw = '';
  try {
    pw = execSync(
      `docker inspect ${crsContainer} --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ADMIN_PASSWORD=//p'`,
      { timeout: 8000 },
    ).toString().trim();
  } catch {}
  if (!pw) return null;
  try {
    const r = await fetch(`${crsBase}/web/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUser, password: pw }),
    }).then(x => x.json());
    const tok = r.token || r.data?.token;
    return tok ? { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` } : null;
  } catch { return null; }
}

async function main() {
  assertCrsInvariant(process.env, 'crs-token-feed:main');
  const configPath = resolveConfigPath();
  if (!configPath) {
    log('no rotation config found — set CRS_CONFIG or install account-rotation config.json');
    process.exit(1);
  }
  const config = loadRotationConfig();
  const { nameByVaultKey } = buildCrsNameMaps(config);
  const fileVault = crsFileVaultPath(config);
  const crsBase = crsBaseUrl(config);
  const crsContainer = process.env.CRS_CONTAINER || config.crs?.containerName || 'crs-claude-relay-1';
  const adminUser = process.env.CRS_ADMIN_USER || config.crs?.adminUser || 'cradmin';
  const vault = makeVaultOps(fileVault);
  const H = await crsLogin(crsBase, crsContainer, adminUser);
  if (!H) { log('CRS login failed (relay down or no admin pw) — aborting'); process.exit(1); }
  const acctsResp = await fetch(`${crsBase}/admin/claude-accounts`, { headers: H }).then(r => r.json());
  const byName = Object.fromEntries((acctsResp.data || acctsResp.accounts || acctsResp).map(a => [a.name, a]));
  const now = Date.now();
  // Contention guard: never refresh an account the OTHER host holds the lease on
  // (refresh tokens are single-use; double-refresh → 400s on the other machine).
  let foreign = new Set();
  try { foreign = new Set(foreignActiveKeys()); } catch (e) { log(`lease check failed (${e.message}) — proceeding propagate-only`); }
  if (foreign.size) log(`foreign-leased (refresh-skipped): ${[...foreign].join(', ')}`);

  if (STATUS) {
    for (const a of config.accounts) {
      const key = accountKey(a); const crsName = nameByVaultKey[key];
      const e = vault.load()[`Claude-Rotation-${key}`]?.claudeAiOauth;
      const min = e?.expiresAt ? Math.floor((e.expiresAt - now) / 60000) : 'n/a';
      const crs = byName[crsName];
      console.log(`  ${key} -> ${crsName || '?'}: vault_min=${min} crs=${crs ? crs.status + '/sched=' + crs.schedulable : 'MISSING'}`);
    }
    return;
  }

  let refreshed = 0, propagated = 0, skipped = 0, missing = 0;
  for (let i = 0; i < config.accounts.length; i++) {
    const a = config.accounts[i];
    const key = accountKey(a);
    const crsName = nameByVaultKey[key];
    if (!crsName || !byName[crsName]) { missing++; continue; }
    const crs = byName[crsName];

    const vaultData = vault.load();
    const entry = vaultData[`Claude-Rotation-${key}`]?.claudeAiOauth;
    if (!entry?.accessToken) { log(`${key}: no vault token — skip`); skipped++; continue; }

    let oauth = entry;
    const expiring = !oauth.expiresAt || oauth.expiresAt < now + BUFFER_MS;
    if (expiring && foreign.has(key)) {
      log(`${key}: expiring but foreign-leased — refresh deferred to owner host, propagating current token`);
    } else if (expiring && oauth.refreshToken && !DRY) {
      if (i > 0) await sleep(INTER_DELAY_MS);
      const release = acquireRefreshLock(key);
      if (!release) {
        log(`${key}: refresh lock held elsewhere — propagate-only`);
      } else {
        try {
          const r = await oauthRefresh(oauth.refreshToken);
          if (r.ok) {
            oauth = { ...oauth, ...r.oauth, scopes: oauth.scopes || [] };
            vaultData[`Claude-Rotation-${key}`] = { claudeAiOauth: oauth, mcpOAuth: vaultData[`Claude-Rotation-${key}`]?.mcpOAuth || {} };
            vault.save(vaultData);
            refreshed++;
            log(`${key}: refreshed (min_left=${Math.floor((oauth.expiresAt - now) / 60000)})`);
          } else if (r.status === 400) {
            log(`${key}: refresh 400 (rotated elsewhere) — propagating existing vault token`);
          } else {
            log(`${key}: refresh failed (${r.error}) — propagating existing vault token`);
          }
        } finally {
          release();
        }
      }
    }

    // propagate whatever fresh token we have (don't push already-expired)
    if ((oauth.expiresAt || 0) < now + 60_000) { log(`${key}: vault token expired, no refresh — CRS left as-is`); skipped++; continue; }
    if (DRY) { log(`${key}: [dry] would PUT -> ${crsName}`); continue; }
    try {
      const put = await fetch(`${crsBase}/admin/claude-accounts/${crs.id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ claudeAiOauth: oauth }),
      });
      if (put.ok) {
        await fetch(`${crsBase}/admin/claude-accounts/${crs.id}/reset-status`, { method: 'POST', headers: H }).catch(() => {});
        propagated++;
      } else { log(`${key}: CRS PUT ${put.status}`); }
    } catch (e) { log(`${key}: CRS PUT error ${e.message}`); }
  }
  log(`feed complete: ${refreshed} refreshed, ${propagated} propagated, ${skipped} skipped, ${missing} unmapped`);
  if (!DRY && propagated > 0 && process.env.CRS_FEED_SKIP_PRIORITY !== '1') {
    const pr = spawnSync(process.execPath, [join(__dirname, 'crs-priority-daemon.mjs')], {
      env: { ...process.env, CRS_ADMIN_PASSWORD: process.env.CRS_ADMIN_PASSWORD || '' },
      timeout: 120_000,
      encoding: 'utf8',
    });
    if (pr.status === 0) log('priority tick after feed: ok');
    else log(`priority tick after feed: exit=${pr.status} ${(pr.stderr || pr.stdout || '').slice(0, 200)}`);
  }
}
main().catch(e => { log(`fatal: ${e.message}`); process.exit(1); });
