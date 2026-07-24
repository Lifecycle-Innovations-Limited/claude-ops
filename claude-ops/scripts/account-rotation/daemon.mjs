#!/usr/bin/env node
/**
 * Claude Account Rotation Daemon
 *
 * Runs in background, monitors:
 *   1. Tool use count (from usage-tracker.js hook)
 *   2. Time per account (maxHoursPerAccount)
 *   3. Rate limit errors (watches Claude Code stderr / log patterns)
 *   4. Token expiry
 *
 * Auto-rotates to the most cooled-down account when any threshold is hit.
 *
 * Rotation path: `node rotate.mjs --no-browser --to <key>` only (keychain swap,
 * no browser). Browser recovery is Gemini-only and never uses a metered cloud fallback
 * runs inside `rotate.mjs` when a browser OAuth flow is used — e.g. force-rotate.sh
 * after fast path fails, `node rotate.mjs --magic-link --force --to …`, or setup --auto.
 *
 * Usage:
 *   node daemon.mjs           # Run in foreground
 *   node daemon.mjs --bg      # Daemonize
 *   node daemon.mjs --stop    # Stop running daemon
 *   node daemon.mjs --status  # Show daemon status
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, statSync } from 'fs';
import { clearHardcodedModelsForOAuthClaudeSettings } from './claude-settings-mode.mjs';
import { readRotationToken, writeRotationToken } from './rotation-vault.mjs';
import {
  destinationUtilHardBlock,
  DAEMON_SAFE_5H_PCT,
  DAEMON_SAFE_7D_PCT,
  DAEMON_RELAXED_BAR,
  isDaemonRotationViable,
  isLiveUtilOk,
  liveUtilMax,
} from './rotation-policy.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync, spawn, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { applyAccountLeases, writeLease } from './account-leases.mjs';
import { sweepDeferredRespawns, listLiveBgSessions, doRespawn } from './bg-respawn.mjs';
import { pickAccountForSession, recordSessionLease, readLeases } from './session-router.mjs';
import { checkFleetStuckAgents } from './fleet-recovery.mjs';
import { repairAccountOn401 } from './auth-repair.mjs';
import { refreshOneAccount } from './refresh-tokens.mjs';
import { checkCrsHealth, buildCrsNameMaps } from './crs-pool-config.mjs';

// Flag-gated cutover to the consolidated refresh authority (see
// NOTES-rotation-consistency.md). Default OFF: daemon.mjs keeps refreshing
// tokens itself via refreshSingleToken()/_dynamicRefresh() below, exactly as
// before. When ON, both call sites delegate to refresh-tokens.mjs's
// refreshOneAccount() instead, which takes the shared per-account lock
// before touching a token — the old local functions stay in the tree,
// unused, until a follow-up PR removes them once the new path has run clean.
const ROTATOR_OWNS_CRS_REFRESH = process.env.ROTATOR_OWNS_CRS_REFRESH === '1';

// CRS reachability cache — refreshed at startup and every ~5min alongside the
// existing periodic status log (see mainLoop). Only consulted when
// ROTATOR_OWNS_CRS_REFRESH=1: a dead CRS relay must not stop keychain-only
// accounts from refreshing, but it should stop this daemon from refreshing a
// CRS-mapped account's OAuth token while CRS can't be told about the new one.
let crsHealthy = true;
async function refreshCrsHealthCache(config) {
  try {
    const health = await checkCrsHealth(config, { timeoutMs: 3000 });
    crsHealthy = health.reachable;
    log(
      `[crs-health] ${health.reachable ? 'reachable' : 'UNREACHABLE'} (${health.base}${health.error ? ` — ${health.error}` : ''})`,
    );
  } catch (e) {
    crsHealthy = false;
    log(`[crs-health] check error — ${e.message}`);
  }
}
function isCrsMappedAccount(account, config) {
  if (account.crsAccountName || account.crsName) return true;
  const { nameByVaultKey } = buildCrsNameMaps(config);
  return Boolean(nameByVaultKey[accountKey(account)]);
}
import { fetchWithProxyFallback } from './proxy-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const PATCH_025_DAEMON_CRS_ONLY = true;

// TTY/pty hygiene for fleet: ensure that even if a sub-agent or error path tries to
// write control sequences while a `claude agents` TUI (raw mode) is active, we
// restore sanity on our exit and prefer dedicated logs over controlling tty.
function resetTty() {
  try {
    execSync('stty sane 2>/dev/null || true', { stdio: 'ignore', timeout: 800 });
  } catch {}
}
process.once('exit', resetTty);
const STATE_PATH = join(__dirname, 'state.json');
const LOG_PATH = join(__dirname, 'rotation.log');
const PID_FILE = join(__dirname, '.daemon.pid');
const ROTATE_SCRIPT = join(__dirname, 'rotate.mjs');

// Keychain account name — must match rotate.mjs convention.
const ACTIVE_KEYCHAIN_ACCOUNT = process.env.USER || 'unknown';
const VAULT_KEYCHAIN_ACCOUNT = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';

const RATE_LIMIT_COOLDOWN = 10_000; // 10s after rate limit before rotating
const POLL_INTERVAL = 30_000; // 30s main-loop tick
const POST_ROTATION_BLACKOUT = 180_000; // 3min after rotation: ignore ALL triggers
// Hard anti-thrash cap: file-driven rotations limited to 1 per 2min. Explicit
// 429 / 401 hooks bypass this (those are real-time signals from a tool failure
// and cannot be stale). Without this, .rate-limits.json poisoning by stale-token
// sessions caused 30+ rotations/hour against a cool active account (2026-05-06).
const FILE_ROTATION_MIN_INTERVAL = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Exhausted-account park map ────────────────────────────────────────────────
// Prevents rescue-loop thrashing on accounts stuck at >=95% for the full reset
// window. Maps accountKey → epoch-ms timestamp before which the account is
// "parked" (skipped for rescue). Reset automatically when the window resets.
// In-memory only — intentionally resets on daemon restart so stale parks don't
// persist across a full reset cycle.
const PARK_THRESHOLD_PCT = 95; // park when max(5h,7d) >= this
const _parkedUntil = new Map(); // accountKey → epoch-ms

function isParked(key) {
  const until = _parkedUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    _parkedUntil.delete(key);
    return false;
  }
  return true;
}

function parkAccount(key, resetEpochSec, reason) {
  // Park until reset time, with a 2-min buffer so the first poll after reset
  // re-probes rather than immediately triggering. If no reset info, park for
  // 10 minutes as a conservative fallback.
  const resetMs = resetEpochSec ? resetEpochSec * 1000 + 2 * 60_000 : Date.now() + 10 * 60_000;
  _parkedUntil.set(key, resetMs);
  const minsUntil = Math.ceil((resetMs - Date.now()) / 60_000);
  log(`[park] ${key} parked for ${minsUntil}min (${reason})`);
}

const MAX_LOG_SIZE = 50_000; // 50KB — ~500 lines, enough for debugging
function log(msg) {
  const line = `[${new Date().toISOString()}] [daemon] ${msg}`;
  console.error(line);
  try {
    appendFileSync(LOG_PATH, line + '\n');
    // Truncate: keep last half when exceeding max
    try {
      const { size } = statSync(LOG_PATH);
      if (size > MAX_LOG_SIZE) {
        const content = readFileSync(LOG_PATH, 'utf8');
        const lines = content.split('\n');
        writeFileSync(LOG_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch {}
  } catch {}
}

function notify(title, msg) {
  try {
    if (IS_LINUX) {
      spawnSync('notify-send', [title, msg], { timeout: 3000 });
    } else {
      const escaped = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const titleEsc = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawnSync('osascript', ['-e', `display notification "${escaped}" with title "${titleEsc}"`], { timeout: 5000 });
    }
  } catch {}
}

// Cross-machine account leases (2026-06-06): NOT a static per-machine split.
// Both machines may use ALL accounts; the only constraint is the same account is
// never ACTIVE on both at once. readConfig() drops accounts a FOREIGN host holds
// a fresh lease on; the loop heartbeats THIS machine's active-account lease.
// Never drop our own active key. Fail-open. Mirror of rotate.mjs. See
// account-leases.mjs for the S3 store + TTL semantics.
function readConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  let keepKey = null;
  try {
    const st = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    keepKey = st.activeAccount || null;
  } catch {}
  return applyAccountLeases(config, {
    keepKey,
    log: (m) => {
      try {
        log(m);
      } catch {}
    },
  });
}
// Legacy account-key renames: old label → new canonical key.
// Applied once per readState() call to keep state.json consistent as labels evolve.
// Safe to run repeatedly (no-op when the old key doesn't exist).
const STATE_KEY_MIGRATIONS = {
  'example-personal': 'example', // label changed: personal org is now just "example"
};

function readState() {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { activeAccount: null, accounts: {}, toolUses: 0, totalRotations: 0 };
  }
  // Apply key migrations: rename stale keys to canonical keys.
  let migrated = false;
  if (state.accounts) {
    for (const [oldKey, newKey] of Object.entries(STATE_KEY_MIGRATIONS)) {
      if (state.accounts[oldKey] && !state.accounts[newKey]) {
        state.accounts[newKey] = state.accounts[oldKey];
        delete state.accounts[oldKey];
        migrated = true;
        log(`[state-migration] renamed account key "${oldKey}" → "${newKey}"`);
      } else if (state.accounts[oldKey]) {
        // Both exist — drop the stale key, keep the newer canonical one.
        delete state.accounts[oldKey];
        migrated = true;
        log(`[state-migration] dropped stale key "${oldKey}" (canonical "${newKey}" already exists)`);
      }
    }
    if (state.activeAccount && STATE_KEY_MIGRATIONS[state.activeAccount]) {
      state.activeAccount = STATE_KEY_MIGRATIONS[state.activeAccount];
      migrated = true;
    }
  }
  if (migrated) {
    try {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch {}
  }
  return state;
}

// ── Account cooldown tracking ───────────────────────────────────────────────
// Each account's state.accounts[key].lastUtilization has { pct, reset, ts }.
// `reset` is epoch seconds for when the 5h window resets. If reset > now, the
// account is still cooling down. rotate.mjs queries all accounts via the
// Anthropic API and populates this data at rotation time.

function accountCooldownStatus(state) {
  const now = Date.now();
  const summary = [];
  for (const [key, acct] of Object.entries(state.accounts || {})) {
    const util = acct.lastUtilization;
    if (!util) {
      summary.push(`  ${key}: unknown`);
      continue;
    }
    const resetMs = util.reset ? util.reset * 1000 : 0;
    const fresh = resetMs && resetMs < now;
    const pct = util.pct ?? '?';
    if (fresh) {
      summary.push(`  ${key}: READY (reset ${Math.round((now - resetMs) / 60_000)}min ago, was ${pct}%)`);
    } else if (resetMs) {
      summary.push(`  ${key}: COOLING (${pct}%, resets in ${Math.round((resetMs - now) / 60_000)}min)`);
    } else {
      summary.push(`  ${key}: ${pct}% (no reset info)`);
    }
  }
  return summary.join('\n');
}

function accountKey(a) {
  return a.label || a.email;
}

// account_email in .rate-limits.json is usually an email, while state.activeAccount
// is the canonical key (label || email). Match both forms.
function utilizationTagMatchesActive(tag, activeKey, accounts) {
  if (!tag) return true;
  if (tag === activeKey) return true;
  const active = accounts.find((a) => accountKey(a) === activeKey);
  return !!(active && tag === active.email);
}

function resolveAccountFromUtilizationTag(tag, config, activeKey) {
  if (!tag) return getActiveAccount(config, activeKey);
  const byKey = config.accounts.find((a) => accountKey(a) === tag);
  if (byKey) return byKey;
  const matches = config.accounts.filter((a) => a.email === tag);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const notActive = matches.find((a) => accountKey(a) !== activeKey);
    if (notActive) return notActive;
    return matches[0];
  }
  return getActiveAccount(config, activeKey);
}

function tokenExpired(json) {
  try {
    const exp = JSON.parse(json)?.claudeAiOauth?.expiresAt;
    if (!exp) return false;
    // Expired or expiring within 5 minutes
    return Date.now() > exp - 5 * 60_000;
  } catch {
    return false;
  }
}

// Linux backend: tokens live in ~/.claude/.credentials.json keyed by service
// name (mirrors rotate.mjs _linuxReadCred). The macOS `security` keychain only
// exists on Darwin — without this branch every probe returned null tokens and
// logged "skipped N expired-token" for all accounts on EC2.
const IS_LINUX = process.platform === 'linux';
const LINUX_CRED_PATH = join(process.env.HOME || '', '.claude', '.credentials.json');

function readStoredToken(account) {
  try {
    return readRotationToken(accountKey(account));
  } catch {
    return null;
  }
}

function deleteStoredToken(account) {
  const svc = `Claude-Rotation-${accountKey(account)}`;
  if (IS_LINUX) {
    try {
      const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
      delete store[svc];
      writeFileSync(LINUX_CRED_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
    } catch {}
    return;
  }
  try {
    execFileSync('security', ['delete-generic-password', '-s', svc, '-a', VAULT_KEYCHAIN_ACCOUNT], {
      stdio: 'ignore',
    });
  } catch {}
}

function writeStoredToken(account, json) {
  writeRotationToken(accountKey(account), json);
}

function syncStoredTokenToCrs(account) {
  if (process.env.CLAUDE_ROTATION_SKIP_CRS_SYNC === '1') return;
  const key = accountKey(account);
  try {
    const out = execFileSync(process.execPath, [join(__dirname, 'sync-crs-account.mjs'), key], {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    log(out.split('\n').slice(-1)[0] || `[crs-sync] ${key}: complete`);
  } catch (e) {
    log(`[crs-sync] ${key}: failed — ${String(e.message || e).slice(0, 180)}`);
  }
}

function getAuthRepairDeps() {
  return {
    readStoredToken,
    writeStoredToken,
    deleteStoredToken,
    syncStoredTokenToCrs,
    log,
    accountKey,
    rotateScriptDir: __dirname,
  };
}

function readActiveKeychainToken() {
  if (IS_LINUX) {
    try {
      const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
      if (!store.claudeAiOauth) return null;
      return JSON.stringify({ claudeAiOauth: store.claudeAiOauth, mcpOAuth: store.mcpOAuth || {} });
    } catch {
      return null;
    }
  }
  try {
    const out = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${ACTIVE_KEYCHAIN_ACCOUNT}" -g 2>&1`,
      {
        timeout: 5000,
      },
    ).toString();
    const m = out.match(/^password: "?(.*?)"?$/m);
    return m ? m[1].replace(/\\"/g, '"') : null;
  } catch {
    return null;
  }
}

function tokenAccessKey(json) {
  try {
    return JSON.parse(json)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

// First try: cheap vault-token comparison (zero network). Works briefly after
// a rotation. Falls back to /api/oauth/profile (1 cheap API call) when Claude
// Code has refreshed its own token and the live no longer matches any vault.
async function detectLiveAccountFromVault(config) {
  const liveTok = tokenAccessKey(readActiveKeychainToken());
  if (!liveTok) return null;
  for (const a of config.accounts) {
    const vaultTok = tokenAccessKey(readStoredToken(a));
    if (vaultTok && vaultTok === liveTok) return accountKey(a);
  }
  // Vault miss — query profile to get the actual email
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${liveTok}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const liveEmail = body?.account?.email?.toLowerCase();
    if (!liveEmail) return null;
    // Map email → account key (handle multi-org accounts via label)
    const matches = config.accounts.filter((a) => a.email.toLowerCase() === liveEmail);
    if (matches.length === 1) return accountKey(matches[0]);
    if (matches.length > 1) {
      // Multiple labels for same email (e.g. example vs example-team).
      // Use orgName from profile to disambiguate.
      const orgName = body?.organization?.name?.toLowerCase() || '';
      const byOrg = matches.find((a) => (a.orgName || '').toLowerCase() === orgName);
      if (byOrg) return accountKey(byOrg);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Real utilization from Anthropic (via statusline export) ──────────────────

const RATE_LIMITS_FILE = join(__dirname, '.rate-limits.json');
const UTILIZATION_ROTATE_THRESHOLD = 90; // Rotate at 90% — 95%+ is always too late: Claude
// surfaces its own limit warnings ~75%, and an in-flight session crossing ~95% is already
// throttling before the daemon can rescue it. Destination viability bars (DAEMON_SAFE_*=95/94)
// stay ABOVE this so there is always a cooler account to land on. (2026-06-13 policy.)

function readRealUtilization() {
  try {
    if (!existsSync(RATE_LIMITS_FILE)) return null;
    const data = JSON.parse(readFileSync(RATE_LIMITS_FILE, 'utf8'));
    const age = Date.now() - data.ts * 1000;
    if (age > 5 * 60_000) return null; // Stale (>5min) — session may be dead
    // Anti-thrash A: discard reads that predate the most recent rotation (+60s
    // buffer for statusline render lag) BUT ONLY when the file's tagged
    // account matches the active. A mismatched-tag write (from a parallel
    // session on a different account) is independently valid and must pass
    // through so we can rescue that session before it 429s — see shouldRotate.
    try {
      const st = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      const lastRotMs = st.lastRotation ? new Date(st.lastRotation).getTime() : 0;
      let accounts = [];
      try {
        accounts = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).accounts || [];
      } catch {}
      const tagMatchesActive = utilizationTagMatchesActive(data.account_email, st.activeAccount, accounts);
      if (tagMatchesActive && lastRotMs && data.ts * 1000 < lastRotMs + 60_000) return null;
    } catch {}
    return data;
  } catch {
    return null;
  }
}

// ── Rate limit detection ─────────────────────────────────────────────────────

function checkRateLimited() {
  // Method 1: Real Anthropic utilization from statusline (primary signal)
  const real = readRealUtilization();
  if (real) {
    const pct5h = real.five_hour?.pct || 0;
    const pct7d = real.seven_day?.pct || 0;
    if (pct5h >= UTILIZATION_ROTATE_THRESHOLD) {
      return {
        limited: true,
        reason: `5h utilization ${pct5h.toFixed(1)}% >= ${UTILIZATION_ROTATE_THRESHOLD}%`,
        utilization: real,
      };
    }
    // 7d weekly cap — same 90% trigger (UTILIZATION_ROTATE_THRESHOLD). Claude surfaces
    // its weekly-limit warning at ~75%, so anything ≥95% is too late: the active session
    // sees "you've used X% of your weekly limit" before the daemon can act.
    if (pct7d >= UTILIZATION_ROTATE_THRESHOLD) {
      return {
        limited: true,
        reason: `7d utilization ${pct7d.toFixed(1)}% >= ${UTILIZATION_ROTATE_THRESHOLD}%`,
        utilization: real,
      };
    }
  }

  // Method 2: Explicit 429 signal from rate-limit-detector.cjs hook.
  // The hook writes a signal file with `fireAt` (now+15s) when it detects a
  // real 429 response. We honor the delay to give the user time to see the
  // error and let the rotation complete before they retry.
  try {
    const rateLimitFile = join(tmpdir(), 'claude-rate-limited.json');
    if (existsSync(rateLimitFile)) {
      const data = JSON.parse(readFileSync(rateLimitFile, 'utf8'));
      const fireAt = data.fireAt || 0;
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age > 5 * 60_000) {
        // Stale — discard
        unlinkSync(rateLimitFile);
      } else if (Date.now() >= fireAt) {
        // Delay elapsed — trigger rotation and consume the signal
        unlinkSync(rateLimitFile);
        return {
          limited: true,
          reason: `429 signal: ${(data.reason || 'rate_limit').substring(0, 120)}`,
        };
      }
      // else: signal fresh but delay not elapsed — wait for next poll
    }
  } catch {}

  return { limited: false };
}

// ── Should we rotate? ─────────────────────────────────────────────────────────

function getActiveAccount(config, activeKey) {
  return config.accounts.find((a) => accountKey(a) === activeKey) || null;
}

const AUTH_ERROR_FILE = join(tmpdir(), 'claude-auth-error.json');

async function shouldRotate(config, state) {
  // 0. Browser pin: claude-in-chrome requires CLI account == claude.ai login.
  // While the PreToolUse hook holds a fresh .browser-pin sentinel, never rotate
  // away — it would break the extension pairing mid-use. Short TTL (refreshed
  // per browser tool call) bounds the window where a hot account can't rotate.
  try {
    const pinPath = join(__dirname, '.browser-pin');
    if (existsSync(pinPath)) {
      const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
      if (pin?.until && Date.now() < pin.until) {
        return { should: false, reason: `browser-pinned to ${pin.email}` };
      }
      // Pin TTL lapsed — restore the pre-pin oauthAccount/chromeExtension
      // blocks in ~/.claude.json so terminal Claude Code returns to the prior
      // identity before any keychain swap below. Fire-and-forget; the daemon
      // does not need to await the restore to make a rotation decision.
      try {
        const rotateScript = join(__dirname, 'rotate.mjs');
        spawn('node', [rotateScript, '--release-browser-pin'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        log(`[browser-pin] TTL lapsed (was pinned to ${pin?.email || 'unknown'}) — release dispatched`);
      } catch {}
    }
  } catch {}

  // 1. Real utilization from statusline (PRIMARY signal for rotation)
  const rl = checkRateLimited();
  if (rl.limited) {
    // Anti-thrash A: confirm the trigger against the account that the
    // statusline write was actually tagged for. Two paths:
    //   1. Tag matches active (or absent) → verify active's live util.
    //      If active is fine, file is stale/poisoned — skip + unlink.
    //   2. Tag is a DIFFERENT account → that's a parallel Claude Code
    //      session reporting its own saturation. Live-probe THAT account
    //      via vault token. If confirmed hot → rotate (rescues the hot
    //      session via keychain swap; Claude Code re-reads keychain per
    //      request). If not confirmed hot → silently discard.
    const taggedEmail = rl.utilization?.account_email;
    const isMismatched = taggedEmail && !utilizationTagMatchesActive(taggedEmail, state.activeAccount, config.accounts);
    const probeAccount = isMismatched
      ? resolveAccountFromUtilizationTag(taggedEmail, config, state.activeAccount)
      : getActiveAccount(config, state.activeAccount);
    if (probeAccount) {
      const probeKey = accountKey(probeAccount);

      // Park check: if this account is already known-exhausted and parked until
      // its reset window, skip the rescue entirely — don't re-probe live API
      // every 30s just to confirm it's still at 100%.
      if (isParked(probeKey) && isMismatched) {
        const until = _parkedUntil.get(probeKey);
        const minsLeft = Math.ceil((until - Date.now()) / 60_000);
        log(`[park] ${probeKey} is parked for ${minsLeft}min more — suppressing rescue trigger`);
        return { should: false };
      }

      const live = await queryLiveUtilization(probeAccount);
      if (live.ok) {
        const triggered7d = /7d utilization/.test(rl.reason);
        const triggered5h = /5h utilization/.test(rl.reason);
        const overProbed =
          (triggered5h && live.pct5h >= UTILIZATION_ROTATE_THRESHOLD) ||
          (triggered7d && live.pct7d >= UTILIZATION_ROTATE_THRESHOLD);
        if (!overProbed) {
          if (!isMismatched) {
            log(
              `[anti-thrash] file says ${rl.reason} but active ${state.activeAccount} live 5h=${live.pct5h}% 7d=${live.pct7d}% — skipping (stale .rate-limits.json)`,
            );
            try {
              unlinkSync(RATE_LIMITS_FILE);
            } catch {}
          }
          // Mismatched + not hot = just a low-util parallel session; silent skip.
          return { should: false };
        }
        if (isMismatched) {
          // If the mismatched account is fully exhausted (>=PARK_THRESHOLD_PCT),
          // park it so we don't rescue-loop on every 30s tick. The keychain
          // swap won't help — there's nowhere to rotate TO for that session.
          const liveMax = Math.max(live.pct5h, live.pct7d);
          if (liveMax >= PARK_THRESHOLD_PCT) {
            // Prefer the 5h reset (shorter) so the park clears as soon as possible.
            const resetEpoch = live.reset5h || live.reset7d || null;
            parkAccount(
              probeKey,
              resetEpoch,
              `live ${liveMax.toFixed(0)}% >= ${PARK_THRESHOLD_PCT}% exhausted (5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}%)`,
            );
            return { should: false };
          }
          log(
            `[multi-session] parallel session on ${probeKey} (${taggedEmail}) is hot (live 5h=${live.pct5h}% 7d=${live.pct7d}%) — rotating keychain to rescue`,
          );
        }
      }
    }
    // Anti-thrash B: hard rate-cap on UTILIZATION-driven rotations regardless
    // of verification outcome (covers live-query failures). Explicit 429
    // signals from the rate-limit-detector hook bypass — they're real-time
    // ground truth and cannot be poisoned by a stale-token session.
    const isUtilizationTrigger = /utilization/.test(rl.reason);
    if (isUtilizationTrigger) {
      const lastRotMs = state.lastRotation ? new Date(state.lastRotation).getTime() : 0;
      const sinceLast = Date.now() - lastRotMs;
      if (lastRotMs && sinceLast < FILE_ROTATION_MIN_INTERVAL) {
        const remaining = Math.ceil((FILE_ROTATION_MIN_INTERVAL - sinceLast) / 1000);
        log(
          `[anti-thrash] utilization-rotation cap: skipping "${rl.reason}" (last rotation ${Math.floor(sinceLast / 1000)}s ago, ${remaining}s until cap clears)`,
        );
        return { should: false };
      }
    }
    return { should: true, reason: `Rate limited: ${rl.reason}` };
  }

  // 2. Auth error signal (401) from PostToolUseFailure hook
  try {
    if (existsSync(AUTH_ERROR_FILE)) {
      const sig = JSON.parse(readFileSync(AUTH_ERROR_FILE, 'utf8'));
      const age = Date.now() - new Date(sig.timestamp).getTime();
      if (age < 5 * 60_000) {
        unlinkSync(AUTH_ERROR_FILE);
        log(`401 auth error detected: ${sig.reason || 'unknown'}`);
        return {
          should: true,
          reason: `Auth error (401): ${sig.reason || 'invalid credentials'}`,
        };
      }
      unlinkSync(AUTH_ERROR_FILE); // Stale
    }
  } catch {}

  // 3. Token expiring — try refresh first, only rotate if refresh fails
  const account = getActiveAccount(config, state.activeAccount);
  if (account) {
    const token = readStoredToken(account);
    if (token && tokenExpired(token)) {
      // Try refreshing the active token in-place before rotating
      log('[active-refresh] Active token expiring — attempting in-place refresh');
      const refreshed = ROTATOR_OWNS_CRS_REFRESH
        ? (await refreshOneAccount(account, { force: true })).refreshed
        : await refreshSingleToken(account);
      if (refreshed) {
        // Also update the active keychain so running sessions pick it up on next /login
        // Merge mcpOAuth from the current active keychain before overwriting — vault
        // tokens have mcpOAuth:{} stripped by design; without this merge the active
        // keychain loses all MCP OAuth tokens (giga, Amplitude, higgsfield) on every
        // in-place refresh, forcing CC to re-auth them on the next session launch.
        try {
          const freshToken = readStoredToken(account);
          if (freshToken) {
            const svc = 'Claude Code-credentials';
            let tokenToWrite = freshToken;
            try {
              // Use readActiveKeychainToken() — already platform-aware (macOS
              // security(1) on darwin, file vault on Linux). Avoids require()
              // which is not available in ESM modules.
              const currentRaw = readActiveKeychainToken();
              if (currentRaw) {
                const currentParsed = JSON.parse(currentRaw);
                const freshParsed = JSON.parse(freshToken);
                if (currentParsed.mcpOAuth) {
                  freshParsed.mcpOAuth = { ...freshParsed.mcpOAuth, ...currentParsed.mcpOAuth };
                }
                tokenToWrite = JSON.stringify(freshParsed);
              }
            } catch (_mergeErr) {
              /* merge failed — fall through to raw write */
            }
            // Write via platform-aware path: Linux credentials file or macOS keychain.
            if (IS_LINUX) {
              // On Linux the active token lives in LINUX_CRED_PATH as a flat
              // JSON object. Merge the updated token into it preserving any
              // other fields (mcpOAuth, etc.) already present in the file.
              try {
                let existing = {};
                try {
                  existing = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
                } catch {}
                const merged = { ...existing, ...JSON.parse(tokenToWrite) };
                writeFileSync(LINUX_CRED_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
              } catch (_writeErr) {
                /* non-fatal — best-effort */
              }
            } else {
              // macOS: use spawnSync (no shell, no injection) instead of execSync.
              spawnSync(
                'security',
                ['add-generic-password', '-U', '-s', svc, '-a', ACTIVE_KEYCHAIN_ACCOUNT, '-w', tokenToWrite],
                {
                  timeout: 5000,
                },
              );
              // macOS: Claude Code ≥2.1 reads the ACTIVE credential from the FILE
              // ~/.claude/.credentials.json, NOT the keychain. Mirror the refreshed
              // active token into the file (merge to preserve other fields) so new
              // sessions pick it up. Without this the keychain write above is
              // invisible to claude. (root-caused 2026-06-12)
              try {
                let fileStore = {};
                try {
                  fileStore = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
                } catch {}
                const incoming = JSON.parse(tokenToWrite);
                fileStore.claudeAiOauth = incoming.claudeAiOauth || incoming;
                if (incoming.mcpOAuth) fileStore.mcpOAuth = incoming.mcpOAuth;
                writeFileSync(LINUX_CRED_PATH, JSON.stringify(fileStore, null, 2), { mode: 0o600 });
              } catch (_fileErr) {
                /* best-effort */
              }
            }
            log('[active-refresh] Active keychain updated with mcpOAuth preserved — sessions will auto-recover');
          }
        } catch (err) {
          log(`[active-refresh] Keychain update failed: ${err.message?.substring(0, 60)}`);
        }
        return { should: false }; // Refreshed in-place, no rotation needed
      }
      log('[active-refresh] Refresh failed — triggering rotation');
      return { should: true, reason: 'Token expired and refresh failed' };
    }
  }

  return { should: false };
}

