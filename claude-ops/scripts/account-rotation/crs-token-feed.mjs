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
import { readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { foreignActiveKeys } from './account-leases.mjs';
import { assertCrsInvariant } from './route-state.mjs';
import { acquireRefreshLock, claimRefreshPace } from './crs-refresh-lock.mjs';
import {
  buildCrsNameMaps,
  crsBaseUrl,
  crsFileVaultPath,
  loadRotationConfig,
  resolveConfigPath,
} from './crs-pool-config.mjs';
import { resolveAccountsBackend } from './ops-accounts-backend.mjs';
import { withAuthWriterLock } from './auth-writer-coordination.mjs';
import { verifyRefreshedTokenIdentity } from './token-identity.mjs';
import { automatedAuthAllowed } from './auto-auth-policy.mjs';
import { publishCredentialFileCas, snapshotCredentialFile } from './credential-file-publication.mjs';

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
  try {
    // Operational log data is written only to the fixed plugin-local log path.
    // CodeQL[js/http-to-file-access]
    appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}
function accountKey(a) {
  return a.label || a.email;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeVaultOps(fileVaultPath) {
  const snapshots = new WeakMap();
  return {
    load() {
      try {
        const snapshot = snapshotCredentialFile(fileVaultPath);
        const value = snapshot.absent ? {} : JSON.parse(snapshot.bytes.toString('utf8'));
        snapshots.set(value, snapshot);
        return value;
      } catch {
        return {};
      }
    },
    save(v) {
      const snapshot = snapshots.get(v);
      if (!snapshot) throw new Error('CRS_VAULT_SNAPSHOT_REQUIRED');
      publishCredentialFileCas(fileVaultPath, Buffer.from(JSON.stringify(v, null, 2)), snapshot);
    },
  };
}

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

async function crsLogin(crsBase, crsContainer, adminUser = 'cradmin') {
  let pw = '';
  try {
    pw = execSync(
      `docker inspect ${crsContainer} --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ADMIN_PASSWORD=//p'`,
      { timeout: 8000 },
    )
      .toString()
      .trim();
  } catch {}
  if (!pw) return null;
  if (!process.env.CRS_ADMIN_PASSWORD) process.env.CRS_ADMIN_PASSWORD = pw;
  try {
    const r = await fetch(`${crsBase}/web/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUser, password: pw }),
    }).then((x) => x.json());
    const tok = r.token || r.data?.token;
    return tok ? { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` } : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.CLAUDE_ROTATOR_CONFIG) throw new Error('CLAUDE_ROTATOR_CONFIG_REQUIRED');
  if (!process.env.CLAUDE_AUTH_COORDINATION_CONFIG) throw new Error('AUTH_COORDINATION_CONFIG_REQUIRED');
  const earlyCfg = loadRotationConfig();
  const backend = resolveAccountsBackend({ env: process.env, cfgBackend: earlyCfg.crs?.backend });
  if (backend === 'local') {
    log('backend=local — CRS token-feed no-op (CLI seats read vault/keychain directly; no pool to feed)');
    return;
  }
  assertCrsInvariant(process.env, 'crs-token-feed:main');
  const configPath = resolveConfigPath();
  if (!configPath) {
    log('no rotation config found — set CRS_CONFIG or install account-rotation config.json');
    process.exit(1);
  }
  const config = earlyCfg;
  const { nameByVaultKey } = buildCrsNameMaps(config);
  const fileVault = crsFileVaultPath(config);
  const crsBase = crsBaseUrl(config);
  const crsContainer = process.env.CRS_CONTAINER || config.crs?.containerName || 'crs-claude-relay-1';
  const adminUser = process.env.CRS_ADMIN_USER || config.crs?.adminUser || 'cradmin';
  const vault = makeVaultOps(fileVault);
  const H = await crsLogin(crsBase, crsContainer, adminUser);
  if (!H) {
    log('CRS login failed (relay down or no admin pw) — aborting');
    process.exit(1);
  }
  const acctsResp = await fetch(`${crsBase}/admin/claude-accounts`, { headers: H }).then((r) => r.json());
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
      const crsName = nameByVaultKey[key];
      const e = vault.load()[`Claude-Rotation-${key}`]?.claudeAiOauth;
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
    const crsName = nameByVaultKey[key];
    if (!crsName || !byName[crsName]) {
      missing++;
      continue;
    }
    const crs = byName[crsName];

    await withAuthWriterLock(async () => {
      const vaultData = vault.load();
      const entry = vaultData[`Claude-Rotation-${key}`]?.claudeAiOauth;
      if (!entry?.accessToken) {
        log(`${key}: no vault token — skip`);
        skipped++;
        return;
      }

      let oauth = entry;
      const expiring = !oauth.expiresAt || oauth.expiresAt < now + BUFFER_MS;
      if (expiring && foreign.has(key)) {
        log(`${key}: expiring but foreign-leased — refresh deferred to owner host, propagating current token`);
      } else if (expiring && oauth.refreshToken && !DRY && automatedAuthAllowed(a)) {
        if (i > 0) await sleep(INTER_DELAY_MS);
        const release = acquireRefreshLock(key);
        if (!release) {
          log(`${key}: refresh lock held elsewhere — propagate-only`);
        } else {
          try {
            const paceWaitMs = claimRefreshPace(key);
            if (paceWaitMs === null) {
              log(`${key}: refresh pacing lease held elsewhere — propagate-only`);
              return;
            }
            if (paceWaitMs > 0) await sleep(paceWaitMs);
            const r = await withAuthWriterLock(async () => {
              // Re-read under the canonical writer lock: refresh tokens are
              // single-use and the resulting file update is one transaction.
              const currentVault = vault.load();
              const current = currentVault[`Claude-Rotation-${key}`]?.claudeAiOauth;
              if (!current?.refreshToken) return { ok: false, error: 'vault token changed' };
              const result = await oauthRefresh(current.refreshToken);
              if (result.ok) {
                await verifyRefreshedTokenIdentity(a, result.oauth.accessToken);
                const updated = { ...current, ...result.oauth, scopes: current.scopes || [] };
                currentVault[`Claude-Rotation-${key}`] = {
                  claudeAiOauth: updated,
                  mcpOAuth: currentVault[`Claude-Rotation-${key}`]?.mcpOAuth || {},
                };
                vault.save(currentVault);
                result.oauth = updated;
              }
              return result;
            });
            if (r.ok) {
              oauth = r.oauth;
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
      } else if (expiring && oauth.refreshToken && !DRY) {
        log(`${key}: automated refresh denied — propagate-only`);
      }

      // propagate whatever fresh token we have (don't push already-expired)
      if ((oauth.expiresAt || 0) < now + 60_000) {
        log(`${key}: vault token expired, no refresh — CRS left as-is`);
        skipped++;
        return;
      }
      if (DRY) {
        log(`${key}: [dry] would PUT -> ${crsName}`);
        return;
      }
      try {
        await verifyRefreshedTokenIdentity(a, oauth.accessToken);
        const update = { claudeAiOauth: oauth };
        if ('proxy' in crs) update.proxy = crs.proxy;
        if ('maxConcurrency' in crs) update.maxConcurrency = crs.maxConcurrency;
        if ('schedulable' in crs) update.schedulable = crs.schedulable;
        // The credential is sent only to the configured CRS administrative endpoint.
        // CodeQL[js/file-access-to-http]
        const put = await fetch(`${crsBase}/admin/claude-accounts/${crs.id}`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify(update),
        });
        if (put.ok) {
          if (crs.schedulable !== false) {
            // This fixed CRS control request contains no credential-file bytes.
            // CodeQL[js/file-access-to-http]
            await fetch(`${crsBase}/admin/claude-accounts/${crs.id}/reset-status`, {
              method: 'POST',
              headers: H,
            }).catch(() => {});
          }
          propagated++;
        } else {
          log(`${key}: CRS PUT ${put.status}`);
        }
      } catch (e) {
        log(`${key}: CRS PUT error ${e.message}`);
      }
    });
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
main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
