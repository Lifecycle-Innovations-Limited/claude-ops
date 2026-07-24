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
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync, spawnSync, spawn } from 'child_process';
import { foreignActiveKeys } from './account-leases.mjs';
import { assertCrsInvariant } from './route-state.mjs';
import { propagateFreshTokenToPeer } from './crs-peer-propagate.mjs';
import { fetchWithProxyFallback } from './proxy-helper.mjs';
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
// Align with oauth-keep-alive-policy: never leave tokens under 6h remaining
// when this host is the refresh authority (CRS_FEED_REFRESH_AUTHORITY=1).
const BUFFER_MS = Number(process.env.CLAUDE_OAUTH_REFRESH_WHEN_BELOW_MS || 6 * 3_600_000);
const INTER_DELAY_MS = 1_500;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STATUS = args.includes('--status');
// The rotation vault is the sole refresh authority. Feeders only copy its
// current value into CRS, preventing Mac and EC2 from rotating the same
// single-use refresh token independently.
const ROTATOR_OWNS_CRS_REFRESH = process.env.ROTATOR_OWNS_CRS_REFRESH === '1';
// When the rotator fully owns CRS refresh, this feeder is ALWAYS propagate-only —
// CRS_FEED_REFRESH_AUTHORITY is retired; refresh-tokens.mjs is the one place
// that performs an OAuth refresh_token grant (see NOTES-rotation-consistency.md).
// Off by default: this feeder keeps its pre-existing opt-in escape hatch as-is.
const PROPAGATE_ONLY = ROTATOR_OWNS_CRS_REFRESH
  ? true
  : args.includes('--propagate-only') || process.env.CRS_FEED_REFRESH_AUTHORITY !== '1';

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
function accountUpdate(account, oauth) {
  const update = { claudeAiOauth: oauth };
  if (account.email) update.email = account.email;
  return update;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function futureIso(value) {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > Date.now();
}

function crsHardHeld(account) {
  if (!account) return false;
  const status = String(account.status || '');
  return (
    ['blocked', 'auth_repair', 'error', 'unauthorized', 'temp_error', 'account_blocked'].includes(status) ||
    futureIso(account.rateLimitEndAt || account.rateLimitStatus?.rateLimitEndAt || account.rateLimitStatus?.resetAt) ||
    futureIso(account.weeklyRateLimitEndAt)
  );
}

function expiryEpochMs(oauth) {
  const raw = oauth?.expiresAt;
  if (raw === null || raw === undefined || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenNearExpiry(oauth, at = Date.now()) {
  const expiresAt = expiryEpochMs(oauth);
  return !expiresAt || expiresAt < at + BUFFER_MS;
}

function truthy(value) {
  return value === true || value === 'true';
}

function default401StatePath() {
  const configDir =
    process.env.CRS_CONFIG_DIR ||
    (process.platform === 'darwin'
      ? join(process.env.HOME || __dirname, '.config', 'crs-sync')
      : join(process.env.HOME || '/home/ec2-user', 'crs-config'));
  return join(configDir, 'crs-401-state.json');
}

function load401State(config) {
  const candidates = [process.env.CRS_401_STATE_PATH, config.crs?.state401Path, default401StatePath()].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('expected an object');
      return { state, failed: false };
    } catch {
      log('401 quarantine state is unreadable — propagation fails closed this cycle');
      return { state: {}, failed: true };
    }
  }
  return { state: {}, failed: false };
}

function crsNeedsReauth(account, state) {
  if (!account) return false;
  const entry = state[account.id] || state[account.name];
  const status = String(account.status || '').toLowerCase();
  const authError = [account.errorCode, account.errorMessage, account.lastError]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    truthy(entry?.needsReauth) ||
    truthy(account.needsReauth) ||
    Boolean(account.unauthorizedAt) ||
    ['unauthorized', 'auth_repair', 'account_blocked'].includes(status) ||
    (['error', 'temp_error'].includes(status) && /401|unauthor|oauth|auth[_ -]?repair/.test(authError))
  );
}

// Magic-link cooldown tracker: persist to file so it survives feed restarts.
const MAGIC_COOLDOWN_PATH = join(__dirname, '.crs-magic-cooldowns.json');
const MAGIC_LINK_COOLDOWN_MS = 30 * 60_000;

