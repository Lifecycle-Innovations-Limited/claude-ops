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
 * no browser). That path does not invoke ai-brain.mjs. Full ai-brain (Bedrock
 * Converse, stall recovery, optional Context7 + web research, billing scrape)
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
import { persistBedrockClaudeSettings, clearHardcodedModelsForOAuthClaudeSettings, resolveWorkingAwsEnv } from './claude-settings-mode.mjs';
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
import { sweepDeferredRespawns, listLiveBgSessions, doRespawn, isLoopSession } from './bg-respawn.mjs';
import { pickAccountForSession, recordSessionLease, readLeases, writeLeases } from './session-router.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, 'state.json');
const LOG_PATH = join(__dirname, 'rotation.log');
const PID_FILE = join(__dirname, '.daemon.pid');
const ROTATE_SCRIPT = join(__dirname, 'rotate.mjs');

// Keychain account name — must match rotate.mjs convention.
const ACTIVE_KEYCHAIN_ACCOUNT = process.env.USER || 'unknown';
const VAULT_KEYCHAIN_ACCOUNT = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';

const RECOVERY_STATUS_PATH = join(__dirname, '.bedrock-recovery-status.json');
const USAGE_PROBE_CONCURRENCY = 3;
const BEDROCK_RECOVERY_MIN_INTERVAL_MS = 25_000;
const BEDROCK_RECOVERY_DEFAULT_INTERVAL_MS = 50_000;
const BEDROCK_RECOVERY_MAX_INTERVAL_MS = 180_000;

function writeRecoveryStatus(payload) {
  try {
    writeFileSync(RECOVERY_STATUS_PATH, JSON.stringify({ ...payload, written_at: new Date().toISOString() }, null, 2));
  } catch {}
}
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