// ── Execute rotation ──────────────────────────────────────────────────────────

// Fetch live 5h/7d utilization for one account. Returns:
//   { ok: true, pct5h, pct7d, reset5h, reset7d } | { ok: false, rateLimited?: true }
// reset* fields are epoch seconds for the window reset; null when the API
// omits resets_at (e.g. fresh windows below reporting threshold).
function parseLiveUsageResponse(data) {
  const toEpoch = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  };
  return {
    ok: true,
    pct5h: data?.five_hour?.utilization ?? 0,
    pct7d: data?.seven_day?.utilization ?? 0,
    reset5h: toEpoch(data?.five_hour?.resets_at),
    reset7d: toEpoch(data?.seven_day?.resets_at),
  };
}

async function fetchLiveUsageProbe(account) {
  const tokenJson = readStoredToken(account);
  if (!tokenJson) return { kind: 'missing' };
  let accessToken;
  try {
    accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
  } catch {
    return { kind: 'missing' };
  }
  if (!accessToken) return { kind: 'missing' };

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(4000),
  });
  if (res.status === 401) return { kind: '401' };
  if (res.status === 429) return { kind: '429' };
  if (!res.ok) return { kind: 'error', status: res.status };
  const data = await res.json();
  return { kind: 'ok', data };
}