function loadMagicCooldowns() {
  try {
    return JSON.parse(readFileSync(MAGIC_COOLDOWN_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveMagicCooldowns(data) {
  try {
    writeFileSync(MAGIC_COOLDOWN_PATH, JSON.stringify(data, null, 0));
  } catch {}
}

async function triggerMagicLink(key, email) {
  const cooldowns = loadMagicCooldowns();
  const last = cooldowns[key];
  if (last && Date.now() - last < MAGIC_LINK_COOLDOWN_MS) {
    log(`${key}: magic-link on cooldown (${Math.round((Date.now() - last) / 60000)}m ago) — skipping`);
    return false;
  }
  const rotateMjs = join(__dirname, 'rotate.mjs');
  log(`${key}: triggering magic-link re-auth for ${email}`);
  try {
    const child = spawn(process.execPath, [rotateMjs, '--magic-link', '--to', email], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    cooldowns[key] = Date.now();
    saveMagicCooldowns(cooldowns);
    return true;
  } catch (e) {
    log(`${key}: magic-link spawn error: ${e.message}`);
    return false;
  }
}

function makeVaultOps(fileVaultPath) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(fileVaultPath, 'utf8'));
      } catch {
        return {};
      }
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
    const res = await fetchWithProxyFallback(TOKEN_ENDPOINT, {
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
  let pw = process.env.CRS_ADMIN_PASSWORD || '';
  if (!pw) {
    // Do the `sed -n 's/^ADMIN_PASSWORD=//p'` filtering in JS instead of a
    // shell pipeline — execFileSync means no shell parses crsContainer at all.
    try {
      const envOut = execFileSync(
        'docker',
        ['inspect', crsContainer, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
        { timeout: 8000, encoding: 'utf8' },
      );
      const m = envOut.match(/^ADMIN_PASSWORD=(.*)$/m);
      if (m) pw = m[1].trim();
    } catch {}
  }
  // Native Mac relay (launchd node, no docker): fall back to local .env
  if (!pw) {
    try {
      const envPaths = [
        `${process.env.HOME}/crs-local-fallback/relay-image/app/.env`,
        `${process.env.HOME}/crs-local-fallback/.env`,
      ];
      for (const ep of envPaths) {
        try {
          const m = readFileSync(ep, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m);
          if (m) {
            pw = m[1].trim();
            break;
          }
        } catch {}
      }
    } catch {}
  }
  if (!pw) return null;
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
  const detectCrsContainer = () => {
    try {
      const out = execSync('docker ps --format {{.Names}}', { encoding: 'utf8', timeout: 3000 });
      const names = out.split(/\n/).filter(Boolean);
      if (names.includes('crs-local-fallback-claude-relay-1')) return 'crs-local-fallback-claude-relay-1';
      if (names.includes('crs-claude-relay-1')) return 'crs-claude-relay-1';
    } catch {}
    return config.crs?.containerName || 'crs-claude-relay-1';
  };
  // Prefer live container over stale config (Mac uses crs-local-fallback-*).
  const crsContainer = process.env.CRS_CONTAINER || detectCrsContainer();
  const adminUser = process.env.CRS_ADMIN_USER || config.crs?.adminUser || 'cradmin';
  const vault = makeVaultOps(fileVault);
  const H = await crsLogin(crsBase, crsContainer, adminUser);
  if (!H) {
    log('CRS login failed (relay down or no admin pw) — aborting');
    process.exit(1);
  }
  let acctsResp;
  try {
    const response = await fetch(`${crsBase}/admin/claude-accounts`, { headers: H });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    acctsResp = await response.json();
  } catch (e) {
    log(`Failed to fetch Claude accounts from CRS: ${e.message}`);
    process.exit(1);
  }
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

    // Quarantine skip removed: do not pre-filter needs-reauth accounts. Attempt
    // the refresh/PUT and let Anthropic's actual 400/401 drive recovery below.
    const vaultData = vault.load();
    const entry = vaultData[`Claude-Rotation-${key}`]?.claudeAiOauth;
    if (!entry?.accessToken) {
      log(`${key}: no vault token — skip`);
      skipped++;
      continue;
    }

    let oauth = entry;
    const expiring = tokenNearExpiry(oauth, now);
    if (expiring && PROPAGATE_ONLY) {
      log(`${crsName}: vault token expired or near expiry; propagate-only mode skips PUT`);
      skipped++;
      continue;
    }

    // Refresh lock removed: leases (foreign-lease skip above) already prevent the
    // two boxes from refreshing the same account, and peer propagation + the
    // reactive 400/401 recovery below make any residual race self-healing.
    {
      let refreshedThisCycle = false;
      let recoveredFromPeer = false;
      if (expiring && foreign.has(key)) {
        log(`${key}: expiring but foreign-leased — refresh deferred to owner host`);
      } else if (expiring && oauth.refreshToken && !DRY) {
        if (i > 0) await sleep(INTER_DELAY_MS);
        const r = await oauthRefresh(oauth.refreshToken);
        if (r.ok) {
          oauth = { ...oauth, ...r.oauth, scopes: oauth.scopes || [] };
          vaultData[`Claude-Rotation-${key}`] = {
            claudeAiOauth: oauth,
            mcpOAuth: vaultData[`Claude-Rotation-${key}`]?.mcpOAuth || {},
          };
          vault.save(vaultData);
          refreshed++;
          refreshedThisCycle = true;
          log(`${key}: refreshed (min_left=${Math.floor((oauth.expiresAt - now) / 60000)})`);
          // Single-use refresh tokens: hand the freshly-minted token to the peer
          // box while we still hold the single-writer lock, so its next cycle
          // does not 400 on a now-stale refresh token.
          try {
            propagateFreshTokenToPeer(key, oauth, { log });
          } catch (e) {
            log(`${key}: peer propagation error ${e.message}`);
          }
        } else if (r.status === 400 || r.status === 401) {
          // Let Anthropic's error drive recovery. A 400 (invalid_grant) / 401
          // usually means the peer box already rotated this single-use token and
          // propagated the fresh one to us. Re-read the vault and use it if fresh;
          // only re-auth when the account is genuinely dead.
          const latest = vault.load()[`Claude-Rotation-${key}`]?.claudeAiOauth;
          if (latest?.accessToken && !tokenNearExpiry(latest, now)) {
            oauth = latest;
            recoveredFromPeer = true;
            log(`${key}: refresh ${r.status} but recovered fresh token from vault (peer rotated it)`);
          } else {
            log(`${key}: refresh ${r.status} — no fresh peer token; triggering re-auth`);
            triggerMagicLink(key, a.email);
          }
        } else {
          log(`${key}: refresh failed (${r.error})`);
        }
      }

      // Never copy stale credentials into CRS. A failed refresh or a refresh
      // deferred to the lease owner must leave the existing CRS quarantine intact.
      if (tokenNearExpiry(oauth)) {
        log(`${crsName}: vault token remains expired or near expiry — skip PUT`);
        skipped++;
        continue;
      }
      if (DRY) {
        log(`${key}: [dry] would PUT -> ${crsName}`);
        continue;
      }
      try {
        const put = await fetch(`${crsBase}/admin/claude-accounts/${crs.id}`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify(accountUpdate(a, oauth)),
        });
        if (put.ok) {
          // A token refreshed this cycle (or a fresh one recovered from the peer)
          // proves the account is authorized, so clear any auth quarantine. Real
          // rate-limit holds are not auth failures and must survive.
          const haveFreshProof = refreshedThisCycle || recoveredFromPeer;
          const rateLimited =
            futureIso(crs.rateLimitEndAt || crs.rateLimitStatus?.rateLimitEndAt || crs.rateLimitStatus?.resetAt) ||
            futureIso(crs.weeklyRateLimitEndAt);
          if (haveFreshProof && !rateLimited) {
            await fetch(`${crsBase}/admin/claude-accounts/${crs.id}/reset-status`, {
              method: 'POST',
              headers: H,
            }).catch(() => {});
          } else if (rateLimited) {
            log(`${crsName}: propagated fresh token but preserved rate-limit hold`);
          } else {
            log(`${crsName}: propagated token without resetting CRS status`);
          }
          propagated++;
        } else {
          log(`${key}: CRS PUT ${put.status}`);
        }
      } catch (e) {
        log(`${key}: CRS PUT error ${e.message}`);
      }
    }
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