// Cross-machine account leases (Sam 2026-06-06): NOT a static per-machine split.
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
  'account-personal': 'account-main', // label changed: personal org is now just "account-main"
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
  const svc = `Claude-Rotation-${accountKey(account)}`;
  if (IS_LINUX) {
    try {
      const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
      const val = store[svc];
      if (!val) return null;
      return typeof val === 'string' ? val : JSON.stringify(val);
    } catch {
      return null;
    }
  }
  try {
    const out = execSync(`security find-generic-password -s "${svc}" -a "${VAULT_KEYCHAIN_ACCOUNT}" -g 2>&1`, {
      timeout: 5000,
    }).toString();
    const m = out.match(/^password: "?(.*?)"?$/m);
    return m ? m[1].replace(/\\"/g, '"') : null;
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
      // Multiple labels for same email (e.g. account-main vs account-team).
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
const UTILIZATION_ROTATE_THRESHOLD = 95; // Rotate when near exhaustion

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
    // 7d weekly cap — also rotate at 80% (was 95%, but Claude itself surfaces
    // the warning at ~75%, so 95% is too late and the active session sees
    // "you've used X% of your weekly limit" before the daemon acts).
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
      const refreshed = await refreshSingleToken(account);
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
                try { fileStore = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8')); } catch {}
                const incoming = JSON.parse(tokenToWrite);
                fileStore.claudeAiOauth = incoming.claudeAiOauth || incoming;
                if (incoming.mcpOAuth) fileStore.mcpOAuth = incoming.mcpOAuth;
                writeFileSync(LINUX_CRED_PATH, JSON.stringify(fileStore, null, 2), { mode: 0o600 });
              } catch (_fileErr) { /* best-effort */ }
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
async function queryLiveUtilization(account) {
  try {
    const tokenJson = readStoredToken(account);
    if (!tokenJson) return { ok: false };
    const accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
    if (!accessToken) return { ok: false };
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401) {
      log(`[daemon-query] Account ${account.email} returned 401 (Unauthorized) — invalidating token`);
      deleteStoredToken(account);
      return { ok: false, authFailed: true };
    }
    if (res.status === 429) return { ok: false, rateLimited: true };
    if (!res.ok) return { ok: false };
    const data = await res.json();
    // resets_at comes back as ISO 8601 string — convert to epoch seconds so
    // it matches state.accounts[].lastUtilization.reset format (numeric)
    // used by accountCooldownStatus and findValidRotationTarget.
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

    if (isExpired) {
      log(`[pre-rotate] ${key}: token expired/expiring — attempting refresh`);
      const refreshed = await refreshSingleToken(account);
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
      log(`[pre-rotate] ${key}: auth failed (401) — skipping this candidate this pass`);
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
      // that's how we picked an exhausted account and bricked Sam's session.
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
  // stalling. Only Bedrock fallback when even the relaxed bar fails.
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
//      Anthropic API is dead would just leave Sam stuck.
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

function stopClaudeDaemon() {
  log('[daemon-stop] Stopping Claude daemon to clear cached environment...');
  try {
    const result = execSync('claude daemon stop --any', {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
    });
    log(`[daemon-stop] Daemon stop success: ${result.trim()}`);
  } catch (err) {
    log(`[daemon-stop] Daemon stop failed: ${err.message}`);
  }
}

// Activate Bedrock fallback from inside daemon. Probes AWS reachability,
// writes the sentinel + sends a desktop notification. Returns true on success.
function activateBedrockFallbackFromDaemon(reason) {
  // disabled 2026-05-08 — Max plan handles this, see audit ($600-1.2k/mo bleed via Bedrock)
  // Set CLAUDE_DISABLE_BEDROCK_FALLBACK=0 in launchd plist to re-enable.
  if (process.env.CLAUDE_DISABLE_BEDROCK_FALLBACK !== '0') {
    log(`[bedrock-fallback] BLOCKED by CLAUDE_DISABLE_BEDROCK_FALLBACK (reason was: ${reason})`);
    notify('Bedrock Fallback BLOCKED', 'Kill-switch active — Max-only mode. Wait for reset window or rotate manually.');
    return false;
  }
  const region = process.env.AWS_BEDROCK_REGION || 'us-east-1';
  try {
    const aws = resolveWorkingAwsEnv(region);
    execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      stdio: 'pipe',
      timeout: 5000,
      env: aws.env,
    });
    execFileSync('aws', ['bedrock', 'list-inference-profiles', '--region', region, '--max-results', '1'], {
      stdio: 'pipe',
      timeout: 6000,
      env: aws.env,
    });
  } catch (e) {
    log(`[bedrock-fallback] AWS unreachable: ${(e.message || '').slice(0, 80)}`);
    notify('Bedrock Fallback FAILED', 'aws sts/bedrock unreachable — manual intervention needed');
    return false;
  }
  try {
    const sentinel = join(process.env.HOME || '', '.claude', '.bedrock-fallback.json');
    const payload = {
      activated_at: new Date().toISOString(),
      reason,
      region,
      available: true,
      activated_by: 'daemon',
    };
    writeFileSync(sentinel, JSON.stringify(payload, null, 2));
    try {
      persistBedrockClaudeSettings(region);
      log(`[bedrock-fallback] settings.json → Bedrock env (${region})`);
    } catch (e) {
      log(`[bedrock-fallback] settings persist failed: ${e.message?.slice(0, 80)}`);
    }
    try {
      stopClaudeDaemon();
    } catch (e) {
      log(`[bedrock-fallback] stopClaudeDaemon failed: ${e.message}`);
    }
    log(`[bedrock-fallback] ACTIVATED region=${region} reason=${reason}`);
    notify(
      'Bedrock Fallback Active',
      `Max rotation stuck — settings.json → Bedrock (${region}). New shells pick it up; optional: source use-bedrock.sh`,
    );
    return true;
  } catch (e) {
    log(`[bedrock-fallback] write error: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function doRotation(reason) {
  const lockFile = join(__dirname, '.rotating');
  // Lock format written by rotate.mjs: `<ISO timestamp>\n<pid>`. If the holder
  // PID is still alive, skip — don't race even if the wall-clock is ancient
  // (browser OAuth flows can legitimately run several minutes).
  const LOCK_HARD_CEILING_MS = 15 * 60_000;
  if (existsSync(lockFile)) {
    try {
      const raw = readFileSync(lockFile, 'utf8').trim();
      const [tsStr, pidStr] = raw.split(/\s+/);
      const age = Date.now() - new Date(tsStr).getTime();
      const pid = parseInt(pidStr || '', 10);
      let holderAlive = false;
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          holderAlive = true;
        } catch {}
      }
      if (holderAlive && age < LOCK_HARD_CEILING_MS) {
        log(`Rotation already in progress (holder PID ${pid}, ${Math.round(age / 1000)}s) — skipping`);
        return;
      }
      if (!holderAlive) log(`Stale lock (PID ${pid || '?'} dead) — proceeding`);
      else log(`Lock exceeded hard ceiling (${Math.round(age / 60_000)}min) — proceeding`);
    } catch {
      // Unparseable lock — treat as stale
    }
  }

  log(`AUTO-ROTATING: ${reason}`);

  // Pre-rotation: find a candidate with a valid (non-expired) token
  const config = readConfig();
  const state = readState();
  const target = await findValidRotationTarget(config, state);

  if (!target) {
    log('ROTATION ABORTED: no viable Max target after pre-rotate (util bars, tokens, or live query refusals)');
    // Live-confirm exhaustion before flipping to Bedrock — Sam's rule.
    const exhausted = await allCandidatesExhausted(config, state);
    if (exhausted) {
      log('All candidates LIVE-CONFIRMED exhausted (>=95%) — engaging Bedrock fallback');
      activateBedrockFallbackFromDaemon(`auto_rotation: ${reason}`);
      return;
    }
    // Same as rotate.mjs --force: destination cap stuck (e.g. every non-active >=90%)
    // leaves OAuth tokens valid but no swap target — daemon must flip Bedrock without manual rotate-magic.
    let rec = null;
    try {
      const r = spawnSync(process.execPath, [ROTATE_SCRIPT, '--recommend', '--json'], {
        cwd: __dirname,
        encoding: 'utf8',
        maxBuffer: 2_000_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
        timeout: 90_000,
      });
      if (r.stdout?.trim()) {
        rec = JSON.parse(r.stdout.trim());
      }
    } catch (e) {
      log(`[bedrock-eval] --recommend --json parse/exec failed: ${(e.message || '').slice(0, 100)}`);
    }
    if (rec && (rec.destinationCapStuck === true || rec.allExhausted === true)) {
      const label = rec.allExhausted ? 'allExhausted' : 'destinationCapStuck';
      log(
        `[bedrock-eval] recommend JSON confirms ${label} (destCap=${rec.destinationMaxUtilPercent ?? '?'}) — engaging Bedrock fallback`,
      );
      activateBedrockFallbackFromDaemon(`auto_rotation_${label}: ${reason}`);
      return;
    }
    notify('Account Rotation', 'ABORTED — no Max headroom; Bedrock not confirmed (check tokens / live util queries)');
    return;
  }

  const targetKey = accountKey(target);
  log(`Target account: ${targetKey} — token validated, proceeding with rotation`);
  notify('Claude Account Rotation', `Auto-rotating to ${targetKey}: ${reason}`);

  try {
    // --no-browser: no Chrome, no API calls (works when rate limited)
    // --to: daemon controls which account to rotate to (pre-validated token)
    // NO --session: keychain swap only. Background rotation must NEVER inject /login
    // into running sessions — that interrupts active work. Sessions pick up the new
    // token on next 401 (auto-retry) or when the user voluntarily runs /login.
    // execFileSync (not execSync) — no shell, no injection risk on targetKey.
    const result = execFileSync('node', [ROTATE_SCRIPT, '--no-browser', '--to', targetKey], {
      cwd: __dirname,
      timeout: 120_000, // 2min — keychain swap is fast; no per-session injection
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

function syncDriftedState(state, config, lastRotatedAt = 0) {
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
    const res = await fetch(TOKEN_ENDPOINT, {
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
    const svc = `Claude-Rotation-${key}`;
    const tokenStr = JSON.stringify(parsed);
    if (IS_LINUX) {
      try {
        let store = {};
        try {
          store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
        } catch {}
        store[svc] = tokenStr;
        writeFileSync(LINUX_CRED_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
      } catch (writeErr) {
        throw new Error(`Linux vault write failed: ${writeErr.message}`);
      }
    } else {
      // Use spawnSync (no shell) to avoid injection risk on tokenStr.
      spawnSync('security', ['add-generic-password', '-U', '-s', svc, '-a', VAULT_KEYCHAIN_ACCOUNT, '-w', tokenStr], {
        timeout: 5000,
      });
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

async function dynamicRefresh(config, state) {
  const now = Date.now();
  const real = readRealUtilization();
  const pct5h = real?.five_hour?.pct || 0;

  for (const account of config.accounts) {
    const key = accountKey(account);
    if (key === state.activeAccount) continue; // Don't refresh active account mid-session

    const tokenJson = readStoredToken(account);
    if (!tokenJson) continue;
    const expiry = parseTokenExpiry(tokenJson);
    const remaining = expiry - now;

    // Refresh if: token expiring within 1h, OR utilization >50% and token <3h
    const urgent = remaining > 0 && remaining < REFRESH_URGENCY_MS;
    const preemptive = pct5h >= 50 && remaining > 0 && remaining < 3 * 3_600_000;

    if (urgent || preemptive) {
      await refreshSingleToken(account);
      await sleep(2000); // Don't hammer the token endpoint
    }
  }
}

/** Lowest cached util + reset-window first — fastest path to a cooled account. */
function prioritizeAccountsForRecovery(state, accounts) {
  const now = Date.now();
  return [...accounts].sort((a, b) => {
    const ua = state.accounts?.[accountKey(a)]?.lastUtilization;
    const ub = state.accounts?.[accountKey(b)]?.lastUtilization;
    const ra = ua?.pct == null ? 999 : ua.pct;
    const rb = ub?.pct == null ? 999 : ub.pct;
    if (ra !== rb) return ra - rb;
    const wA = ua?.reset && ua.reset * 1000 < now ? 0 : 1;
    const wB = ub?.reset && ub.reset * 1000 < now ? 0 : 1;
    if (wA !== wB) return wA - wB;
    return (ua?.ts ?? 0) - (ub?.ts ?? 0);
  });
}

/**
 * When Bedrock sentinel exists: probe prioritized accounts (parallel batches),
 * same viability bars as pre-rotate. Adaptive interval + 429 backoff.
 */
async function maybeRecoverOAuthFromBedrock(config, state, sentinelPath, ctx) {
  const now = Date.now();
  if (now < ctx.backoffUntil) {
    writeRecoveryStatus({ phase: 'backoff', until: ctx.backoffUntil });
    return { didRecover: false };
  }
  if (now - ctx.lastCheck < ctx.intervalMs) return { didRecover: false };
  ctx.lastCheck = now;

  const withTokens = config.accounts
    .filter((a) => a.disabled !== true)
    .filter((a) => {
      const t = readStoredToken(a);
      return t && !tokenExpired(t);
    });
  if (withTokens.length === 0) {
    log('[bedrock-recovery] no non-expired vault tokens — skip probe batch');
    writeRecoveryStatus({ phase: 'no_tokens', probed: [] });
    ctx.intervalMs = Math.min(BEDROCK_RECOVERY_MAX_INTERVAL_MS, Math.floor((ctx.intervalMs || 60_000) * 1.12));
    return { didRecover: false };
  }

  const ordered = prioritizeAccountsForRecovery(state, withTokens);
  const maxAccounts = Math.min(ordered.length, 8);
  const cap = Math.max(1, Math.min(ctx.concurrency || USAGE_PROBE_CONCURRENCY, USAGE_PROBE_CONCURRENCY));
  let saw429 = false;
  /** @type {{ key: string, ok?: boolean, rateLimited?: boolean }[]} */
  const rows = [];
  let maxLiveUtil = 0;

  for (let i = 0; i < maxAccounts; i += cap) {
    const slice = ordered.slice(i, i + cap);
    const results = await Promise.all(
      slice.map(async (acct) => {
        const live = await queryLiveUtilization(acct);
        return { acct, live };
      }),
    );
    for (const { acct, live } of results) {
      const probeKey = accountKey(acct);
      if (live?.rateLimited) saw429 = true;
      rows.push({ key: probeKey, ok: isLiveUtilOk(live), rateLimited: live?.rateLimited === true });
      if (isLiveUtilOk(live)) {
        const max = liveUtilMax(live);
        maxLiveUtil = Math.max(maxLiveUtil, max);
        state.accounts = state.accounts || {};
        state.accounts[probeKey] = state.accounts[probeKey] || {};
        state.accounts[probeKey].lastUtilization = { pct: max, reset: null, ts: Date.now() };
        log(`[bedrock-recovery] probe ${probeKey}: 5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}%`);
        if (isDaemonRotationViable(live)) {
          const tokenJson = readStoredToken(acct);
          if (tokenJson && !tokenExpired(tokenJson)) {
            log(
              `[bedrock-recovery] ${probeKey} viable (daemon 5h<${DAEMON_SAFE_5H_PCT}% & 7d<${DAEMON_SAFE_7D_PCT}%) — exiting Bedrock fallback`,
            );
            try {
              unlinkSync(sentinelPath);
            } catch {}
            try {
              clearHardcodedModelsForOAuthClaudeSettings();
              log('[bedrock-recovery] settings.json → OAuth (hardcoded models cleared)');
            } catch (e) {
              log(`[bedrock-recovery] settings clear failed: ${e.message?.slice(0, 80)}`);
            }
            // Purge stale `bedrock`-keyed session leases. Without this, bg-respawn.mjs
            // keeps reading lease.accountKey === 'bedrock' and re-injecting
            // CLAUDE_CODE_USE_BEDROCK on every respawn forever — sessions stay stranded
            // on metered Bedrock long after OAuth headroom returns. (2026-06-14: 9 sessions
            // still pinned to bedrock 17h post-recovery; Sam: "Bedrock should never be in
            // use if any OAuth account has tokens available.") Drop the leases so the next
            // respawn falls through to OAuth token injection.
            try {
              const leases = readLeases();
              let purged = 0;
              for (const [sid, entry] of Object.entries(leases)) {
                if (entry?.accountKey === 'bedrock') { delete leases[sid]; purged++; }
              }
              if (purged > 0) {
                writeLeases(leases);
                log(`[bedrock-recovery] purged ${purged} stale bedrock lease(s) → respawns will use OAuth`);
              }
            } catch (e) {
              log(`[bedrock-recovery] bedrock-lease purge failed: ${e.message?.slice(0, 80)}`);
            }
            try {
              stopClaudeDaemon();
            } catch (e) {
              log(`[bedrock-recovery] stopClaudeDaemon failed: ${e.message}`);
            }
            notify(
              'OAuth Restored',
              `${probeKey} has Max headroom — settings.json OAuth; Bedrock shells: source use-oauth.sh`,
            );
            try {
              writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
            } catch {}
            if (state.activeAccount !== probeKey) {
              await doRotation(`bedrock-recovery: ${probeKey} viable Max headroom`);
            }
            ctx.intervalMs = BEDROCK_RECOVERY_DEFAULT_INTERVAL_MS;
            ctx.concurrency = USAGE_PROBE_CONCURRENCY;
            ctx.backoffUntil = 0;
            writeRecoveryStatus({ phase: 'recovered', account: probeKey, probed: rows });
            return { didRecover: true };
          }
          log(`[bedrock-recovery] ${probeKey} util OK but token missing/expired — staying on Bedrock`);
        }
      }
    }
    if (i + cap < maxAccounts) await sleep(90 + Math.floor(Math.random() * 110));
  }

  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {}

  if (saw429) {
    ctx.backoffUntil = Date.now() + 50_000;
    ctx.concurrency = 1;
    log('[bedrock-recovery] usage API 429 — backoff 50s, concurrency=1 next cycle');
  } else {
    ctx.concurrency = USAGE_PROBE_CONCURRENCY;
    ctx.backoffUntil = 0;
  }

  let nextMs = BEDROCK_RECOVERY_DEFAULT_INTERVAL_MS;
  if (maxLiveUtil >= 95) nextMs = 140_000;
  else if (maxLiveUtil >= 85) nextMs = 72_000;
  else if (maxLiveUtil > 0 && maxLiveUtil < 72) nextMs = 38_000;

  try {
    const st = statSync(sentinelPath);
    if (now - st.mtimeMs < 3 * 60_000) nextMs = Math.min(nextMs, 42_000);
  } catch {}

  ctx.intervalMs = Math.max(BEDROCK_RECOVERY_MIN_INTERVAL_MS, Math.min(BEDROCK_RECOVERY_MAX_INTERVAL_MS, nextMs));

  writeRecoveryStatus({
    phase: 'watching',
    next_interval_ms: ctx.intervalMs,
    max_live_util_batch: maxLiveUtil,
    dest_cap: destinationUtilHardBlock(config),
    probed: rows,
  });
  return { didRecover: false };
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
      const isActive = key === state.activeAccount;
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
      // Active-account self-trigger: shouldRotate only live-probes the active
      // account when a statusline session has already written .rate-limits.json.
      // Headless/subagent-only workloads never write it, so an active account
      // could sit at a 100% weekly cap while every subagent dispatch failed
      // (bit us 2026-06-12). When the probe sees the active account over the
      // rotation threshold and no fresh trigger file exists, file one in the
      // statusline format — the normal shouldRotate path (with its anti-thrash
      // guards) then performs the rotation on the next tick.
      if (isActive && pct >= UTILIZATION_ROTATE_THRESHOLD) {
        try {
          if (!readRealUtilization()) {
            writeFileSync(
              RATE_LIMITS_FILE,
              JSON.stringify({
                ts: Math.floor(Date.now() / 1000),
                account_email: a.email,
                five_hour: { pct: pct5h, reset: live.reset5h ?? null },
                seven_day: { pct: pct7d, reset: live.reset7d ?? null },
                source: 'daemon-active-probe',
              }),
            );
            log(
              `[active-probe] active ${key} over threshold (5h=${pct5h.toFixed(0)}% 7d=${pct7d.toFixed(0)}% >= ${UTILIZATION_ROTATE_THRESHOLD}%) — filed rotation trigger`,
            );
          }
        } catch {}
      }
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
      const newKey = pickAccountForSession(s.id, config, state);
      if (newKey) {
        log(`[session-router] Session ${s.id} has no lease. Assigning to ${newKey}`);
        recordSessionLease(s.id, newKey, s.pid);
        if (s.status !== 'busy' && !isLoopSession(s.id)) {
          doRespawn(s, log);
        } else {
          try {
            const marker = `/tmp/claude-respawn-deferred-${s.id}`;
            if (!existsSync(marker)) writeFileSync(marker, String(Date.now()));
            log(`[session-router] Session ${s.id} is ${s.status === 'busy' ? 'busy' : 'a /loop session'} — deferred respawn (sweep handles it).`);
          } catch {}
        }
        return; // Rotate/respawn at most one session per tick to stagger
      }
      continue;
    }

    // Case 2: Session has a lease, check if its account is exhausted or if it is on bedrock
    const currentKey = lease.accountKey;
    if (currentKey === 'bedrock') {
      // Check if a Max account has cooled down and is now viable
      const newKey = pickAccountForSession(s.id, config, state);
      if (newKey && newKey !== 'bedrock') {
        log(`[session-router] Max account available. Migrating session ${s.id} off Bedrock to ${newKey}`);
        recordSessionLease(s.id, newKey, s.pid);
        if (s.status !== 'busy' && !isLoopSession(s.id)) {
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

    const acct = config.accounts.find(a => accountKey(a) === currentKey);
    if (!acct) continue;

    const cached = state.accounts?.[currentKey]?.lastUtilization;
    const util = cached?.pct ?? 0;
    const maxUtil = acct.maxUtilPercent || config.rateLimits.destinationMaxUtilPercent;

    // We no longer guess utilization based on active lease count.
    // Instead, we rely strictly on the live metrics fetched from Claude API by the usage probe.
    if (util >= maxUtil) {
      log(`[session-router] Session ${s.id} leased account ${currentKey} ACTUAL utilization is exhausted (${util}% >= ${maxUtil}%). Rotating.`);
      const newKey = pickAccountForSession(s.id, config, state);
      if (newKey && newKey !== currentKey) {
        log(`[session-router] Swapping lease for session ${s.id}: ${currentKey} -> ${newKey}`);
        recordSessionLease(s.id, newKey, s.pid);
        
        if (s.status !== 'busy' && !isLoopSession(s.id)) {
          doRespawn(s, log);
        } else {
          try {
            const marker = `/tmp/claude-respawn-deferred-${s.id}`;
            if (!existsSync(marker)) writeFileSync(marker, String(Date.now()));
            log(`[session-router] Session ${s.id} is busy or looping. Deferred rotation to idle state.`);
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

  let lastRotatedAt = 0; // track when we last rotated
  let lastStatusLog = 0; // periodic status logging
  let lastLeaseBeat = 0; // cross-machine lease heartbeat (S3)
  const lastRefreshCheck = 0; // dynamic refresh check
  let lastDriftCheck = 0; // cheap vault-based drift detection
  let lastFullProbe = 0; // periodic fleet-wide live-util snapshot refresh
  let lastRespawnSweep = 0; // deferred bg-session respawn retry (busy at rotation time)
  const FULL_PROBE_INTERVAL = 5 * 60_000;
  const bedrockRecCtx = {
    lastCheck: 0,
    intervalMs: BEDROCK_RECOVERY_DEFAULT_INTERVAL_MS,
    backoffUntil: 0,
    concurrency: USAGE_PROBE_CONCURRENCY,
  };

  while (true) {
    try {
      const config = readConfig();
      if (!config.autoRotate) {
        await sleep(POLL_INTERVAL);
        continue;
      }

      const state = readState();

      // Periodic status log (every 5 min) — shows cooldown state for all accounts
      if (Date.now() - lastStatusLog > 300_000) {
        log(`Account cooldown status:\n${accountCooldownStatus(state)}`);
        lastStatusLog = Date.now();
      }

      // Cross-machine lease heartbeat (every 3 min, << 2h TTL): refresh THIS
      // machine's claim on its active account so the other machine keeps
      // excluding it. Best-effort / fail-open (S3 down => no-op). (Sam 2026-06-06)
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
      if (Date.now() - lastRespawnSweep > 120_000) {
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

      const sentinelPath = join(process.env.HOME || '', '.claude', '.bedrock-fallback.json');
      // Effective-Bedrock detection: settings.json can be flipped to Bedrock
      // WITHOUT writing the sentinel (use-bedrock.sh, app-releaser routing,
      // manual edits). In that case the metered Bedrock provider stays active
      // but the recovery probe below never runs, stranding the box on paid
      // tokens even when OAuth accounts have headroom. Treat USE_BEDROCK=1 in
      // settings.json as an equivalent recovery trigger so we always probe
      // back to free OAuth. (2026-06-13: stuck on Bedrock 19h post-recovery.)
      let settingsBedrock = false;
      try {
        const sp = join(process.env.HOME || '', '.claude', 'settings.json');
        if (existsSync(sp)) {
          const senv = JSON.parse(readFileSync(sp, 'utf8'))?.env || {};
          settingsBedrock = senv.CLAUDE_CODE_USE_BEDROCK === '1' || senv.CLAUDE_CODE_USE_BEDROCK === 1;
        }
      } catch {}
      if (existsSync(sentinelPath) || settingsBedrock) {
        const { didRecover } = await maybeRecoverOAuthFromBedrock(config, state, sentinelPath, bedrockRecCtx);
        if (didRecover) lastRotatedAt = Date.now();
      } else {
        bedrockRecCtx.intervalMs = BEDROCK_RECOVERY_DEFAULT_INTERVAL_MS;
        bedrockRecCtx.backoffUntil = 0;
        bedrockRecCtx.concurrency = USAGE_PROBE_CONCURRENCY;
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
      } else {
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
      process.kill(parseInt(pid));
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
      process.kill(parseInt(pid), 0); // Check if alive
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