async function queryLiveUtilization(account) {
  try {
    let probe = await fetchLiveUsageProbe(account);
    if (probe.kind === '401') {
      log(`[daemon-query] Account ${account.email} returned 401 — attempting repair (vault preserved by default)`);
      const repair = await repairAccountOn401(account, getAuthRepairDeps());
      if (repair.repaired) {
        probe = await fetchLiveUsageProbe(account);
      } else if (repair.preserved) {
        return { ok: false, authFailed: true, preserved: true };
      } else if (repair.deleted) {
        return { ok: false, authFailed: true, deleted: true };
      } else {
        return { ok: false, authFailed: true };
      }
    }

    if (probe.kind === 'missing') return { ok: false };
    if (probe.kind === '429') return { ok: false, rateLimited: true };
    if (probe.kind === 'error') return { ok: false };
    if (probe.kind !== 'ok') return { ok: false };
    return parseLiveUsageResponse(probe.data);
  } catch {
    return { ok: false };
  }
}

async function findValidRotationTarget(config, state) {
  const now = Date.now();
  const activeKey = state.activeAccount;

  // Build candidate list: all accounts except the active one AND disabled ones.
  const candidates = config.accounts.filter((a) => accountKey(a) !== activeKey && a.disabled !== true);

  // Sort by cached util (best-guess ordering before live query). Treat
  // missing reset as "unknown utilization" — DON'T treat null reset as
  // "ready" (lic had reset:null + pct:0 and got picked while live was 100%).
  candidates.sort((a, b) => {
    const aUtil = state.accounts?.[accountKey(a)]?.lastUtilization;
    const bUtil = state.accounts?.[accountKey(b)]?.lastUtilization;
    const aResetMs = aUtil?.reset ? aUtil.reset * 1000 : 0;
    const bResetMs = bUtil?.reset ? bUtil.reset * 1000 : 0;
    // Account is "ready" only if it has a known reset time AND that's passed
    const aReady = aResetMs > 0 && aResetMs < now;
    const bReady = bResetMs > 0 && bResetMs < now;
    if (aReady !== bReady) return aReady ? -1 : 1;
    return (aUtil?.pct || 0) - (bUtil?.pct || 0);
  });

  for (const account of candidates) {
    const key = accountKey(account);
    const tokenJson = readStoredToken(account);

    if (!tokenJson) {
      log(`[pre-rotate] ${key}: no token in keychain — skipping`);
      continue;
    }

    const expiry = parseTokenExpiry(tokenJson);
    const isExpired = expiry > 0 && now > expiry - 5 * 60_000;

    if (isExpired && ROTATOR_OWNS_CRS_REFRESH && !crsHealthy && isCrsMappedAccount(account, config)) {
      log(
        `[pre-rotate] ${key}: token expired but CRS unreachable — skipping refresh, not a rotation candidate this cycle`,
      );
      continue;
    }

    if (isExpired) {
      log(`[pre-rotate] ${key}: token expired/expiring — attempting refresh`);
      const refreshed = ROTATOR_OWNS_CRS_REFRESH
        ? (await refreshOneAccount(account, { force: true })).refreshed
        : await refreshSingleToken(account);
      if (!refreshed) {
        log(`[pre-rotate] ${key}: refresh FAILED — skipping`);
        continue;
      }
      log(`[pre-rotate] ${key}: refresh succeeded`);
    } else {
      log(`[pre-rotate] ${key}: token valid (${((expiry - now) / 3_600_000).toFixed(1)}h remaining)`);
    }

    // Live util check — never rotate to a high-utilization account.
    // The cached snapshot may be stale (e.g. lic had pct:0 but live was 100%).
    const live = await queryLiveUtilization(account);
    if (live?.rateLimited) {
      log(`[pre-rotate] ${key}: usage API 429 — skipping this candidate this pass`);
      continue;
    }
    if (live?.authFailed) {
      const vaultNote = live.preserved ? ' (vault preserved)' : live.deleted ? ' (token deleted)' : '';
      log(`[pre-rotate] ${key}: auth failed (401) — skipping this candidate this pass${vaultNote}`);
      continue;
    }
    if (isLiveUtilOk(live)) {
      const max = liveUtilMax(live);
      const tooHot5h = live.pct5h >= DAEMON_SAFE_5H_PCT;
      const tooHot7d = live.pct7d >= DAEMON_SAFE_7D_PCT;
      if (tooHot5h || tooHot7d) {
        const reason = tooHot5h
          ? `5h ${live.pct5h.toFixed(0)}% >= ${DAEMON_SAFE_5H_PCT}%`
          : `7d ${live.pct7d.toFixed(0)}% >= ${DAEMON_SAFE_7D_PCT}%`;
        log(
          `[pre-rotate] ${key}: live util 5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}% — skipping (${reason})`,
        );
        // Also update cached util so future picks see the truth
        if (!state.accounts) state.accounts = {};
        if (!state.accounts[key]) state.accounts[key] = {};
        state.accounts[key].lastUtilization = {
          pct: max,
          reset: null,
          ts: now,
        };
        continue;
      }
      log(`[pre-rotate] ${key}: live util 5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}% — OK`);
    } else {
      // Live query failed (Anthropic 429 or network). DO NOT accept blindly —
      // that's how we picked an exhausted account and bricked the operator's session.
      // Fall back to cached util; refuse if cached is unknown OR >=90%.
      const cached = state.accounts?.[key]?.lastUtilization;
      const cachedPct = cached?.pct;
      const cachedAge = cached?.ts ? (now - cached.ts) / 60_000 : Infinity;
      if (cachedPct == null) {
        log(`[pre-rotate] ${key}: live query FAILED + no cache — REFUSING`);
        continue;
      }
      if (cachedPct >= 90) {
        log(
          `[pre-rotate] ${key}: live query FAILED + cached ${cachedPct.toFixed(0)}% (${cachedAge.toFixed(0)}min old) — REFUSING`,
        );
        continue;
      }
      if (cachedAge > 30) {
        log(`[pre-rotate] ${key}: live query FAILED + cache stale (${cachedAge.toFixed(0)}min) — REFUSING (safety)`);
        continue;
      }
      log(
        `[pre-rotate] ${key}: live query failed but cached ${cachedPct.toFixed(0)}% (${cachedAge.toFixed(0)}min old) — accepting`,
      );
    }

    return account;
  }

  // SECOND PASS: strict bar (70%/95%) excluded everyone. Try a relaxed bar
  // (94%/94%) so we still rotate to "warm but not exhausted" rather than
  // stalling. If the relaxed bar also fails, remain CRS-only and fail closed.
  log('[pre-rotate] strict-bar pass empty — trying relaxed (sub-95%) bar');
  for (const account of candidates) {
    const key = accountKey(account);
    const tokenJson = readStoredToken(account);
    if (!tokenJson) continue;
    const live = await queryLiveUtilization(account);
    if (!isLiveUtilOk(live)) continue;
    const max = liveUtilMax(live);
    if (max < DAEMON_RELAXED_BAR) {
      log(`[pre-rotate-relaxed] ${key}: 5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}% — accepting`);
      return account;
    }
  }
  return null; // No valid candidate found
}

// Exhaustion check across ALL non-active, non-disabled accounts.
// Two acceptance modes:
//   1. LIVE-confirmed: every candidate live-queried >= 95% (preferred).
//   2. CACHED-evidence: when API is throttling us (live fails) BUT every
//      candidate has fresh (<15min) cached util >= 95% AND a recent rate-limit
//      signal exists, we accept cached evidence — refusing to fall back when
//      Anthropic API is dead would just leave the operator stuck.
async function allCandidatesExhausted(config, state) {
  const EXHAUSTED_THRESHOLD = 95;
  const now = Date.now();
  const activeKey = state.activeAccount;
  const candidates = config.accounts.filter((a) => accountKey(a) !== activeKey && a.disabled !== true);
  if (candidates.length === 0) return false;

  let liveOk = true;
  let allLiveExhausted = true;
  for (const a of candidates) {
    const live = await queryLiveUtilization(a);
    if (!isLiveUtilOk(live)) {
      liveOk = false;
      break;
    }
    if (Math.max(live.pct5h, live.pct7d) < EXHAUSTED_THRESHOLD) {
      allLiveExhausted = false;
      break;
    }
  }
  if (liveOk && allLiveExhausted) return true;

  // CACHED fallback: only when we have recent rate-limit evidence
  let recentRateLimit = false;
  try {
    if (existsSync(RATE_LIMITS_FILE)) {
      const rl = JSON.parse(readFileSync(RATE_LIMITS_FILE, 'utf8'));
      const rlMs = rl.timestamp ? new Date(rl.timestamp).getTime() : (rl.ts || 0) * 1000;
      const age = now - rlMs;
      if (age < 5 * 60_000) recentRateLimit = true;
    }
  } catch {}
  if (!recentRateLimit) return false;

  // All cached >=95% AND fresh? Then we're truly stuck.
  for (const a of candidates) {
    const cached = state.accounts?.[accountKey(a)]?.lastUtilization;
    if (!cached?.pct || !cached?.ts) return false;
    if (now - cached.ts > 15 * 60_000) return false;
    if (cached.pct < EXHAUSTED_THRESHOLD) return false;
  }
  log(
    '[allCandidatesExhausted] cached-evidence path: live unreachable but cached + rate-limit signal confirm exhaustion',
  );
  return true;
}

// Metered cloud-provider activation is permanently removed. The daemon stays
// on CRS and waits for OAuth capacity to recover.

async function doRotation(reason) {
  log(`AUTO-ROTATING: ${reason}`);

  // Pre-rotation: find a candidate with a valid (non-expired) token
  const config = readConfig();
  const state = readState();
  const target = await findValidRotationTarget(config, state);

  if (!target) {
    log('ROTATION ABORTED: no viable Max target; CRS remains fail-closed until OAuth capacity recovers');
    const exhausted = await allCandidatesExhausted(config, state);
    notify(
      'Account Rotation',
      exhausted
        ? 'ABORTED — all Max accounts are live-confirmed exhausted; waiting for reset'
        : 'ABORTED — no verified Max headroom; check token health and live utilization',
    );
    return;
  }

  const targetKey = accountKey(target);
  log(`Target account: ${targetKey} — token validated, proceeding with rotation`);
  notify('Claude Account Rotation', `Auto-rotating to ${targetKey}: ${reason}`);

  try {
    // --no-browser: no Chrome, no API calls (works when rate limited)
    // --to: daemon controls which account to rotate to (pre-validated token)
    // --session: ALSO rotate live sessions mid-flight (2026-06-13 policy) —
    // identical to the manual `/rotate --session` path. The keychain swap alone only
    // helps NEW sessions / next-401 retry, which at the 90% trigger is already too late
    // for the in-flight session. refreshRunningSession() injects `/login` into running
    // sessions (tmux send-keys / iTerm2 + Ghostty via System Events keystroke), and
    // `/login` re-reads the keychain → picks up the new token instantly, no restart.
    // bg sessions (no TTY) are handled separately by respawnBgSessions().
    // execFileSync (not execSync) — no shell, no injection risk on targetKey.
    const result = execFileSync('node', [ROTATE_SCRIPT, '--no-browser', '--session', '--to', targetKey], {
      cwd: __dirname,
      timeout: 150_000, // 2.5min — keychain swap is fast; +per-session /login injection
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    log(`Rotation result: ${result.substring(0, 200)}`);
  } catch (err) {
    log(`Rotation failed: ${err.message}`);
    notify('Account Rotation', `Auto-rotation failed: ${err.message.substring(0, 60)}`);
  }
}

// ── Auto-sync: detect if live auth drifted from state ────────────────────────

function _syncDriftedState(state, config, lastRotatedAt = 0) {
  // After a rotation, `claude auth status` still returns the OLD session's email
  // until the user restarts Claude Code. Don't undo the rotation by "correcting"
  // state back to the stale live email — wait for the blackout to pass.
  // Use the shared state.lastRotation (written by rotate.mjs) so duplicate daemon
  // instances both respect the blackout, even if one of them didn't do the rotation.
  const stateLastRotation = state.lastRotation ? new Date(state.lastRotation).getTime() : 0;
  const effectiveLastRotation = Math.max(lastRotatedAt, stateLastRotation);
  if (effectiveLastRotation && Date.now() - effectiveLastRotation < POST_ROTATION_BLACKOUT) return false;

  try {
    const liveAuth = execSync('claude auth status 2>&1', {
      timeout: 5_000,
    }).toString();
    const liveEmail = JSON.parse(liveAuth)?.email;
    if (!liveEmail) return false;

    const liveKey = config.accounts.find((a) => a.email === liveEmail);
    if (!liveKey) return false;

    const liveAccountKey = accountKey(liveKey);
    if (state.activeAccount !== liveAccountKey) {
      log(
        `⚠️ DRIFT DETECTED: state says ${state.activeAccount || 'none'}, live auth is ${liveAccountKey} — syncing state`,
      );
      state.activeAccount = liveAccountKey;
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      return true; // Drift was corrected
    }
  } catch {}
  return false;
}

// ── Dynamic token refresh ────────────────────────────────────────────────────
// Instead of a fixed hourly launchd job refreshing all accounts, refresh
// on-demand: when utilization is climbing (50%+), pre-refresh candidate
// accounts so they're ready for rotation. Also refresh any token within
// 1h of expiry regardless of utilization.

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow — public OAuth client ID, not a secret
const REFRESH_URGENCY_MS = 1 * 3_600_000; // Refresh if <1h remaining

function parseTokenExpiry(tokenJson) {
  try {
    return JSON.parse(tokenJson)?.claudeAiOauth?.expiresAt || 0;
  } catch {
    return 0;
  }
}

function parseRefreshToken(tokenJson) {
  try {
    return JSON.parse(tokenJson)?.claudeAiOauth?.refreshToken || null;
  } catch {
    return null;
  }
}

async function refreshSingleToken(account) {
  const key = accountKey(account);
  const tokenJson = readStoredToken(account);
  if (!tokenJson) return false;

  const refreshToken = parseRefreshToken(tokenJson);
  if (!refreshToken) return false;

  try {
    const res = await fetchWithProxyFallback(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) return false;

    const parsed = JSON.parse(tokenJson);
    parsed.claudeAiOauth.accessToken = body.access_token;
    if (body.refresh_token) parsed.claudeAiOauth.refreshToken = body.refresh_token;
    parsed.claudeAiOauth.expiresAt = body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000;

    // Save back to vault — platform-aware (Linux: credentials file; macOS: Keychain)
    const tokenStr = JSON.stringify(parsed);
    try {
      writeStoredToken(account, tokenStr);
    } catch (writeErr) {
      throw new Error(`Vault write failed: ${writeErr.message}`);
    }
    log(
      `[refresh] ${key}: refreshed (${((parsed.claudeAiOauth.expiresAt - Date.now()) / 3_600_000).toFixed(1)}h remaining)`,
    );
    return true;
  } catch (err) {
    log(`[refresh] ${key}: failed — ${err.message?.substring(0, 60)}`);
    return false;
  }
}

async function _dynamicRefresh(config, state) {
  const now = Date.now();
  const real = readRealUtilization();
  const pct5h = real?.five_hour?.pct || 0;

  for (const account of config.accounts) {
    const key = accountKey(account);
    if (key === state.activeAccount) continue; // Don't refresh active account mid-session
    if (account.disabled === true) continue; // hands-off: a disabled account is owned
    // elsewhere (e.g. a CRS relay pool). Refreshing its OAuth token rotates the
    // refresh token and INVALIDATES the copy CRS holds → CRS "Invalid API key" 401s.
    if (ROTATOR_OWNS_CRS_REFRESH && !crsHealthy && isCrsMappedAccount(account, config)) {
      continue; // CRS unreachable — leave this account's token alone until it's back
    }

    const tokenJson = readStoredToken(account);
    if (!tokenJson) continue;
    const expiry = parseTokenExpiry(tokenJson);
    const remaining = expiry - now;

    // Refresh if: token expiring within 1h, OR utilization >50% and token <3h
    const urgent = remaining > 0 && remaining < REFRESH_URGENCY_MS;
    const preemptive = pct5h >= 50 && remaining > 0 && remaining < 3 * 3_600_000;

    if (urgent || preemptive) {
      if (ROTATOR_OWNS_CRS_REFRESH) {
        await refreshOneAccount(account, { force: true });
      } else {
        await refreshSingleToken(account);
      }
      await sleep(2000); // Don't hammer the token endpoint
    }
  }
}

// ── Periodic fleet-wide live-util probe ──────────────────────────────────────
// Keeps state.accounts[*].lastUtilization fresh for ALL accounts so the
// cooldown status report and findValidRotationTarget candidate sort have
// recent data. Sequential to avoid parallel keychain + API hits.
async function runFullProbe(config, state) {
  const start = Date.now();
  let probed = 0;
  let updated = 0;
  let skippedExpired = 0;
  try {
    for (const a of config.accounts) {
      const key = accountKey(a);
      if (key === state.activeAccount) continue; // active already covered by shouldRotate path
      probed += 1;
      const tokenJson = readStoredToken(a);
      if (!tokenJson || tokenExpired(tokenJson)) {
        skippedExpired += 1;
        continue;
      }
      const live = await queryLiveUtilization(a);
      if (!live?.ok) continue;
      // Pick the higher-util window's reset epoch — that's the one that
      // gates next-rotate eligibility. Falls back to whichever has a reset.
      const pct5h = live.pct5h || 0;
      const pct7d = live.pct7d || 0;
      const pct = Math.max(pct5h, pct7d);
      const reset = pct5h >= pct7d ? (live.reset5h ?? live.reset7d ?? null) : (live.reset7d ?? live.reset5h ?? null);
      state.accounts = state.accounts || {};
      state.accounts[key] = state.accounts[key] || {};
      state.accounts[key].lastUtilization = { pct, reset, ts: Date.now() };
      updated += 1;
    }
    // Compute and persist the next-rotation candidate for statusline display.
    // Pick the lowest-util non-active account with a non-expired vault token.
    try {
      let bestKey = null;
      let bestEmail = null;
      let bestPct = Infinity;
      for (const a of config.accounts) {
        const k = accountKey(a);
        if (k === state.activeAccount) continue;
        if (a.disabled === true) continue;
        const tok = readStoredToken(a);
        if (!tok || tokenExpired(tok)) continue;
        const u = state.accounts?.[k]?.lastUtilization;
        const p = u?.pct ?? 0;
        if (p < bestPct) {
          bestPct = p;
          bestKey = k;
          bestEmail = a.email;
        }
      }
      if (bestKey) {
        writeFileSync(
          join(__dirname, '.next-rotation-target.json'),
          JSON.stringify({ key: bestKey, email: bestEmail, pct: bestPct, ts: Date.now() }),
        );
      }
    } catch {}
    try {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch {}
    log(
      `[periodic-probe] probed ${probed} accounts in ${Date.now() - start}ms (updated ${updated} snapshots, skipped ${skippedExpired} expired-token)`,
    );
  } catch (err) {
    log(`[periodic-probe] error: ${err.message?.substring(0, 120)}`);
  }
}

async function checkSessionLeaseRotations(config, state) {
  const sessions = listLiveBgSessions();
  if (sessions.length === 0) return;

  const leases = readLeases();

  for (const s of sessions) {
    const lease = leases[s.id];

    // Case 1: Session has no lease assigned yet
    if (!lease) {
      const pickedKey = pickAccountForSession(s.id, config, state);
      const newKey = pickedKey === 'bedrock' ? null : pickedKey;
      if (newKey) {
        log(`[session-router] Session ${s.id} has no lease. Assigning to ${newKey}`);
        recordSessionLease(s.id, newKey, s.pid);
        if (s.status !== 'busy') {
          doRespawn(s, log);
        }
        return; // Rotate/respawn at most one session per tick to stagger
      }
      continue;
    }

    // Case 2: Session has a lease; quarantine any prohibited legacy provider lease
    const currentKey = lease.accountKey;
    if (currentKey === 'bedrock') {
      // Check if a Max account has cooled down and is now viable
      const newKey = pickAccountForSession(s.id, config, state);
      if (newKey && newKey !== 'bedrock') {
        log(
          `[session-router] OAuth account available. Reassigning session ${s.id} from a prohibited legacy provider to ${newKey}`,
        );
        recordSessionLease(s.id, newKey, s.pid);
        if (s.status !== 'busy') {
          doRespawn(s, log);
        } else {
          try {
            const marker = `/tmp/claude-respawn-deferred-${s.id}`;
            if (!existsSync(marker)) writeFileSync(marker, String(Date.now()));
          } catch {}
        }
        return; // Rotate at most one session per tick to stagger
      }
      continue;
    }

    const acct = config.accounts.find((a) => accountKey(a) === currentKey);
    if (!acct) continue;

    const cached = state.accounts?.[currentKey]?.lastUtilization;
    const util = cached?.pct ?? 0;
    const maxUtil = acct.maxUtilPercent || config.rateLimits.destinationMaxUtilPercent;

    // We no longer guess utilization based on active lease count.
    // Instead, we rely strictly on the live metrics fetched from Claude API by the usage probe.
    if (util >= maxUtil) {
      log(
        `[session-router] Session ${s.id} leased account ${currentKey} ACTUAL utilization is exhausted (${util}% >= ${maxUtil}%). Rotating.`,
      );
      const newKey = pickAccountForSession(s.id, config, state);
      if (newKey && newKey !== currentKey) {
        log(`[session-router] Swapping lease for session ${s.id}: ${currentKey} -> ${newKey}`);
        recordSessionLease(s.id, newKey, s.pid);

        if (s.status !== 'busy') {
          doRespawn(s, log);
        } else {
          try {
            const marker = `/tmp/claude-respawn-deferred-${s.id}`;
            if (!existsSync(marker)) writeFileSync(marker, String(Date.now()));
            log(`[session-router] Session ${s.id} is busy. Deferred rotation to idle state.`);
          } catch {}
        }
        return; // Rotate at most one session per tick to stagger
      }
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function mainLoop() {
  log('Daemon started (v4 — recovery: prioritized usage probes, adaptive interval, 429 backoff)');
  notify('Claude Rotation Daemon', 'Monitoring usage — dynamic refresh');
  if (ROTATOR_OWNS_CRS_REFRESH) {
    await refreshCrsHealthCache(readConfig());
  }

  let lastRotatedAt = 0; // track when we last rotated
  let lastStatusLog = 0; // periodic status logging
  let lastLeaseBeat = 0; // cross-machine lease heartbeat (S3)
  const _lastRefreshCheck = 0; // dynamic refresh check
  let lastDriftCheck = 0; // cheap vault-based drift detection
  let lastFullProbe = 0; // periodic fleet-wide live-util snapshot refresh
  let lastRespawnSweep = 0; // deferred bg-session respawn retry (busy at rotation time)
  const FULL_PROBE_INTERVAL = 5 * 60_000;
  while (true) {
    try {
      const config = readConfig();
      if (!config.autoRotate) {
        await sleep(POLL_INTERVAL);
        continue;
      }

      const state = readState();

      // Fleet stuck-agent auto-recovery (every tick): detect bg agents wedged on
      // a session-limit popup (usage-limit → re-lease to coolest + neutralize +
      // respawn) or a transient server-side 429 ("Server is temporarily limiting
      // requests" — global, hits all accounts at once → respawn-with-backoff to
      // retry). This is the only cure for a whole-fleet simultaneous flip, which
      // by definition is NOT per-account quota. (2026-06-13)
      if (process.env.CLAUDE_ENABLE_FLEET_RECOVERY === '1') {
        try {
          checkFleetStuckAgents(config, state, (m) => log(`[fleet-recover] ${m}`));
        } catch (e) {
          log(`[fleet-recover] error: ${e.message?.substring(0, 120)}`);
        }
      }

      // Periodic status log (every 5 min) — shows cooldown state for all accounts
      if (Date.now() - lastStatusLog > 300_000) {
        log(`Account cooldown status:\n${accountCooldownStatus(state)}`);
        if (ROTATOR_OWNS_CRS_REFRESH) await refreshCrsHealthCache(config);
        lastStatusLog = Date.now();
      }

      // Cross-machine lease heartbeat (every 3 min, << 2h TTL): refresh THIS
      // machine's claim on its active account so the other machine keeps
      // excluding it. Best-effort / fail-open (S3 down => no-op). (2026-06-06)
      if (state.activeAccount && Date.now() - lastLeaseBeat > 180_000) {
        lastLeaseBeat = Date.now();
        try {
          writeLease(state.activeAccount, (m) => log(m));
        } catch {}
      }

      // Drift detection — every 2 min, find the actual live account.
      // 1) Cheap vault-token compare first (zero network).
      // 2) Fall back to /api/oauth/profile when Claude Code has refreshed
      //    its own token and the live no longer matches any vault.
      // Self-heals when state.json disagrees with the actual active account
      // (crashed rotation, manual /login, leftover lock).
      // Deferred bg-session respawn sweep (every 2 min): sessions that were
      // busy at rotation time get respawned once they go idle, or force-
      // respawned after 90 min so they never wedge on an expired token.
      if (process.env.CLAUDE_ENABLE_BG_RESPAWN === '1' && Date.now() - lastRespawnSweep > 120_000) {
        lastRespawnSweep = Date.now();
        try {
          const handled = sweepDeferredRespawns((m) => log(m));
          if (handled > 0) log(`[bg-respawn] sweep refreshed ${handled} deferred bg session(s)`);
        } catch (e) {
          log(`[bg-respawn] sweep error: ${e.message?.substring(0, 80)}`);
        }
      }

      if (Date.now() - lastDriftCheck > 120_000) {
        lastDriftCheck = Date.now();
        const stateLastRotation2 = state.lastRotation ? new Date(state.lastRotation).getTime() : 0;
        const inBlackoutDrift = stateLastRotation2 && Date.now() - stateLastRotation2 < POST_ROTATION_BLACKOUT;
        if (!inBlackoutDrift) {
          const liveKey = await detectLiveAccountFromVault(config);
          if (liveKey && liveKey !== state.activeAccount) {
            log(`⚠️ DRIFT: state=${state.activeAccount || 'none'} but keychain=${liveKey} — syncing state.json`);
            state.activeAccount = liveKey;
            writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
          }
        }
      }

      // Dynamic token refresh disabled — only refresh when the active account
      // actually needs rotation (shouldRotate handles in-place refresh, and
      // findValidRotationTarget refreshes candidates lazily). Avoids keychain
      // churn that was disconnecting HTTP MCP sessions every 5 min.

      // Periodic fleet-wide live-util probe (every 5 min). Side-channel
      // snapshot refresh only — does NOT trigger rotation. Keeps the cooldown
      // status report accurate and feeds findValidRotationTarget's pre-sort.
      if (Date.now() - lastFullProbe >= FULL_PROBE_INTERVAL) {
        await runFullProbe(config, state);
        lastFullProbe = Date.now();
      }

      const legacyFallbackSentinel = join(process.env.HOME || '', '.claude', '.bedrock-fallback.json');
      if (existsSync(legacyFallbackSentinel)) {
        try {
          unlinkSync(legacyFallbackSentinel);
        } catch {}
        try {
          clearHardcodedModelsForOAuthClaudeSettings();
        } catch {}
        log('[crs-only] removed legacy metered-provider sentinel and restored OAuth settings');
      }

      const { should, reason } = await shouldRotate(config, state);

      // Post-rotation blackout: ALL rotation triggers are suppressed for 90s
      // after any rotation. `claude auth status` returns stale data during this
      // window, which causes drift detection → re-rotation thrashing loops.
      const stateLastRotation = readState().lastRotation ? new Date(readState().lastRotation).getTime() : 0;
      const effectiveLastRotated = Math.max(lastRotatedAt, stateLastRotation);
      const inBlackout = effectiveLastRotated && Date.now() - effectiveLastRotated < POST_ROTATION_BLACKOUT;

      if (should && inBlackout) {
        const remaining = Math.ceil((POST_ROTATION_BLACKOUT - (Date.now() - effectiveLastRotated)) / 1000);
        log(`Post-rotation blackout: ignoring "${reason}" for ${remaining}s more`);
      } else if (should) {
        await doRotation(reason);
        lastRotatedAt = Date.now();
        await sleep(RATE_LIMIT_COOLDOWN);
      } else if (process.env.CLAUDE_ENABLE_BG_SESSION_ROUTER === '1') {
        await checkSessionLeaseRotations(config, state);
      }
    } catch (err) {
      log(`Daemon error: ${err.message}`);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--stop')) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    try {
      process.kill(parseInt(pid, 10));
      log(`Stopped daemon (PID ${pid})`);
    } catch {}
    try {
      unlinkSync(PID_FILE);
    } catch {}
    console.log(`Daemon stopped (PID ${pid})`);
  } else {
    console.log('No daemon running');
  }
} else if (args.includes('--status')) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    try {
      process.kill(parseInt(pid, 10), 0); // Check if alive
      console.log(`Daemon running (PID ${pid})`);
    } catch {
      console.log('Daemon PID file exists but process is dead');
      unlinkSync(PID_FILE);
    }
  } else {
    console.log('Daemon not running');
  }
} else if (args.includes('--bg')) {
  // Daemonize
  const child = spawn('node', [join(__dirname, 'daemon.mjs')], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Daemon started in background (PID ${child.pid})`);
  console.log(
    `Monitoring: tool uses (${readConfig().toolUseThreshold}), hours (${readConfig().maxHoursPerAccount}h), rate limits, token expiry`,
  );
  console.log(`Log: ${LOG_PATH}`);
} else {
  // Foreground
  writeFileSync(PID_FILE, String(process.pid));
  process.on('SIGINT', () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  });
  await mainLoop();
}
