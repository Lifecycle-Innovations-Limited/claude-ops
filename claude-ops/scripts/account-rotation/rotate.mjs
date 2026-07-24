#!/usr/bin/env node
/**
 * Claude Max Account Rotation — dcli + keychain + Kapture
 *
 * PRIMARY PATH (fast, ~1s, no browser):
 *   dcli read token → write to keychain "Claude Code-credentials" → done
 *
 * FALLBACK (token missing/expired) — browser automation cascade:
 *   1. Kapture MCP  (ws://localhost:61822 — your real Chrome, all Google sessions)
 *   2. Playwright   (persistent context)
 *   3. Chrome JXA   (AppleScript, needs "Allow JS from Apple Events")
 *   4. Manual       (opens URL, notifies user)
 *
 * Usage:
 *   node rotate.mjs                           # auto-rotate to longest-idle account
 *   node rotate.mjs --to <email>              # rotate to specific account
 *   node rotate.mjs --status                  # show state
 *   node rotate.mjs --utilization             # live 5h/7d utilization (read-only; vault preserved on 401)
 *   node rotate.mjs --utilization --repair    # utilization + attempt refresh/magic-link repair on 401
 *   node rotate.mjs --audit-billing           # 🔴/🟢 per-account extra_usage (overage billing) audit
 *   node rotate.mjs --setup                   # manual: claude auth login per account (interactive)
 *   node rotate.mjs --setup --auto            # AUTOMATED: magic-link + browser cascade, all configured accounts end-to-end
 *   node rotate.mjs --setup --auto --skip-valid  # skip accounts whose vault token is still alive
 *   node rotate.mjs --setup --only=<key>      # only re-capture one account (e.g. --only=user@example.com)
 *   node rotate.mjs --capture                 # save current active token (print for Dashlane)
 *   node rotate.mjs --session                 # also send /login to running iTerm2 session
 *   node rotate.mjs --magic-link --to <email> # re-auth via email magic link (no Google OAuth)
 *   node rotate.mjs --sync-crs-all              # push all vault tokens to dev-us CRS (no OAuth)
 *   Note: --allow-extra-usage is ignored if passed (legacy); extra_usage is per-org in Claude console only.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  appendFileSync,
  chmodSync,
  readdirSync,
  renameSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import path, { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync, spawnSync, spawn } from 'child_process';
import os, { tmpdir, homedir } from 'os';
import { createHmac, randomUUID } from 'node:crypto';
import {
  askAIBrain,
  executeAIAction,
  AI_BRAIN_MAX_DECISIONS,
  scrapeBillingState,
  geminiAvailable,
} from './ai-brain.mjs';
import { cachedUtilizationMax, destinationUtilHardBlock } from './rotation-policy.mjs';
import { repairAccountOn401 } from './auth-repair.mjs';
import { applyAccountLeases, writeLease } from './account-leases.mjs';
import { respawnBgSessions, listLiveBgSessions, doRespawn } from './bg-respawn.mjs';
import { readRotationToken, writeRotationToken } from './rotation-vault.mjs';
import { pickAccountForSession, recordSessionLease, readLeases } from './session-router.mjs';
import { trashMagicLinkMessages } from './magic-link-cleanup.mjs';
import { ensureVirtualDisplay } from './virtual-display.mjs';
import { launchCrsOperator } from './crs-operator.mjs';
import { bootstrapRotatorSecrets } from './secrets-bootstrap.mjs';
import { solveCaptchaOnPage, captchaSolverAvailable } from './captcha-helper.mjs';
import { checkCrsHealth } from './crs-pool-config.mjs';
import { acquireRefreshLock } from './crs-refresh-lock.mjs';
import {
  RotationSafetyError,
  acquireProcessLock,
  classifyGogFailure,
  createDeadline,
  evaluateFreshToken,
  preflightGogInbox,
  redactSensitiveText,
  tokenSnapshot,
  withDeadline,
} from './rotation-safety.mjs';

const _PATCH_025_ROTATION_AUTH_HARDENING = true;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, 'state.json');
const LOCK_PATH = join(__dirname, '.rotating');
const LOG_PATH = join(__dirname, 'rotation.log');
const OAUTH_SNAPSHOTS_DIR = join(__dirname, 'oauth-snapshots');
const BROWSER_PIN_PATH = join(__dirname, '.browser-pin');
const BROWSER_PIN_BACKUP_PATH = join(__dirname, '.browser-pin-backup.json');
const CLAUDE_JSON_PATH = join(process.env.HOME || '', '.claude.json');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const ACTIVE_KEYCHAIN_ACCOUNT = process.env.USER || 'unknown';
const VAULT_KEYCHAIN_ACCOUNT = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load GOG keyring secrets for headless/launchd (never log the value).
// Order: env → mode-600 file next to this script → Keychain security(1) → ~/.mcp-secrets.env
if (!process.env.GOG_KEYRING_PASSWORD) {
  try {
    const secretFile = join(__dirname, '.gog-keyring-password');
    if (existsSync(secretFile)) {
      const pw = readFileSync(secretFile, 'utf8').replace(/[\r\n]+$/g, '');
      if (pw) process.env.GOG_KEYRING_PASSWORD = pw;
    }
  } catch {}
}
if (!process.env.GOG_KEYRING_PASSWORD) {
  try {
    for (const svc of ['gog-keyring-password', 'gogcli', 'gog']) {
      const r = spawnSync('security', ['find-generic-password', '-s', svc, '-w'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const pw = (r.stdout || '').trim();
      if (pw) {
        process.env.GOG_KEYRING_PASSWORD = pw;
        break;
      }
    }
  } catch {}
}
if (!process.env.GOG_KEYRING_PASSWORD && existsSync(join(homedir(), '.mcp-secrets.env'))) {
  try {
    const envContent = readFileSync(join(homedir(), '.mcp-secrets.env'), 'utf8');
    const pwdMatch =
      envContent.match(/^export GOG_KEYRING_PASSWORD='([^']+)'/m) ||
      envContent.match(/^GOG_KEYRING_PASSWORD="([^"]+)"/m) ||
      envContent.match(/^GOG_KEYRING_PASSWORD=([^\s]+)/m);
    const backendMatch =
      envContent.match(/^export GOG_KEYRING_BACKEND='([^']+)'/m) ||
      envContent.match(/^GOG_KEYRING_BACKEND="([^"]+)"/m) ||
      envContent.match(/^GOG_KEYRING_BACKEND=([^\s]+)/m);
    if (pwdMatch) process.env.GOG_KEYRING_PASSWORD = pwdMatch[1];
    if (backendMatch) process.env.GOG_KEYRING_BACKEND = backendMatch[1];
  } catch {}
}

// Graceful rotation-over stagger: after a swap, sessions are moved onto the new
// account ONE AT A TIME with this gap between them. Without it the whole fleet
// reloads in the same instant and stampedes the single new account → immediate
// rate-limit → fleet crash (observed 2026-06-14). Applies to the hot-swap SIGHUP
// fan-out, the interactive /login injection, and bg-respawn. Default 5s; tune via
// CLAUDE_ROTATION_SESSION_STAGGER_MS (0 disables).
const SESSION_STAGGER_MS = (() => {
  const v = parseInt(process.env.CLAUDE_ROTATION_SESSION_STAGGER_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 5000;
})();

// ── Bootstrap: reaper for leftover `claude auth login` zombies ───────────────
// Past rotation runs (especially during the foundation re-login attempts on
// 2026-07-02) leaked auth procs that held the user's terminal TTY open with
// "Sign in to Claude.ai" prompts. Sweep on startup so any leftovers don't
// block the current rotation or continue confusing the user. Kill-switch:
// CLAUDE_ROTATION_SKIP_AUTH_REAPER=1.
function reapLeftoverAuthProcs() {
  if (process.env.CLAUDE_ROTATION_SKIP_AUTH_REAPER === '1') return;
  const parseEtimeSeconds = (text) => {
    const parts = String(text || '')
      .trim()
      .split('-');
    let days = 0;
    let hms = parts[0] || '';
    if (parts.length === 2) {
      days = parseInt(parts[0], 10) || 0;
      hms = parts[1] || '';
    }
    const nums = hms.split(':').map((p) => parseInt(p, 10) || 0);
    if (nums.length === 3) return days * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 2) return days * 86400 + nums[0] * 60 + nums[1];
    return days * 86400 + (nums[0] || 0);
  };
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('pgrep', ['-f', 'claude.*auth.*login'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return;
    const pids = out.split('\n').filter(Boolean);
    for (const pid of pids) {
      const ageText = execFileSync('ps', ['-o', 'etime=', '-p', pid], { encoding: 'utf8', timeout: 3000 }).trim();
      const age = parseEtimeSeconds(ageText);
      if (age < 300) continue;
      try {
        process.kill(parseInt(pid, 10), 'SIGKILL');
        log(`[auth-reaper] killed leftover auth login pid ${pid}`);
      } catch {}
    }
  } catch {}
}
reapLeftoverAuthProcs();

// ── Bootstrap: verify dependencies ───────────────────────────────────────────
// Browser driver tiers (Playwright):
//   1. CDP-attach to an already-running Chrome on :9222
//   2. Spawn Chrome Beta with an isolated automation profile (preferred — has
//      real-Chrome network stack so claude.ai/Google don't flag it)
//   3. Fallback: Playwright's bundled Chromium with launchPersistentContext on
//      an ISOLATED profile dir (used when no Chrome/Chrome Beta binary, or when
//      Chrome Beta launch fails). Never depends on / touches the operator's daily Chrome
//      or Comet — Comet stays reserved for the user.
function ensureMCPServersAndTools() {
  const actions = [];
  const earlyLog = (m) => {
    try {
      console.error(`[bootstrap] ${m}`);
    } catch {}
  };

  // 1. Chrome or Chrome Beta binary (Comet is off-limits)
  const realChromes = [
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/opt/brave.com/brave/brave',
  ];
  const foundChrome = realChromes.find((p) => existsSync(p));
  if (foundChrome) {
    actions.push(`chrome-binary: ${foundChrome.split('/').pop()}`);
  } else {
    // Fallback: try `which google-chrome chromium chromium-browser brave`
    const whichCandidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave'];
    const foundWhich = whichCandidates.find((c) => {
      try {
        execSync(`command -v ${c} >/dev/null 2>&1`, { timeout: 1000 });
        return true;
      } catch {
        return false;
      }
    });
    if (foundWhich) {
      actions.push(`chrome-binary: ${foundWhich} (via PATH)`);
    } else {
      actions.push('chrome-binary: WARNING — no Chrome/Chrome Beta found');
    }
  }

  // 2. Chrome CDP port 9222 — probe (driver will launch Chrome if needed)
  try {
    execSync(`curl -sf http://localhost:9222/json/version >/dev/null 2>&1`, {
      timeout: 1500,
    });
    actions.push('chrome-cdp: reachable on :9222');
  } catch {
    actions.push('chrome-cdp: not reachable (driver will launch Chrome)');
  }

  // 3. dcli (Dashlane) — required for primary token path
  try {
    execSync(`command -v dcli >/dev/null 2>&1`, { timeout: 1000 });
    actions.push('dcli: available');
  } catch {
    actions.push('dcli: MISSING — primary token path will fail');
  }

  // 4. security (macOS keychain) — required for token writes ON MACOS ONLY.
  // On Linux the token store is the file-based ~/.claude/.credentials.json
  // (see _linuxWriteCred / IS_LINUX), so a missing `security` binary is benign
  // here — don't emit a misleading warning. (2026-06-06: box-local separation.)
  if (process.platform === 'darwin') {
    try {
      execSync(`command -v security >/dev/null 2>&1`, { timeout: 1000 });
    } catch {
      actions.push('security(1): MISSING — keychain writes will fail');
    }
  } else {
    actions.push('token-store: file (~/.claude/.credentials.json) — Linux, keychain not required');
  }

  for (const a of actions) earlyLog(a);
}

// Unconditional warmup: every rotate.mjs run starts its MCP servers + tools FIRST.
// Skip only for --help (where nothing runs downstream).
if (
  !process.argv.slice(2).includes('--help') &&
  !process.argv.slice(2).includes('--no-browser') &&
  !process.argv.slice(2).includes('--pin-browser')
) {
  ensureMCPServersAndTools();
}

// ── Utilities ────────────────────────────────────────────────────────────────

function log(msg) {
  const safeMessage = redactSensitiveText(msg);
  const line = `[${new Date().toISOString()}] ${safeMessage}`;
  console.error(line);
  try {
    appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

const logger = {
  error: (msg, err) => log(`${msg} ${err?.stack || err?.message || err}`),
};

// Repeatedly-overwritten bookkeeping files (pidfiles, recovery markers) that
// live under predictable /tmp paths: O_NOFOLLOW makes the open fail if a
// local attacker has pre-planted a symlink there, instead of silently
// writing through it to whatever it points at. O_CREAT|O_TRUNC preserves the
// normal "create if missing, overwrite if present" behavior for the real file.
function writeFileNoFollowSync(path, data) {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function notify(title, msg) {
  try {
    if (process.platform === 'darwin') {
      // AppleScript string-literal escaping (backslash first, then quote) —
      // execFileSync also means no shell is involved, so this only has to be
      // valid for the AppleScript source itself, not a second shell layer.
      const escAS = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `display notification "${escAS(msg)}" with title "${escAS(title)}"`;
      execFileSync('osascript', ['-e', script]);
    } else {
      execFileSync('notify-send', [String(title), String(msg)], { timeout: 2000 });
    }
  } catch {}
}

// Cross-machine account leases (2026-06-06): NOT a static per-machine split.
// Both machines may use ALL accounts; the only constraint is that the same
// account is never ACTIVE on both at once. readConfig() drops accounts a FOREIGN
// host currently holds a fresh lease on. We never drop the account we're
// staying on (the live/tracked active key) so a heartbeat-write can refresh it.
// Fail-open: lease store unreachable => no exclusion. See account-leases.mjs.
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

// All used Claude.ai account email addresses forward to ONE Gmail inbox:
// shared-inbox@example.com. Always poll that forwarding inbox for magic links and
// verification codes; the target Claude account email is still used for the
// Claude login form and for validating embedded magic-link targets.
function magicLinkInbox() {
  if ((process.env.CLAUDE_ROT_GMAIL_ACCOUNT || '').trim()) return process.env.CLAUDE_ROT_GMAIL_ACCOUNT.trim();
  if ((process.env.GOG_ACCOUNT || '').trim()) return process.env.GOG_ACCOUNT.trim();
  try {
    return (readConfig().magicLinkGmailAccount || 'shared-inbox@example.com').trim();
  } catch {
    return 'shared-inbox@example.com';
  }
}

// All Claude.ai account login emails (magic links + verification codes) are
// forwarded to ONE mailbox: shared-inbox@example.com. The original recipient
// address in the email body is the Claude account being rotated; the magic
// link itself is bound to that account by Anthropic and is safe to consume
// regardless of which Claude account's email is the visible recipient.
//
// For account-bound safety during concurrent rotations across multiple Claude
// accounts, we still cross-check the magic-link's embedded target against the
// set of Claude accounts currently scheduled in the scheduler, to avoid
// spending a fresh magic-link URL on the wrong account.
function forwardingInboxLower() {
  return (magicLinkInbox() || 'shared-inbox@example.com').toLowerCase();
}
function isForwardedToSharedInbox(recipientEvidence) {
  // Accept any email routed to the forwarding mailbox, by any header hint
  // (To/Cc/Bcc/X-Original-To/Delivered-To) or by sender being anthropic/claude.
  const forward = forwardingInboxLower();
  const senderOK = /(anthropic\.com|claude\.ai)/i.test(recipientEvidence);
  const forwardOK = recipientEvidence.includes(forward);
  return senderOK && (forwardOK || forward === 'shared-inbox@example.com');
}

function requireMagicLinkInboxReady(deadline) {
  const inbox = magicLinkInbox();
  preflightGogInbox({
    inbox,
    headless: process.env.CLAUDE_ROT_HEADED !== '1' || !process.stdin.isTTY,
    timeoutMs: deadline.budget('gog preflight', 10_000),
  });
  return inbox;
}
// Legacy account-key renames: old label → new canonical key.
// Keep in sync with daemon.mjs STATE_KEY_MIGRATIONS.
const STATE_KEY_MIGRATIONS = {
  'example-personal': 'example',
};

function readState() {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { activeAccount: null, accounts: {}, toolUses: 0, totalRotations: 0 };
  }
  let migrated = false;
  if (state.accounts) {
    for (const [oldKey, newKey] of Object.entries(STATE_KEY_MIGRATIONS)) {
      if (state.accounts[oldKey] && !state.accounts[newKey]) {
        state.accounts[newKey] = state.accounts[oldKey];
        delete state.accounts[oldKey];
        migrated = true;
      } else if (state.accounts[oldKey]) {
        delete state.accounts[oldKey];
        migrated = true;
      }
    }
    if (state.activeAccount && STATE_KEY_MIGRATIONS[state.activeAccount]) {
      state.activeAccount = STATE_KEY_MIGRATIONS[state.activeAccount];
      migrated = true;
    }
  }
  if (migrated) {
    try {
      writeFileSync(STATE_PATH + '.tmp.' + process.pid, JSON.stringify(state, null, 2));
      renameSync(STATE_PATH + '.tmp.' + process.pid, STATE_PATH);
    } catch {}
  }
  return state;
}
function writeState(s, dryRun = false) {
  if (dryRun) {
    log('[DRY-RUN] Would write state');
    return;
  }
  const tmp = STATE_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH);
}

// Process-wide rotation lock. Acquisition is atomic and a live holder is
// never evicted because of age. --force cannot bypass this lock.
let releaseRotationLock = null;
function acquireLock() {
  releaseRotationLock = acquireProcessLock(LOCK_PATH, { log });
  return Boolean(releaseRotationLock);
}
function releaseLock() {
  try {
    releaseRotationLock?.();
  } finally {
    releaseRotationLock = null;
  }
}

function accountKey(a) {
  return a.label || a.email;
}

/** After OAuth completes in the same Playwright session, scrape console billing into state. */
async function maybeScrapeBillingAfterOAuth(driver, account, log) {
  if (process.env.CLAUDE_ROTATOR_SKIP_BILLING_SCRAPE === '1') return;
  const page = driver?._page;
  if (!page || typeof page.goto !== 'function') return;
  const key = accountKey(account);
  try {
    log(`[billing-scrape] console billing for ${key}...`);
    const billing = await scrapeBillingState(page, (m) => log(m));
    if (!billing) return;
    const state = readState();
    state.accounts[key] = state.accounts[key] || {};
    const prev = state.accounts[key].lastBilling || {};
    state.accounts[key].lastBilling = {
      ...prev,
      credits_usd: billing.credits_usd,
      auto_reload_enabled: billing.auto_reload_enabled,
      extra_usage_enabled:
        billing.extra_usage_enabled !== null && billing.extra_usage_enabled !== undefined
          ? billing.extra_usage_enabled === true
          : prev.extra_usage_enabled,
      ts: Date.now(),
      source: 'console_scrape',
    };
    writeState(state);
    log(
      `[billing-scrape] merged credits=${billing.credits_usd} auto_reload=${billing.auto_reload_enabled} extra_usage=${billing.extra_usage_enabled}`,
    );
  } catch (e) {
    log(`[billing-scrape] error: ${String(e.message || e).slice(0, 100)}`);
  }
}

// ── Live utilization query ────────────────────────────────────────────────────

// Shared on-disk + in-process cache: avoid hammering /oauth/usage more than once per 4 minutes
// per account across ALL processes (TUI, daemon, manual runs).
// 340+ hits in one session triggers persistent 429s from Anthropic.
const _utilCache = new Map(); // key → { ts, data }
const UTIL_CACHE_TTL = 4 * 60 * 1000; // 4 minutes
const UTIL_FAILURE_CACHE_TTL = 60 * 1000; // bound retries while a token is being repaired
const UTIL_CACHE_FILE = join(__dirname, '.util-cache.json');

function _loadUtilDiskCache() {
  try {
    const raw = JSON.parse(readFileSync(UTIL_CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (v?.ts && now - v.ts < UTIL_CACHE_TTL) {
        _utilCache.set(k, v);
      }
    }
  } catch {}
}

function _saveUtilDiskCache() {
  try {
    let obj = {};
    try {
      obj = JSON.parse(readFileSync(UTIL_CACHE_FILE, 'utf8')) || {};
    } catch {}
    // Multiple TUI/daemon processes share this file. Merge by timestamp so a
    // slower writer cannot erase another process's fresher account result.
    for (const [k, v] of _utilCache.entries()) {
      if (!obj[k]?.ts || v.ts >= obj[k].ts) obj[k] = v;
    }
    const tmp = `${UTIL_CACHE_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, UTIL_CACHE_FILE);
  } catch {}
}

_loadUtilDiskCache();

// Query all accounts in parallel — best-effort, uses cached fallback.
// Staggered + retry-on-429 to avoid rate-limiting the /oauth/usage endpoint,
// especially right after a token refresh when Anthropic briefly throttles.
async function queryAllUtilization(config, opts = {}) {
  const allowRepair = opts.repair === true || process.env.CLAUDE_ROTATION_UTILIZATION_REPAIR === '1';
  const readOnly = opts.readOnly !== false && !allowRepair;
  const forceRefresh = opts.forceRefresh === true;

  async function queryAccount(a, triedRepair = false) {
    const cacheKey = accountKey(a);
    // Return in-process cached result if fresh enough, unless forceRefresh
    if (!forceRefresh && !triedRepair) {
      const cached = _utilCache.get(cacheKey);
      const cacheTtl = cached?.data ? UTIL_CACHE_TTL : UTIL_FAILURE_CACHE_TTL;
      if (cached && Date.now() - cached.ts < cacheTtl) {
        return cached.data;
      }
    }
    try {
      const tokenJson = readStoredToken(a);
      if (!tokenJson) return null;
      const parsed = JSON.parse(tokenJson);
      const accessToken = parsed?.claudeAiOauth?.accessToken;
      if (!accessToken) return null;

      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      };

      async function fetchWithRetry(url, attempt = 0) {
        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(12000),
        });
        // Retry on 429 with backoff — 2 attempts max to keep total query time bounded.
        if (res.status === 429 && attempt < 2) {
          const delay = 1500 * (attempt + 1); // 1.5s, 3s
          await new Promise((r) => setTimeout(r, delay));
          return fetchWithRetry(url, attempt + 1);
        }
        return res;
      }

      // Usage is the authoritative signal and must not compete with optional
      // profile enrichment. Running both endpoints (and their retries) in
      // parallel across the fleet doubled the burst and caused otherwise-valid
      // accounts to fall back to stale cache. Fetch usage first; profile is a
      // best-effort, non-retried follow-up only after usage succeeds.
      const usageRes = await fetchWithRetry('https://api.anthropic.com/api/oauth/usage');

      if (usageRes.status === 401) {
        if (readOnly && !triedRepair) {
          log(`[query] Account ${a.email} returned 401 on usage — vault preserved (read-only)`);
          _utilCache.set(cacheKey, { ts: Date.now(), data: null, status: 401 });
          _saveUtilDiskCache();
          return null;
        }
        if (!triedRepair && allowRepair) {
          const repair = await repairAccountOn401(a, getAuthRepairDeps());
          if (repair.repaired) return queryAccount(a, true);
        }
        log(`[query] Account ${a.email} returned 401 on usage — query failed (vault preserved)`);
        return null;
      }

      if (!usageRes.ok) {
        log(`[query] Account ${a.email} usage unavailable — HTTP ${usageRes.status}`);
        _utilCache.set(cacheKey, { ts: Date.now(), data: null, status: usageRes.status });
        _saveUtilDiskCache();
        return null;
      }
      const data = await usageRes.json();
      let extraUsageEnabled = null;
      let billingType = null;
      let subscriptionStatus = null;
      try {
        const profileRes = await fetch('https://api.anthropic.com/api/oauth/profile', {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (profileRes.ok) {
          const prof = await profileRes.json();
          extraUsageEnabled = prof?.organization?.has_extra_usage_enabled ?? null;
          billingType = prof?.organization?.billing_type ?? null;
          subscriptionStatus = prof?.organization?.subscription_status ?? null;
        }
      } catch {}
      const result = {
        five_hour_pct: Math.round((data.five_hour?.utilization ?? 0) * 100) / 100,
        seven_day_pct: Math.round((data.seven_day?.utilization ?? 0) * 100) / 100,
        resets_at_5h: data.five_hour?.resets_at || null,
        resets_at_7d: data.seven_day?.resets_at || null,
        extra_usage_enabled: extraUsageEnabled,
        billing_type: billingType,
        subscription_status: subscriptionStatus,
      };
      // Store in process + disk cache to avoid re-hitting the rate-limited endpoint
      _utilCache.set(cacheKey, { ts: Date.now(), data: result });
      _saveUtilDiskCache();
      return result;
    } catch {
      return null;
    }
  }

  // Stagger account queries by 500ms to avoid bursting /oauth/usage endpoint,
  // which 429s when many accounts query in parallel from the same IP.
  const results = await Promise.allSettled(
    config.accounts
      .filter((a) => a.disabled !== true)
      .map(async (a, idx) => {
        if (idx > 0) await new Promise((r) => setTimeout(r, 500 * idx));
        return { key: accountKey(a), util: await queryAccount(a) };
      }),
  );
  const map = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.util) {
      map[r.value.key] = r.value.util;
    }
  }
  return map;
}

function currentActiveIsOnlyViableTarget(config, state, liveUtil) {
  const activeKey = state.activeAccount;
  if (!activeKey) return false;
  const activeAcc = config.accounts.find((a) => accountKey(a) === activeKey);
  if (!activeAcc || activeAcc.disabled === true) return false;
  const key = accountKey(activeAcc);
  const live = liveUtil[key];
  const u5 = live?.five_hour_pct;
  const u7 = live?.seven_day_pct;
  if (u5 == null || u7 == null) return false;
  const cap = destinationUtilHardBlock(config);
  return Math.max(u5, u7) < cap;
}

// liveUtil: optional map from queryAllUtilization() — key → { five_hour_pct, ... }
function pickNextAccount(config, state, liveUtil = {}) {
  const activeKey = state.activeAccount;
  const windowMs = (config.rateLimits?.windowHours || 5) * 3_600_000;
  const now = Date.now();

  // extra_usage is informational only — manage pay-per-use per org in the Claude console;
  // it does not affect who we can rotate to.
  function hasExtraUsageEnabled(a) {
    const key = accountKey(a);
    // Per-account safe override (2026-06-11 policy): when auto-reload/auto-billing is
    // OFF on the org, extra_usage cannot leak money — at 0 credits Claude simply
    // stops, it does NOT pay-per-use. Such accounts are first-class rotation
    // targets, not last-resort EU-pool. Honors the config `extraUsageSafeOverride`
    // field (previously declared but never wired).
    if (a.extraUsageSafeOverride === true) return false;
    const live = liveUtil[key];
    if (live && live.extra_usage_enabled === true) return true;
    // Fallback to last-known extra_usage state from state.json
    const cached = state.accounts?.[key]?.lastBilling?.extra_usage_enabled;
    if (cached === true) return true;
    return false;
  }

  // Money-leak guard (inverted default): by default EXTRA_USAGE accounts ARE
  // first-class rotation targets. Pass --block-extra-usage to pin them to
  // last-resort pools (only picked when no non-EU account is viable).
  // Per-account safety override: set `extraUsageSafeOverride: true` in config
  // to force this account as first-class regardless of flags.
  const blockExtraUsage =
    process.argv.slice(2).includes('--block-extra-usage') || process.env.BLOCK_EXTRA_USAGE === '1';
  const blockExtra = (a) => blockExtraUsage && hasExtraUsageEnabled(a);

  // Check if an account's quota window has been exhausted (local tool-use tracking)
  function isExhausted(a) {
    const key = accountKey(a);
    const acct = state.accounts[key];
    if (!acct?.windowStart) return false;
    const windowAge = now - new Date(acct.windowStart).getTime();
    if (windowAge >= windowMs) return false;
    const capacity = a.capacityMultiplier ?? 1.0;
    const maxUses = Math.floor(config.toolUseThreshold * capacity);
    return (acct.windowToolUses || 0) >= maxUses;
  }

  // Get best available utilization for an account:
  //   1. Live API data (freshest)
  //   2. Snapshot from last rotation away (stale but better than nothing)
  //   3. null (unknown)
  function getUtil5h(a) {
    const key = accountKey(a);

    // 1. Live
    if (liveUtil[key] != null) return liveUtil[key].five_hour_pct;

    // 2. Snapshot stored in state
    const acct = state.accounts[key];
    if (!acct?.lastUtilization) return null;
    const { pct, reset, ts } = acct.lastUtilization;
    if (!ts) return null;
    const resetMs = reset * 1000;
    if (resetMs && resetMs < now) return 0; // Window reset — account is fresh
    if (now - ts > 6 * 3_600_000) return null; // Too stale
    return pct ?? null;
  }

  // 7-day weekly cap utilization. Prefer live, then use the persisted weekly
  // window while its reset is still in the future. Ignoring cached `pct7`
  // allowed 100%-weekly accounts to look like 0%-5h candidates during API 429s.
  function getUtil7d(a) {
    const key = accountKey(a);
    if (liveUtil[key] != null && liveUtil[key].seven_day_pct != null) {
      return liveUtil[key].seven_day_pct;
    }
    const cached = state.accounts[key]?.lastUtilization;
    if (!cached?.ts) return null;
    if (cached.pct7 == null) return null;
    const reset7Ms = cached.reset7 ? cached.reset7 * 1000 : 0;
    if (reset7Ms && reset7Ms < now) return 0;
    if (!reset7Ms && now - cached.ts > 6 * 3_600_000) return null;
    return cached.pct7;
  }

  // Score: max of (5h, 7d) — both windows must be known or we penalize heavily.
  // Never treat a missing window as 0%: old bug was max(0, null→0)=0, so an account
  // with live 7d=100% but a transient live miss became "best" pick via stale 5h cache.
  function score(a) {
    const u5 = getUtil5h(a);
    const u7 = getUtil7d(a);
    // If both unknown, return 50 (middle of the pack)
    if (u5 === null && u7 === null) return 50;
    // If one is unknown, use the known one instead of penalizing at 100.
    // This fixes the "query_failed blocks rotation" issue for transient API misses.
    if (u5 === null) return u7;
    if (u7 === null) return u5;
    return Math.max(u5, u7);
  }

  const extraUsageAccounts = config.accounts.filter(hasExtraUsageEnabled);
  if (extraUsageAccounts.length > 0) {
    log(
      `ℹ  EXTRA USAGE ENABLED on ${extraUsageAccounts.length} account(s): ${extraUsageAccounts
        .map((a) => accountKey(a))
        .join(', ')} — overage billing possible; ${
        blockExtraUsage
          ? 'pinned to last-resort pools (pass --allow-extra-usage to override)'
          : 'first-class rotation targets (pass --block-extra-usage to pin to last-resort)'
      }. Disable per org at console.anthropic.com/settings/billing.`,
    );
  }

  const excludeKey = (a) => a.disabled === true || accountKey(a) === activeKey;

  // Vault-expired destinations thrash forever: cached util often shows 0% while
  // refresh_token is dead (HTTP 400). Automatic pick must only choose accounts
  // with a usable vault access token. Explicit `--to X --magic-link` bypasses
  // pickNextAccount for re-auth. (root-caused 2026-07-16 incident.)
  const vaultUsableCache = new Map();
  const vaultDeadKeys = [];
  function hasUsableVaultToken(a) {
    const key = accountKey(a);
    if (vaultUsableCache.has(key)) return vaultUsableCache.get(key);
    let ok = false;
    try {
      const json = readStoredToken(a);
      ok = Boolean(json) && !tokenExpired(json);
    } catch {
      ok = false;
    }
    vaultUsableCache.set(key, ok);
    if (!ok) vaultDeadKeys.push(key);
    return ok;
  }
  const excludeVaultDead = (a) => !hasUsableVaultToken(a);
  // Touch all non-active accounts once so vaultDeadKeys is complete for the summary log.
  for (const a of config.accounts) {
    if (!excludeKey(a)) hasUsableVaultToken(a);
  }
  if (vaultDeadKeys.length) {
    log(
      `vault-expired excluded from destination pick (${vaultDeadKeys.length}): ${vaultDeadKeys.slice(0, 8).join(', ')}${
        vaultDeadKeys.length > 8 ? ` +${vaultDeadKeys.length - 8} more` : ''
      } — re-auth with rotate-magic / --magic-link`,
    );
  }

  // Separate refreshable accounts from accounts that are usable today but cannot
  // be unattended-reauthenticated when their stored token dies. Manual-reauth
  // accounts stay as a fallback, but should not win just because they are at 0%
  // while other healthy refreshable accounts have headroom.
  const refreshableNormal = config.accounts.filter(
    (a) =>
      a.priority !== 'low' && a.autoAuthDisabled !== true && !excludeKey(a) && !blockExtra(a) && !excludeVaultDead(a),
  );
  const refreshableLow = config.accounts.filter(
    (a) =>
      a.priority === 'low' && a.autoAuthDisabled !== true && !excludeKey(a) && !blockExtra(a) && !excludeVaultDead(a),
  );
  const manualReauthNormal = config.accounts.filter(
    (a) =>
      a.priority !== 'low' && a.autoAuthDisabled === true && !excludeKey(a) && !blockExtra(a) && !excludeVaultDead(a),
  );
  const manualReauthLow = config.accounts.filter(
    (a) =>
      a.priority === 'low' && a.autoAuthDisabled === true && !excludeKey(a) && !blockExtra(a) && !excludeVaultDead(a),
  );

  // Absolute last-resort pools: accounts blocked ONLY because extra_usage is on.
  // Empty when allowExtraUsage (they already live in the pools above). Tried after
  // every non-EU pool, so an overage account is only ever picked when nothing else
  // is viable — better a paid token than a fully stalled session on an exhausted key.
  const euNormal = config.accounts.filter(
    (a) => a.priority !== 'low' && !excludeKey(a) && blockExtra(a) && !excludeVaultDead(a),
  );
  const euLow = config.accounts.filter(
    (a) => a.priority === 'low' && !excludeKey(a) && blockExtra(a) && !excludeVaultDead(a),
  );

  // Hard refusal for rotation *destination*: max(5h,7d) must stay below this.
  // Default 95 (matches the hard exhaustion threshold). Lower with
  // rateLimits.destinationMaxUtilPercent (e.g. 90) if 90% 5h still feels empty in practice.
  const UTIL_HARD_BLOCK = destinationUtilHardBlock(config);

  for (const pool of [refreshableNormal, refreshableLow, manualReauthNormal, manualReauthLow, euNormal, euLow]) {
    const fresh = pool.filter((a) => !isExhausted(a));
    const exhausted = pool.filter((a) => isExhausted(a));

    for (const candidates of [fresh, exhausted]) {
      // Per-account destination cap: an account may set `maxUtilPercent` in config to be
      // refused as a rotation target at a STRICTER threshold than the global UTIL_HARD_BLOCK.
      // min() ensures it can only tighten, never loosen, the global hard block.
      // An account may set maxUtilPercent to cap it stricter than the global block (e.g. ≥50%).
      const capFor = (a) => Math.min(UTIL_HARD_BLOCK, a.maxUtilPercent ?? Infinity);
      const viable = candidates.filter((a) => score(a) < capFor(a));
      // Primary key: utilization score (freshest first). Tie-breaker: when two
      // accounts are within TIE_EPSILON percentage points of each other, prefer
      // the least-recently-active (LRU) one. Without this, a pool of equally-low
      // accounts (e.g. two tied at 3% 7d) ping-pongs forever — the active one is
      // excluded, so the other is always "the minimum", and repeated /rotate just
      // swaps the same pair. LRU spreads load across the whole low-util pool.
      const TIE_EPSILON = 5;
      const lastActiveMs = (a) => {
        const la = state.accounts?.[accountKey(a)]?.lastActive;
        const t = la ? new Date(la).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
      };
      const sorted = [...viable].sort((a, b) => {
        const d = score(a) - score(b);
        if (Math.abs(d) >= TIE_EPSILON) return d;
        // Within the tie band: oldest lastActive (smallest ms) wins.
        return lastActiveMs(a) - lastActiveMs(b);
      });

      if (sorted.length > 0) {
        const best = sorted[0];
        const u5 = getUtil5h(best);
        const u7 = getUtil7d(best);
        const src = liveUtil[accountKey(best)]
          ? 'live'
          : state.accounts[accountKey(best)]?.lastUtilization
            ? 'cached'
            : 'unknown';
        const reauthNote = best.autoAuthDisabled === true ? ', manual-reauth fallback' : '';
        if (blockExtra(best)) {
          log(
            `⚠  LAST-RESORT: only viable target ${accountKey(best)} has extra_usage ON — rotating to it may incur paid overage (every non-overage account is exhausted/excluded). Disable extra_usage in the console to avoid this.`,
          );
        }
        log(`Picked ${accountKey(best)} 5h=${u5 ?? '?'}% 7d=${u7 ?? '?'}% [${src}${reauthNote}]`);
        return best;
      }
    }
  }
  // Already on the only account with API headroom (non-active pool is empty of viable targets).
  if (activeKey && currentActiveIsOnlyViableTarget(config, state, liveUtil)) {
    const aa = config.accounts.find((a) => accountKey(a) === activeKey);
    const u5 = aa ? getUtil5h(aa) : null;
    const u7 = aa ? getUtil7d(aa) : null;
    log(
      `Only viable Max account is already active (${activeKey}, 5h=${u5 ?? '?'}% 7d=${u7 ?? '?'}%) — no rotation target (others exceed ${UTIL_HARD_BLOCK}% max(5h,7d) destination cap or tool-window exhausted).`,
    );
    return null;
  }
  // All non-active candidates exceed UTIL_HARD_BLOCK. Refuse to pick and
  // remain fail-closed on CRS instead of switching to a metered provider.
  log(
    `All non-active candidates score ≥${UTIL_HARD_BLOCK}% max(5h,7d) (or pool empty) — refusing to pick; CRS remains fail-closed`,
  );
  return null;
}

// ── Smart recommend / CRS fail-closed ────────────────────────────────────────
// "Will immediately say token-limit-reached" guard. Anything at/above this
// 5h or 7d util is refused as a rotation target.
const EXHAUSTED_THRESHOLD = 95;

/** True when every non-active account with complete live util is at/above destination cap (no swap target). */
function allNonActiveLiveConfirmedOverDestinationCap(config, state, liveUtil) {
  const destCap = destinationUtilHardBlock(config);
  const activeKey = state.activeAccount;
  const others = config.accounts.filter((a) => a.disabled !== true && accountKey(a) !== activeKey);
  if (others.length === 0) return false;
  let nConfirmed = 0;
  for (const a of others) {
    const u = liveUtil[accountKey(a)];
    if (!u || u.five_hour_pct == null || u.seven_day_pct == null) continue;
    nConfirmed++;
    if (Math.max(u.five_hour_pct, u.seven_day_pct) < destCap) return false;
  }
  return nConfirmed > 0;
}

// Returns { pick, allExhausted, allHaveLive, onlyActiveViable, destinationCapStuck } using LIVE util only.
// allExhausted is true ONLY when every viable candidate has live data AND
// max(5h,7d) >= EXHAUSTED_THRESHOLD. Policy: never assume exhaustion
// from cached / unknown data — exhaustion must be live-confirmed.
function recommendAccount(config, state, liveUtil) {
  const candidates = config.accounts.filter((a) => a.disabled !== true);
  const pick = pickNextAccount(config, state, liveUtil);
  const onlyActiveViable = !pick && currentActiveIsOnlyViableTarget(config, state, liveUtil);
  const allHaveLive =
    candidates.length > 0 &&
    candidates.every((a) => {
      const u = liveUtil[accountKey(a)];
      return u && u.five_hour_pct != null && u.seven_day_pct != null;
    });
  const allExhausted =
    !onlyActiveViable &&
    allHaveLive &&
    candidates.every((a) => {
      const u = liveUtil[accountKey(a)];
      return Math.max(u.five_hour_pct, u.seven_day_pct) >= EXHAUSTED_THRESHOLD;
    });
  const destinationCapStuck =
    !pick && !onlyActiveViable && !allExhausted && allNonActiveLiveConfirmedOverDestinationCap(config, state, liveUtil);
  return { pick, allExhausted, allHaveLive, onlyActiveViable, destinationCapStuck };
}

// Metered cloud-provider fallback is prohibited. Rotation remains CRS-only
// and fails closed when no OAuth account is schedulable.

// ── Keychain ─────────────────────────────────────────────────────────────────

// Linux fallback: ~/.claude/.credentials.json keyed by service name
const LINUX_CRED_PATH = join(process.env.HOME || '', '.claude', '.credentials.json');
const IS_LINUX = process.platform === 'linux';

function _linuxReadCred(svc) {
  try {
    const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
    const val = store[svc];
    if (!val) throw new Error(`No entry for ${svc}`);
    return typeof val === 'string' ? val : JSON.stringify(val);
  } catch (e) {
    throw new Error(`No Linux cred entry ${svc}: ${e.message}`);
  }
}

function _linuxWriteCred(svc, json) {
  let store = {};
  try {
    store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
  } catch {}
  if (svc === KEYCHAIN_SERVICE) {
    // Main slot: merge claudeAiOauth only, preserve mcpOAuth
    try {
      const incoming = JSON.parse(json);
      store.claudeAiOauth = incoming.claudeAiOauth || incoming;
    } catch {
      store[svc] = json;
    }
  } else {
    // Per-account vault slot
    try {
      store[svc] = JSON.parse(json);
    } catch {
      store[svc] = json;
    }
  }
  writeFileSync(LINUX_CRED_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function readKeychain(
  svc = KEYCHAIN_SERVICE,
  acct = svc === KEYCHAIN_SERVICE ? ACTIVE_KEYCHAIN_ACCOUNT : VAULT_KEYCHAIN_ACCOUNT,
) {
  // Claude Code >=2.1 writes the active OAuth slot to this file on both macOS
  // and Linux. Prefer it for the active service so a completed `claude auth
  // login` cannot be shadowed by a stale legacy macOS keychain item.
  if (svc === KEYCHAIN_SERVICE) {
    try {
      if (existsSync(LINUX_CRED_PATH)) {
        const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
        if (store.claudeAiOauth) {
          return JSON.stringify({ claudeAiOauth: store.claudeAiOauth, mcpOAuth: store.mcpOAuth || {} });
        }
      }
    } catch (e) {
      log(`[readKeychain] read active credentials file failed: ${e.message}`);
    }
  }
  if (IS_LINUX) {
    if (svc === KEYCHAIN_SERVICE) throw new Error(`No Linux cred entry ${svc}`);
    return _linuxReadCred(svc);
  }

  // macOS path: try keychain first
  try {
    const result = spawnSync('security', ['find-generic-password', '-s', svc, '-a', acct, '-g'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const out = (result.stdout || '') + (result.stderr || '');
    const m = out.match(/^password: "?(.*?)"?$/m);
    if (m) {
      return m[1].replace(/\\"/g, '"');
    }
    throw new Error('No password match in output');
  } catch (keychainErr) {
    // If keychain lookup fails, and it is the active slot, try reading from the file
    if (svc === KEYCHAIN_SERVICE) {
      try {
        if (existsSync(LINUX_CRED_PATH)) {
          const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
          if (store.claudeAiOauth) {
            return JSON.stringify({ claudeAiOauth: store.claudeAiOauth, mcpOAuth: store.mcpOAuth || {} });
          }
        }
      } catch (fileErr) {
        log(`[readKeychain] read active credentials file fallback failed: ${fileErr.message}`);
      }
    }
    throw new Error(`No keychain entry ${svc}/${acct} and file fallback failed: ${keychainErr.message}`);
  }
}

function writeKeychain(
  json,
  svc = KEYCHAIN_SERVICE,
  acct = svc === KEYCHAIN_SERVICE ? ACTIVE_KEYCHAIN_ACCOUNT : VAULT_KEYCHAIN_ACCOUNT,
) {
  if (IS_LINUX) {
    _linuxWriteCred(svc, json);
    return;
  }
  try {
    execFileSync('security', ['add-generic-password', '-U', '-s', svc, '-a', acct, '-w', json], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || error)
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/-w\s+\{.*$/s, '-w [REDACTED]')
      .slice(0, 240);
    throw new Error(`Keychain update failed for ${svc}/${acct}: ${detail}`);
  }
  // macOS: Claude Code ≥2.1 reads the ACTIVE credential from
  // ~/.claude/.credentials.json (file), NOT the keychain. Mirror the active slot
  // to the file so new/restarted sessions pick up the rotated account. Without
  // this, keychain swaps are invisible to claude and every new session stays
  // pinned to the file's stale account. (root-caused 2026-06-12) Keychain write
  // above is retained for legacy/compat. _linuxWriteCred preserves mcpOAuth.
  if (svc === KEYCHAIN_SERVICE) {
    try {
      _linuxWriteCred(svc, json);
    } catch {}
  }
}

function tokenExpired(json) {
  try {
    const exp = JSON.parse(json)?.claudeAiOauth?.expiresAt;
    if (!exp) return false;
    // Match daemon.mjs: treat as expired within 5 minutes of expiry
    return Date.now() > exp - 5 * 60_000;
  } catch {
    return false;
  }
}

// ── Token vault (local keychain entries per account) ─────────────────────────

const TOKEN_PREFIX = 'Claude-Rotation';

function tokenService(account) {
  return `${TOKEN_PREFIX}-${accountKey(account)}`;
}

function readStoredToken(account) {
  try {
    return readRotationToken(accountKey(account));
  } catch {
    return null;
  }
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

function syncCrsAll() {
  if (process.env.CLAUDE_ROTATION_SKIP_CRS_SYNC === '1') {
    console.log('[crs-sync] skipped (CLAUDE_ROTATION_SKIP_CRS_SYNC=1)');
    return;
  }
  console.log('[crs-sync] pushing all vault tokens to CRS...');
  execFileSync(process.execPath, [join(__dirname, 'sync-crs-account.mjs'), '--all'], {
    stdio: 'inherit',
    timeout: 180_000,
  });
}

function deleteStoredToken(account) {
  const svc = tokenService(account);
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

function hasStoredToken(account) {
  try {
    readKeychain(tokenService(account));
    return true;
  } catch {
    return false;
  }
}

// ── OAuth snapshots (chrome-bridge sync) ─────────────────────────────────────
//
// `~/.claude.json` carries an `oauthAccount` block + `chromeExtension` pairing
// block that Claude Code uses to identify "who am I?" to the browser-extension
// bridge. The bridge refuses to connect when claude.ai (in the paired Chrome
// profile) is logged in as account A but Claude Code's oauthAccount says B.
//
// `swapToken()` only rotates the macOS keychain entry — it does NOT touch
// `.claude.json`, so terminal rotation leaves the chrome-bridge auth stale.
// Snapshots capture each account's `oauthAccount` + `chromeExtension` blocks
// (one file per accountKey under `oauth-snapshots/`) so `--pin-browser` can
// atomically swap both keychain AND `.claude.json` blocks before the extension
// retries its handshake.

function ensureSnapshotsDir() {
  try {
    mkdirSync(OAUTH_SNAPSHOTS_DIR, { recursive: true });
  } catch {}
}

function snapshotPathFor(key) {
  // Sanitize for filesystem: replace any path-hostile chars
  const safe = String(key).replace(/[/\\\0]/g, '_');
  return join(OAUTH_SNAPSHOTS_DIR, `${safe}.json`);
}

// Per-account Chrome profile name. One profile per account keeps each account
// signed into claude.ai independently and lets each profile own its own
// extension pairing (pairedDeviceId). Pin-browser swaps `.claude.json`
// chromeExtension to the snapshot's deviceId; only the matching profile's
// extension service worker will then authenticate against the CLI bridge.
function chromeProfileDirFor(accountKey) {
  // Chrome profile dir names tolerate most chars but we keep them shell-clean.
  const safe = String(accountKey)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `ClaudeCode-${safe || 'unknown'}`;
}

function isChromeProfileRunning(profileDir) {
  // Exact dir match — `profile-directory=ClaudeCode` must NOT match the longer
  // `profile-directory=ClaudeCode-support-example.com`. Chrome appends the dir
  // name and then a space (next CLI flag) or EOL. We parse the pgrep output
  // and check the full arg.
  try {
    const out = spawnSync('pgrep', ['-fl', `profile-directory=${profileDir}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const lines = (out.stdout || '').split('\n').filter(Boolean);
    const needle = `profile-directory=${profileDir}`;
    return lines.some((line) => {
      const idx = line.indexOf(needle);
      if (idx < 0) return false;
      const tail = line.charAt(idx + needle.length);
      // Match only when the next char is whitespace, end-of-string, or a
      // shell-quote — not when it's part of a longer profile name.
      return tail === '' || tail === ' ' || tail === '\t' || tail === '"' || tail === "'";
    });
  } catch {
    return false;
  }
}

const CHROME_PROFILES_BASE =
  process.platform === 'linux'
    ? join(process.env.HOME || '', '.config', 'google-chrome')
    : join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');

function chromeProfilePath(profileDir) {
  return join(CHROME_PROFILES_BASE, profileDir);
}

function isChromeProfileBootstrapped(profileDir) {
  return existsSync(chromeProfilePath(profileDir));
}

// Clone an existing Chrome profile dir (extension + cookies + bookmarks
// preserved). Caller is responsible for ensuring Chrome isn't running against
// the source profile at clone time — otherwise leveldb/Network state may be
// captured mid-write and corrupt the destination.
function cloneChromeProfile(srcProfileDir, dstProfileDir) {
  const src = chromeProfilePath(srcProfileDir);
  const dst = chromeProfilePath(dstProfileDir);
  if (!existsSync(src)) {
    log(`[chrome-profile] clone source missing: ${src}`);
    return { ok: false, reason: 'src-missing' };
  }
  if (existsSync(dst)) {
    return { ok: true, reason: 'already-exists' };
  }
  // Refuse to clone while the source profile is in use — leveldb corruption.
  if (isChromeProfileRunning(srcProfileDir)) {
    return { ok: false, reason: 'src-running' };
  }
  const cp = spawnSync('cp', ['-R', src, dst], { timeout: 120_000 });
  if (cp.status !== 0) {
    log(`[chrome-profile] cp -R failed (exit ${cp.status}): ${(cp.stderr || '').toString().slice(0, 200)}`);
    return { ok: false, reason: 'cp-failed' };
  }
  return { ok: existsSync(dst), reason: 'cloned' };
}

const CHROME_LOCAL_STATE_PATH = join(CHROME_PROFILES_BASE, 'Local State');

// Hand-picked, visually distinct Chrome theme colors. The numeric form is
// Chrome's signed-int packed sRGB used in `profile.info_cache.<dir>.profile_highlight_color`.
// Hex shown for human-readability; converted via colorIntFromHex().
const PROFILE_COLOR_PALETTE = [
  { name: 'Cyan', hex: '#00ACC1' },
  { name: 'Indigo', hex: '#3949AB' },
  { name: 'Pink', hex: '#D81B60' },
  { name: 'Green', hex: '#43A047' },
  { name: 'Orange', hex: '#F4511E' },
  { name: 'Purple', hex: '#8E24AA' },
  { name: 'Teal', hex: '#00897B' },
  { name: 'Red', hex: '#E53935' },
  { name: 'Blue', hex: '#1E88E5' },
];

function colorIntFromHex(hex) {
  const h = hex.replace('#', '');
  // Chrome stores as 0xFF<R><G><B> (alpha=255), then interprets via int32 signed.
  const argb = 0xff000000 | parseInt(h, 16);
  // Convert to signed int32 the way Chrome serializes it
  return argb | 0;
}

function readChromeLocalState() {
  if (!existsSync(CHROME_LOCAL_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CHROME_LOCAL_STATE_PATH, 'utf8'));
  } catch (e) {
    log(`[chrome-localstate] parse failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

function writeChromeLocalStateAtomic(obj) {
  const tmp = `${CHROME_LOCAL_STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, CHROME_LOCAL_STATE_PATH);
}

// Human-friendly display name from an accountKey. Best-effort:
//   `support@example.ai`            → `Example Support`
//   `info@myorg.nl`                 → `Myorg`
//   `team-label`                    → `Team-Label`
//   `user@example.foundation`       → `Example Foundation`
function displayNameFor(account) {
  const key = accountKey(account);
  if (account.displayName) return account.displayName;
  if (!key.includes('@')) {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  const [local, domain] = key.split('@');
  const domainParts = (domain || '').split('.');
  // For user@example.com → "Example"
  // For info@myorg.nl → "Myorg"
  // For support@example.ai → "Example Support"
  const orgRaw = domainParts[0] || '';
  // CamelCase split of org: "acmecorp" → "Acme Corp"
  const org = orgRaw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(^|\s)\S/g, (s) => s.toUpperCase());
  // For info@/support@/sales@ etc., prefix the local part as a role suffix
  const roleLocals = new Set(['info', 'support', 'sales', 'hello', 'team', 'admin', 'help']);
  if (roleLocals.has(local.toLowerCase())) {
    return `${org} ${local.charAt(0).toUpperCase() + local.slice(1)}`;
  }
  // For personal mailboxes (firstname@…), use Org only if org is meaningful, else email local
  return org || local.charAt(0).toUpperCase() + local.slice(1);
}

function launchChromeProfile(profileDir, url) {
  // Use macOS `open -na` to launch a fresh Chrome instance bound to the named
  // profile. Multiple Chrome instances on different profile-directories
  // coexist; each gets its own extension service-worker scope.
  try {
    const args = [
      '-na',
      'Google Chrome',
      '--args',
      `--profile-directory=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (url) args.push(url);
    spawnSync('open', args, { timeout: 8000 });
    return true;
  } catch (e) {
    log(`[chrome-profile] launch failed for ${profileDir}: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

function readClaudeJson() {
  if (!existsSync(CLAUDE_JSON_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf8'));
  } catch (e) {
    log(`[oauth-snapshot] failed to parse ~/.claude.json: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

function writeClaudeJsonAtomic(obj) {
  const tmp = `${CLAUDE_JSON_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    renameSync(tmp, CLAUDE_JSON_PATH);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function extractOauthBlocks(claudeJson) {
  if (!claudeJson) return null;
  return {
    oauthAccount: claudeJson.oauthAccount || null,
    chromeExtension: claudeJson.chromeExtension || null,
  };
}

function captureOauthSnapshot(accountEmail) {
  ensureSnapshotsDir();
  const cj = readClaudeJson();
  if (!cj) {
    log(`[oauth-snapshot] cannot capture: ~/.claude.json missing/unreadable`);
    return false;
  }
  const blocks = extractOauthBlocks(cj);
  if (!blocks?.oauthAccount?.emailAddress) {
    log(`[oauth-snapshot] cannot capture: no oauthAccount.emailAddress in ~/.claude.json`);
    return false;
  }
  const currentEmail = blocks.oauthAccount.emailAddress.toLowerCase();
  const wantedEmail = (accountEmail || '').toLowerCase();
  if (wantedEmail && currentEmail !== wantedEmail) {
    log(
      `[oauth-snapshot] refuse capture: ~/.claude.json oauthAccount=${currentEmail} but caller asked to capture for ${wantedEmail}. Restart Claude Code while CLI keychain is on ${wantedEmail} to refresh oauthAccount, then re-run --capture-oauth-snapshot.`,
    );
    return false;
  }
  // Always key the snapshot file by the .claude.json email — that's the truth.
  const cfg = readConfig();
  const matched = cfg.accounts.find((a) => (a.email || '').toLowerCase() === currentEmail);
  const key = matched ? accountKey(matched) : currentEmail;
  const out = snapshotPathFor(key);
  const payload = {
    capturedAt: new Date().toISOString(),
    accountKey: key,
    email: currentEmail,
    chromeProfileDir: chromeProfileDirFor(key),
    blocks,
  };
  writeFileSync(out, JSON.stringify(payload, null, 2));
  log(`[oauth-snapshot] captured ${key} → ${out}`);
  return true;
}

function loadOauthSnapshot(accountKeyOrEmail) {
  const direct = snapshotPathFor(accountKeyOrEmail);
  if (existsSync(direct)) {
    try {
      return JSON.parse(readFileSync(direct, 'utf8'));
    } catch {}
  }
  // Fallback: resolve via config (label↔email)
  const cfg = readConfig();
  const acct = cfg.accounts.find(
    (a) =>
      (a.email || '').toLowerCase() === String(accountKeyOrEmail).toLowerCase() ||
      (a.label || '').toLowerCase() === String(accountKeyOrEmail).toLowerCase(),
  );
  if (acct) {
    const alt = snapshotPathFor(accountKey(acct));
    if (existsSync(alt)) {
      try {
        return JSON.parse(readFileSync(alt, 'utf8'));
      } catch {}
    }
  }
  return null;
}

function applyOauthSnapshotToClaudeJson(snapshot) {
  if (!snapshot?.blocks) return false;
  const cj = readClaudeJson();
  if (!cj) return false;
  let changed = false;
  if (snapshot.blocks.oauthAccount) {
    cj.oauthAccount = snapshot.blocks.oauthAccount;
    changed = true;
  }
  if (snapshot.blocks.chromeExtension) {
    cj.chromeExtension = snapshot.blocks.chromeExtension;
    changed = true;
  }
  if (changed) writeClaudeJsonAtomic(cj);
  return changed;
}

function backupCurrentOauthBlocks() {
  const cj = readClaudeJson();
  if (!cj) return false;
  const blocks = extractOauthBlocks(cj);
  if (!blocks?.oauthAccount?.emailAddress) return false;
  const payload = {
    backedUpAt: new Date().toISOString(),
    email: blocks.oauthAccount.emailAddress,
    blocks,
  };
  writeFileSync(BROWSER_PIN_BACKUP_PATH, JSON.stringify(payload, null, 2));
  return true;
}

function restoreOauthBlocksFromBackup() {
  if (!existsSync(BROWSER_PIN_BACKUP_PATH)) return false;
  try {
    const backup = JSON.parse(readFileSync(BROWSER_PIN_BACKUP_PATH, 'utf8'));
    const applied = applyOauthSnapshotToClaudeJson({ blocks: backup.blocks });
    if (applied) log(`[oauth-snapshot] restored backup oauthAccount=${backup.email}`);
    try {
      unlinkSync(BROWSER_PIN_BACKUP_PATH);
    } catch {}
    return applied;
  } catch (e) {
    log(`[oauth-snapshot] backup restore failed: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// Fetches Google password AND (optional) TOTP secret from dcli by querying
// all google.com credentials and matching on email.
// Returns { password, otpSecret } or null.
function fetchGoogleCreds(account) {
  try {
    const json = execSync(`dcli password -o json google.com 2>/dev/null`, {
      timeout: 15_000,
    }).toString();
    const creds = JSON.parse(json);
    // Find credential whose email matches account.email
    const match = creds.find((c) => (c.email || '').toLowerCase() === account.email.toLowerCase());
    if (!match) return null;
    return {
      password: match.password || null,
      otpSecret: match.otpSecret || null,
      phone: match.phone || match.phoneNumber || null,
    };
  } catch {
    return null;
  }
}

// Legacy alias — returns only password for backwards compat with existing call sites
function fetchGooglePassword(account) {
  // Legacy path: honor explicit dashlaneGooglePath if set
  if (account.dashlaneGooglePath) {
    try {
      return execFileSync('dcli', ['read', account.dashlaneGooglePath], {
        timeout: 10_000,
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }
  // New path: query by email
  const creds = fetchGoogleCreds(account);
  return creds?.password || null;
}

// Generate a TOTP code from a base32 secret using the Node crypto module.
// Used when an account has 2FA and we have the secret in dcli.
function generateTOTP(base32Secret) {
  // Uses top-level ESM import: createHmac from "node:crypto"
  // Decode base32
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.replace(/\s/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const i = base32chars.indexOf(c);
    if (i === -1) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  // TOTP counter: 30-second intervals since epoch
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

// Read the latest SMS verification code from Messages.app for the Google 2FA number.
// Returns a 6-digit code string or null.
// Read latest SMS verification code from Messages.app.
// Modern iMessages store text in `attributedBody` (NSKeyedArchiver blob), not `text`.
// We hex-dump both and extract G-XXXXXX or a 6-digit code.
function readLatestSMSCode({ maxAgeSec = 300 } = {}) {
  try {
    const db = join(process.env.HOME || '', 'Library/Messages/chat.db');
    if (!existsSync(db)) return null;
    // Apple timestamp = seconds since 2001-01-01, stored as nanoseconds
    const cutoffAppleNs = (Math.floor(Date.now() / 1000) - 978307200 - maxAgeSec) * 1_000_000_000;
    const sql = `SELECT hex(attributedBody), text FROM message WHERE date > ${cutoffAppleNs} AND service IN ('SMS','iMessage') ORDER BY date DESC LIMIT 10;`;
    const rows = execFileSync('sqlite3', [db, sql], { timeout: 5000 }).toString().split('\n').filter(Boolean);
    for (const row of rows) {
      const [hex, text] = row.split('|');
      // Plain text column (older macOS)
      if (text) {
        const m = text.match(/G-(\d{6})/) || text.match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
      // attributedBody blob — decode as latin-1 and regex-match
      if (hex && hex.length > 20) {
        const decoded = Buffer.from(hex, 'hex').toString('latin1');
        const m = decoded.match(/G-(\d{6})/) || decoded.match(/(\d{6})\s+is your (?:Google )?verification code/);
        if (m) return m[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── PRIMARY: local keychain token swap ───────────────────────────────────────

// OAuth refresh_token grant — same client/endpoint as refresh-tokens.mjs.
// Critical on headless Linux: the browser-OAuth fallback can never complete
// there, so an expired vault token must be refreshable in-process or the
// rotation dies ("Cascade exhausted: All browser drivers failed").
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

async function refreshExpiredStoredToken(account, tokenJson) {
  const releaseRefreshLock = acquireRefreshLock(accountKey(account));
  if (!releaseRefreshLock) {
    log(`[refresh] ${accountKey(account)}: refresh lock held — another refresh path owns this account right now`);
    return null;
  }
  try {
    const parsed = JSON.parse(tokenJson);
    const o = parsed?.claudeAiOauth;
    if (!o?.refreshToken) return null;
    const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      log(
        `[refresh] ${accountKey(account)}: refresh_token grant failed — ${body?.error?.message || `HTTP ${res.status}`}`,
      );
      return null;
    }
    const updated = {
      claudeAiOauth: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || o.refreshToken,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 3_600_000,
        scopes: o.scopes || [],
        subscriptionType: body.subscription_type || o.subscriptionType,
        rateLimitTier: body.rate_limit_tier || o.rateLimitTier,
      },
      mcpOAuth: {},
    };
    const json = JSON.stringify(updated);
    writeStoredToken(account, json);
    syncStoredTokenToCrs(account);
    return json;
  } catch (e) {
    log(`[refresh] ${accountKey(account)}: refresh error — ${e.message?.slice(0, 100)}`);
    return null;
  } finally {
    releaseRefreshLock();
  }
}

async function swapToken(account) {
  let token = readStoredToken(account);
  if (!token) {
    log('[primary] No stored token — need browser fallback');
    return false;
  }
  // Keep-alive: always try refresh when under the 6h floor OR when --magic-link
  // was requested (caller wants a proven-good refresh_token, not a still-valid
  // access token with a dead refresh — that goes dark at access expiry).
  const magicLinkIntent = process.argv.includes('--magic-link') || process.env.CLAUDE_ROTATION_MAGIC_LINK_AUTO === '1';
  const nearExpiry = tokenExpired(token);
  if (nearExpiry || magicLinkIntent) {
    const refreshed = await refreshExpiredStoredToken(account, token);
    if (refreshed) {
      token = refreshed;
      log('[primary] Token renewed via refresh_token grant');
    } else if (nearExpiry || magicLinkIntent) {
      log(
        magicLinkIntent && !nearExpiry
          ? '[primary] refresh_token dead while access still live — need browser reauth (keep-alive)'
          : '[primary] Token expired and refresh failed — need browser fallback',
      );
      return false; // forces browserOAuthFallback in rotate()
    }
  }
  log(`[primary] Swapping active keychain for ${accountKey(account)}...`);

  // Save-back: preserve any silent OAuth refresh Claude Code performed mid-session
  // by writing the current main-slot token back to the source account's vault entry.
  try {
    const swapState = readState();
    const sourceKey = swapState.activeAccount;
    if (sourceKey && sourceKey !== accountKey(account)) {
      const swapConfig = readConfig();
      const sourceAccount = swapConfig.accounts.find((a) => accountKey(a) === sourceKey);
      if (sourceAccount) {
        const currentJson = (() => {
          try {
            return readKeychain(KEYCHAIN_SERVICE, ACTIVE_KEYCHAIN_ACCOUNT);
          } catch {
            return null;
          }
        })();
        if (currentJson?.includes('claudeAiOauth')) {
          try {
            const parsed = JSON.parse(currentJson);
            const clean = JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth, mcpOAuth: {} });
            writeKeychain(clean, tokenService(sourceAccount));
            log(`[save-back] preserved current token for ${sourceKey}`);
          } catch (e) {
            log(`[save-back] skipped: parse/write error — ${e.message?.slice(0, 80)}`);
          }
        } else {
          log(`[save-back] skipped: no claudeAiOauth in current main slot`);
        }
      } else {
        log(`[save-back] skipped: source account ${sourceKey} not found in config`);
      }
    } else if (!sourceKey) {
      log(`[save-back] skipped: no active account tracked in state`);
    }
  } catch (e) {
    log(`[save-back] skipped: ${e.message?.slice(0, 80)}`);
  }

  // Preserve mcpOAuth from current active token (giga, Amplitude, higgsfield etc.)
  // Always merge — even if current mcpOAuth appears empty it may be populated by CC
  // between writes; the guard Object.keys>0 caused silent wipes when a prior rotation
  // had already zeroed the field.
  try {
    const current = readKeychain();
    const currentParsed = JSON.parse(current);
    const newParsed = JSON.parse(token);
    if (currentParsed.mcpOAuth) {
      // Unconditional merge: keep all current mcpOAuth entries, only swap claudeAiOauth
      newParsed.mcpOAuth = { ...newParsed.mcpOAuth, ...currentParsed.mcpOAuth };
    }
    writeKeychain(JSON.stringify(newParsed));
    log('[primary] Wrote token (mcpOAuth merged from current session)');
    return true;
  } catch {}

  // Defensive fallback: catch path or falsy currentParsed.mcpOAuth lands here.
  // Re-attempt the merge once more before writing — without this, a transient
  // read/parse error wipes mcpOAuth and forces every MCP OAuth server to reauth.
  let outToken = token;
  try {
    const cur = readKeychain();
    const cp = JSON.parse(cur);
    if (cp.mcpOAuth && Object.keys(cp.mcpOAuth).length > 0) {
      const np = JSON.parse(token);
      np.mcpOAuth = { ...np.mcpOAuth, ...cp.mcpOAuth };
      outToken = JSON.stringify(np);
      log('[primary] mcpOAuth preserved via fallback merge');
    }
  } catch {}
  writeKeychain(outToken);
  return true;
}

// Save current active token back to the account's vault entry
// Strips mcpOAuth so vault tokens are clean (mcpOAuth merged at swap time)
function saveCurrentToken(account) {
  try {
    const token = readKeychain();
    if (token.includes('claudeAiOauth')) {
      // Store only claudeAiOauth, not mcpOAuth (that's session-specific)
      try {
        const parsed = JSON.parse(token);
        const clean = { claudeAiOauth: parsed.claudeAiOauth, mcpOAuth: {} };
        writeStoredToken(account, JSON.stringify(clean));
        syncStoredTokenToCrs(account);
      } catch {
        writeStoredToken(account, token);
        syncStoredTokenToCrs(account);
      }
      log(`Saved token to vault: ${tokenService(account)}`);
      return true;
    }
  } catch (e) {
    log(`Save token failed: ${e.message}`);
  }
  return false;
}

// ── Browser driver cascade ────────────────────────────────────────────────────

// Driver cascade — Playwright only by default.
// Kapture/Chrome-JXA/Manual are disabled because they may touch Comet (user's browser)
// or depend on whatever is frontmost. Set CLAUDE_ROTATION_ENABLE_FALLBACKS=1 to enable.
const _fallbacksEnabled = process.env.CLAUDE_ROTATION_ENABLE_FALLBACKS === '1';
const _scrapingBrowserFirst = process.env.CLAUDE_ROTATOR_SCRAPING_BROWSER === '1';
const DRIVER_CASCADE = [
  // Driver 0: remote headless cloud browser — tried first when enabled so the
  // flow never depends on a local macOS GUI session. Falls through to the local
  // Playwright driver if the connection or flow fails.
  ...(_scrapingBrowserFirst ? [['scraping-browser', makeScrapingBrowserDriver]] : []),
  ['playwright', makePlaywrightDriver], // CDP to Chrome/Chrome Beta with real profile
  ...(_fallbacksEnabled
    ? [
        ['kapture', makeKaptureDriver],
        ['chrome-jxa', makeChromeJXADriver],
        ['manual', makeManualDriver],
      ]
    : []),
];

async function getBrowserDriver(skip = new Set()) {
  for (const [name, factory] of DRIVER_CASCADE) {
    if (skip.has(name)) continue;
    try {
      const d = await factory();
      log(`Browser driver: ${name}`);
      d._driverName = name;
      return d;
    } catch (err) {
      log(`Driver [${name}] unavailable: ${err.message}`);
    }
  }
  throw new Error('All browser drivers failed');
}

// XPath 1.0 has no escape character for quotes inside a string literal —
// `str.replace(/'/g, "\\'")` produces a literal backslash followed by an
// unescaped quote, which still breaks the string. Standard workaround: switch
// delimiter if the string only contains one quote type, else build it with
// concat() split around the embedded single quotes.
function xpathLiteral(str) {
  const s = String(str);
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  const parts = s.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

// ─── Driver 1: Kapture MCP (WebSocket → real Chrome, all Google sessions) ────

async function makeKaptureDriver() {
  const { default: WebSocket } = await import('ws');

  // Auto-start Kapture server if not running
  let ws;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket('ws://localhost:61822/mcp');
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error('timeout'));
        }, 4000);
        socket.once('open', () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      break;
    } catch {
      if (attempt === 0) {
        log('Kapture not running — starting server...');
        spawn('npx', ['kapture-mcp'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        await sleep(3000);
      }
    }
  }
  if (!ws) throw new Error('Kapture unavailable');

  // JSON-RPC over WebSocket
  let msgId = 0;
  const pending = new Map();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    } catch {}
  });

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30_000);
      const origResolve = pending.get(id)?.resolve;
      if (origResolve) {
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(t);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
      }
    });
  }

  function tool(name, args = {}) {
    return rpc('tools/call', { name, arguments: args });
  }

  // MCP handshake
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-rotation', version: '1.0' },
  });
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
  );

  // Get existing tab or open new one
  let tabId;
  try {
    const tabsResult = await tool('list_tabs', {});
    const text = extractText(tabsResult);
    log(`Kapture tabs: ${text.substring(0, 200)}`);
    // Parse first tab ID from format: "Tab ID: abc123" or "id: abc123" or "(abc123)"
    const m =
      text.match(/[Tt]ab\s+[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)/) ||
      text.match(/\bid[:\s]+([a-zA-Z0-9_-]+)/) ||
      text.match(/\(([a-zA-Z0-9_-]{6,})\)/);
    tabId = m?.[1];
  } catch {}

  if (!tabId) {
    // Open new tab
    const result = await tool('new_tab', { browser: 'chrome' });
    const text = extractText(result);
    const m = text.match(/[Tt]ab\s+[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)/) || text.match(/([a-zA-Z0-9_-]{8,})/);
    tabId = m?.[1] || 'tab1';
    await sleep(2000);
  }

  log(`Kapture using tab: ${tabId}`);

  return {
    name: 'kapture',
    _tabId: tabId,
    async goto(url) {
      await tool('navigate', { tabId, url, timeout: 30_000 });
      await sleep(2500);
    },
    async currentUrl() {
      try {
        const r = await tool('tab_detail', { tabId });
        const text = extractText(r);
        const m = text.match(/[Uu][Rr][Ll][:\s]+(\S+)/) || text.match(/https?:\/\/[^\s"',]+/);
        return m?.[1] || m?.[0] || '';
      } catch {
        return '';
      }
    },
    async findAndClick(texts) {
      for (const t of texts) {
        // CSS selector? Try that first — most reliable.
        const isCss = /^[[#.]/.test(t) || t.includes('data-testid') || t.includes('[type=');
        if (isCss) {
          try {
            await tool('click', { tabId, selector: t });
            log(`[kapture] clicked via CSS: ${t}`);
            return true;
          } catch {}
          continue;
        }
        const clean = t
          .replace(/button:has-text\("?([^"]+)"?\)/g, '$1')
          .replace(/"/g, '')
          .trim();
        const lit = xpathLiteral(clean);
        const xpaths = [
          `//button[.//*[contains(normalize-space(.),${lit})] or contains(normalize-space(.),${lit})]`,
          `//a[.//*[contains(normalize-space(.),${lit})] or contains(normalize-space(.),${lit})]`,
          `//*[@role='button' and (.//*[contains(normalize-space(.),${lit})] or contains(normalize-space(.),${lit}))]`,
          `//*[@aria-label=${lit} or contains(@aria-label,${lit})]`,
          `//*[normalize-space(text())=${lit}]`,
          `//*[contains(normalize-space(text()),${lit})]`,
          `//*[@data-identifier=${lit}]`,
          `//*[@placeholder=${lit}]`,
        ];
        for (const xpath of xpaths) {
          try {
            await tool('click', { tabId, xpath });
            log(`[kapture] clicked via xpath: ${xpath.substring(0, 80)}`);
            return true;
          } catch {}
        }
      }
      return false;
    },
    async fillInput(sel, val) {
      if (!val) return false;
      try {
        await tool('fill', { tabId, selector: sel, value: val });
        return true;
      } catch {}
      // XPath fallback
      try {
        const xpath = `//*[self::input or self::textarea][@type='${sel.includes('password') ? 'password' : 'email'}']`;
        await tool('fill', { tabId, xpath, value: val });
        return true;
      } catch {
        return false;
      }
    },
    async screenshot(path) {
      try {
        const r = await tool('screenshot', {
          tabId,
          format: 'png',
          scale: 0.5,
        });
        const content = r?.content?.[0];
        if (content?.type === 'image' && content.data) {
          writeFileSync(path, Buffer.from(content.data, 'base64'));
        }
      } catch {}
    },
    async readPageText() {
      try {
        const r = await tool('dom', { tabId });
        return extractText(r);
      } catch {
        return '';
      }
    },
    // Poll list_tabs for a new tab that appears after a Google OAuth click.
    // Returns a new driver bound to the popup's tab ID.
    async waitForPopup(timeoutMs = 15_000) {
      // Snapshot current tabs
      const snapshotTabs = async () => {
        try {
          const r = await tool('list_tabs', {});
          const text = extractText(r);
          // Parse all tab IDs from the response
          const ids = [];
          const re = /[Tt]ab\s+[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)|\(([a-zA-Z0-9_-]{6,})\)|"id"\s*:\s*"([a-zA-Z0-9_-]+)"/g;
          let m;
          while ((m = re.exec(text)) !== null) {
            const id = m[1] || m[2] || m[3];
            if (id) ids.push(id);
          }
          return new Set(ids);
        } catch {
          return new Set();
        }
      };

      const before = await snapshotTabs();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(1000);
        const after = await snapshotTabs();
        const newTabs = [...after].filter((id) => !before.has(id) && id !== tabId);
        if (newTabs.length > 0) {
          const popupTabId = newTabs[0];
          log(`Popup detected, switching to tab: ${popupTabId}`);
          // Return a minimal driver bound to the popup tab
          return {
            name: 'kapture-popup',
            _tabId: popupTabId,
            async goto(url) {
              await tool('navigate', {
                tabId: popupTabId,
                url,
                timeout: 30_000,
              });
              await sleep(2500);
            },
            async currentUrl() {
              try {
                const r = await tool('tab_detail', { tabId: popupTabId });
                const text = extractText(r);
                const m = text.match(/[Uu][Rr][Ll][:\s]+(\S+)/) || text.match(/https?:\/\/[^\s"',]+/);
                return m?.[1] || m?.[0] || '';
              } catch {
                return '';
              }
            },
            async findAndClick(texts) {
              for (const t of texts) {
                const clean = t
                  .replace(/button:has-text\("?([^"]+)"?\)/g, '$1')
                  .replace(/"/g, '')
                  .trim();
                const xpaths = [
                  `//*[normalize-space(text())='${clean}']`,
                  `//*[contains(normalize-space(text()),'${clean}')]`,
                  `//*[@data-identifier='${clean}']`,
                  `//*[@placeholder='${clean}']`,
                ];
                for (const xpath of xpaths) {
                  try {
                    await tool('click', { tabId: popupTabId, xpath });
                    return true;
                  } catch {}
                }
              }
              return false;
            },
            async fillInput(sel, val) {
              if (!val) return false;
              try {
                await tool('fill', {
                  tabId: popupTabId,
                  selector: sel,
                  value: val,
                });
                return true;
              } catch {}
              return false;
            },
            async waitForEvent() {
              return null;
            },
            async close() {},
          };
        }
      }
      log('No popup appeared within timeout');
      return null;
    },
    async close() {
      ws.close();
    },
  };
}

// Helper: extract text from MCP tool result
function extractText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const content = result.content || result;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.data || '').join('\n');
  }
  return JSON.stringify(result);
}

// ─── Driver 2: Playwright (CDP → Chrome Beta → bundled Chromium) ────────────
// Tiered strategy — never touches the operator's daily Chrome / Comet profile:
//   1. If CDP is already up on :9222 → attach directly
//   2. Else: spawn Chrome Beta (REAL_BROWSERS) with an ISOLATED automation
//      profile (.chrome-beta-automation) and CDP enabled
//   3. Fallback: Playwright's bundled Chromium via launchPersistentContext on
//      its own ISOLATED profile (.chromium-automation). Used when no Chrome
//      Beta binary is found, or its launch fails.

// Chrome Beta ONLY — dedicated automation browser.
// Uses an ISOLATED profile (not linked to Chrome Beta's default). Starts empty;
// rotation logs into Google accounts from scratch using dcli passwords + TOTP.
// Comet = user's browser (never touch). Chrome = user's browser (never touch).
const REAL_BROWSERS = [
  {
    name: 'Google Chrome Beta',
    bin: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    profile: join(__dirname, '.chrome-beta-automation'),
    appName: 'Google Chrome Beta',
  },
];

// Ensure an isolated automation profile directory exists.
// We use a FRESH profile with NO pre-logged accounts — rotation logs in from
// scratch using dcli credentials + TOTP/SMS each time. This is cleaner than
// trying to share Chrome's profile (cookie encryption is keychain-bound).
function ensureSymlinkedProfile(browser) {
  const auto = browser.profile;
  if (!existsSync(auto)) {
    execSync(`mkdir -p "${auto}"`, { timeout: 2000 });
  }
  // Persistent profile — it keeps cookies between runs so subsequent rotations
  // can reuse existing logins. First run per account: full login flow.
  // Subsequent runs: Google session cookies are still fresh, chooser shows
  // the accounts, we just click to select.
}
const CDP_PORT = 9222;

function findRealBrowser({ preferNotRunning = true } = {}) {
  const existing = REAL_BROWSERS.filter((b) => existsSync(b.bin));
  if (preferNotRunning) {
    // Prefer a browser that isn't currently running (avoid disrupting user's session)
    const notRunning = existing.find((b) => !isAppRunning(b.appName));
    if (notRunning) return notRunning;
  }
  return existing[0] || null;
}

async function tryConnectCDP(chromium) {
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    const contexts = browser.contexts();
    const ctx = contexts[0] || (await browser.newContext());
    const page = await ctx.newPage();
    log(`[playwright] Attached to running Chrome via CDP :${CDP_PORT} (fresh tab)`);
    return { browser, ctx, page };
  } catch {
    return null;
  }
}

function isAppRunning(appName) {
  try {
    execSync(`pgrep -f "${appName.replace(/ /g, '.')}" > /dev/null 2>&1`, {
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function gracefullyQuitApp(appName) {
  try {
    execSync(`osascript -e 'tell application "${appName}" to quit' 2>/dev/null`, { timeout: 8000 });
    // Wait up to 5s for it to actually quit
    for (let i = 0; i < 10; i++) {
      if (!isAppRunning(appName)) return true;
      execSync('sleep 0.5');
    }
  } catch {}
  return false;
}

// Flags that keep a hidden/occluded renderer running at full speed. Without
// these, macOS App Nap + Chrome's own backgrounding throttle the renderer once
// the window is hidden, which stalls the Cloudflare JS challenge. Applied to
// both the Chrome Beta spawn and the bundled-Chromium fallback so we can hide
// the window (below) while still passing Cloudflare with a real headed browser.
const NO_THROTTLE_FLAGS = [
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
];

// macOS: hide the automation browser so it doesn't pop up in the user's face.
// This is the Cmd-H equivalent (set visible=false) — the app keeps running
// headed (so Cloudflare still sees a real browser), it's just removed from
// view. No-op on Linux, where headed Chrome already runs inside Xvfb (see
// ensureVirtualDisplay) and is never visible to begin with.
function hideAutomationApp(appName) {
  if (process.platform !== 'darwin') return;
  try {
    execSync(
      `osascript -e 'tell application "System Events" to set visible of (every process whose name is "${appName}") to false' 2>/dev/null`,
      { timeout: 4000 },
    );
  } catch {}
}

// A single hide doesn't hold: Chrome re-grabs the foreground on launch and again
// on every OAuth navigation/redirect (we deliberately never call `activate`, but
// macOS still surfaces a fresh GUI app + Chrome raises its own window on nav). So
// we keep re-hiding on an interval for the life of the driver. Returns a stop()
// fn that the driver close-fn calls. No-op (returns a no-op stop) off macOS.
function startHideKeeper(appName) {
  if (process.platform !== 'darwin') return () => {};
  hideAutomationApp(appName); // immediate
  log(`[display] Hiding ${appName} (headed but off-view); re-hide keeper armed`);
  const timer = setInterval(() => hideAutomationApp(appName), 1200);
  // unref so this timer never keeps the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    try {
      clearInterval(timer);
    } catch {}
  };
}

// Belt-and-suspenders orphan cleanup. Chrome Beta is spawned detached + unref'd,
// so if rotate.mjs exits before the driver's close-fn runs (early-success return,
// throw, or a signal), the browser is reparented to launchd (PPID 1) and lingers
// as a visible orphaned window — exactly what the user sees pop up "every time".
// Track spawned automation profiles and pkill them on ANY process exit.
const _profilesToCleanup = new Set();
let _cleanupHandlersInstalled = false;
function registerProfileCleanup(profilePath) {
  if (!profilePath) return;
  _profilesToCleanup.add(profilePath);
  if (_cleanupHandlersInstalled) return;
  _cleanupHandlersInstalled = true;
  const killAll = () => {
    for (const p of _profilesToCleanup) {
      try {
        execFileSync('pkill', ['-f', p], { timeout: 4000 });
      } catch {}
    }
  };
  process.once('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      killAll();
      process.exit(1);
    });
  }
}
function unregisterProfileCleanup(profilePath) {
  _profilesToCleanup.delete(profilePath);
}

// Isolated profile dir for the bundled-Chromium fallback. Distinct from
// .chrome-beta-automation so the two tiers can coexist without stepping on each
// other's Cookies/LoginData files.
const CHROMIUM_FALLBACK_PROFILE = join(__dirname, '.chromium-automation');

// ─── Driver 0: Bright Data Scraping Browser (remote headless Chrome / WSS CDP) ─
// A cloud browser reached over CDP-in-WSS. Because it renders on Bright Data's
// infrastructure, it needs NO local macOS GUI/WindowServer session — it works
// off-Mac / on a locked screen where headed Chrome dies with CVDisplayLink
// -6670. Cloudflare sees a real (remote) browser, and Bright Data unblocks most
// challenges automatically. OAuth still works: the auth code is captured from
// CDP request/frame events and replayed to THIS machine's localhost callback
// via curl (see attachOAuthCallbackWatcher, isRemote path).
//
// Enable with CLAUDE_ROTATOR_SCRAPING_BROWSER=1. Provide either:
//   BRIGHT_DATA_BROWSER_WSS = full wss://…@host:port connection string, or
//   BRIGHT_DATA_CUSTOMER + BRIGHT_DATA_SCRAPING_ZONE + BRIGHT_DATA_SCRAPING_PASS
//   (endpoint built as wss://brd-customer-<c>-zone-<z>:<pass>@brd.superproxy.io:9222).
function buildScrapingBrowserEndpoint() {
  const direct = process.env.BRIGHT_DATA_BROWSER_WSS;
  if (direct && /^wss?:\/\//i.test(direct)) return direct.trim();
  const customer = process.env.BRIGHT_DATA_CUSTOMER;
  const zone = process.env.BRIGHT_DATA_SCRAPING_ZONE;
  const pass =
    process.env.BRIGHT_DATA_SCRAPING_PASS || process.env.BRIGHT_DATA_PASS || process.env.BRIGHT_DATA_PROXY_PASS;
  if (!customer || !zone || !pass) return null;
  const host = process.env.BRIGHT_DATA_PROXY_HOST || 'brd.superproxy.io';
  return `wss://brd-customer-${customer}-zone-${zone}:${pass}@${host}:9222`;
}

function scrapingBrowserEnabled() {
  return process.env.CLAUDE_ROTATOR_SCRAPING_BROWSER === '1';
}

async function makeScrapingBrowserDriver() {
  bootstrapRotatorSecrets(log);
  const endpoint = buildScrapingBrowserEndpoint();
  if (!endpoint) {
    throw new Error(
      'Bright Data Scraping Browser not configured (set BRIGHT_DATA_BROWSER_WSS or BRIGHT_DATA_CUSTOMER + BRIGHT_DATA_SCRAPING_ZONE + BRIGHT_DATA_SCRAPING_PASS)',
    );
  }
  const { chromium } = await import('playwright');
  log('[scraping-browser] connecting to Bright Data cloud browser (WSS CDP)...');
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 90_000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.setViewportSize?.({ width: 1280, height: 900 });
  } catch {}
  log('[scraping-browser] connected — remote browser ready (no local display needed)');
  const driver = buildPageDriver(
    'scraping-browser',
    page,
    async () => {
      try {
        await browser.close();
      } catch {}
    },
    ctx,
  );
  driver._remoteBrowser = true;
  return driver;
}

async function makePlaywrightDriver() {
  await ensureVirtualDisplay((m) => log(m));

  const { chromium } = await import('playwright');

  // Tier 1: attach to an already-running Chrome on CDP :9222 (cheapest).
  let attached = await tryConnectCDP(chromium);
  if (attached) {
    try {
      await attached.page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 });
    } catch {
      log('[playwright] CDP attach wedged — closing and respawning Chrome Beta');
      try {
        await attached.browser?.close();
      } catch {}
      attached = null;
    }
  }
  let weSpawnedChrome = false;
  let spawnedProfile = null;
  let stopHideKeeper = () => {};
  const fallbackBrowser = findRealBrowser();

  if (!attached) {
    // Tier 2: spawn Chrome Beta with CDP + isolated profile, if installed.
    const browser = fallbackBrowser;
    if (browser) {
      ensureSymlinkedProfile(browser);

      // Quit any running Chrome Beta holding the profile files
      // (the symlinked profile shares Cookies/LoginData files with the real one).
      if (isAppRunning(browser.appName)) {
        log(`[playwright] ${browser.name} running — quitting to release profile files...`);
        gracefullyQuitApp(browser.appName);
        await sleep(1500);
        try {
          execFileSync('pkill', ['-f', `${browser.appName}.app/Contents/MacOS`]);
        } catch {}
        await sleep(500);
      }

      // Launch headed (NOT headless — Cloudflare blocks headless Chrome), then
      // hide the window via System Events once CDP is up (see below). The app
      // keeps rendering full-speed thanks to NO_THROTTLE_FLAGS, so Cloudflare
      // still sees a real browser while it stays off the user's screen.
      log(`[playwright] Launching ${browser.name} headed (will hide) with CDP :${CDP_PORT}...`);
      spawn(
        browser.bin,
        [
          `--remote-debugging-port=${CDP_PORT}`,
          `--user-data-dir=${browser.profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-notifications',
          ...NO_THROTTLE_FLAGS,
          // Off-screen: headed so Cloudflare still sees a real browser, but
          // window is parked at -32000,-32000 so it never appears on-screen.
          // The startHideKeeper osascript interval provides belt-and-suspenders.
          // TODO: replace with Bright Data Scraping Browser (WSS CDP zone) once
          // provisioned — that removes the need for headed Chrome entirely.
          '--window-position=-32000,-32000',
          '--window-size=1280,800',
        ],
        { detached: true, stdio: 'ignore' },
      ).unref();
      weSpawnedChrome = true;
      spawnedProfile = browser.profile;
      // Arm the exit-time orphan killer the instant we spawn, so even an early
      // exit/throw before the close-fn can't leave a detached Chrome behind.
      registerProfileCleanup(browser.profile);

      // Poll CDP until it comes up
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        attached = await tryConnectCDP(chromium);
        if (attached) break;
      }
      if (attached) stopHideKeeper = startHideKeeper(browser.appName);
      if (!attached) {
        log(
          `[playwright] Chrome Beta CDP didn't come up on :${CDP_PORT} within 15s — falling back to Playwright launch`,
        );
        // The failed detached Chrome can still own the app singleton even
        // though CDP never became reachable. Stop only this isolated profile
        // before Playwright launches its separate fallback profile.
        try {
          execFileSync('pkill', ['-f', browser.profile], { timeout: 5000 });
        } catch {}
        unregisterProfileCleanup(browser.profile);
        weSpawnedChrome = false;
        spawnedProfile = null;
        await sleep(500);
      }
    } else {
      log('[playwright] No Chrome Beta / Chrome binary found — falling back to bundled Chromium');
    }
  }

  // Tier 3: Playwright launch. Installed Chrome on macOS cannot reliably use
  // launchPersistentContext when the app singleton was recently quit, so use
  // a normal isolated browser context there. Only bundled Chromium uses the
  // persistent-profile API.
  let bundledCtx = null;
  if (!attached) {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-notifications',
      '--no-first-run',
      '--no-default-browser-check',
      ...NO_THROTTLE_FLAGS,
      '--window-position=-32000,-32000',
      '--window-size=1280,800',
    ];
    if (fallbackBrowser?.bin) {
      log(`[playwright] Launching ${fallbackBrowser.name} with an isolated Playwright context headed (will hide)...`);
      const launchedBrowser = await chromium.launch({
        headless: false,
        executablePath: fallbackBrowser.bin,
        args,
      });
      const ctx = await launchedBrowser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      attached = { browser: launchedBrowser, ctx, page };
      stopHideKeeper = startHideKeeper(fallbackBrowser.appName);
      log(`[playwright] Attached to ${fallbackBrowser.name} isolated context`);
    } else {
      if (!existsSync(CHROMIUM_FALLBACK_PROFILE)) {
        execSync(`mkdir -p "${CHROMIUM_FALLBACK_PROFILE}"`, { timeout: 2000 });
      }
      log(
        `[playwright] Launching bundled Chromium (persistent profile: ${CHROMIUM_FALLBACK_PROFILE}) headed (will hide)...`,
      );
      bundledCtx = await chromium.launchPersistentContext(CHROMIUM_FALLBACK_PROFILE, {
        headless: false,
        args,
      });
      const page = bundledCtx.pages()[0] || (await bundledCtx.newPage());
      attached = { browser: null, ctx: bundledCtx, page };
      stopHideKeeper = startHideKeeper('Chromium');
      log('[playwright] Attached to bundled Chromium');
    }
  }

  const { browser: pwBrowser, ctx, page } = attached;
  return buildPageDriver(
    'playwright',
    page,
    async () => {
      stopHideKeeper();
      if (bundledCtx) {
        try {
          await bundledCtx.close();
        } catch {}
        return;
      }
      try {
        if (pwBrowser) await pwBrowser.close();
      } catch {}
      // Kill Chrome Beta if WE spawned it — don't leave zombie Chromes
      if (weSpawnedChrome && spawnedProfile) {
        try {
          execFileSync('pkill', ['-f', spawnedProfile], { timeout: 5000 });
        } catch {}
        unregisterProfileCleanup(spawnedProfile);
      }
    },
    ctx,
  );
}

// ─── Driver 3: Chrome JXA ────────────────────────────────────────────────────

async function makeChromeJXADriver() {
  const test = execSync(
    `osascript -l JavaScript -e '
    var chrome = Application("Google Chrome");
    "ok:" + chrome.windows[0].activeTab().url();
  '`,
    { timeout: 5000 },
  )
    .toString()
    .trim();
  if (!test.startsWith('ok:')) throw new Error('Chrome JXA test failed');

  // execFileSync (no shell) — the JXA source is passed as its own argv entry,
  // so nothing embedded in it (a page's button text, a stored credential) can
  // break out via shell metacharacters. JSON.stringify still safely embeds
  // arbitrary `js`/`url` content inside the JXA source's own string literal.
  function jxaJs(js) {
    const jxaSource = `
      var chrome = Application("Google Chrome");
      chrome.windows[0].activeTab().execute({javascript: ${JSON.stringify(js)}});
    `;
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', jxaSource], { timeout: 10_000 }).toString().trim();
  }

  return {
    name: 'chrome-jxa',
    async goto(url) {
      // Do NOT activate Chrome — focus-steal would interrupt the user's work.
      // URL assignment alone is enough to drive navigation via JXA.
      const jxaSource = `
        var c = Application("Google Chrome");
        c.windows[0].activeTab().url = ${JSON.stringify(url)};
      `;
      execFileSync('osascript', ['-l', 'JavaScript', '-e', jxaSource]);
      await sleep(3000);
    },
    async currentUrl() {
      const jxaSource = `
        Application("Google Chrome").windows[0].activeTab().url();
      `;
      return execFileSync('osascript', ['-l', 'JavaScript', '-e', jxaSource]).toString().trim();
    },
    async findAndClick(texts) {
      for (const t of texts) {
        const clean = t
          .replace(/button:has-text\("?([^"]+)"?\)/g, '$1')
          .replace(/"/g, '')
          .trim();
        try {
          const r = jxaJs(
            `(function(){var els=document.querySelectorAll('button,a,[role=button],input[type=submit]');` +
              `for(var e of els){if((e.textContent||e.value||'').trim().toLowerCase().includes('${clean.toLowerCase()}')){e.click();return'ok';}}return'miss';})()`,
          );
          if (r === 'ok') return true;
        } catch {}
      }
      return false;
    },
    async fillInput(sel, val) {
      if (!val) return false;
      try {
        // Both interpolate into single-quoted JS string literals in the
        // generated source. Escape backslashes BEFORE quotes — escaping only
        // the quote is incomplete: a value ending in "...\\'" would have its
        // pre-existing backslash combine with the escaped quote's own
        // backslash into `\\'`, which JS parses as one escaped backslash
        // followed by an unescaped, string-terminating quote.
        const jsStringEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const escSel = jsStringEscape(sel);
        const escVal = jsStringEscape(val);
        jxaJs(
          `(function(){var e=document.querySelector('${escSel}');if(e){e.value='${escVal}';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}})()`,
        );
        return true;
      } catch {
        return false;
      }
    },
    async screenshot(path) {
      try {
        execFileSync('screencapture', ['-x', path]);
      } catch {}
    },
    async waitForPopup() {
      return null;
    },
    async close() {},
  };
}

// ─── Driver 4: Manual ────────────────────────────────────────────────────────

async function makeManualDriver() {
  return {
    name: 'manual',
    async goto(url) {
      execSync(`open "${url}"`);
      notify('Account Rotation', 'Complete Google sign-in → click Allow');
    },
    async currentUrl() {
      return '';
    },
    async findAndClick() {
      return false;
    },
    async fillInput() {
      return false;
    },
    async screenshot() {},
    async waitForPopup() {
      return null;
    },
    async close() {},
  };
}

// ─── Playwright page → driver adapter ────────────────────────────────────────

function buildPageDriver(name, page, closeFn, ctx) {
  return {
    name,
    // Raw refs — exposed so the AI-brain fallback can screenshot / evaluate
    // against the same page the flow is driving.
    _page: page,
    _ctx: ctx,
    async goto(url) {
      const isOAuthNav = /claude\.(ai|com)|platform\.claude\.com|accounts\.google|localhost/i.test(url);
      const waitUntil = isOAuthNav ? 'commit' : 'domcontentloaded';
      const timeout = isOAuthNav ? 60_000 : 30_000;
      try {
        await page.goto(url, { waitUntil, timeout });
      } catch (navErr) {
        const cur = page.url();
        if (isOAuthNav && cur && cur !== 'about:blank' && !cur.startsWith('chrome-error')) {
          return;
        }
        throw navErr;
      }
      if (!isOAuthNav) {
        await page.waitForLoadState?.('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    },
    async currentUrl() {
      return page.url();
    },
    async findAndClick(texts) {
      for (const t of texts) {
        // If it looks like a CSS selector (starts with [, #, ., or contains data-testid), use directly
        const isCss = /^[[#.]/.test(t) || t.includes('data-testid') || t.includes('[type=');
        if (isCss) {
          try {
            const loc = page.locator(t).first();
            if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
              await loc.click({ timeout: 5000 });
              return true;
            }
          } catch {}
          continue;
        }
        // Otherwise treat as text — broad matcher covering buttons, links, list items,
        // and ARIA roles (Google 2FA pages use <li> for options, not <button>)
        const clean = t
          .replace(/button:has-text\("?([^"]+)"?\)/g, '$1')
          .replace(/"/g, '')
          .trim();
        try {
          // Try each element type individually so we don't get strict-mode violations
          const selectors = [
            `button:has-text("${clean}")`,
            `a:has-text("${clean}")`,
            `[role=button]:has-text("${clean}")`,
            `[role=link]:has-text("${clean}")`,
            `li:has-text("${clean}")`,
            `div[data-challengetype]:has-text("${clean}")`,
          ];
          for (const sel of selectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
              await loc.click({ timeout: 5000 });
              return true;
            }
          }
        } catch {}
      }
      return false;
    },
    async fillInput(sel, val) {
      if (!val) return false;
      try {
        if (page.fill) {
          // Short explicit timeout — Playwright's default is 30s, which
          // causes a single iteration to hang for 30-60s when the selector
          // doesn't exist on the current page (e.g. generic fallback on a
          // page that's really a 2FA challenge). 3s is plenty for a real
          // input; missing inputs should fail fast so the loop can move on.
          await page.fill(sel, val, { timeout: 3000 });
          return true;
        }
        await page.type(sel, val, { delay: 40, timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    },
    async screenshot(path) {
      try {
        await page.screenshot({ path });
      } catch {}
    },
    async readPageText() {
      try {
        return await page.evaluate(() => document.body?.innerText || '');
      } catch {
        return '';
      }
    },
    async waitForPopup(timeout = 10_000) {
      return ctx ? ctx.waitForEvent('page', { timeout }).catch(() => null) : null;
    },
    async close() {
      await closeFn();
    },
  };
}

// ── Magic link Gmail polling ─────────────────────────────────────────────────

/**
 * Poll Gmail via `gog` CLI for a Claude magic link email.
 * Returns the login URL from the email body, or null if not found within timeout.
 */
// Decode the target email embedded in a Claude magic-link URL.
// Format: https://claude.ai/magic-link#<hex>:<base64-email>
function magicLinkTargetEmail(url) {
  try {
    const parsed = new URL(url);
    for (const name of ['email', 'login_hint', 'recipient']) {
      const value = parsed.searchParams.get(name)?.trim().toLowerCase();
      if (value?.includes('@')) return value;
    }
    const hash = url.split('#')[1] || '';
    const b64 = hash.split(':')[1] || '';
    if (!b64) return null;
    return Buffer.from(b64, 'base64').toString('utf-8').trim().toLowerCase();
  } catch {
    return null;
  }
}

// Autonomous magic-link tuning (env-overridable). Defaults sized for unattended background re-auth.
const MAGIC_POLL_MS = Number(process.env.CLAUDE_ROT_MAGIC_POLL_MS || 180_000);
const MAGIC_POLL_INTERVAL_MS = Number(process.env.CLAUDE_ROT_MAGIC_POLL_INTERVAL_MS || 2_500);
const MAGIC_AUTHORIZE_WAIT_MS = Math.max(360_000, Number(process.env.CLAUDE_ROT_MAGIC_AUTHORIZE_WAIT_MS || 360_000));
const MAGIC_TOTAL_MS = Math.max(720_000, Number(process.env.CLAUDE_ROT_MAGIC_TOTAL_TIMEOUT_MS || 720_000));
const MAGIC_GMAIL_PHASE_MS = Number(process.env.CLAUDE_ROT_MAGIC_GMAIL_PHASE_MS || 60_000);
// After localhost callback, `claude auth login` can take >15s to write keychain
// (observed 2026-07-16: callback OK → token-unchanged false FAIL
// while keychain actually landed ~20–30s later and daemon drifted to it).
const MAGIC_FRESH_TOKEN_WAIT_MS = Number(process.env.CLAUDE_ROT_MAGIC_FRESH_TOKEN_WAIT_MS || 45_000);

function magicPhaseBudget(driver, phase, requestedMs) {
  return driver?._rotationDeadline ? driver._rotationDeadline.budget(phase, requestedMs) : requestedMs;
}

async function pollGmailForMagicLink(accountEmail, maxWaitMs = MAGIC_POLL_MS) {
  const startTime = Date.now();
  // gog cold-start + keyring unlock often needs 20–40s under load. Never clamp
  // the child timeout to the remaining poll window alone — that turned short
  // peeks into hard ETIMEDOUT fatals (2026-07-16 incident).
  const commandTimeout = () => {
    const remaining = maxWaitMs - (Date.now() - startTime);
    if (remaining <= 0) return 1;
    return Math.max(45_000, Math.min(90_000, remaining + 30_000));
  };
  // Anchor to "now" so we never accept a login email older than this call.
  const requestedAt = Math.floor(Date.now() / 1000);
  const targetLower = accountEmail.toLowerCase();

  // ONLY the shared forwarding inbox (magicLinkInbox() = shared-inbox@example.com)
  // is ever queried. Every Claude account's login email (magic link / code) is
  // forwarded there, and it is the sole inbox with gog OAuth access. The
  // account's own inbox is never polled. The magic-link URL embeds the real
  // account email, so the target-email guard still disambiguates per-account
  // even though all mail lands in this one inbox.
  const forwarding = magicLinkInbox();
  const inboxes = [forwarding || accountEmail];
  log(
    `[magic-link] Polling Gmail for login email to ${accountEmail}: inbox [${inboxes.join(', ')}] (max ${maxWaitMs / 1000}s)`,
  );

  // Per-inbox skip set so a stale thread doesn't get re-evaluated every poll.
  const seenSkipByInbox = new Map(inboxes.map((i) => [i, new Set()]));

  // Broad pre-filter; the code-side parser does the real subject/body matching.
  // Claude's current flow emails a 6-digit verification code (subject like
  // "Your Claude code" / "Verification code"), replacing the older
  // "Secure link to log in to Claude" magic-link subject.
  const searchQuery =
    'newer_than:15m (from:anthropic.com OR from:claude.ai OR subject:claude OR subject:verification OR subject:"log in" OR subject:"secure link" OR subject:"Secure link" OR "Your secure link")';

  const linkPatterns = [
    /https:\/\/claude\.ai\/magic-link#[^\s"'<>)}\]]+/,
    /https:\/\/claude\.ai\/api\/auth\/verify[^\s"'<>)}\]]+/,
    /https:\/\/claude\.ai\/login\/verify[^\s"'<>)}\]]+/,
    /https:\/\/claude\.ai\/auth\/verify[^\s"'<>)}\]]+/,
    /https:\/\/claude\.ai\/[^\s"'<>)}\]]*(?:verify|confirm|magic-link|login\?code)[^\s"'<>)}\]]*/,
  ];

  // Scan one inbox once. Returns `code:NNNNNN`, a login URL, or null.
  const scanInbox = (inbox) => {
    const seenSkip = seenSkipByInbox.get(inbox);
    const acctArgs = inbox ? ['--account', inbox] : [];
    try {
      const searchResult = execFileSync('gog', ['gmail', 'search', searchQuery, '--max', '10', '-j', ...acctArgs], {
        timeout: commandTimeout(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();

      const parsedSearch = JSON.parse(searchResult);
      const list = Array.isArray(parsedSearch) ? parsedSearch : parsedSearch.threads || parsedSearch.results || [];

      for (const item of list) {
        const threadIdRaw = item.id || item.threadId;
        if (!threadIdRaw) continue;
        // Sanitize: Gmail IDs are alphanumeric. Reject anything else.
        if (!/^[A-Za-z0-9_-]+$/.test(threadIdRaw)) continue;
        if (seenSkip.has(threadIdRaw)) continue;

        const threadJson = execFileSync('gog', ['gmail', 'get', threadIdRaw, '-j', ...acctArgs], {
          timeout: commandTimeout(),
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();

        const parsed = JSON.parse(threadJson);
        const messages = parsed?.thread?.messages || parsed?.messages || (parsed?.message ? [parsed.message] : []);

        // Reject any message older than our requestedAt (stale link from prior call).
        // Grace window must cover the gap between form-submit and this poll call
        // (captcha solving alone can take 15-25s), not just clock skew — a tight
        // 5s grace was discarding genuinely-fresh emails sent moments before the
        // poll started (a shared-inbox reauth incident).
        const msgTimes = messages.map((m) => parseInt(m.internalDate || '0', 10) / 1000).filter((t) => t > 0);
        const newestMsg = msgTimes.length ? Math.max(...msgTimes) : 0;
        if (newestMsg && newestMsg < requestedAt - 180) {
          seenSkip.add(threadIdRaw);
          continue;
        }

        const decodedBodies = [];
        if (parsed?.body) decodedBodies.push(String(parsed.body));
        const walkParts = (part) => {
          const data = part?.body?.data;
          if (data) {
            try {
              decodedBodies.push(Buffer.from(data, 'base64url').toString('utf-8'));
            } catch {}
          }
          for (const p of part?.parts || []) walkParts(p);
        };
        for (const msg of messages) walkParts(msg.payload);
        const fullBody = decodedBodies.join('\n');

        let url = null;
        for (const pattern of linkPatterns) {
          const m = fullBody.match(pattern);
          if (m) {
            url = m[0];
            break;
          }
        }

        if (!url) {
          // Claude's current flow emails a 6-digit verification code (no link).
          // Prefer a code labelled as a code/verification, then fall back to any
          // standalone 6-digit number. Avoid 7-8 digit matches (order numbers etc).
          const labelledCode = fullBody.match(/(?:code|verify|verification)[^\d]{0,24}(\d{6})\b/i);
          const codeMatch = labelledCode || fullBody.match(/\b(\d{6})\b/);
          const recipientEvidence = [
            fullBody,
            ...messages.flatMap((m) => (m?.payload?.headers || []).map((h) => `${h?.name || ''}: ${h?.value || ''}`)),
          ]
            .join('\n')
            .toLowerCase();
          if (codeMatch && isForwardedToSharedInbox(recipientEvidence)) {
            log(`[magic-link] Found login verification code in ${inbox} (forwarded to ${forwardingInboxLower()})`);
            // Consumed → archive so the inbox doesn't accumulate single-use codes.
            trashMagicLinkMessages(
              messages.map((m) => m.id),
              inbox,
              log,
            );
            return `code:${codeMatch[1]}`;
          }
          if (codeMatch) log(`[magic-link] Skipping code without forwarding evidence for ${targetLower}`);
          seenSkip.add(threadIdRaw);
          continue;
        }

        // All Claude login emails land in the shared inbox, but the magic-link
        // embeds the *real* target account. Accepting a mismatched link (e.g.
        // a different account's link while rotating support@) burns the wrong
        // session and archives the email so the rightful rotation can never
        // use it. Aliases that only share a mailbox are still separate Claude
        // accounts — never treat them as interchangeable.
        const linkTarget = magicLinkTargetEmail(url);
        if (linkTarget && linkTarget !== targetLower) {
          log(`[magic-link] Skipping link target=${linkTarget} (want ${targetLower}) — leave for correct rotation`);
          seenSkip.add(threadIdRaw);
          continue;
        }

        log(`[magic-link] Found login link in ${inbox}`);
        // Consumed → archive so the inbox doesn't accumulate single-use links
        // (which also confuse the stale-link guards on the next poll).
        trashMagicLinkMessages(
          messages.map((m) => m.id),
          inbox,
          log,
        );
        return url;
      }
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().trim() : '';
      const detail = redactSensitiveText(stderr || err.message || err);
      const code = classifyGogFailure(detail);
      // Soft / retryable: preflight fail, timeouts, transient keyring blips.
      // Hard-fail only permanent auth/config problems so one slow gog call
      // cannot abort the whole magic-link cascade.
      const soft =
        code === 'GOG_PREFLIGHT_FAILED' ||
        code === 'GOG_PREFLIGHT_TIMEOUT' ||
        /ETIMEDOUT|timed?\s*out|EAGAIN|ECONNRESET/i.test(detail);
      if (!soft) {
        throw new RotationSafetyError(code, `Gmail polling cannot continue: ${detail.split('\n')[0].slice(0, 180)}`);
      }
      log(`[magic-link] Gmail poll error on ${inbox} (${code}): ${detail.split('\n')[0].slice(0, 140)}`);
    }
    return null;
  };

  while (Date.now() - startTime < maxWaitMs) {
    for (const inbox of inboxes) {
      const found = scanInbox(inbox);
      if (found) return found;
    }
    const remaining = maxWaitMs - (Date.now() - startTime);
    if (remaining > 0) await sleep(Math.min(MAGIC_POLL_INTERVAL_MS, remaining));
  }
  log(`[magic-link] Timed out waiting for login email for ${accountEmail} (polled: ${inboxes.join(', ')})`);
  return null;
}

// ── Auth flow (driver-agnostic) ───────────────────────────────────────────────

/** True when the browser URL indicates OAuth completed (not chrome-error noise). */
function isOAuthSuccessUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome-error:') || url.startsWith('about:blank')) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
  } catch {}
  if (url.includes('/oauth/code/success')) return true;
  if (url.includes('/oauth/code/callback') && url.includes('code=')) return true;
  return false;
}

/** After Authorize, Chrome often shows chrome-error while localhost callback is handled by CLI. */
async function waitForAuthProcComplete(proc, timeoutMs = 15_000) {
  if (!proc) return false;
  // Already finished
  if (proc.exitCode === 0) return true;
  if (proc.exitCode != null) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        proc.removeListener('exit', onExit);
      } catch {}
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    const onExit = (code) => finish(code === 0);
    proc.once('exit', onExit);
    // Re-check after listener attach — closes the race where the process exits
    // between the initial exitCode read and once('exit'), which previously
    // hung forever after oauth-watcher captured the callback (2026-07-16).
    if (proc.exitCode === 0) finish(true);
    else if (proc.exitCode != null) finish(false);
  });
}

function replayOAuthCallbackToLocalhost(url, localhostPort, logFn = log) {
  if (!url.includes('/oauth/code/callback') || !url.includes('code=') || !localhostPort) return false;
  const codeMatch = url.match(/[?&]code=([^&]+)/);
  const stateMatch = url.match(/[?&]state=([^&]+)/);
  if (!codeMatch) return false;
  const code = decodeURIComponent(codeMatch[1]);
  const state = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
  const replayUrl = `http://localhost:${localhostPort}/callback?code=${encodeURIComponent(code)}${state ? '&state=' + encodeURIComponent(state) : ''}`;
  logFn(`Auth callback reached (platform.claude.com) — replaying to localhost`);
  try {
    execSync(`curl -sS "${replayUrl}" -o /dev/null`, { timeout: 8000 });
  } catch {}
  return true;
}

/** Capture OAuth callback URLs from Playwright before chrome-error masks the redirect. */
function attachOAuthCallbackWatcher(page, localhostPort, logFn = log, isRemote = false) {
  const state = { captured: false, code: null, stateParam: null, source: null };

  const tryCapture = (rawUrl) => {
    if (!rawUrl || state.captured) return;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    const host = parsed.hostname;
    const path = parsed.pathname || '';
    if ((host === 'localhost' || host === '127.0.0.1') && path.includes('callback')) {
      const code = parsed.searchParams.get('code');
      if (code) {
        state.captured = true;
        state.code = code;
        state.stateParam = parsed.searchParams.get('state');
        state.source = 'localhost';
        logFn(`[oauth-watcher] Captured localhost callback (code …${code.slice(-6)})`);
      }
      return;
    }
    if (rawUrl.includes('/oauth/code/callback') && rawUrl.includes('code=')) {
      const code = parsed.searchParams.get('code') || rawUrl.match(/[?&]code=([^&]+)/)?.[1];
      if (code) {
        state.captured = true;
        state.code = decodeURIComponent(code);
        state.stateParam = parsed.searchParams.get('state');
        state.source = 'platform';
        logFn(`[oauth-watcher] Captured platform callback (code …${state.code.slice(-6)})`);
      }
      return;
    }
    if (rawUrl.includes('/oauth/code/success')) {
      state.captured = true;
      state.source = 'success-page';
      logFn('[oauth-watcher] Saw OAuth success page');
    }
  };

  const onFrame = (frame) => tryCapture(frame.url());
  const onRequest = (req) => tryCapture(req.url());
  page.on('framenavigated', onFrame);
  page.on('request', onRequest);

  const cleanup = () => {
    page.off('framenavigated', onFrame);
    page.off('request', onRequest);
  };

  const replayIfNeeded = async () => {
    // Always curl-replay when we have a code+port. A localhost-source capture
    // only means Playwright *saw* the callback URL — chrome-error often means
    // the auth CLI never received it (race / connection refused). Replaying is
    // idempotent enough for single-use codes and unblocks finalize after
    // chrome-error (account failures 2026-07-16).
    if (state.source === 'success-page' || !state.code || !localhostPort) {
      // Localhost source without a parseable code: nothing to do.
      return state.source === 'localhost' && !isRemote;
    }
    const replayUrl = `http://localhost:${localhostPort}/callback?code=${encodeURIComponent(state.code)}${state.stateParam ? '&state=' + encodeURIComponent(state.stateParam) : ''}`;
    logFn(`[oauth-watcher] Replaying ${state.source || 'captured'} callback → localhost:${localhostPort}`);
    try {
      execSync(`curl -sS "${replayUrl}" -o /dev/null`, { timeout: 8000 });
      return true;
    } catch (e) {
      logFn(`[oauth-watcher] curl replay failed (${String(e.message || e).slice(0, 80)}) — trying page.goto`);
      if (!page.isClosed?.()) {
        try {
          await page.goto(replayUrl, { waitUntil: 'commit', timeout: 8000 });
          return true;
        } catch {}
      }
    }
    return false;
  };

  const waitForCapture = async (timeoutMs = 25_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (state.captured) return true;
      await sleep(150);
    }
    return state.captured;
  };

  return { state, cleanup, replayIfNeeded, waitForCapture };
}

async function finalizeOAuthFromDriver(driver, { waitCaptureMs = 20_000, procTimeoutMs = 25_000 } = {}) {
  const watcher = driver._oauthWatcher;
  if (watcher) {
    await watcher.waitForCapture(waitCaptureMs);
    await watcher.replayIfNeeded();
  }
  if (driver._authProc && (await waitForAuthProcComplete(driver._authProc, procTimeoutMs))) {
    return true;
  }
  return false;
}

async function resolveOAuthFromBrowserUrl(url, driver, { waitForProc = true } = {}) {
  const procOk = async (timeoutMs = 20_000) =>
    !waitForProc || !driver._authProc || (await waitForAuthProcComplete(driver._authProc, timeoutMs));

  const watcher = driver._oauthWatcher;
  if (watcher?.state.captured) {
    await watcher.replayIfNeeded();
    if (await procOk()) {
      log('[oauth-watcher] Auth proc completed after captured callback');
      return true;
    }
  }

  if (url.includes('/oauth/code/callback') && url.includes('code=')) {
    replayOAuthCallbackToLocalhost(url, driver._localhostPort);
    if (await procOk()) return true;
    return false;
  }

  if (isOAuthSuccessUrl(url)) {
    if (url.includes('/oauth/code/success')) {
      log('Auth success page reached — waiting for claude auth login');
    } else {
      log('Auth callback reached (localhost) — waiting for claude auth login');
    }
    // procOk returns false if the proc exited with non-zero. But on some
    // accounts (notably when BROWSER capture race causes early exit) the
    // page still reaches /oauth/code/success — meaning claude.ai accepted
    // the authorize click. In that case, treat as success: the gog-driven
    // pre-warm above already consumed the magic link, and the OAuth callback
    // is on its way (or already consumed via OAuth-watcher replayIfNeeded).
    if (await procOk(25_000)) return true;
    if (url.includes('/oauth/code/success')) {
      log('[oauth-success] proc exited non-zero but page reached success page — treating as success');
      return true;
    }
    return false;
  }

  if (url.startsWith('chrome-error:')) {
    log('Browser on chrome-error — checking captured callback + auth proc');
    if (watcher) await watcher.waitForCapture(5000);
    await watcher?.replayIfNeeded();
    if (await procOk(25_000)) {
      log('Auth callback completed despite chrome-error page');
      return true;
    }
  }
  return false;
}

// Proper hostname check, not a substring match — `isGoogleAccountsUrl(url)`
// would also match e.g. `https://accounts.google.com.evil.example/`. This only
// classifies which stage of Google's own login flow a driven browser is on, it's
// not a security boundary, but the strict check is free and closes the gap.
function isGoogleAccountsUrl(url) {
  try {
    return new URL(url).hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

async function runAuthFlow(driver, account) {
  const creds = fetchGoogleCreds(account) || {};
  const googlePassword = creds.password || fetchGooglePassword(account);
  const googleOtpSecret = creds.otpSecret || null;
  const googleSmsPhone =
    (process.env.CLAUDE_ROTATION_GOOGLE_SMS_PHONE || '').trim() ||
    (account.googleSmsPhone || '').trim() ||
    (creds.phone || '').trim() ||
    null;
  if (googlePassword) log(`dcli Google password available for ${account.email}${googleOtpSecret ? ' (+TOTP)' : ''}`);

  // Hydrate captcha + proxy secrets (2captcha / Bright Data) from Doppler if
  // absent, so the Turnstile solver below has TWOCAPTCHA_API_KEY available.
  bootstrapRotatorSecrets(log);

  let oauthWatcher = null;
  if (driver._page) {
    oauthWatcher = attachOAuthCallbackWatcher(driver._page, driver._localhostPort, log, driver._remoteBrowser === true);
    driver._oauthWatcher = oauthWatcher;
  }

  // Auto-solve a Cloudflare Turnstile / hCaptcha challenge on the current page
  // via 2captcha, if one is present and TWOCAPTCHA_API_KEY is set. Returns true
  // only when a challenge was detected AND solved (caller may re-submit). Safe
  // to call speculatively — returns false quickly when no challenge is present.
  async function maybeSolveCaptcha(reason) {
    if (!driver._page) return false;
    try {
      const r = await solveCaptchaOnPage(driver._page, (m) => log(`[captcha] ${m}`), {});
      if (r.present && !r.solved && !captchaSolverAvailable()) {
        log(`[captcha] challenge present${reason ? ` (${reason})` : ''} but no solver key — AI-brain/manual fallback`);
      }
      if (r.solved) {
        log(`[captcha] solved ${r.provider}${reason ? ` (${reason})` : ''}`);
        await sleep(1500);
      }
      return r.solved === true;
    } catch (e) {
      log(`[captcha] solve attempt failed: ${String(e.message || e).slice(0, 100)}`);
      return false;
    }
  }

  try {
    // AI-brain stall detector: when the URL doesn't advance for N consecutive
    // steps, hand the page to Claude to decide what to do. Kept separate from
    // the hard-coded URL branches below — the branches stay fast + free for the
    // common case; Claude only fires on genuinely unseen pages.
    //
    // Threshold is low (2) because each iteration's findAndClick/fillInput
    // retries can take 20-60s on a page with nothing to match — we want Claude
    // to intervene on the second stagnant step, not the fourth.
    let lastStallUrl = '';
    let stallCount = 0;
    const STALL_THRESHOLD = 2;
    const aiBrainHistory = [];
    const geminiForBrain = process.env.CLAUDE_ROTATOR_DISABLE_AI_BRAIN === '1' ? false : geminiAvailable();
    const aiBrainEnabled = driver._page && process.env.CLAUDE_ROTATOR_DISABLE_AI_BRAIN !== '1' && geminiForBrain;
    const crsOperatorEnabled =
      driver._page &&
      process.env.CLAUDE_ROTATOR_DISABLE_AI_BRAIN !== '1' &&
      process.env.CLAUDE_ROTATOR_DISABLE_CRS_OPERATOR !== '1';
    let crsOperatorLaunched = false;
    if (driver._page && process.env.CLAUDE_ROTATOR_DISABLE_AI_BRAIN !== '1' && geminiForBrain) {
      log('[ai-brain] Gemini vision brain available through CRS-managed local routing');
    }

    async function escalateCrsOperator(stallReason, url) {
      if (!crsOperatorEnabled || crsOperatorLaunched) return false;
      crsOperatorLaunched = true;
      let screenshotPath = '';
      try {
        screenshotPath = path.join(
          os.homedir(),
          '.claude/scripts/account-rotation/screenshots',
          `crs-operator-${account.email.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${Date.now()}.png`,
        );
        await driver.screenshot(screenshotPath);
      } catch (err) {
        log(`[crs-operator] screenshot capture failed: ${String(err.message || err).slice(0, 100)}`);
      }
      const res = await launchCrsOperator({
        account,
        stallReason,
        url,
        screenshotPath,
        logger: (m) => log(m),
      });
      if (res?.ok) {
        log(`[crs-operator] background agent dispatched; continuing local poll loop`);
        return true;
      }
      crsOperatorLaunched = false;
      return false;
    }

    /** Switch org via account menu (same pattern as disable-extra-usage.mjs). */
    async function switchClaudeOrgViaAccountMenu(orgName, logPrefix = '[org-switch]') {
      const page = driver._page;
      if (!page || !orgName) return false;
      try {
        const accountBtn = page.locator('button[aria-label*="Account" i], button:has-text("Account")').first();
        if (!(await accountBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
          return false;
        }
        await accountBtn.click();
        await sleep(1500);
        const orgItem = page.locator(`[role="menuitem"]:has-text("${orgName}"), button:has-text("${orgName}")`).first();
        if (!(await orgItem.isVisible({ timeout: 5000 }).catch(() => false))) {
          await page.keyboard.press('Escape').catch(() => {});
          return false;
        }
        await orgItem.click();
        await sleep(3000);
        log(`${logPrefix} switched to org "${orgName}" via account menu`);
        return true;
      } catch (e) {
        log(`${logPrefix} account-menu switch failed: ${String(e.message || e).slice(0, 120)}`);
        return false;
      }
    }

    async function waitOutLoginPageAfterOrgPick(logPrefix = '[magic-link]') {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await driver.currentUrl().catch(() => '');
        if (!cur.includes('claude.ai/login')) return true;
        log(`${logPrefix} on /login after org pick — waiting for session (attempt ${attempt + 1}/3)`);
        await sleep(5000);
        await driver.goto('https://claude.ai/home').catch(() => {});
        await sleep(3000);
      }
      const final = await driver.currentUrl().catch(() => '');
      return !final.includes('claude.ai/login');
    }

    async function finishMagicLinkLogin(magicLink) {
      if (!magicLink) return false;
      if (magicLink.startsWith('code:')) {
        const code = magicLink.replace('code:', '');
        log(`[magic-link] Entering verification code: ${code}`);
        // Claude's current flow: single input#code[data-testid="code"]
        // (autocomplete="one-time-code", inputmode="numeric"). Prefer it.
        await driver.fillInput(
          '#code, [data-testid="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"], input[type="number"], input[name="code"], input[placeholder*="code" i]',
          code,
        );
        await driver.findAndClick([
          '[data-testid="continue"]',
          'button:has-text("Verify Email Address")',
          'button:has-text("Verify")',
          'Continue',
          'Submit',
          'button[type="submit"]',
        ]);
        // Wait up to 12s for the code to be accepted and the page to leave the
        // code-entry state (code input disappears or URL changes off /login)
        // before re-navigating to the OAuth authorize URL — verification is async.
        for (let i = 0; i < 24; i++) {
          await sleep(500);
          const curUrl = await driver.currentUrl().catch(() => '');
          const codeInput =
            (await driver._page
              ?.$('input[data-testid="code"], input[autocomplete="one-time-code"]')
              .catch(() => null)) || null;
          if (!curUrl.includes('claude.ai/login') || !codeInput) break;
        }
      } else {
        log(`[magic-link] Navigating to login link`);
        try {
          await driver.goto(magicLink);
        } catch (e) {
          log(
            `[magic-link] login-link navigation did not settle (${String(e.message || e).slice(0, 100)}) — probing current page`,
          );
        }
      }
      // Wait up to 10s for the magic-link login redirect to complete
      let navigated = false;
      for (let i = 0; i < 20; i++) {
        const curUrl = await driver.currentUrl().catch(() => '');
        if (!curUrl.includes('magic-link')) {
          navigated = true;
          break;
        }
        await sleep(500);
      }
      if (!navigated) {
        log(`[magic-link] URL did not change from magic-link after 10s, proceeding anyway`);
        // DEBUG: capture the stuck magic-link page DOM + screenshot so we can
        // see the new Claude flow's extra step (confirmation button, challenge, etc).
        try {
          const ssPath = `/tmp/magic-link-stall-${account.email.replace(/[^a-z0-9]/gi, '_')}.png`;
          await driver.screenshot(ssPath);
          let inputs = 'n/a',
            btns = 'n/a',
            text = 'n/a';
          if (driver._page) {
            inputs = JSON.stringify(
              await driver._page
                .$$eval('input', (els) =>
                  els.map((e) => ({
                    type: e.type,
                    id: e.id,
                    testid: e.getAttribute('data-testid'),
                    aria: e.getAttribute('aria-label'),
                    ph: e.placeholder,
                  })),
                )
                .catch(() => 'err'),
            );
            btns = JSON.stringify(
              await driver._page
                .$$eval('button,[role="button"]', (els) =>
                  els
                    .filter((e) => e.offsetWidth)
                    .slice(0, 20)
                    .map((e) => ({
                      text: (e.innerText || '').trim().slice(0, 40),
                      testid: e.getAttribute('data-testid'),
                      aria: e.getAttribute('aria-label'),
                      disabled: e.disabled,
                    })),
                )
                .catch(() => 'err'),
            );
            text =
              (await driver._page.$$eval('body', (els) => (els[0]?.innerText || '').slice(0, 800))).catch?.() || text;
          }
          log(`[magic-link-debug] screenshot=${ssPath}`);
          log(`[magic-link-debug] INPUTS=${String(inputs).slice(0, 600)}`);
          log(`[magic-link-debug] BUTTONS=${String(btns).slice(0, 900)}`);
          log(`[magic-link-debug] TEXT=${String(text).slice(0, 800)}`);
        } catch (dbgErr) {
          log(`[magic-link-debug] dump failed: ${dbgErr.message}`);
        }
      }
      // After magic link login, session is now valid — re-navigate to authUrl
      // so the OAuth flow can complete (org chooser → authorize → callback)
      if (driver._authUrl) {
        // For multi-org accounts (same email, multiple workspaces like
        // user-personal vs user-team), force an explicit org
        // pick BEFORE hitting /oauth/authorize. Otherwise claude.ai uses
        // the "last active" org silently, and both sibling vaults end up
        // holding the same org's token.
        const isMultiOrg =
          account.label && account.orgName && account.orgName.toLowerCase() !== account.email.toLowerCase();
        if (isMultiOrg) {
          log(`[magic-link] Multi-org account — forcing org pick for "${account.orgName}" via claude.ai/home detour`);
          try {
            await driver.goto('https://claude.ai/home');
          } catch {}
          await sleep(3500);
          await dismissGoogleOneTap('org-detour');
          const alreadyOnOrg = await (async () => {
            try {
              const curUrl = await driver.currentUrl().catch(() => '');
              if (/select-organization|choose-organization|choose-workspace|select-workspace|\/login/i.test(curUrl)) {
                return false;
              }
              const text = ((await driver.readPageText?.()) || '').toLowerCase();
              const looksLikeChooser =
                text.includes('select organization') ||
                text.includes('choose an organization') ||
                text.includes('select an organization') ||
                text.includes('which organization') ||
                text.includes('choose a workspace') ||
                text.includes('select a workspace');
              if (looksLikeChooser) return false;
              const orgVisible = text.includes(String(account.orgName).toLowerCase());
              const onAppRoute =
                /claude\.ai\/(new|chat|project|recents|home)?($|\/|\?)/i.test(curUrl) && !curUrl.includes('/login');
              return orgVisible && onAppRoute;
            } catch {
              return false;
            }
          })();
          let picked = alreadyOnOrg;
          if (alreadyOnOrg) {
            log(`[magic-link] Already on correct org "${account.orgName}" — org pick satisfied`);
          } else {
            picked = await driver.findAndClick([
              `button:has-text("${account.orgName}")`,
              `[role="button"]:has-text("${account.orgName}")`,
              `text="${account.orgName}"`,
              account.orgName,
            ]);
          }
          if (!picked) {
            picked = await switchClaudeOrgViaAccountMenu(account.orgName, '[magic-link]');
          }
          if (picked) {
            if (!alreadyOnOrg) log(`[magic-link] Pre-selected org "${account.orgName}" before OAuth`);
            await sleep(2500);
          } else {
            log(`[magic-link] No immediate match for "${account.orgName}" — will rely on org-chooser loop / ai-brain`);
          }
          if (!alreadyOnOrg) {
            const sessionOk = await waitOutLoginPageAfterOrgPick('[magic-link]');
            if (!sessionOk) {
              log(`[magic-link] Still on /login after org pick — org-chooser loop will retry`);
            }
          }
        }
        log(`[magic-link] Re-navigating to OAuth authorize URL`);
        try {
          await driver.goto(driver._authUrl);
        } catch {}
        await sleep(3000);
      }
      return true;
    }

    async function dismissGoogleOneTap(reason = '') {
      const page = driver._page;
      if (!page) return false;
      try {
        const removed = await page.evaluate(() => {
          let hit = false;
          const selectors = [
            '#credential_picker_container',
            '#credential_picker_iframe',
            'iframe[src*="accounts.google.com/gsi"]',
            'iframe[title="Sign in with Google Dialog"]',
            'div[aria-labelledby="credential_picker"]',
            'div[id^="g_id_onload"]',
          ];
          for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
              element.remove();
              hit = true;
            }
          }
          return hit;
        });
        if (removed) log(`[magic-link] Dismissed Google One-Tap overlay${reason ? ` (${reason})` : ''}`);
        await page.keyboard.press('Escape').catch(() => {});
        return removed;
      } catch {
        return false;
      }
    }

    async function magicLinkSendErrored() {
      if (!driver.readPageText) return false;
      try {
        const text = (await driver.readPageText()).toLowerCase();
        return (
          text.includes('error sending you a login link') ||
          text.includes('there was an error sending') ||
          (text.includes('login link') && text.includes('contact support'))
        );
      } catch {
        return false;
      }
    }

    async function handleClaudeMagicLinkEmailPrompt(reason) {
      if (!account.useMagicLink) return false;
      await dismissGoogleOneTap('pre-email-fill');
      // A Cloudflare Turnstile can gate the login page before the email field is
      // usable — try to clear it first.
      await maybeSolveCaptcha('pre-email');
      const filled = await driver.fillInput('[data-testid="email"], #email, input[type="email"]', account.email);
      if (!filled) return false;
      log(`[magic-link] ${reason ? `${reason} — ` : ''}Filled email: ${account.email}`);
      await sleep(500);
      const submitted = await driver.findAndClick([
        '[data-testid="continue"]',
        'button[data-testid="continue"]',
        'button[type="submit"]:has-text("Continue with email")',
        'button:has-text("Continue with email")',
        'button:has-text("Continue")',
      ]);
      if (!submitted) return false;
      log(`[magic-link] Submitted email — magic link should be sent`);
      await sleep(3000);
      // Submitting can raise a Turnstile challenge that blocks the email send;
      // solve it and re-submit once if so.
      if (await maybeSolveCaptcha('post-email')) {
        await driver.findAndClick([
          '[data-testid="continue"]',
          'button[data-testid="continue"]',
          'button:has-text("Continue with email")',
          'button:has-text("Continue")',
        ]);
        await sleep(3000);
      }

      if (await magicLinkSendErrored()) {
        log(`[magic-link] Claude rejected the login-link send for ${account.email}; backing off`);
        try {
          const errPath = path.join(
            os.homedir(),
            '.claude/scripts/account-rotation/screenshots/magic-link-send-error.png',
          );
          await driver.screenshot(errPath);
        } catch {}
        return false;
      }

      const magicLink = await pollGmailForMagicLink(
        account.email,
        magicPhaseBudget(driver, 'primary in-flow Gmail polling', MAGIC_GMAIL_PHASE_MS),
      );
      if (await finishMagicLinkLogin(magicLink)) return true;

      try {
        const errorScreenshotPath = path.join(
          os.homedir(),
          '.claude/scripts/account-rotation/screenshots/magic-link-error.png',
        );
        await driver.screenshot(errorScreenshotPath);
        log(`[magic-link] Saved error screenshot to ${errorScreenshotPath}`);
      } catch (err) {
        log(`[magic-link] Failed to save error screenshot: ${err.message}`);
      }

      log(`[magic-link] No magic link found in Gmail — magic-link-only, no Google fallback`);
      return false;
    }

    async function isClaudeLoginCodePage() {
      // DOM check first: Claude's code-entry page renders input#code[data-testid="code"].
      try {
        if (driver._page) {
          const codeInput = await driver._page.$('input[data-testid="code"], input[autocomplete="one-time-code"]');
          if (codeInput) return true;
        }
      } catch {}
      if (!driver.readPageText) return false;
      try {
        const text = (await driver.readPageText()).toLowerCase();
        return (
          text.includes('verification code') ||
          text.includes('enter the code') ||
          text.includes('check your email') ||
          text.includes('we sent') ||
          text.includes('code sent') ||
          text.includes('verify email address')
        );
      } catch {
        return false;
      }
    }

    async function claudeLoginCodeRecipient() {
      if (!driver.readPageText) return null;
      try {
        const text = await driver.readPageText();
        const match =
          text.match(/sent to[\s\S]{0,120}?([\w.+-]+@[\w.-]+\.\w+)/i) || text.match(/([\w.+-]+@[\w.-]+\.\w+)/i);
        return match ? match[1].trim().toLowerCase() : null;
      } catch {
        return null;
      }
    }

    function configuredVerificationEmail() {
      return (
        String(account.verificationEmail || account.codeRecipientEmail || account.magicLinkRecipient || '')
          .trim()
          .toLowerCase() || null
      );
    }

    async function changeClaudeLoginEmail() {
      const changed = await driver.findAndClick([
        'Change email address',
        'button:has-text("Change email address")',
        'a:has-text("Change email address")',
      ]);
      if (!changed) return false;
      await sleep(1500);
      return handleClaudeMagicLinkEmailPrompt('Wrong verification recipient');
    }

    let codePageEmailRetryDone = false;

    for (let step = 0; step < 20; step++) {
      await sleep(2500);
      const url = await driver.currentUrl().catch(() => '');
      log(`Step ${step} [${driver.name}]: ${url.substring(0, 100)}`);

      if (/claude\.(ai|com)/i.test(url) && account.useMagicLink) {
        await dismissGoogleOneTap('step-loop');
      }

      // chrome-error after Authorize usually means localhost callback fired — don't stall/ai-brain it.
      if (url.startsWith('chrome-error:') && driver._authProc) {
        if (await finalizeOAuthFromDriver(driver)) return true;
        stallCount = 0;
        lastStallUrl = url;
        await sleep(2000);
        continue;
      }

      // Claude sometimes renders the email login form while preserving the
      // /oauth/authorize URL. Handle known Claude auth prompts before the generic
      // stall detector, otherwise AI-brain burns multiple decisions waiting for a
      // verification code that the deterministic Gmail poller can resolve or fail.
      if (account.useMagicLink && url.includes('claude.ai')) {
        if (
          await handleClaudeMagicLinkEmailPrompt(
            url.includes('/oauth/authorize') ? 'OAuth page rendered login prompt' : 'Login prompt',
          )
        ) {
          stallCount = 0;
          continue;
        }
        if (url.includes('/login') && (await isClaudeLoginCodePage())) {
          const recipient = await claudeLoginCodeRecipient();
          // Accept any address that we know routes the same shared inbox. All
          // Claude account login emails forward to forwardingInboxLower() (default
          // shared-inbox@example.com), so a recipient match to that address is
          // equivalent to a match to account.email itself.
          const recipientAccountEmailLower = account.email.toLowerCase();
          const isSharedForwarding = !!recipient && recipient === forwardingInboxLower();
          const recipientMatches = !!recipient && (recipient === recipientAccountEmailLower || isSharedForwarding);
          if (recipient && !recipientMatches) {
            log(
              `[magic-link] Claude verification code was sent to ${recipient}, expected ${account.email}; changing email`,
            );
            codePageEmailRetryDone = true;
            if (await changeClaudeLoginEmail()) {
              stallCount = 0;
            }
          } else if (recipient && isSharedForwarding) {
            log(`[magic-link] recipient ${recipient} matches forwarding inbox — accepting without email-change`);
          }
          if (!recipient && !codePageEmailRetryDone) {
            log(`[magic-link] Claude verification recipient was not readable; resubmitting ${account.email} once`);
            codePageEmailRetryDone = true;
            if (await changeClaudeLoginEmail()) {
              stallCount = 0;
              continue;
            }
          }
          log(
            `[magic-link] Claude login is waiting for an email verification code; polling Gmail once before aborting`,
          );
          const magicLink = await pollGmailForMagicLink(
            account.email,
            magicPhaseBudget(driver, 'secondary in-flow Gmail polling', Math.min(MAGIC_GMAIL_PHASE_MS, 90_000)),
          );
          if (await finishMagicLinkLogin(magicLink)) {
            stallCount = 0;
            continue;
          }
          const configuredRecipient = configuredVerificationEmail();
          const accountEmailLower = account.email.toLowerCase();
          const fallbackRecipient =
            recipient && recipient !== accountEmailLower
              ? recipient
              : configuredRecipient && configuredRecipient !== accountEmailLower
                ? configuredRecipient
                : null;
          log(
            `[magic-link] verification recipient candidates: page=${recipient || 'unreadable'} config=${configuredRecipient || 'unset'}`,
          );
          if (fallbackRecipient) {
            log(
              `[magic-link] No code/link for ${account.email}; polling verification recipient ${fallbackRecipient} before aborting`,
            );
            const recipientMagicLink = await pollGmailForMagicLink(
              fallbackRecipient,
              magicPhaseBudget(driver, 'fallback-recipient Gmail polling', Math.min(MAGIC_GMAIL_PHASE_MS, 90_000)),
            );
            if (await finishMagicLinkLogin(recipientMagicLink)) {
              stallCount = 0;
              continue;
            }
          }
          log(`[magic-link] Verification-code page could not be completed automatically for ${account.email}`);
          return false;
        }
      }

      // Stall check — run BEFORE the URL pattern dispatcher so an unknown
      // challenge page gets escalated to the AI brain. Skip on the very first
      // step (no history yet) and skip inside the manual driver.
      if (aiBrainEnabled && step > 0 && driver.name !== 'manual' && !url.startsWith('chrome-error:')) {
        if (url && url === lastStallUrl) {
          stallCount++;
        } else {
          stallCount = 0;
        }
        lastStallUrl = url;
        if (stallCount >= STALL_THRESHOLD && aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS) {
          const stallReason = `url stagnant for ${stallCount} steps: ${url.substring(0, 100)}`;
          log(`[ai-brain] STALL DETECTED — ${stallReason}`);
          await escalateCrsOperator(stallReason, url);
          if (!aiBrainEnabled) {
            stallCount = 0;
            await sleep(5000);
            continue;
          }
          const action = await askAIBrain({
            page: driver._page,
            account,
            history: aiBrainHistory,
            stallReason,
            logger: (m) => log(`[ai-brain] ${m}`),
          });
          aiBrainHistory.push(
            `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ''} — ${String(action.reason || '').slice(0, 60)}`,
          );
          if (action.action === 'abort') {
            const reason = String(action.reason || '');
            log(`[ai-brain] aborted — reason: ${reason}. Returning to caller.`);
            return false;
          }
          const ok = await executeAIAction(driver, action, { googlePassword });
          log(`[ai-brain] executed ${action.action}: ${ok ? 'ok' : 'no-op'}`);
          stallCount = 0;
          await sleep(3000);
          continue;
        }
      }

      if (await resolveOAuthFromBrowserUrl(url, driver)) return true;
      if (driver.name === 'manual') {
        await sleep(12_000);
        continue;
      }

      // Google 2FA: push notification to phone (/challenge/dp) — can't automate, must switch
      if (isGoogleAccountsUrl(url) && url.includes('challenge/dp')) {
        log(`Push-notification 2FA detected — clicking "Try another way"`);
        const clicked = await driver.findAndClick(['Try another way', 'Probeer een andere manier']);
        if (!clicked) {
          log(`Could not find "Try another way" button`);
          return false;
        }
        await sleep(4000);
        continue;
      }

      // Google passkey challenge (/challenge/pk/presend, /challenge/pk/verify).
      // No hardware key available — bail out via "Try another way".
      if (isGoogleAccountsUrl(url) && url.includes('/challenge/pk')) {
        log(`Passkey challenge detected — clicking "Try another way"`);
        const clicked = await driver.findAndClick([
          'Try another way',
          'Try another method',
          'Use password instead',
          'Use your password instead',
          'Probeer een andere manier',
          'Gebruik wachtwoord',
          'button:has-text("Try another way")',
          'button:has-text("Use password")',
          '[jsname="QkNstf"]',
        ]);
        if (!clicked) {
          log(`Passkey: "Try another way" not clickable — AI-brain will escalate`);
        } else {
          await sleep(4000);
        }
        continue;
      }

      // Google 2FA: method selection page (/challenge/selection)
      // Google orders options differently per account. Confirmed via CDP on
      // a live "Too many failed attempts" selection page:
      //   - data-challengetype="1"  → "Enter your password"
      //   - data-challengetype="9"  → "Get a verification code" (SMS)
      //   - data-challengetype="53" → "Use your passkey" / "Try another way"
      //   - data-challengetype="6"  → TOTP authenticator app
      // Preference: password (we have it via dcli) > TOTP (we have the secret)
      //           > SMS (requires a phone) > passkey (no hardware).
      if (isGoogleAccountsUrl(url) && url.includes('challenge/selection')) {
        log(`On 2FA selection page — prefer password, then TOTP, then SMS`);
        const selectors = [];
        if (googlePassword)
          selectors.push(
            'div[data-challengetype="1"]',
            'li:has-text("Enter your password")',
            'Enter your password',
            'Wachtwoord invoeren',
          );
        if (googleOtpSecret)
          selectors.push(
            'div[data-challengetype="6"]',
            'li:has-text("Google Authenticator")',
            'Google Authenticator',
            'Authenticator app',
          );
        selectors.push(
          'div[data-challengetype="9"]',
          'li:has-text("Get a verification code")',
          'Get a verification code',
          'Text message',
        );
        const clicked = await driver.findAndClick(selectors);
        if (clicked) {
          await sleep(5000);
          continue;
        }
        log(`No preferred method found on selection page — AI-brain will escalate`);
        continue; // don't hard-abort; let stall detector route to AI-brain
      }

      // Google 2FA: TOTP code entry
      if (isGoogleAccountsUrl(url) && url.includes('challenge/totp')) {
        if (googleOtpSecret) {
          const code = generateTOTP(googleOtpSecret);
          log(`Entering TOTP code from dcli secret`);
          await driver.fillInput('input[type="tel"], input[name=totpPin], #totpPin', code);
          await sleep(500);
          await driver.findAndClick(['Next', '#totpNext button', 'Verify']);
          await sleep(3000);
          continue;
        }
        log(`No TOTP secret — trying alternate verification`);
        await driver.findAndClick(['Try another way']);
        await sleep(2000);
        continue;
      }

      // Google 2FA: SMS phone collect (/challenge/ipp/collect) — enter phone, click Send
      if (isGoogleAccountsUrl(url) && url.includes('challenge/ipp/collect')) {
        if (!googleSmsPhone) {
          log(
            `SMS phone collect page — no phone (set CLAUDE_ROTATION_GOOGLE_SMS_PHONE, account.googleSmsPhone, or dcli phone on google.com cred)`,
          );
          return false;
        }
        log(`SMS phone collect — entering configured number and clicking Send`);
        await driver.fillInput('#phoneNumberId, input[type="tel"]', googleSmsPhone);
        await sleep(500);
        await driver.findAndClick(['Send', 'Next', 'Verstuur']);
        await sleep(4000);
        continue;
      }

      // Google 2FA: SMS code verify (/challenge/ipp/verify or /challenge/sms)
      if (isGoogleAccountsUrl(url) && (url.includes('challenge/ipp/verify') || url.includes('challenge/sms'))) {
        log(`Waiting for SMS code from Messages.app (up to 60s)...`);
        let smsCode = null;
        for (let waitI = 0; waitI < 12; waitI++) {
          await sleep(5000);
          smsCode = readLatestSMSCode({ maxAgeSec: 180 });
          if (smsCode) break;
        }
        if (!smsCode) {
          log(`Failed to retrieve SMS code — aborting`);
          return false;
        }
        log(`Got SMS code: ${smsCode}`);
        await driver.fillInput('#idvPin, input[name="Pin"], input[type="tel"]', smsCode);
        await sleep(500);
        await driver.findAndClick(['Next', 'Verify']);
        await sleep(4000);
        continue;
      }

      // Google consent page (/signin/oauth/id or /signin/oauth/consent) — click Continue
      if (
        isGoogleAccountsUrl(url) &&
        (url.includes('/signin/oauth/id') ||
          url.includes('/signin/oauth/consent') ||
          url.includes('/signin/oauth/legacy'))
      ) {
        log(`Google OAuth consent — clicking Continue`);
        // Workspace accounts show a scope list with a Continue button at the bottom;
        // sometimes it's disabled until the user scrolls. Try direct click first, then fall through.
        const clicked = await driver.findAndClick([
          'button[jsname="LgbsSe"]:has-text("Continue")',
          'button[jsname="LgbsSe"]:has-text("Allow")',
          'button[jsname="LgbsSe"]:has-text("Approve")',
          'button:has-text("Continue")',
          'button:has-text("Allow")',
          'button:has-text("Approve")',
          'button:has-text("Confirm")',
          'button:has-text("Doorgaan")',
          'button:has-text("Toestaan")',
          '[role="button"]:has-text("Continue")',
          '[role="button"]:has-text("Allow")',
          '[role="button"]:has-text("Approve")',
          'Continue',
          'Allow',
          'Approve',
          'Confirm',
          'Doorgaan',
          'Toestaan',
        ]);
        if (!clicked) {
          log(`Continue button not found on consent page — waiting and retrying`);
        }
        await sleep(3000);
        continue;
      }

      // Google password prompt (standalone /challenge/pwd — must run BEFORE the
      // broad accounts.google.com account-chooser branch below).
      if (isGoogleAccountsUrl(url) && url.includes('challenge/pwd')) {
        if (googlePassword) {
          await driver.fillInput('input[type="password"]', googlePassword);
          await sleep(500);
          await driver.findAndClick(['Next', '#passwordNext button']);
          continue;
        }
      }

      // Google account chooser — click the target account
      if (isGoogleAccountsUrl(url)) {
        // Detect "Signed out" next to the target account (needs re-login)
        let targetSignedOut = false;
        if (driver.readPageText) {
          try {
            const txt = (await driver.readPageText()).toLowerCase();
            const emailIdx = txt.indexOf(account.email.toLowerCase());
            if (emailIdx >= 0) {
              const nearby = txt.substring(emailIdx, emailIdx + 200);
              targetSignedOut = nearby.includes('signed out');
            }
          } catch {}
        }

        const picked = await driver.findAndClick([account.email, `data-identifier="${account.email}"`]);
        if (picked && targetSignedOut && googlePassword) {
          // Account was signed out — click picked it, now password prompt will appear
          log(`Account ${account.email} was signed out — password flow will handle`);
        }
        if (!picked) {
          // Not in list — add manually
          await driver.findAndClick(['Use another account', 'Add account']);
          await sleep(2000);
          await driver.fillInput('input[type="email"], #identifierId', account.email);
          await sleep(500);
          await driver.findAndClick(['Next', '#identifierNext button']);
          await sleep(2000);
          if (googlePassword) {
            await driver.fillInput('input[type="password"]', googlePassword);
            await sleep(500);
            await driver.findAndClick(['Next', '#passwordNext button']);
          }
        }
        continue;
      }

      // Claude organization/workspace chooser (Workspace accounts on a custom domain)
      // Shown between Google OAuth return and /oauth/authorize. Pick Personal unless
      // the account metadata specifies a team/organization name.
      // URL match is intentionally broad — claude.ai has renamed the chooser route
      // several times (select-organization, onboarding/organization, workspaces,
      // choose-workspace). Also triggers on page-text heuristic for routes we miss.
      const isOrgChooserUrl =
        url.includes('claude.ai') &&
        (url.includes('select-organization') ||
          url.includes('/onboarding/organization') ||
          url.includes('choose-organization') ||
          url.includes('select-workspace') ||
          url.includes('choose-workspace') ||
          url.includes('workspaces') ||
          url.includes('select-account') ||
          url.includes('switch-org'));
      let isOrgChooserByText = false;
      if (!isOrgChooserUrl && url.includes('claude.ai') && driver.readPageText) {
        try {
          const t = (await driver.readPageText()).toLowerCase();
          isOrgChooserByText =
            (t.includes('choose an organization') ||
              t.includes('select an organization') ||
              t.includes('choose a workspace') ||
              t.includes('select a workspace') ||
              t.includes('which organization')) &&
            (t.includes('personal') || t.includes('organization'));
        } catch {}
      }
      if (isOrgChooserUrl || isOrgChooserByText) {
        const orgLabel = account.organization || account.orgName || 'Personal';
        // No explicit organization/orgName configured — derive candidate
        // chooser-button labels from the account's own email domain instead
        // of a hardcoded company name, so this works for any domain.
        const orgFallbacks =
          !account.organization && !account.orgName && String(account.email || '').includes('@')
            ? [displayNameFor(account), `${account.email}'s Organization`]
            : [];
        log(
          `Claude organization chooser (${isOrgChooserByText ? 'via page-text' : 'via URL'}) — selecting "${orgLabel}"`,
        );
        // Dump all visible button/link labels so we can see the real workspace
        // names claude.ai is showing (vs what's configured as orgName).
        if (driver.readPageText) {
          try {
            const t = await driver.readPageText();
            const labels = [
              ...new Set(
                (t || '')
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0 && l.length < 80),
              ),
            ].slice(0, 40);
            log(`[org-chooser] Visible lines: ${JSON.stringify(labels)}`);
          } catch {}
        }
        let picked = await driver.findAndClick([
          `button:has-text("${orgLabel}")`,
          `[role="button"]:has-text("${orgLabel}")`,
          `text="${orgLabel}"`,
          orgLabel,
          ...orgFallbacks,
          // Only fall back to "Personal" / "Continue" if the configured label
          // is itself Personal — never silently default a team account to Personal.
          ...(orgLabel === 'Personal' && orgFallbacks.length === 0 ? ['Personal', 'Continue'] : []),
        ]);
        if (!picked && orgLabel !== 'Personal') {
          picked = await switchClaudeOrgViaAccountMenu(orgLabel, '[org-chooser]');
        }
        if (!picked) {
          log(`No organization button matched "${orgLabel}" — the account may land on the wrong org`);
        } else {
          await waitOutLoginPageAfterOrgPick('[org-chooser]');
        }
        await sleep(3000);
        continue;
      }

      // Claude OAuth consent page — MUST check account BEFORE clicking Authorize.
      // Match by pathname only — URL params (like redirect_uri=...callback) would
      // false-match a substring check on the full URL.
      let oauthPath = '';
      try {
        oauthPath = new URL(url).pathname;
      } catch {}
      if (oauthPath.includes('/oauth/authorize') || (oauthPath.endsWith('/authorize') && url.includes('claude'))) {
        // Step 1: Read page to verify "Logged in as <correct email>".
        // Wait up to 5s for the page text to contain any email address (async render).
        let pageText = '';
        for (let i = 0; i < 10; i++) {
          try {
            if (driver.readPageText) {
              pageText = (await driver.readPageText()).toLowerCase();
              if (pageText.includes(account.email.toLowerCase()) || /[\w.+-]+@[\w.-]+\.\w+/.test(pageText)) {
                break;
              }
            }
          } catch {}
          await sleep(500);
        }

        const hasCorrectAccount = pageText?.includes(account.email.toLowerCase());
        const hasAnyOtherEmail = pageText && /[\w.+-]+@[\w.-]+\.\w+/.test(pageText) && !hasCorrectAccount;

        // If we see the wrong account, force switch (even for magic-link logins).
        if (hasAnyOtherEmail) {
          log(
            `Page text shows WRONG account (mismatch): expected "${account.email}", but found another email. Clicking Switch account / Logout.`,
          );
          const switched = await driver.findAndClick([
            'Switch account',
            'Log out',
            'Logout',
            'Sign out',
            'Use another account',
          ]);
          if (switched) {
            await sleep(3000);
            continue;
          }
          // Try clicking the email we want directly if we are on account chooser
          const picked = await driver.findAndClick([account.email]);
          if (picked) {
            await sleep(3000);
            continue;
          }
        } else if (hasCorrectAccount) {
          log(`Correct account confirmed: ${account.email}`);
        } else {
          // No email rendered in page text after 5s.
          if (account.useMagicLink) {
            // Magic-link route: profile text did not render within 5s, proceed to Authorize
            log(`[magic-link] Profile email did not render within 5s — proceeding straight to Authorize blind`);
          } else {
            log(`Page text unreadable — clicking Switch account / Logout`);
            const switched = await driver.findAndClick([
              'Switch account',
              'Log out',
              'Logout',
              'Sign out',
              'Use another account',
            ]);
            if (switched) {
              await sleep(3000);
              continue;
            }
          }
        }

        // Step 2: Click Authorize — wait for button to become enabled (up to 30s)
        let authorized = false;
        for (let wait = 0; wait < 6; wait++) {
          if (
            await driver.findAndClick([
              '[data-testid="continue"]',
              'button[data-testid="continue"]',
              'Authorize',
              'Allow',
              'Approve',
              'Accept',
              'Continue',
            ])
          ) {
            log('Clicked Authorize');
            authorized = true;
            break;
          }
          // Check if the prior click (or magic-link) already navigated us off
          // the authorize page. If we're on /oauth/code/success or any non-claude.ai
          // URL, auth is done — stop hunting for a button that no longer exists.
          const currentUrl = await driver.currentUrl().catch(() => '');
          if (isOAuthSuccessUrl(currentUrl)) {
            log(`Auth already succeeded — URL moved to ${currentUrl.substring(0, 80)}`);
            authorized = true;
            break;
          }
          if (currentUrl.startsWith('chrome-error:') && driver._authProc) {
            if (await finalizeOAuthFromDriver(driver)) {
              log('Auth callback completed after Authorize (chrome-error — CLI handled redirect)');
              return true;
            }
          }
          // Button might exist but be disabled — wait for page to finish loading
          log(`Authorize button not clickable — waiting (attempt ${wait + 1}/6)...`);
          await sleep(5000);
        }
        if (authorized) {
          if (await finalizeOAuthFromDriver(driver, { waitCaptureMs: 25_000, procTimeoutMs: 30_000 })) {
            return true;
          }
          const postAuthUrl = await driver.currentUrl().catch(() => '');
          if (await resolveOAuthFromBrowserUrl(postAuthUrl, driver)) return true;
          continue;
        }
        log('Authorize button still not clickable after 30s — escalating to ai-brain');
        // Fast-path ai-brain escalation: don't wait for stall detector to catch up
        // on the next loop iter. Gemini vision through the CRS-managed route picks
        // the next action without a metered cloud fallback.
        await escalateCrsOperator(`authorize button not clickable on ${url.substring(0, 100)}`, url);
        if (aiBrainEnabled && aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS) {
          const action = await askAIBrain({
            page: driver._page,
            account,
            history: aiBrainHistory,
            stallReason: `authorize button not clickable on ${url.substring(0, 100)}`,
            logger: (m) => log(`[ai-brain] ${m}`),
          });
          aiBrainHistory.push(
            `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ''} — ${String(action.reason || '').slice(0, 60)}`,
          );
          if (action.action !== 'abort') {
            const ok = await executeAIAction(driver, action, { googlePassword });
            log(`[ai-brain] executed ${action.action}: ${ok ? 'ok' : 'no-op'}`);
            stallCount = 0;
            await sleep(3000);
            continue;
          }
          const reason = String(action.reason || '');
          log(`[ai-brain] aborted — reason: ${reason}`);
        }
        await sleep(3000);
        continue;
      }

      // Accept cookie consent so the decision persists in the account profile.
      // Reject-first made the banner recur across fresh OAuth contexts.
      if (url.includes('claude.ai')) {
        await driver.findAndClick([
          '[data-testid="consent-accept"]',
          'Accept All Cookies',
          'Accept all cookies',
          'button:has-text("Accept all")',
        ]);
        await sleep(500);
      }

      // Claude.ai login → Magic link path (when account.useMagicLink is set)
      // The email input is always visible on /login — no button click needed first.
      if (account.useMagicLink && url.includes('claude.ai/login')) {
        // Clear any Cloudflare Turnstile gating the login page first.
        await maybeSolveCaptcha('pre-email');
        // Fill the email input directly
        const filled = await driver.fillInput('[data-testid="email"], #email, input[type="email"]', account.email);
        if (filled) {
          log(`[magic-link] Filled email: ${account.email}`);
          await sleep(500);
          // Click the "Continue with email" submit button (data-testid="continue")
          const submitted = await driver.findAndClick([
            '[data-testid="continue"]',
            'button[type="submit"]:has-text("Continue with email")',
            'button:has-text("Continue with email")',
          ]);
          if (submitted) {
            log(`[magic-link] Submitted email — magic link should be sent`);
            await sleep(3000);
            if (await maybeSolveCaptcha('post-email')) {
              await driver.findAndClick([
                '[data-testid="continue"]',
                'button:has-text("Continue with email")',
                'button:has-text("Continue")',
              ]);
              await sleep(3000);
            }

            // Poll Gmail for the magic link
            const magicLink = await pollGmailForMagicLink(
              account.email,
              magicPhaseBudget(driver, 'late in-flow Gmail polling', MAGIC_GMAIL_PHASE_MS),
            );
            if (magicLink) {
              if (magicLink.startsWith('code:')) {
                const code = magicLink.replace('code:', '');
                log('[magic-link] Entering verification code');
                await driver.fillInput(
                  '#code, [data-testid="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"], input[type="number"], input[name="code"], input[placeholder*="code" i]',
                  code,
                );
                await driver.findAndClick([
                  '[data-testid="continue"]',
                  'button:has-text("Verify Email Address")',
                  'button:has-text("Verify")',
                  'Continue',
                  'Submit',
                  'button[type="submit"]',
                ]);
                // Wait up to 12s for the code to be accepted (code input gone / URL off /login).
                for (let i = 0; i < 24; i++) {
                  await sleep(500);
                  const curUrl = await driver.currentUrl().catch(() => '');
                  const codeInput =
                    (await driver._page
                      ?.$('input[data-testid="code"], input[autocomplete="one-time-code"]')
                      .catch(() => null)) || null;
                  if (!curUrl.includes('claude.ai/login') || !codeInput) break;
                }
              } else {
                log(`[magic-link] Navigating to login link`);
                await driver.goto(magicLink);
              }
              // Wait up to 10s for the magic-link login redirect to complete
              let navigated = false;
              for (let i = 0; i < 20; i++) {
                const curUrl = await driver.currentUrl().catch(() => '');
                if (!curUrl.includes('magic-link')) {
                  navigated = true;
                  break;
                }
                await sleep(500);
              }
              if (!navigated) {
                log(`[magic-link] URL did not change from magic-link after 10s, proceeding anyway`);
              }
              // After magic link login, session is now valid — re-navigate to authUrl
              // so the OAuth flow can complete (org chooser → authorize → callback)
              if (driver._authUrl) {
                // For multi-org accounts (same email, multiple workspaces like
                // user-personal vs user-team), force an explicit org
                // pick BEFORE hitting /oauth/authorize. Otherwise claude.ai uses
                // the "last active" org silently, and both sibling vaults end up
                // holding the same org's token.
                const isMultiOrg =
                  account.label && account.orgName && account.orgName.toLowerCase() !== account.email.toLowerCase();
                if (isMultiOrg) {
                  log(
                    `[magic-link] Multi-org account — forcing org pick for "${account.orgName}" via claude.ai/home detour`,
                  );
                  try {
                    await driver.goto('https://claude.ai/home');
                  } catch {}
                  await sleep(3500);
                  // Try to click the configured orgName if a chooser is showing.
                  // The broadened org-chooser logic in the main loop will also
                  // pick this up on the next iteration, but an immediate attempt
                  // here short-circuits silently-skipped cases.
                  const picked = await driver.findAndClick([
                    `button:has-text("${account.orgName}")`,
                    `[role="button"]:has-text("${account.orgName}")`,
                    `text="${account.orgName}"`,
                    account.orgName,
                  ]);
                  if (picked) {
                    log(`[magic-link] Pre-selected org "${account.orgName}" before OAuth`);
                    await sleep(2500);
                  } else {
                    log(
                      `[magic-link] No immediate match for "${account.orgName}" — will rely on org-chooser loop / ai-brain`,
                    );
                  }
                }
                log(`[magic-link] Re-navigating to OAuth authorize URL`);
                try {
                  await driver.goto(driver._authUrl);
                } catch {}
                await sleep(3000);
              }
              continue;
            }
            log(
              `[magic-link] No magic link found in Gmail — magic-link-only, will re-poll next step (no Google fallback)`,
            );
          }
        }
      }

      // Google OAuth is DISABLED — magic-link is the only auth method. We never
      // click "Continue with Google" or drive accounts.google.com. If the magic
      // link could not be completed above, keep looping (re-poll Gmail) until the
      // step budget is exhausted, then fail this driver.
    }

    // Loop exhausted — final AI-brain attempt before giving up. Some flows
    // legitimately exceed 20 steps (multi-factor + workspace chooser + consent),
    // so give Claude up to its remaining decision budget to unstick us.
    if (aiBrainEnabled && aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS) {
      const url = await driver.currentUrl().catch(() => '');
      log(`[ai-brain] loop exhausted — final rescue attempt`);
      for (let rescue = 0; rescue < AI_BRAIN_MAX_DECISIONS - aiBrainHistory.length && rescue < 3; rescue++) {
        const action = await askAIBrain({
          page: driver._page,
          account,
          history: aiBrainHistory,
          stallReason: `loop exhausted at ${url.substring(0, 80)} (rescue ${rescue + 1})`,
          logger: (m) => log(`[ai-brain] ${m}`),
        });
        aiBrainHistory.push(
          `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ''} — ${String(action.reason || '').slice(0, 60)}`,
        );
        if (action.action === 'abort') {
          break;
        }
        await executeAIAction(driver, action, { googlePassword });
        await sleep(4000);
        const newUrl = await driver.currentUrl().catch(() => '');
        if (await resolveOAuthFromBrowserUrl(newUrl, driver)) {
          log('[ai-brain] rescue SUCCEEDED');
          return true;
        }
      }
    }

    if (!aiBrainEnabled) {
      const url = await driver.currentUrl().catch(() => '');
      await escalateCrsOperator(`auth-flow loop exhausted at ${url.substring(0, 80)}`, url);
    }

    if (driver._authProc && (await waitForAuthProcComplete(driver._authProc, 5000))) {
      log('Auth proc completed successfully after auth-flow loop');
      return true;
    }
    return false;
  } finally {
    oauthWatcher?.cleanup();
    delete driver._oauthWatcher;
  }
}

// ── Fast-path: reuse an existing logged-in per-account Chrome profile ─────────
// Before the cookie-clearing login cascade, try the account's OWN persistent
// Chrome profile (ClaudeCode-<accountKey>). If it still holds a live claude.ai
// web session, authorize directly off those cookies — no email entry, no
// magic-link email, no Gmail poll. This is exactly "first try if a login is even
// needed". Strictly FAIL-OPEN:
//   • profile dir missing            → return false (no profile yet)
//   • profile in use by a live Chrome → return false (don't corrupt leveldb)
//   • session dead (bounced to /login) → return false BEFORE consuming the
//     single-use OAuth callback, so the normal cascade still works
//   • any error                      → return false
// Only when the authorize→callback actually completes do we wait on `proc` (the
// `claude auth login` callback server) and report success. Per-account profiles
// are 1:1 with accounts, and the caller re-verifies the minted token via
// /oauth/profile, so a wrong-account authorize is caught downstream.
// Disable entirely with CLAUDE_ROT_NO_SESSION_REUSE=1.

/**
 * Autonomous: open the OAuth authorize URL and submit the Claude email form so
 * Anthropic actually sends the magic-link / verification email.
 * BROWSER=capture only records the URL — it does NOT fill the form.
 * Prefer CDP :9222 (real headed Chrome) — headless is Cloudflare-blocked.
 */
/**
 * Trigger magic-link email (or complete OAuth if already on consent as target).
 * @returns {true|'session-ready'|'oauth-complete'|false}
 *   true            — email form submitted; caller should poll Gmail
 *   'session-ready' — was on consent as target but Authorize did not finish
 *   'oauth-complete'— Authorize + localhost callback succeeded on this page
 *   false           — failed / inconclusive
 */
const magicLinkBrowserState = new Map();

function buildAccountLoginUrl(account, authUrl) {
  try {
    const parsed = new URL(authUrl);
    return `https://claude.ai/login?email=${encodeURIComponent(account.email)}&selectAccount=true&returnTo=${encodeURIComponent(parsed.pathname + parsed.search)}`;
  } catch {
    return `https://claude.ai/login?email=${encodeURIComponent(account.email)}&selectAccount=true`;
  }
}

async function prepareClaudePage(page, reason = '') {
  if (!page) return;
  try {
    await page.evaluate(() => {
      const selectors = [
        '#credential_picker_container',
        '#credential_picker_iframe',
        'iframe[src*="accounts.google.com/gsi"]',
        'iframe[title="Sign in with Google Dialog"]',
        'div[aria-labelledby="credential_picker"]',
        'div[id^="g_id_onload"]',
      ];
      const removeOneTap = () => {
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) element.remove();
        }
      };
      removeOneTap();
      if (!window.__crsGoogleOneTapObserver) {
        window.__crsGoogleOneTapObserver = new MutationObserver(removeOneTap);
        window.__crsGoogleOneTapObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    });
  } catch {}
  for (const selector of [
    '[data-testid="consent-accept"]',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept all")',
  ]) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
        await button.click({ force: true });
        log(`[cookies] accepted Claude cookie banner${reason ? ` (${reason})` : ''}`);
        break;
      }
    } catch {}
  }
}

async function maybeSolvePageCaptcha(page, reason = '') {
  if (!page) return false;
  bootstrapRotatorSecrets(log);
  try {
    // Aggressive budget: keep hammering 2captcha (proxy + no-proxy) until solved.
    const result = await solveCaptchaOnPage(page, (message) => log(`[captcha] ${message}`), {
      totalBudgetMs: Number(process.env.TWOCAPTCHA_TOTAL_BUDGET_MS || 420_000),
      timeoutMs: Number(process.env.TWOCAPTCHA_POLL_MS || 180_000),
      maxAttempts: Number(process.env.TWOCAPTCHA_MAX_ATTEMPTS || 6),
    });
    if (result.present && !result.solved && !captchaSolverAvailable()) {
      log(`[captcha] challenge present${reason ? ` (${reason})` : ''} but no solver key`);
    } else if (result.present && !result.solved) {
      log(`[captcha] still unsolved after budget${reason ? ` (${reason})` : ''}`);
    }
    if (result.solved) {
      log(`[captcha] solved ${result.provider}${reason ? ` (${reason})` : ''}`);
      await sleep(1500);
    }
    return result.solved === true;
  } catch (e) {
    log(`[captcha] solve attempt failed: ${String(e.message || e).slice(0, 100)}`);
    return false;
  }
}

async function triggerMagicLinkEmailSend(account, authUrl, { localhostPort = null, proc = null } = {}) {
  if (!account?.email || !authUrl) return false;
  const { chromium } = await import('playwright');
  const chromeBin =
    process.env.CLAUDE_ROT_CHROME_BIN ||
    [
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p) => existsSync(p));

  let browser = null;
  let page = null;
  let ownsBrowser = false;
  let cdpAttached = false;
  let oauthWatcher = null;
  try {
    const cdp = await tryConnectCDP(chromium);
    if (cdp?.page) {
      browser = cdp.browser;
      page = cdp.page;
      cdpAttached = true;
      log('[magic-link] trigger: using CDP Chrome (bypasses CF headless block)');
    } else {
      const headless = process.platform === 'darwin' ? false : process.env.CLAUDE_ROT_HEADED !== '1';
      browser = await chromium.launch({
        headless,
        ...(chromeBin ? { executablePath: chromeBin } : {}),
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          ...NO_THROTTLE_FLAGS,
        ],
      });
      ownsBrowser = true;
      page = await browser.newPage();
      if (process.platform === 'darwin') {
        hideAutomationApp('Google Chrome Beta');
        hideAutomationApp('Google Chrome');
      }
      log(`[magic-link] trigger: launched ${headless ? 'headless' : 'headed'} Chrome for email submit`);
    }
  } catch (e) {
    log(`[magic-link] trigger launch failed: ${String(e.message || e).slice(0, 120)}`);
    return false;
  }

  try {
    log(`[magic-link] trigger: opening authorize URL to request login email for ${account.email}`);
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => {
      log(`[magic-link] trigger: goto authUrl err ${String(e.message || e).slice(0, 80)}`);
    });
    await sleep(2000);
    await prepareClaudePage(page, 'magic-link-trigger');
    let earlyUrl = page.url();
    log(`[magic-link] trigger: landed url=${earlyUrl.substring(0, 140)}`);

    for (let i = 0; i < 20; i++) {
      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const challenged = /security verification|verify you are human|just a moment|checking your browser/i.test(body);
      if (!challenged) break;
      if (i === 0) log('[magic-link] trigger: Cloudflare challenge — waiting');
      await sleep(1500);
    }
    earlyUrl = page.url();

    // True localhost OAuth callback only (not authorize URL with code=true + redirect_uri=localhost).
    if (
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(earlyUrl) &&
      /[?&]code=[A-Za-z0-9._~-]+/.test(earlyUrl) &&
      !/[?&]code=true(?:&|$)/.test(earlyUrl)
    ) {
      log('[magic-link] trigger: OAuth code already on localhost callback — session live, skip email');
      return false;
    }

    // CDP Chrome often still has a prior account session (e.g. aurora). Consent
    // page then shows "Logged in as X" + Authorize with no email field. Must
    // "Switch account" (or logout) before we can request a magic link for the
    // target email — otherwise Gmail never gets a new message.
    const targetLower = String(account.email || '').toLowerCase();
    for (let sw = 0; sw < 3; sw++) {
      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const loggedAsMatch = body.match(/Logged in as\s+([^\s]+@[^\s]+)/i);
      const loggedAs = (loggedAsMatch?.[1] || '').toLowerCase();
      const hasEmailField = await page
        .locator('input[type="email"], input[name="email"], input[data-testid="email"]')
        .first()
        .isVisible({ timeout: 600 })
        .catch(() => false);
      const onConsent = /would like to connect|your account will be used to/i.test(body);
      const wrongSession = Boolean(loggedAs && loggedAs !== targetLower);

      // Already on consent as the *correct* account — try Authorize HERE on CDP.
      // If Authorize does not navigate within a few seconds, the OAuth state is
      // likely stale (prior consent page) — Switch account and send a fresh
      // magic-link for *this* authUrl instead of hanging in finalize (chairman hang).
      if (process.env.CLAUDE_ROT_ALLOW_SESSION_REUSE === '1' && onConsent && loggedAs === targetLower) {
        log(`[magic-link] trigger: consent already as ${account.email} — Authorize on same CDP page`);
        let authorized = false;
        if (localhostPort) {
          oauthWatcher = attachOAuthCallbackWatcher(page, localhostPort, log);
          try {
            // Ensure we are on *this* authUrl (not a stale consent tab)
            const cur = page.url();
            if (!cur.includes('oauth/authorize') || (authUrl && !cur.includes(String(localhostPort)))) {
              // redirect_uri embeds the port — if missing, re-goto authUrl
              if (authUrl && !String(cur).includes(String(localhostPort))) {
                log('[magic-link] trigger: consent page missing this callback port — re-goto authUrl');
                await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
                await sleep(2000);
              }
            }
            const authBtn = page.locator('button:has-text("Authorize")').first();
            if (await authBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
              await authBtn.scrollIntoViewIfNeeded().catch(() => {});
              await authBtn.click({ force: true, timeout: 5000 }).catch(async () => {
                await page.evaluate(() => {
                  const b = [...document.querySelectorAll('button')].find((x) =>
                    /authorize/i.test((x.textContent || '').trim()),
                  );
                  if (b) b.click();
                });
              });
              log('[magic-link] trigger: clicked Authorize on session-ready consent');
              let navigated = false;
              try {
                await page.waitForURL(
                  (u) => {
                    const s = String(u);
                    if (/oauth\/authorize/i.test(s) && !/^https?:\/\/(?:localhost|127\.0\.0\.1)/.test(s)) return false;
                    return (
                      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(s) ||
                      /oauth\/code\/(callback|success)/i.test(s) ||
                      s.startsWith('chrome-error:')
                    );
                  },
                  { timeout: 12_000 },
                );
                navigated = true;
                log(`[magic-link] trigger: post-Authorize nav ${page.url().substring(0, 100)}`);
              } catch {
                log(`[magic-link] trigger: post-Authorize still at ${page.url().substring(0, 100)}`);
              }
              if (navigated || oauthWatcher.state.captured) {
                const shim = {
                  _localhostPort: localhostPort,
                  _authProc: proc,
                  _oauthWatcher: oauthWatcher,
                  _account: account,
                };
                if (
                  await finalizeOAuthFromDriver(shim, {
                    waitCaptureMs: 20_000,
                    procTimeoutMs: 30_000,
                  })
                ) {
                  log('[magic-link] trigger: ✓ OAuth complete from session-ready consent (CDP)');
                  authorized = true;
                  return 'oauth-complete';
                }
              }
            }
          } finally {
            try {
              oauthWatcher?.cleanup();
            } catch {}
            oauthWatcher = null;
          }
        }
        if (!authorized) {
          // Stale consent — force fresh login email for this OAuth state
          log('[magic-link] trigger: Authorize no-nav — Switch account + fresh magic-link for this authUrl');
          let switched = false;
          for (const label of ['Switch account', 'Use a different account', 'Log out', 'Sign out']) {
            try {
              const btn = page
                .locator(`button:has-text("${label}"), a:has-text("${label}"), [role="button"]:has-text("${label}")`)
                .first();
              if (await btn.isVisible({ timeout: 1200 })) {
                await btn.click();
                log(`[magic-link] trigger: clicked "${label}" after stale Authorize`);
                switched = true;
                await sleep(2000);
                break;
              }
            } catch {}
          }
          if (!switched) {
            await page
              .goto('https://claude.ai/api/auth/logout', { waitUntil: 'commit', timeout: 20_000 })
              .catch(() => {});
            await sleep(1500);
            await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
            await sleep(2000);
          }
          continue; // re-check page; then email-fill path below after loop
        }
      }

      if (wrongSession || (onConsent && !hasEmailField)) {
        log(
          `[magic-link] trigger: wrong/stale session (loggedAs=${loggedAs || 'unknown'}, want=${targetLower}) — Switch account`,
        );
        let switched = false;
        for (const label of ['Switch account', 'Use a different account', 'Log out', 'Sign out', 'Change account']) {
          try {
            const btn = page
              .locator(`button:has-text("${label}"), a:has-text("${label}"), [role="button"]:has-text("${label}")`)
              .first();
            if (await btn.isVisible({ timeout: 1200 })) {
              await btn.click();
              log(`[magic-link] trigger: clicked "${label}"`);
              switched = true;
              await sleep(2000);
              break;
            }
          } catch {}
        }
        if (!switched) {
          log('[magic-link] trigger: no Switch account control — hard logout');
          await page
            .goto('https://claude.ai/api/auth/logout', { waitUntil: 'commit', timeout: 20_000 })
            .catch(() => {});
          await sleep(1500);
          await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
          await sleep(2000);
        }
        continue;
      }
      break;
    }

    const preEmailField = await page
      .locator('input[type="email"], input[name="email"], input[data-testid="email"]')
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false);
    const preEmailText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!preEmailField && !/would like to connect|your account will be used to/i.test(preEmailText)) {
      log('[magic-link] trigger: authorize page has no login controls — forcing account login route');
      await page
        .goto(buildAccountLoginUrl(account, authUrl), {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        })
        .catch(() => {});
      await sleep(2000);
      await prepareClaudePage(page, 'forced-account-login');
    }

    for (const label of ['Continue with email', 'Use email', 'Email', 'Sign in with email']) {
      try {
        const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 1200 })) {
          await btn.click();
          log(`[magic-link] trigger: clicked "${label}"`);
          await sleep(1200);
          break;
        }
      } catch {}
    }

    const emailSel =
      'input[type="email"], input[name="email"], input[data-testid="email"], #email, input[autocomplete="email"]';
    let filled = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const inp = page.locator(emailSel).first();
        if (await inp.isVisible({ timeout: 2500 })) {
          await inp.click({ timeout: 1000 }).catch(() => {});
          await inp.fill('');
          await inp.fill(account.email);
          filled = true;
          log(`[magic-link] trigger: filled email ${account.email}`);
          break;
        }
      } catch {}
      if (attempt === 2 || attempt === 5) {
        try {
          // Re-try switch if still on wrong-account consent mid-loop
          const sw = page.locator('button:has-text("Switch account"), a:has-text("Switch account")').first();
          if (await sw.isVisible({ timeout: 600 })) {
            await sw.click();
            log('[magic-link] trigger: mid-loop Switch account');
            await sleep(1500);
          }
          const emailTab = page.locator('button:has-text("Continue with email"), button:has-text("Email")').first();
          if (await emailTab.isVisible({ timeout: 800 })) await emailTab.click();
        } catch {}
      }
      await sleep(1200);
    }
    if (!filled) {
      try {
        const t = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 400);
        const ss = `/tmp/magic-link-trigger-fail-${Date.now()}.png`;
        await page.screenshot({ path: ss, fullPage: true }).catch(() => {});
        log(
          `[magic-link] trigger: no email field url=${page.url().substring(0, 100)} ss=${ss} text=${t.replace(/\s+/g, ' ').slice(0, 220)}`,
        );
      } catch {}
      return false;
    }

    await sleep(400);
    let submitted = false;
    for (const label of [
      'Continue with email',
      'Continue',
      'Send login link',
      'Send code',
      'Next',
      'Submit',
      'Log in',
      'Sign in',
    ]) {
      try {
        const btn = page.locator(`button:has-text("${label}"), button[type="submit"]`).first();
        if ((await btn.isVisible({ timeout: 1000 })) && (await btn.isEnabled().catch(() => true))) {
          await btn.click();
          submitted = true;
          log(`[magic-link] trigger: submitted via "${label}" — magic link / code should be emailed`);
          break;
        }
      } catch {}
    }
    if (!submitted) {
      try {
        await page.locator(emailSel).first().press('Enter');
        submitted = true;
        log('[magic-link] trigger: submitted via Enter key');
      } catch {}
    }
    await sleep(submitted ? 3500 : 1000);
    if (submitted) {
      try {
        const state = await page.context().storageState();
        magicLinkBrowserState.set(accountKey(account), state);
        log('[magic-link] trigger: preserved browser transaction state for link completion');
      } catch (e) {
        log(`[magic-link] trigger: could not preserve browser state (${String(e.message || e).slice(0, 100)})`);
      }
    }
    return submitted;
  } catch (e) {
    log(`[magic-link] trigger failed: ${String(e.message || e).slice(0, 140)}`);
    return false;
  } finally {
    try {
      oauthWatcher?.cleanup();
    } catch {}
    try {
      if (page && cdpAttached) await page.close().catch(() => {});
    } catch {}
    try {
      if (ownsBrowser && browser) await browser.close();
      else if (cdpAttached && browser) await browser.close().catch(() => {});
    } catch {}
  }
}

/**
 * Autonomous path: apply gog-fetched magic link / code, then Authorize OAuth.
 * Prefer CDP :9222 (same real Chrome that passes Cloudflare for the email
 * trigger). Fall back to headed per-account profile on Mac.
 */
async function completeOAuthWithGogMagicLink(account, gogMagicLink, authUrl, localhostPort, proc) {
  const { chromium } = await import('playwright');
  const chromeBin =
    process.env.CLAUDE_ROT_CHROME_BIN ||
    [
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p) => existsSync(p));
  const profileDir = `ClaudeCode-${String(account.email || account.label || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  const profilePath = join(homedir(), 'Library/Application Support/Google/Chrome', profileDir);
  const useProfile = existsSync(profilePath) ? profilePath : join(tmpdir(), `claude-magic-auto-${process.pid}`);

  let ctx = null;
  let browser = null;
  let page = null;
  let cdpMode = false;
  let ownsBrowser = false;

  // Tier 1: CDP attach (CF-cleared Chrome already running for the trigger).
  try {
    const cdp = await tryConnectCDP(chromium);
    if (cdp?.page) {
      browser = cdp.browser;
      page = cdp.page;
      cdpMode = true;
      log('[magic-link-auto] completing OAuth via CDP Chrome');
    }
  } catch {}

  if (!page) {
    const headless = process.platform === 'darwin' ? false : process.env.CLAUDE_ROT_HEADED !== '1';
    try {
      ctx = await chromium.launchPersistentContext(useProfile, {
        headless,
        ...(chromeBin ? { executablePath: chromeBin } : {}),
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          ...NO_THROTTLE_FLAGS,
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: { width: 1280, height: 900 },
      });
      ownsBrowser = true;
      if (process.platform === 'darwin') {
        hideAutomationApp('Google Chrome Beta');
        hideAutomationApp('Google Chrome');
      }
      page = ctx.pages()[0] || (await ctx.newPage());
      log(`[magic-link-auto] completing OAuth via ${headless ? 'headless' : 'headed'} profile`);
    } catch (e) {
      log(`[magic-link] profile launch failed: ${String(e.message || e).slice(0, 120)}`);
      return false;
    }
  }

  const oauthWatcher = attachOAuthCallbackWatcher(page, localhostPort, log);
  try {
    const triggerState = magicLinkBrowserState.get(accountKey(account));
    if (triggerState?.cookies?.length) {
      try {
        await page.context().addCookies(triggerState.cookies);
        log(`[magic-link-auto] restored ${triggerState.cookies.length} trigger cookie(s)`);
      } catch (e) {
        log(`[magic-link-auto] trigger-cookie restore failed (${String(e.message || e).slice(0, 100)})`);
      }
    }
    if (String(gogMagicLink).startsWith('code:')) {
      await page.goto(authUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
      await sleep(2000);
      const code = String(gogMagicLink).replace('code:', '');
      for (const sel of [
        'input[autocomplete="one-time-code"]',
        'input[name="code"]',
        'input[inputmode="numeric"]',
        'input[type="text"]',
      ]) {
        try {
          const inp = page.locator(sel).first();
          if (await inp.isVisible({ timeout: 1500 })) {
            await inp.fill(code);
            log(`[magic-link] filled verification code via ${sel}`);
            break;
          }
        } catch {}
      }
      for (const label of ['Continue', 'Verify', 'Submit', 'Log in', 'Sign in']) {
        try {
          const btn = page.locator(`button:has-text("${label}")`).first();
          if (await btn.isVisible({ timeout: 1000 })) {
            await btn.click();
            log(`[magic-link] clicked ${label} after code`);
            break;
          }
        } catch {}
      }
      await sleep(2500);
    } else {
      await page.goto(gogMagicLink, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
      await sleep(2000);
      await prepareClaudePage(page, 'magic-link-visit');
      log(`[magic-link] magic-link visit landed: ${page.url().substring(0, 120)}`);
      // Wait for magic-link hash URL to resolve into a real session (not still on /magic-link).
      for (let i = 0; i < 15; i++) {
        const u = page.url();
        if (!u.includes('/magic-link')) {
          log(`[magic-link] session settled after magic-link: ${u.substring(0, 120)}`);
          break;
        }
        // Click through any continue buttons on the magic-link interstitial
        try {
          const cont = page
            .locator('button:has-text("Continue"), button:has-text("Log in"), button:has-text("Open Claude")')
            .first();
          if (await cont.isVisible({ timeout: 800 })) await cont.click();
        } catch {}
        await sleep(1500);
      }
    }

    if (authUrl) {
      try {
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      } catch {}
      await sleep(2500);
      await prepareClaudePage(page, 'oauth-authorize');
    } else {
      // patch 048-magic-link-2: authUrl may be null after BROWSER redact; rely on
      // cookies already set by magic-link visit to proceed.
      log('[magic-link-auto] skipping authorize goto (no authUrl); cookies should already be valid');
    }
    for (let step = 0; step < 24; step++) {
      await sleep(2000);
      const url = page.url();
      await prepareClaudePage(page, 'oauth-loop');
      log(`[magic-link-auto] step ${step}: ${url.substring(0, 120)}`);
      const shim = {
        _localhostPort: localhostPort,
        _authProc: proc,
        _oauthWatcher: oauthWatcher,
        _account: account,
      };
      if (await resolveOAuthFromBrowserUrl(url, shim)) {
        log('[magic-link-auto] OAuth resolved from browser URL');
        return true;
      }
      // Org chooser
      try {
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (/Select (?:which )?organization/i.test(text)) {
          const targetOrg = account.orgName || account.email;
          const orgBtn = page.locator(`button:has-text("${targetOrg}")`).first();
          if (await orgBtn.isVisible({ timeout: 1500 })) {
            await orgBtn.click();
            log(`[magic-link-auto] selected org "${targetOrg}"`);
            await sleep(1500);
          }
        }
      } catch {}
      // Authorize — match both /oauth/authorize and /redirect/.../oauth/authorize
      if (/oauth\/authorize/i.test(url) || /\/authorize\?/i.test(url)) {
        try {
          await maybeSolvePageCaptcha(page, 'magic-link-authorize');
          // Prefer explicit Authorize/Allow — do NOT grab bare type=submit first
          // (that often hits a hidden/disabled control and no-ops).
          let authBtn = page.locator('button:has-text("Authorize")').first();
          if (!(await authBtn.isVisible({ timeout: 1500 }).catch(() => false))) {
            authBtn = page.locator('button:has-text("Allow"), button:has-text("Approve")').first();
          }
          if (await authBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
            const label = (await authBtn.innerText().catch(() => 'Authorize')).replace(/\s+/g, ' ').slice(0, 40);
            await authBtn.scrollIntoViewIfNeeded().catch(() => {});
            await authBtn.click({ timeout: 5000, force: true }).catch(async () => {
              await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button')];
                const b = btns.find((x) => /authorize|allow|approve/i.test((x.textContent || '').trim()));
                if (b) b.click();
              });
            });
            log(`[magic-link-auto] clicked Authorize ("${label}")`);
            // Prefer navigation to localhost/callback over long blind wait
            try {
              await page.waitForURL(
                (u) => {
                  const s = String(u);
                  // Must not match authorize URL which always has code=true + redirect_uri=localhost
                  if (/oauth\/authorize/i.test(s) && !/localhost:\d+/.test(s)) return false;
                  return (
                    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(s) ||
                    /oauth\/code\/(callback|success)/i.test(s) ||
                    s.startsWith('chrome-error:')
                  );
                },
                { timeout: 12_000 },
              );
              log(`[magic-link-auto] post-Authorize nav: ${page.url().substring(0, 120)}`);
            } catch {
              log(`[magic-link-auto] post-Authorize still at: ${page.url().substring(0, 120)}`);
            }
            if (
              await finalizeOAuthFromDriver(shim, {
                waitCaptureMs: Math.min(MAGIC_AUTHORIZE_WAIT_MS, 25_000),
                procTimeoutMs: 35_000,
              })
            ) {
              return true;
            }
            try {
              if (await authBtn.isVisible({ timeout: 1500 })) {
                await authBtn.click({ force: true });
                log('[magic-link-auto] re-clicked Authorize');
                if (await finalizeOAuthFromDriver(shim, { waitCaptureMs: 20_000, procTimeoutMs: 30_000 })) {
                  return true;
                }
              }
            } catch {}
          } else if (step % 4 === 3) {
            const t = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 200);
            log(`[magic-link-auto] Authorize not visible yet text=${t.replace(/\s+/g, ' ').slice(0, 160)}`);
          }
        } catch (e) {
          if (step % 4 === 0) log(`[magic-link-auto] Authorize click err: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      // Login interstitial often shows hCaptcha before Authorize is reachable.
      // Solve captcha on /login too — not only on /oauth/authorize.
      if (/\/login/.test(url) || /selectAccount=true/i.test(url)) {
        try {
          await maybeSolvePageCaptcha(page, 'magic-link-login');
        } catch {}
        if (account.email) {
          try {
            const emailInp = page.locator('input[type="email"], input[name="email"]').first();
            if (await emailInp.isVisible({ timeout: 1500 })) {
              await emailInp.fill(account.email);
              const cont = page
                .locator('button:has-text("Continue"), button[type="submit"]')
                .filter({ hasNotText: /google|apple|sso|single sign/i })
                .first();
              if (await cont.isVisible({ timeout: 1000 })) await cont.click();
              await sleep(2000);
              // Second pass after Continue may re-present captcha / magic-link wait.
              await maybeSolvePageCaptcha(page, 'magic-link-login-post-continue');
            }
          } catch {}
        }
      }
      // chrome-error after Authorize often means localhost callback fired
      if (url.startsWith('chrome-error:') || url.startsWith('about:blank') || /localhost/.test(url)) {
        if (await finalizeOAuthFromDriver(shim, { waitCaptureMs: 12_000, procTimeoutMs: 18_000 })) {
          log('[magic-link-auto] finalized after chrome-error/localhost');
          return true;
        }
      }
    }
    if (
      await finalizeOAuthFromDriver(
        { _authProc: proc, _oauthWatcher: oauthWatcher, _localhostPort: localhostPort, _account: account },
        { waitCaptureMs: 15_000, procTimeoutMs: 20_000 },
      )
    ) {
      log('[magic-link-auto] finalized OAuth after loop');
      return true;
    }
    return false;
  } finally {
    magicLinkBrowserState.delete(accountKey(account));
    try {
      oauthWatcher.cleanup();
    } catch {}
    try {
      if (cdpMode && page) await page.close().catch(() => {});
    } catch {}
    try {
      // Playwright's CDP close can wait forever after Chrome has consumed a
      // localhost OAuth callback. Never let cleanup block the verified-token
      // save/sync path.
      if (cdpMode && browser) {
        await Promise.race([browser.close().catch(() => {}), sleep(3_000)]);
      } else if (ownsBrowser && ctx) await ctx.close();
    } catch {}
  }
}

async function tryProfileSessionAuth(account, authUrl, localhostPort, proc) {
  const key = accountKey(account);
  const profileDir = chromeProfileDirFor(key);
  const profilePath = chromeProfilePath(profileDir);
  if (!existsSync(profilePath)) {
    log(`[session-reuse] no existing profile for ${account.email} (${profileDir}) — full login`);
    return false;
  }
  if (isChromeProfileRunning(profileDir)) {
    log(`[session-reuse] profile ${profileDir} is in use by a running Chrome — skipping fast-path`);
    return false;
  }

  try {
    if (typeof ensureVirtualDisplay === 'function') await ensureVirtualDisplay((m) => log(m));
  } catch {}

  const { chromium } = await import('playwright');
  const chromeBin = REAL_BROWSERS.find((b) => existsSync(b.bin))?.bin;
  // Mac cookie encryption is keychain-bound; headless can't decrypt the profile
  // cookies, so run headful there (matches inject-magic-link.mjs). On Linux a
  // virtual display backs headless.
  const headless = process.platform !== 'darwin';

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profilePath, {
      headless,
      ...(chromeBin ? { executablePath: chromeBin } : {}),
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1280, height: 900 },
    });
  } catch (e) {
    log(`[session-reuse] could not launch profile context (${String(e?.message || e).slice(0, 100)}) — full login`);
    return false;
  }
  registerProfileCleanup(profilePath);
  const page = ctx.pages()[0] || (await ctx.newPage());
  const oauthWatcher = attachOAuthCallbackWatcher(page, localhostPort, log);

  try {
    log(`[session-reuse] probing existing session for ${account.email} via ${profileDir}`);
    // Navigate straight to the OAuth authorize URL on the profile's cookies.
    await page.goto(authUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
    await sleep(3000);

    let success = false;
    for (let step = 0; step < 16; step++) {
      await sleep(2000);
      const url = page.url();
      log(`[session-reuse] step ${step}: ${url.substring(0, 100)}`);

      // Dead session — login/magic-link page appeared. Bail BEFORE consuming proc.
      if (/\/login(?:[/?#]|$)/.test(url) || url.includes('/magic-link')) {
        log('[session-reuse] profile session not valid (hit login) — falling back to full login');
        return false;
      }

      const shimDriver = {
        _localhostPort: localhostPort,
        _authProc: proc,
        _oauthWatcher: oauthWatcher,
        _account: account,
      };
      if (await resolveOAuthFromBrowserUrl(url, shimDriver)) {
        success = true;
        break;
      }

      // Org chooser — pick the configured org (or fall back to the email).
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (text.includes('Select organization') || text.includes('Select which organization')) {
        const targetOrg = account.orgName || account.email;
        try {
          const orgBtn = page.locator(`button:has-text("${targetOrg}")`).first();
          if (await orgBtn.isVisible({ timeout: 3000 })) {
            await orgBtn.click();
            log(`[session-reuse] selected org "${targetOrg}"`);
            await sleep(2000);
          }
        } catch {}
      }

      // Authorize button.
      if (url.includes('/oauth/authorize')) {
        try {
          const authBtn = page.locator('button:has-text("Authorize"), button[type="submit"]').first();
          if (await authBtn.isVisible({ timeout: 2000 })) {
            await authBtn.click();
            log('[session-reuse] clicked Authorize');
            const shimAfterAuth = {
              _authProc: proc,
              _oauthWatcher: oauthWatcher,
              _localhostPort: localhostPort,
              _account: account,
            };
            // Autonomous: Authorize often needs more than 20s for localhost callback + claude auth login.
            if (
              await finalizeOAuthFromDriver(shimAfterAuth, {
                waitCaptureMs: MAGIC_AUTHORIZE_WAIT_MS,
                procTimeoutMs: MAGIC_AUTHORIZE_WAIT_MS + 15_000,
              })
            ) {
              success = true;
              break;
            }
            // Re-click Authorize once if still on the page (SPA re-render / missed click).
            try {
              const authBtn2 = page.locator('button:has-text("Authorize"), button[type="submit"]').first();
              if (await authBtn2.isVisible({ timeout: 1500 })) {
                await authBtn2.click();
                log('[session-reuse] re-clicked Authorize after incomplete finalize');
                if (
                  await finalizeOAuthFromDriver(shimAfterAuth, {
                    waitCaptureMs: MAGIC_AUTHORIZE_WAIT_MS,
                    procTimeoutMs: MAGIC_AUTHORIZE_WAIT_MS + 15_000,
                  })
                ) {
                  success = true;
                  break;
                }
              }
            } catch {}
            // chrome-error / about:blank after click often means callback succeeded
            const postUrl = page.url();
            if (
              postUrl.startsWith('chrome-error:') ||
              postUrl.startsWith('about:blank') ||
              postUrl.includes('localhost')
            ) {
              if (await finalizeOAuthFromDriver(shimAfterAuth, { waitCaptureMs: 15_000, procTimeoutMs: 20_000 })) {
                log('[session-reuse] finalized OAuth after chrome-error/localhost post-Authorize');
                success = true;
                break;
              }
            }
            await sleep(2000);
          }
        } catch {}
      }
    }

    if (
      !success &&
      (await finalizeOAuthFromDriver({
        _authProc: proc,
        _oauthWatcher: oauthWatcher,
        _localhostPort: localhostPort,
        _account: account,
      }))
    ) {
      log('[session-reuse] claude auth login completed despite browser chrome-error');
      success = true;
    }

    if (!success) {
      log('[session-reuse] authorize flow did not complete from profile session — falling back to full login');
      return false;
    }

    // Let `claude auth login` write the active keychain from the replayed callback.
    await new Promise((r) => {
      const t = setTimeout(() => r(), 30_000);
      proc.on('exit', () => {
        clearTimeout(t);
        r();
      });
      if (proc.exitCode !== null) {
        clearTimeout(t);
        r();
      }
    });
    await sleep(1500);
    return true;
  } finally {
    oauthWatcher.cleanup();
    try {
      await ctx.close();
    } catch {}
    unregisterProfileCleanup(profilePath);
    try {
      execFileSync('pkill', ['-f', profilePath], { timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {}
  }
}

// ── Browser OAuth fallback ────────────────────────────────────────────────────

/** Read active OAuth from file AND keychain; prefer the newer expiry. */
function readActiveOAuthJsonBestEffort() {
  const candidates = [];
  // 1) Claude Code file slot
  try {
    if (existsSync(LINUX_CRED_PATH)) {
      const store = JSON.parse(readFileSync(LINUX_CRED_PATH, 'utf8'));
      if (store?.claudeAiOauth) {
        candidates.push(JSON.stringify({ claudeAiOauth: store.claudeAiOauth, mcpOAuth: store.mcpOAuth || {} }));
      }
    }
  } catch {}
  // 2) macOS keychain active slot (security) — OAuth often lands here first
  if (!IS_LINUX) {
    try {
      const result = spawnSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ACTIVE_KEYCHAIN_ACCOUNT, '-w'],
        { timeout: 5_000, encoding: 'utf8' },
      );
      const raw = (result.stdout || '').trim();
      if (raw && raw.includes('claudeAiOauth')) candidates.push(raw);
    } catch {}
  }
  if (!candidates.length) {
    try {
      return readKeychain();
    } catch {
      return null;
    }
  }
  // Prefer highest expiresAt (the one OAuth just wrote)
  let best = candidates[0];
  let bestExp = 0;
  for (const c of candidates) {
    try {
      const exp = Number(JSON.parse(c)?.claudeAiOauth?.expiresAt || 0);
      if (exp >= bestExp) {
        bestExp = exp;
        best = c;
      }
    } catch {}
  }
  return best;
}

async function waitForFreshOAuthCredential(beforeToken, deadline, phase, account = null) {
  let waitMs = MAGIC_FRESH_TOKEN_WAIT_MS;
  try {
    waitMs = deadline?.budget ? deadline.budget(phase, MAGIC_FRESH_TOKEN_WAIT_MS) : MAGIC_FRESH_TOKEN_WAIT_MS;
  } catch {
    waitMs = Math.min(MAGIC_FRESH_TOKEN_WAIT_MS, 45_000);
  }
  waitMs = Math.min(waitMs, 60_000); // hard cap — never hang the reauth path
  const endsAt = Date.now() + waitMs;
  let reason = 'missing-token';
  let lastLog = 0;
  while (Date.now() < endsAt) {
    let candidateJson = null;
    let candidate = null;
    try {
      candidateJson = readActiveOAuthJsonBestEffort();
      candidate = tokenSnapshot(candidateJson);
    } catch (e) {
      reason = `read-error:${String(e.message || e).slice(0, 40)}`;
    }
    const result = evaluateFreshToken(beforeToken, candidate);
    reason = result.reason;
    if (result.ok) {
      log(`[fresh-token] OAuth produced a changed, unexpired credential after ${phase}`);
      // Always mirror active → vault for this account so keep-alive/CRS see the new refresh_token
      if (account && candidateJson) {
        try {
          const parsed = JSON.parse(candidateJson);
          const clean = JSON.stringify({
            claudeAiOauth: parsed.claudeAiOauth,
            mcpOAuth: {},
          });
          writeStoredToken(account, clean);
          syncStoredTokenToCrs(account);
          log(`[fresh-token] mirrored active → vault ${accountKey(account)}`);
        } catch (e) {
          log(`[fresh-token] vault mirror failed: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      return true;
    }
    if (Date.now() - lastLog > 8_000) {
      log(`[fresh-token] waiting… reason=${reason} (${Math.round((endsAt - Date.now()) / 1000)}s left)`);
      lastLog = Date.now();
    }
    await sleep(Math.min(400, Math.max(1, endsAt - Date.now())));
  }
  log(`[fresh-token] OAuth result rejected after ${phase}: ${reason}`);
  return false;
}

async function browserOAuthFallback(account) {
  log(`[fallback] Browser OAuth for ${account.email}...`);
  const deadline = createDeadline(MAGIC_TOTAL_MS);
  const driverTimeoutMs = Number(process.env.CLAUDE_ROT_AUTH_DRIVER_TIMEOUT_MS || 180_000);
  let beforeToken = null;
  try {
    beforeToken = tokenSnapshot(readKeychain());
  } catch {}
  if (account.useMagicLink) requireMagicLinkInboxReady(deadline);

  // mkdtempSync creates a directory with a cryptographically-random suffix,
  // mode 0700 (this user only) — nothing predictable a local attacker could
  // pre-plant a symlink at, unlike a pid-based filename. capScript gets
  // chmod'd executable and run as $BROWSER, so this is the one that matters most.
  const capDir = mkdtempSync(join(tmpdir(), 'claude-url-cap-'));
  const capScript = join(capDir, 'capture.sh');
  const urlFile = join(capDir, 'url.txt');
  // #!/bin/sh works on both macOS (Bourne shell) and Linux (dash/bash) — the
  // script just echoes the URL to a file and exits so `claude auth login`
  // thinks "browser opened and closed" and proceeds to wait for the
  // localhost callback.
  writeFileSync(capScript, `#!/bin/sh\necho "$1" > "${urlFile}"\nsleep 600\n`, { flag: 'wx' });
  chmodSync(capScript, 0o755);

  const oauthLoginEnv = { ...process.env, BROWSER: capScript };
  // `claude auth login` must talk to Anthropic directly. Inheriting the CRS
  // client route/key makes the CLI consider the relay credential sufficient,
  // exit 0, and leave the previous account token untouched.
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_BASE',
  ])
    delete oauthLoginEnv[name];
  const proc = spawn('claude', ['auth', 'login', '--email', account.email], {
    env: oauthLoginEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.on('error', (err) => {
    logger.error('Failed to spawn subprocess:', err);
  });

  // BROWSER script gets the URL with localhost redirect (what we want).
  // stderr gets a fallback URL with platform.claude.com redirect (don't use that).
  // Prefer the file-captured URL — wait up to 15s for it, then fall back to stdout.
  let authUrl = null;
  const authCaptureEndsAt = Date.now() + deadline.budget('auth URL capture', 30_000);
  while (Date.now() < authCaptureEndsAt) {
    await sleep(Math.min(500, Math.max(1, authCaptureEndsAt - Date.now())));
    if (existsSync(urlFile)) {
      const u = readFileSync(urlFile, 'utf8').trim();
      try {
        unlinkSync(urlFile);
      } catch {}
      // Claude CLI may intentionally pass `https://claude.ai/[redacted]` to
      // custom BROWSER handlers. That placeholder is not navigable and caused
      // the automator to loop forever on a literal /[redacted] page. Reject it
      // and use the real fallback URL from CLI output instead.
      if (u.startsWith('http') && !/\[redacted\]/i.test(u)) {
        authUrl = u;
        break;
      }
    }
  }
  if (!authUrl) {
    // Fallback: parse from stderr (has platform.claude.com redirect, but still works)
    authUrl = await new Promise((resolve) => {
      const scan = (d) => {
        const urls = d.toString().match(/https?:\/\/[^\s\])"'\n]+/g) || [];
        const usable = urls.find((url) => !/\[redacted\]/i.test(url));
        if (usable) resolve(usable);
      };
      proc.stdout.on('data', scan);
      proc.stderr.on('data', scan);
      setTimeout(() => resolve(null), deadline.budget('auth URL stderr capture', 15_000));
    });
  }
  try {
    rmSync(capDir, { recursive: true, force: true });
  } catch {}

  if (!authUrl) {
    // patch 048-magic-link-1: BROWSER handler redacted the URL claude-cli emits.
    // Build a fresh OAuth authorize URL from OAUTH_CLIENT_ID as a fallback —
    // the magic-link flow will set cookies via gogMagicLink, so this authorize URL
    // can complete without re-triggering an email.
    if (account.useMagicLink) {
      const port = 54680; // default claude-cli auth login port
      const redirectUri = `http://localhost:${port}/callback`;
      const scope =
        'org:create_api_key+user:profile+user:inference+user:sessions:claude_code+user:mcp_servers+user:file_upload';
      authUrl = `https://claude.ai/oauth/authorize?code=true&client_id=${OAUTH_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(Math.random().toString(36).slice(2))}&login_hint=${encodeURIComponent(account.email)}`;
      localhostPort = port;
      log('[magic-link] authUrl was redacted; constructed fallback OAuth URL from OAUTH_CLIENT_ID');
    } else {
      proc.kill();
      return false;
    }
  }
  log('Auth URL captured');

  // Extract localhost port from redirect_uri in the auth URL for code replay
  const portMatch = authUrl.match(/redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/);
  const localhostPort = portMatch ? portMatch[1] : null;
  log(`Localhost callback port: ${localhostPort || 'unknown'}`);

  // ── Autonomous magic-link (always-on background path) ─────────────────────
  // BROWSER=capture only records the OAuth URL — it does NOT fill the Claude
  // login form, so Anthropic never sends mail unless we submit the form.
  // Order: brief gog peek → Playwright trigger (CDP/headed) → gog poll →
  // complete OAuth in account Chrome profile (headed on Mac).
  // Kill-switch: CLAUDE_ROT_NO_GOG_MAGICLINK=1.
  if (process.env.CLAUDE_ROT_NO_GOG_MAGICLINK !== '1') {
    try {
      // Brief preflight peek only (default 8s) — no email expected yet unless a
      // prior attempt already requested one. Full poll is after email trigger.
      const peekMs = Number(process.env.CLAUDE_ROT_MAGIC_PEEK_MS || 8_000);
      log(
        `[magic-link] preflight Gmail peek ≤${Math.round(Math.min(peekMs, MAGIC_GMAIL_PHASE_MS) / 1000)}s (not full poll)`,
      );
      let gogMagicLink = await pollGmailForMagicLink(
        account.email,
        deadline.budget('Gmail preflight peek', Math.min(peekMs, MAGIC_GMAIL_PHASE_MS)),
      );
      if (!gogMagicLink) {
        const triggered = await triggerMagicLinkEmailSend(account, authUrl, {
          localhostPort,
          proc,
        });
        if (triggered === 'oauth-complete') {
          log(`[magic-link] ✓ autonomous OAuth complete via CDP consent for ${account.email}`);
          return true;
        }
        if (triggered === 'session-ready') {
          log('[magic-link] session-ready but CDP Authorize incomplete — short peek then cascade');
          gogMagicLink = await pollGmailForMagicLink(
            account.email,
            deadline.budget('Gmail session-ready peek', Math.min(15_000, MAGIC_POLL_MS)),
          );
        } else if (triggered) {
          log(`[magic-link] email trigger ok — polling Gmail up to ${MAGIC_POLL_MS / 1000}s`);
          gogMagicLink = await pollGmailForMagicLink(
            account.email,
            deadline.budget('Gmail polling', Math.min(MAGIC_POLL_MS, MAGIC_GMAIL_PHASE_MS)),
          );
        } else {
          const shortMs = Math.min(20_000, MAGIC_POLL_MS);
          log(`[magic-link] email trigger inconclusive — short Gmail peek ${shortMs / 1000}s then Authorize path`);
          gogMagicLink = await pollGmailForMagicLink(account.email, deadline.budget('Gmail fallback peek', shortMs));
        }
      } else {
        log('[magic-link] found in-flight login email on brief peek — skipping re-trigger');
      }
      if (gogMagicLink) {
        log(
          `[magic-link] ✓ fetched ${gogMagicLink.startsWith('code:') ? 'verification code' : 'login link'} from gog — completing in account profile (autonomous)`,
        );
        try {
          const completed = await withDeadline(
            () => completeOAuthWithGogMagicLink(account, gogMagicLink, authUrl, localhostPort, proc),
            deadline,
            'gog browser completion',
            MAGIC_AUTHORIZE_WAIT_MS,
            { onTimeout: () => proc.kill('SIGTERM') },
          );
          if (completed) {
            log(`[magic-link] autonomous gog→profile OAuth callback complete for ${account.email}`);
            const fresh = await waitForFreshOAuthCredential(beforeToken, deadline, 'gog browser completion', account);
            if (!fresh) proc.kill('SIGTERM');
            return fresh;
          }
        } catch (e) {
          if (e instanceof RotationSafetyError) {
            proc.kill('SIGTERM');
            throw e;
          }
          log(
            `[magic-link] autonomous gog completion failed (${String(e.message || e).slice(0, 120)}) — cascade continues`,
          );
        }
      }
    } catch (e) {
      if (e instanceof RotationSafetyError) {
        proc.kill('SIGTERM');
        throw e;
      }
      log(`[magic-link] gog-prewarm errored (${String(e?.message || e).slice(0, 120)}) — continuing`);
    }
  }

  // Fast-path: if the account's own Chrome profile is still logged into
  // claude.ai, authorize straight off those cookies — no email, no magic-link,
  // no Gmail poll. Fail-open: returns false (without consuming the OAuth
  // callback) whenever the profile is absent, busy, or its session is dead, so
  // the normal cascade below runs unchanged. Kill-switch: CLAUDE_ROT_NO_SESSION_REUSE=1.
  // Also skipped in scraping-browser mode — session-reuse launches a headed LOCAL
  // Chrome profile, which needs the macOS GUI we are specifically avoiding; let
  // the remote driver handle authorization instead.
  if (process.env.CLAUDE_ROT_ALLOW_SESSION_REUSE === '1' && !scrapingBrowserEnabled()) {
    try {
      const reused = await withDeadline(
        () => tryProfileSessionAuth(account, authUrl, localhostPort, proc),
        deadline,
        'profile session reuse',
        MAGIC_AUTHORIZE_WAIT_MS,
        { onTimeout: () => proc.kill('SIGTERM') },
      );
      if (reused) {
        log(`[session-reuse] OAuth callback completed for ${account.email}`);
        const fresh = await waitForFreshOAuthCredential(beforeToken, deadline, 'profile session reuse', account);
        if (!fresh) proc.kill('SIGTERM');
        return fresh;
      }
    } catch (e) {
      log(`[session-reuse] fast-path errored (${String(e?.message || e).slice(0, 120)}) — falling back to full login`);
    }
  }

  // Cascade: try each driver in order until one completes the OAuth flow.
  // A driver "fails" if runAuthFlow returns false (URL never reaches localhost callback).
  const failed = new Set();
  let success = false;

  while (!success) {
    let driver;
    try {
      driver = await getBrowserDriver(failed);
    } catch (err) {
      log(`Cascade exhausted: ${err.message}`);
      break;
    }
    driver._localhostPort = localhostPort;
    driver._authUrl = authUrl;
    driver._authProc = proc;
    driver._account = account;
    driver._rotationDeadline = deadline;

    try {
      log(`[${driver._driverName}] Logging out existing claude.ai session...`);
      if (driver._ctx) {
        try {
          // Clear EVERY auth-related domain. The OAuth authorize URL lives on
          // claude.com (https://claude.com/cai/oauth/authorize?...), so clearing
          // only .claude.ai / .platform.claude.com leaves a stale claude.com
          // session from a previous account — which then gets Authorize'd as the
          // wrong account (mismatch). Include claude.com + anthropic.com.
          for (const domain of [
            '.claude.ai',
            'claude.ai',
            '.claude.com',
            'claude.com',
            '.platform.claude.com',
            'platform.claude.com',
            '.anthropic.com',
            'anthropic.com',
          ]) {
            try {
              await driver._ctx.clearCookies({ domain });
            } catch {}
          }
          log(
            `[${driver._driverName}] Cookies cleared for claude.ai / claude.com / platform.claude.com / anthropic.com`,
          );
        } catch (cookieErr) {
          log(`[${driver._driverName}] Failed to clear cookies: ${cookieErr.message}`);
        }
      }
      try {
        await driver.goto('https://claude.ai/api/auth/logout');
      } catch {}
      await sleep(1500);
      try {
        await driver.goto('https://claude.ai/logout');
      } catch {}
      await sleep(1500);
      try {
        if (driver._page) {
          await Promise.race([
            driver._page
              .evaluate(() => {
                try {
                  localStorage.clear();
                  sessionStorage.clear();
                } catch (_e) {}
              })
              .catch(() => {}),
            sleep(5000),
          ]);
          log(`[${driver._driverName}] LocalStorage/SessionStorage cleared for claude.ai`);
        }
      } catch (storageErr) {
        log(`[${driver._driverName}] Failed to clear local storage: ${storageErr.message}`);
      }

      // Page may have been destroyed by logout redirect — try navigating,
      // and if the page is dead, get a fresh driver (new tab)
      try {
        await driver.goto(authUrl);
        const postAuthUrl = await driver.currentUrl().catch(() => '');
        if (/\/logout(?:[/?#]|$)|\/\[redacted\](?:[/?#]|$)/i.test(postAuthUrl)) {
          log(`[${driver._driverName}] authorize redirected to a dead logout route — forcing account login`);
          await driver.goto(buildAccountLoginUrl(account, authUrl));
        }
      } catch (navErr) {
        log(`[${driver._driverName}] Page died after logout (${navErr.message}) — getting fresh driver`);
        try {
          await driver.close();
        } catch {}
        try {
          driver = await getBrowserDriver(failed);
          driver._localhostPort = localhostPort;
          driver._authUrl = authUrl;
          driver._authProc = proc;
          driver._account = account;
          driver._rotationDeadline = deadline;
          await driver.goto(authUrl);
        } catch (freshErr) {
          log(`[${driver._driverName}] Fresh driver also failed: ${freshErr.message}`);
          failed.add(driver._driverName || 'unknown');
          continue;
        }
      }
      success = await withDeadline(
        () => runAuthFlow(driver, account),
        deadline,
        `auth driver ${driver._driverName || 'unknown'}`,
        driverTimeoutMs,
        {
          onTimeout: () => {
            proc.kill('SIGTERM');
            driver.close().catch(() => {});
          },
        },
      );

      if (success) {
        await maybeScrapeBillingAfterOAuth(driver, account, log);
      }

      if (!success) {
        log(`[${driver._driverName}] runAuthFlow returned false — trying next driver`);
        failed.add(driver._driverName);
        continue;
      }

      // Wait for claude auth login process to finish writing the keychain.
      // Belt-and-suspenders: SIGKILL after the grace period AND on any
      // exception path below. Without the explicit kill, a stuck `claude auth
      // login` TTY can keep a "Sign in to Claude.ai" prompt visible on the
      // user's terminal long after the rotation completes (observed 2026-07-02:
      // 5 zombie auth login procs from foundation rotation attempts).
      await new Promise((r) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
          r();
        }, 30_000);
        proc.on('exit', () => {
          clearTimeout(t);
          r();
        });
        if (proc.exitCode !== null) {
          clearTimeout(t);
          r();
        }
      });
      // Final defensive kill — proc may have exited but `claude-real` TTY child
      // could still be alive. Don't leave it holding the user's terminal.
      try {
        if (proc.exitCode === null || (proc.exitCode !== 0 && proc.exitCode !== null)) {
          proc.kill('SIGKILL');
        }
        // Also kill any orphan children (the claude-real TTY host)
        for (const child of proc.children || []) {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {}
        }
      } catch {}
    } catch (err) {
      if (err instanceof RotationSafetyError) throw err;
      log(`[${driver._driverName}] threw: ${err.message}`);
      failed.add(driver._driverName);
    } finally {
      try {
        await driver.close();
      } catch {}
      // Always reap the proc — even on early-exit / exception paths. Without
      // this, every failed rotation leaks one `claude auth login` TTY holding
      // a login prompt in the user's background.
      try {
        proc.kill('SIGKILL');
      } catch {}
      for (const child of proc.children || []) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {}
      }
    }
  }

  if (!success) return false;
  return await waitForFreshOAuthCredential(beforeToken, deadline, 'driver completion', account);
}

// ── Session restart via tmux ─────────────────────────────────────────────────

function findClaudeSessions() {
  const sessions = [];
  try {
    // Use pid,args only — no tty column. On macOS, background processes show
    // tty as "??" which never matches the ttys?\d+ pattern, and the old
    // `grep -` (empty pattern) at the end of the pipeline caused the whole
    // execSync to throw "Command failed" on every call.
    // ps -eo pid,args works identically on macOS (BSD) and Linux (GNU).
    //
    // Match ANY claude CLI process, not just `--dangerously-skip-permissions`
    // ones — plain interactive sessions, `claude --resume`, and headless
    // `claude -p` runs all hold tokens that go stale after rotation (observed
    // 2026-06-11: live agent sessions were invisible to this enum and wedged
    // on the expired outgoing token). The first ps token must BE the claude
    // binary — matching `claude` anywhere in args would false-positive on
    // `tail -f .../claude/...log`, `node .../account-rotation/daemon.mjs`, etc.
    // Utility invocations (daemon supervisor, respawn/attach/logs/agents, mcp)
    // are excluded here; daemon-hosted bg sessions are refreshed separately
    // via respawnBgSessions() (they have no TTY to inject /login into).
    const psRaw = execSync(`ps -eo pid,args | grep -E '[c]laude' | grep -v 'grep'`, {
      timeout: 5000,
    })
      .toString()
      .trim();
    const CLAUDE_CMD_RE = /^(?:\S*\/)?claude(?:\s|$)/;
    const UTILITY_SUBCMD_RE = /^(?:\S*\/)?claude\s+(?:daemon|respawn|attach|logs|agents|mcp|doctor|update|config)\b/;
    const psOut = psRaw
      .split('\n')
      .filter((line) => {
        const args = line.trim().replace(/^\d+\s+/, '');
        return CLAUDE_CMD_RE.test(args) && !UTILITY_SUBCMD_RE.test(args);
      })
      .join('\n');
    if (!psOut) return sessions;

    // Build pid→tty map from tmux (best-effort; tty used only for tmux pane lookup)
    const ttyByPid = {};
    try {
      const paneOut = execSync(
        `tmux list-panes -a -F '#{pane_pid}|#{pane_tty}|#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null`,
        { timeout: 3000 },
      )
        .toString()
        .trim();
      for (const line of paneOut.split('\n')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const [panePid, tty, pane] = parts;
          if (panePid && tty && pane) ttyByPid[panePid.trim()] = { tty: tty.trim(), pane: pane.trim() };
        }
      }
    } catch {}

    // Load session state files to detect bg sessions (kind: 'bg')
    const sessionStateDir = join(homedir(), '.claude', 'sessions');
    const bgPids = new Set();
    try {
      for (const f of readdirSync(sessionStateDir).filter((f) => f.endsWith('.json'))) {
        try {
          const s = JSON.parse(readFileSync(join(sessionStateDir, f), 'utf8'));
          if (s.kind === 'bg' && s.pid) bgPids.add(String(s.pid));
        } catch {}
      }
    } catch {}

    for (const line of psOut.split('\n')) {
      // Format: "  <pid> <args...>"
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, args] = match;
      const tmux = ttyByPid[pid] || null;
      const tty = tmux?.tty || null;
      const pane = tmux?.pane || null;
      const resumeMatch = args.match(/--resume\s+(\S+)/);
      const resumeId = resumeMatch ? resumeMatch[1] : null;
      const isBg = bgPids.has(pid);
      sessions.push({ pid: parseInt(pid, 10), tty, pane, resumeId, args, isBg });
    }
  } catch (e) {
    log(`[session] Failed to enumerate sessions: ${e.message.substring(0, 80)}`);
  }
  return sessions;
}

function sendKeysToPane(pane, txt) {
  if (!pane) return false;
  try {
    execSync(`tmux send-keys -t ${JSON.stringify(pane)} ${JSON.stringify(txt)} C-m 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function sendKeysToITerm(tty, txt) {
  // Send text to an iTerm2 session matched by its TTY device path.
  // IMPORTANT: Use `tell s to write text cmd` — the `write text "..." in s`
  // form fails with -1723 ("Can't get ... in s. Access not allowed.") because
  // AppleScript parses the `in s` clause as an accessor lookup, not a target.
  const escaped = txt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          tell s to write text "${escaped}"
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 })
      .toString()
      .trim();
    return result === 'ok';
  } catch {
    return false;
  }
}

// Inject `txt` (e.g. "/login") into Ghostty terminals via System Events keystroke.
// Ghostty has NO scripting dictionary (no `write text` like iTerm2) and a raw TTY
// write renders as on-screen output, not stdin. System Events `keystroke` is the
// only native path that actually reaches the program's stdin — it simulates real
// keypresses into the focused tab of each Ghostty window.
//
// Coverage limit: hits the FOCUSED tab of every Ghostty window. Multiple Claude
// sessions stacked as tabs in one window → only the focused tab re-auths. For full
// coverage run Claude under tmux (the sendKeysToPane path then covers every pane).
//
// Requires Accessibility + Automation (TCC) permission for the node binary running
// this; without it macOS silently no-ops or errors. Disable via
// CLAUDE_ROTATE_NO_GHOSTTY=1 if it ever mis-types into a non-Claude tab.
// Returns the number of windows injected (0 = nothing / blocked).
function injectLoginToGhostty(txt) {
  if (process.env.CLAUDE_ROTATE_NO_GHOSTTY === '1') return 0;
  const escaped = txt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "Ghostty" to activate
delay 0.25
tell application "System Events"
  if not (exists process "Ghostty") then return "0"
  tell process "Ghostty"
    set n to count of windows
    repeat with i from 1 to n
      try
        perform action "AXRaise" of window i
        delay 0.2
        keystroke "${escaped}"
        delay 0.05
        key code 36
        delay 0.45
      end try
    end repeat
    return (n as string)
  end tell
end tell`;
  try {
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 20_000 })
      .toString()
      .trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

// Walk up the process tree from `pid` and return the terminal app that owns
// the session (e.g. "Ghostty", "iTerm2", "Terminal", "Alacritty", "WezTerm")
// or "unknown" if none matched. Used to gate AppleScript injection to
// terminals we know actually support it without launching a new app.
function detectTerminalForPid(pid) {
  try {
    const out = execSync(`ps -eo pid,ppid,comm`, { timeout: 3000 }).toString().trim();
    const byPid = new Map();
    for (const line of out.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (m) byPid.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), comm: m[3] });
    }
    let cur = parseInt(pid, 10);
    for (let i = 0; i < 40 && cur > 1; i++) {
      const entry = byPid.get(cur);
      if (!entry) break;
      const c = entry.comm.toLowerCase();
      if (c.includes('ghostty')) return 'Ghostty';
      if (c.includes('iterm2') || c.includes('iterm')) return 'iTerm2';
      if (c.includes('terminal.app') || /\/terminal$/.test(c)) return 'Terminal';
      if (c.includes('alacritty')) return 'Alacritty';
      if (c.includes('wezterm')) return 'WezTerm';
      if (c.includes('kitty')) return 'kitty';
      cur = entry.ppid;
    }
  } catch {}
  return 'unknown';
}

async function refreshRunningSession(rotatedAccount = null, noBrowser = false) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sessions = findClaudeSessions();

  if (sessions.length === 0) {
    log('[session] No running Claude Code sessions found');
    return;
  }

  // Daemon-hosted `claude --bg` sessions are owned by the respawnBgSessions()
  // path (they have no TTY for /login injection and `claude respawn` is the only
  // supported refresh). They MUST NOT fall through to the interactive
  // injection/skip logic below — doing so mislabels a tracked bg session as an
  // "unknown" terminal with "no safe inject path", which is both wrong and
  // alarming. Partition them out up front.
  const bg = sessions.filter((s) => s.isBg);
  const interactive = sessions.filter((s) => !s.isBg);
  if (bg.length > 0) {
    const gateOn = process.env.CLAUDE_ENABLE_BG_RESPAWN === '1';
    log(
      `[session] ${bg.length} bg session(s) (${bg.map((s) => s.pid).join(', ')}) handled by bg-respawn path` +
        (gateOn ? '' : ' — currently gated off (set CLAUDE_ENABLE_BG_RESPAWN=1 to refresh them)'),
    );
  }

  // Tag each interactive session with its owning terminal app. We only have a
  // reliable AppleScript injection path for tmux + iTerm2. For Ghostty/Terminal/
  // others, writing to the raw TTY shows as OUTPUT (garbles the live display) and
  // `tell application "iTerm2"` would spuriously *launch* iTerm2 — so we skip.
  for (const s of interactive) {
    if (!s.pane && s.pid) s.terminal = detectTerminalForPid(s.pid);
  }

  const sendKeys = (s, txt) => {
    if (s.pane) return sendKeysToPane(s.pane, txt);
    if (s.terminal === 'iTerm2' && s.tty) return sendKeysToITerm(s.tty, txt);
    // Ghostty, Terminal.app, Alacritty, WezTerm, kitty, unknown: skip.
    // Raw TTY write would render "/login" as on-screen output text, not
    // stdin — corrupting the session without triggering the re-auth.
    return false;
  };

  // Reachable = tmux pane OR known-good terminal (iTerm2). Ghostty is handled
  // separately below via System Events keystroke (no scripting dictionary, and a
  // raw TTY write would garble its display). Everyone else is logged + skipped.
  const reachable = interactive.filter((s) => s.pane || (s.terminal === 'iTerm2' && s.tty));
  const ghostty = interactive.filter((s) => !s.pane && s.terminal === 'Ghostty');
  const skipped = interactive.filter(
    (s) => !s.pane && s.terminal && s.terminal !== 'iTerm2' && s.terminal !== 'Ghostty',
  );
  for (const s of skipped) {
    // Non-bg sessions with no injectable TTY: the desktop app's own main
    // process, headless `claude -p` runs, or unsupported terminals. None take a
    // /login keystroke safely; the desktop app manages its own auth and `-p`
    // runs are ephemeral, so skipping is correct.
    log(`[session] Skipping PID ${s.pid} (${s.terminal}) — no safe /login inject path (not a tmux/iTerm2 session)`);
  }

  // Ghostty: one System Events pass injects /login into the focused tab of every
  // Ghostty window — covers all detected Ghostty sessions at once (per-window).
  if (ghostty.length > 0) {
    const n = injectLoginToGhostty('/login');
    if (n > 0) {
      log(`[session] Ghostty: injected /login into ${n} window(s) (${ghostty.length} session(s) detected)`);
    } else {
      log(
        `[session] Ghostty: ${ghostty.length} session(s) but injection did nothing — grant Accessibility + Automation (TCC) to the node binary, or run Claude under tmux for full per-pane coverage`,
      );
    }
  }

  if (reachable.length === 0) {
    if (ghostty.length === 0 && interactive.length > 0)
      log(`[session] Found ${interactive.length} interactive session(s) but none have a reachable TTY`);
    return;
  }

  log(`[session] Injecting /login into ${reachable.length} session(s):`);
  for (const s of reachable) {
    log(`  PID ${s.pid} ${s.pane ? 'pane=' + s.pane : 'tty=' + s.tty}`);
  }

  // Keychain was already swapped to the fresh account's valid token.
  // /login re-reads the keychain → picks up the new token → "Login successful" instantly.
  // No /exit, no process restart, no OAuth browser flow needed (token is already valid).
  // Stagger between sessions so the fleet doesn't all hit the new account at once
  // (simultaneous re-auth = instant rate-limit on the single new account).
  for (let i = 0; i < reachable.length; i++) {
    const s = reachable[i];
    if (sendKeys(s, '/login')) {
      log(`[session] Sent /login to PID ${s.pid} (${s.pane || s.tty})`);
    } else {
      log(`[session] Failed to inject /login to PID ${s.pid} (${s.pane || s.tty})`);
    }
    if (i < reachable.length - 1) await sleep(SESSION_STAGGER_MS || 500);
  }

  // If Claude relaunches trigger an OAuth browser window (token expired mid-rotation),
  // reuse the same browser driver that handles the initial auth flow.
  // Skipped in --no-browser mode (daemon) — token refresh daemon keeps tokens fresh,
  // so this fallback should never be needed from automatic rotations.
  if (!noBrowser) {
    try {
      await sleep(2000);
      const driver = await getBrowserDriver(new Set()).catch(() => null);
      if (driver) {
        const url = await driver.currentUrl().catch(() => '');
        if (url && (url.includes('oauth') || url.includes('authorize') || url.includes('claude.ai/login'))) {
          log(`[session] Detected post-restart OAuth page (${url.substring(0, 60)}) — driving flow`);
          if (rotatedAccount) {
            const authOk = await runAuthFlow(driver, rotatedAccount);
            if (authOk) await maybeScrapeBillingAfterOAuth(driver, rotatedAccount, log);
          }
        }
        try {
          await driver.close?.();
        } catch {}
      }
    } catch (e) {
      log(`[session] Post-restart browser check skipped: ${e.message.substring(0, 60)}`);
    }
  }

  log(`[session] Restart complete: ${reachable.length} session(s) cycled`);
}

// ── Main rotation ─────────────────────────────────────────────────────────────

async function rotate(targetEmail, opts = {}) {
  const config = readConfig();
  const state = readState();
  const dryRun = opts.dryRun || false;

  // Live util is needed for picker (no target) and destination-cap validation.
  // Skip the full-fleet probe on explicit re-auth paths (`--to` + `--allow-exhausted`
  // or magic-link): vault-dead accounts 429 the usage API and thrash Anthropic
  // while browser OAuth is running (2026-07-16).
  const skipFleetUtil =
    Boolean(targetEmail) &&
    (opts.allowExhausted === true || opts.magicLink === true || process.env.CLAUDE_ROTATION_SKIP_FLEET_UTIL === '1');
  let liveUtil = {};
  if (skipFleetUtil) {
    log('Skipping full-fleet utilization probe (explicit re-auth target) — using cached util only');
  } else {
    log('Querying live utilization for all accounts...');
    liveUtil = await queryAllUtilization(config);
    const utilSummary = Object.entries(liveUtil)
      .map(([k, v]) => `${k}:5h=${v.five_hour_pct}%/7d=${v.seven_day_pct}%`)
      .join(', ');
    if (utilSummary) log(`Live util: ${utilSummary}`);
    // Snapshot live data into state for future daemon decisions.
    // Includes BOTH 5h util AND extra_usage_enabled — the latter is sticky-true
    // so EU accounts stay refused even when subsequent live queries fail.
    for (const [key, util] of Object.entries(liveUtil)) {
      state.accounts[key] = state.accounts[key] || {};
      state.accounts[key].lastUtilization = {
        pct: util.five_hour_pct,
        pct7: util.seven_day_pct,
        reset: util.resets_at_5h ? Math.floor(new Date(util.resets_at_5h).getTime() / 1000) : null,
        reset7: util.resets_at_7d ? Math.floor(new Date(util.resets_at_7d).getTime() / 1000) : null,
        ts: Date.now(),
      };
      if (util.extra_usage_enabled !== null && util.extra_usage_enabled !== undefined) {
        state.accounts[key].lastBilling = {
          extra_usage_enabled: util.extra_usage_enabled === true,
          billing_type: util.billing_type || null,
          ts: Date.now(),
        };
      }
    }
    try {
      writeState(state);
    } catch {}
  }

  if (!targetEmail) {
    const { pick, allExhausted, onlyActiveViable, destinationCapStuck } = recommendAccount(config, state, liveUtil);
    if (!pick) {
      if (onlyActiveViable) {
        log('Rotation skipped — already on the only viable Max account (API headroom; other accounts exhausted).');
        return true;
      }
      if (allExhausted || destinationCapStuck) {
        if (allExhausted) {
          log('All accounts live-confirmed exhausted — CRS remains fail-closed');
        } else {
          log(
            `Every live-confirmed non-active account is ≥${destinationUtilHardBlock(config)}% max(5h,7d) — CRS remains fail-closed`,
          );
        }
      } else {
        log('No account available (see utilization / query logs above)');
      }
      return false;
    }
    targetEmail = accountKey(pick);
  } else {
    // Target validation: refuse exhausted API targets unless overridden.
    const targetAcct =
      config.accounts.find((a) => accountKey(a) === targetEmail) ||
      config.accounts.find((a) => a.email === targetEmail);
    if (targetAcct) {
      const tKey = accountKey(targetAcct);
      const tu = liveUtil[tKey];
      const targetExhausted =
        tu &&
        tu.five_hour_pct != null &&
        tu.seven_day_pct != null &&
        Math.max(tu.five_hour_pct, tu.seven_day_pct) >= EXHAUSTED_THRESHOLD;
      if (targetExhausted && !opts.allowExhausted) {
        log(
          `⚠  --to ${targetEmail} is EXHAUSTED (5h=${tu.five_hour_pct}% 7d=${tu.seven_day_pct}%) — auto-falling back to picker`,
        );
        const { pick, allExhausted, onlyActiveViable, destinationCapStuck } = recommendAccount(config, state, liveUtil);
        if (!pick) {
          if (onlyActiveViable) {
            log('Rotation skipped — already on the only viable Max account.');
            return true;
          }
          if (allExhausted || destinationCapStuck) {
            if (allExhausted) log('No alternative — all accounts exhausted; CRS remains fail-closed');
            else {
              log(
                `No alternative under destination cap (${destinationUtilHardBlock(config)}%); CRS remains fail-closed`,
              );
            }
          } else {
            log('No alternative — see utilization / query logs above');
          }
          return false;
        }
        targetEmail = accountKey(pick);
        log(`→ Picker chose ${targetEmail} instead`);
      }
    }
  }

  // Find by label first, then by email
  const account =
    config.accounts.find((a) => accountKey(a) === targetEmail) || config.accounts.find((a) => a.email === targetEmail);
  if (!account) {
    log(`Account ${targetEmail} not in config`);
    return false;
  }
  // Magic-link is the ONLY supported auth method for every account/path
  // (quickest; all login emails forward to one inbox). opts.magicLink is now
  // implied — we never fall through to Google OAuth.
  account.useMagicLink = true;
  const key = accountKey(account);

  log(`=== ROTATING: ${state.activeAccount || 'none'} → ${key} (${account.email}) ===`);
  notify('Claude Account Rotation', `Switching to ${key}...`);

  // Clear statsig cache to prevent device-level rate limit stickiness (anthropics/claude-code#12786)
  try {
    const statsigDir = join(process.env.HOME || '', '.claude', 'statsig');
    if (existsSync(statsigDir)) {
      const files = readdirSync(statsigDir).filter((f) => f.startsWith('statsig.cached.evaluations.'));
      for (const f of files) {
        try {
          unlinkSync(join(statsigDir, f));
        } catch {}
      }
      if (files.length > 0) log(`Cleared ${files.length} statsig cache files (device-level stickiness fix)`);
    }
  } catch {}

  // Save outgoing token to the vault slot matching the active account.
  // In --no-browser mode (daemon), skip the `claude auth status` call — it
  // hits the Anthropic API and fails when we're already rate limited.
  // Trust state.activeAccount instead.
  if (opts.noBrowser) {
    const trackedAccount = config.accounts.find((a) => accountKey(a) === state.activeAccount);
    if (trackedAccount) {
      if (!dryRun) saveCurrentToken(trackedAccount);
      log(`[no-browser] Saved outgoing token for tracked ${accountKey(trackedAccount)}`);
    } else {
      log(`[no-browser] No tracked active account — skipping outgoing save`);
    }
  } else
    try {
      // Identify the live keychain account AUTHORITATIVELY via direct
      // /oauth/profile call, not `claude auth status` — the CLI caches
      // stale email/org from the last session and lies when the keychain
      // has been swapped out from under it. Trusting it corrupts vaults.
      const liveTokenJson = (() => {
        try {
          return readKeychain();
        } catch {
          return null;
        }
      })();
      let liveEmail = null;
      let liveOrgUuid = null;
      if (liveTokenJson) {
        try {
          const liveAccessToken = JSON.parse(liveTokenJson)?.claudeAiOauth?.accessToken;
          if (liveAccessToken) {
            const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${liveAccessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
              },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const prof = await res.json();
              liveEmail = prof?.account?.email || null;
              liveOrgUuid = prof?.organization?.uuid || null;
            }
          }
        } catch {}
      }
      if (liveEmail) {
        // For multi-entry emails (same email under multiple config entries,
        // e.g. user-personal + user-team), prefer the entry whose
        // orgUuid matches live. Fall back to first email match.
        let liveAccount = null;
        if (liveOrgUuid) {
          liveAccount = config.accounts.find((a) => a.email === liveEmail && a.orgUuid === liveOrgUuid);
        }
        if (!liveAccount) {
          liveAccount = config.accounts.find((a) => a.email === liveEmail);
        }
        if (liveAccount) {
          if (!dryRun) saveCurrentToken(liveAccount);
          log(
            `${dryRun ? '[DRY-RUN] Would save' : 'Saved'} outgoing token for LIVE account ${accountKey(liveAccount)} (was tracked as ${state.activeAccount || 'none'})`,
          );
          // Keep state in sync with reality
          if (state.activeAccount !== accountKey(liveAccount)) {
            log(`State drift corrected: activeAccount ${state.activeAccount} → ${accountKey(liveAccount)}`);
            state.activeAccount = accountKey(liveAccount);
          }
        } else {
          log(`WARNING: live account ${liveEmail} not in config — skipping outgoing save`);
        }
      }
    } catch (e) {
      log(`Could not determine live account: ${e.message.substring(0, 80)}`);
    }

  // Snapshot outgoing account's utilization before clearing the rate-limits file.
  // This lets pickNextAccount avoid rotating back to an exhausted account.
  try {
    const rlPath = join(__dirname, '.rate-limits.json');
    if (existsSync(rlPath)) {
      const rl = JSON.parse(readFileSync(rlPath, 'utf8'));
      const outKey = state.activeAccount;
      if (outKey && rl.five_hour) {
        state.accounts[outKey] = state.accounts[outKey] || {};
        state.accounts[outKey].lastUtilization = {
          ...state.accounts[outKey].lastUtilization,
          pct: rl.five_hour.pct,
          reset: rl.five_hour.reset,
          ts: Date.now(),
        };
        log(
          `Snapshotted utilization for ${outKey}: 5h=${rl.five_hour.pct}% (resets ${new Date(rl.five_hour.reset * 1000).toISOString()})`,
        );
      }
    }
  } catch {}

  // Clear stale rate limits file so daemon doesn't use old account's utilization
  if (!dryRun) {
    try {
      unlinkSync(join(__dirname, '.rate-limits.json'));
    } catch {}
  } else {
    log('[DRY-RUN] Would clear .rate-limits.json');
  }

  let ok;
  if (dryRun) {
    log('[DRY-RUN] Would swap token via swapToken()');
    ok = true;
  } else {
    ok = await swapToken(account);
    if (!ok && !opts.noBrowser) {
      ok = await browserOAuthFallback(account);
    } else if (!ok) {
      log('[no-browser] Token swap failed — skipping browser fallback (daemon mode)');
    }
  }

  // ── Last-resort: prevent active-slot starvation ────────────────────────────
  // If every rotation path (vault swap + browser OAuth) failed AND the active
  // slot is empty/expired (the symptom that surfaces as "Not logged in · Please
  // run /login"), pick the lowest-utilization account we know about and swap
  // its vault token into the active slot. It's better to be on a 100% account
  // than to have no token at all — the session at least reaches anthropic and
  // gets a proper 429 (with reset time) instead of a 401 from an empty Bearer.
  // Hit on 2026-07-02: all 12 accounts at 5h=100% from earlier burst
  // tests, smartRecommendRotationTarget returned null (EXHAUSTED_THRESHOLD=95
  // guard refused every account), active credentials stayed empty/expired, and
  // Claude Code showed "Not logged in" forever. Without this guard the active
  // slot stays dead until the next external magic-link rotation lands.
  // Note: --no-browser does NOT skip last-resort — last-resort is purely a
  // vault->active swap, it doesn't launch any browser.
  if (!ok) {
    try {
      const activeJson = readKeychain();
      const activeParsed = JSON.parse(activeJson);
      const activeExpiresAt = activeParsed?.claudeAiOauth?.expiresAt || 0;
      const activeIsDead = !activeExpiresAt || activeExpiresAt < Date.now();
      if (activeIsDead) {
        log('[last-resort] active credentials are empty/expired — picking lowest-util account');
        const fallbackConfig = readConfig();
        const configAccounts = fallbackConfig.accounts || [];
        const liveUtil = await queryAllUtilization(fallbackConfig);
        const ranked = configAccounts
          .filter((a) => a.disabled !== true)
          .map((a) => {
            const u = liveUtil[accountKey(a)] || {};
            const fiveHour = u.five_hour_pct ?? 100;
            const sevenDay = u.seven_day_pct ?? 0;
            return { account: a, score: Math.max(fiveHour, sevenDay) };
          })
          .sort((x, y) => x.score - y.score);
        if (ranked.length > 0) {
          const fallback = ranked[0].account;
          log(
            `[last-resort] falling back to ${accountKey(fallback)} (score=${ranked[0].score}) — every account exhausted, but this is the least-bad`,
          );
          const fbOk = await swapToken(fallback);
          if (fbOk) {
            ok = true;
            log(`[last-resort] ✓ wrote ${accountKey(fallback)} vault token into active slot`);
          }
        }
      }
    } catch (e) {
      log(`[last-resort] failed: ${String(e.message || e).slice(0, 100)}`);
    }
  }

  if (!ok) {
    log('Rotation failed');
    notify('Account Rotation', `FAILED for ${targetEmail}`);
    return false;
  }

  // Verify by reading back what's now in the active keychain
  let verified = false;
  try {
    const active = readKeychain();
    const stored = readStoredToken(account);
    // Token swap: verify the active keychain matches what we wrote.
    // Guard against empty `stored` — substring("", 20, 80) === "" and
    // active.includes("") is always true, which would spuriously verify.
    if (stored && stored.length > 80 && active.includes(stored.substring(20, 80))) {
      verified = true;
      try {
        const parsed = JSON.parse(active);
        const accessToken = parsed?.claudeAiOauth?.accessToken || parsed?.accessToken;
        if (accessToken) {
          const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'anthropic-beta': 'oauth-2025-04-20',
            },
            signal: AbortSignal.timeout(4000),
          });
          if (res.status === 401) {
            log(`[verify] Stored token for ${account.email} revoked (401 on usage) — attempting repair`);
            const repair = await repairAccountOn401(account, getAuthRepairDeps());
            if (repair.repaired) {
              const retryJson = readStoredToken(account);
              const retryToken = retryJson ? JSON.parse(retryJson)?.claudeAiOauth?.accessToken : null;
              if (retryToken) {
                const retryRes = await fetch('https://api.anthropic.com/api/oauth/usage', {
                  method: 'GET',
                  headers: {
                    Authorization: `Bearer ${retryToken}`,
                    'anthropic-beta': 'oauth-2025-04-20',
                  },
                  signal: AbortSignal.timeout(4000),
                });
                verified = retryRes.ok;
              } else {
                verified = false;
              }
            } else {
              verified = false;
            }
          }
        }
      } catch (_e) {
        // network/parsing failures: fail-open to preserve legacy offline logic
      }
    }
    // Fallback: verify via /oauth/profile (skip in --no-browser mode — API may
    // be rate limited). `claude auth status` no longer returns email on
    // Claude Code >=2.1.144, so it can't be used for identity here.
    if (!verified && !opts.noBrowser) {
      try {
        const accessToken = JSON.parse(active)?.claudeAiOauth?.accessToken;
        if (accessToken) {
          const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'anthropic-beta': 'oauth-2025-04-20',
            },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const prof = await res.json();
            const liveEmail = prof?.account?.email || '';
            verified = liveEmail.toLowerCase() === account.email.toLowerCase();
          }
        }
      } catch {}
    }
  } catch {}
  log(`Rotation ${verified ? 'VERIFIED' : 'UNVERIFIED'}: ${key} (${account.email})`);

  // Org-match check: for accounts where label != email (multi-org under same
  // email, like user-personal vs user-team), confirm the live
  // /oauth/profile returns the expected organization. Drift here means the
  // OAuth flow landed on the wrong org picker — the stored token will be
  // usable but will double-count capacity with the sibling account.
  // Fail-open: only log — don't unverify, because the token is still valid.
  if (verified && account.orgName && account.label && !opts.noBrowser) {
    try {
      const liveTok = readKeychain();
      const accessToken = JSON.parse(liveTok)?.claudeAiOauth?.accessToken;
      if (accessToken) {
        const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const prof = await res.json();
          const liveOrg = prof?.organization?.name || '';
          if (liveOrg && liveOrg !== account.orgName) {
            log(
              `⚠  ORG MISMATCH: ${key} expected "${account.orgName}" but live is "${liveOrg}" — OAuth org picker likely landed on wrong workspace. Token still saved but will share quota with sibling account under same email.`,
            );
          } else if (liveOrg) {
            log(`Org match confirmed: ${liveOrg}`);
          }
        }
      }
    } catch (e) {
      log(`Org-match check skipped: ${e.message?.slice(0, 80)}`);
    }
  }

  // Trigger token refresh via `claude auth status` — skipped in --no-browser mode
  // because the API is likely rate limited when the daemon triggers a rotation.
  // Claude Code's own 30s keychain re-read will pick up the new token.
  if (verified && !opts.noBrowser) {
    try {
      execSync('claude auth status 2>&1', { timeout: 10_000 });
      log('Token refresh triggered via auth status');
    } catch {}
  }

  // Save verified (and possibly refreshed) token to vault for future fast swaps
  if (verified && !dryRun) saveCurrentToken(account);
  if (verified && dryRun) log('[DRY-RUN] Would save verified token to vault');

  // Update state — track cumulative window usage per account
  const now = new Date().toISOString();
  const windowMs = (config.rateLimits?.windowHours || 5) * 3_600_000;
  if (state.activeAccount) {
    const prev = (state.accounts[state.activeAccount] = state.accounts[state.activeAccount] || {});
    prev.lastActive = now;
    // Accumulate tool uses into the account's window total
    const windowAge = prev.windowStart ? Date.now() - new Date(prev.windowStart).getTime() : Infinity;
    if (windowAge >= windowMs) {
      // Window expired — reset
      prev.windowStart = prev.switchedAt || now;
      prev.windowToolUses = state.toolUses || 0;
    } else {
      prev.windowToolUses = (prev.windowToolUses || 0) + (state.toolUses || 0);
    }
  }
  // Initialize or carry over window data for target account
  const target = (state.accounts[key] = {
    ...(state.accounts[key] || {}),
    switchedAt: now,
    messagesSinceSwitch: 0,
  });
  const targetWindowAge = target.windowStart ? Date.now() - new Date(target.windowStart).getTime() : Infinity;
  if (targetWindowAge >= windowMs) {
    // Window expired — fresh start
    target.windowStart = now;
    target.windowToolUses = 0;
  }
  // else: keep existing window data (cumulative uses carry over)
  const sourceKeyForHotSwap = state.activeAccount;
  state.activeAccount = key;
  state.toolUses = 0;
  state.lastRotation = now;
  state.totalRotations = (state.totalRotations || 0) + 1;
  writeState(state, dryRun);

  // Claim the cross-machine lease for the account we just activated so the other
  // machine's rotation excludes it. Best-effort / fail-open. Skip on dry-run.
  if (!dryRun) {
    try {
      writeLease(key, (m) => log(m));
    } catch {}
  }

  notify('Claude Account Rotation', `${verified ? '✓' : '⚠'} Now using ${key}`);

  // SIGHUP hot-swap: signal running Claude Code sessions on the rotated-FROM account
  // to reload their keychain (Claude Code catches SIGHUP and re-execs, ~1s restart).
  if (ok && sourceKeyForHotSwap && !dryRun) {
    try {
      const sourceAccountForSwap = config.accounts.find((a) => accountKey(a) === sourceKeyForHotSwap);
      const sourceEmail = sourceAccountForSwap?.email;
      if (sourceEmail) {
        const pidFile = `/tmp/claude-pids-${sourceEmail}`;
        if (existsSync(pidFile)) {
          const pids = readFileSync(pidFile, 'utf8')
            .split('\n')
            .map((l) => parseInt(l.trim(), 10))
            .filter((p) => !Number.isNaN(p) && p > 0);
          // Confirm each pid is actually a live Claude Code process before SIGHUP.
          // kill(pid,0) only proves the pid EXISTS — on Linux pids recycle fast, so a
          // stale pidfile entry can point at an unrelated reused pid, and SIGHUP's
          // default disposition is terminate. Verify via /proc/<pid>/cmdline (Linux)
          // or `ps` (fallback) that the command is `claude`, and prune dead/stale
          // entries so the pidfile self-heals and "signaled N" can't overcount.
          const isClaudePid = (pid) => {
            let cmd = '';
            try {
              cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
            } catch {
              try {
                cmd = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 2000 }).toString();
              } catch {
                return false;
              }
            }
            return /(^|\/)claude(\s|$)/.test(cmd) || cmd.includes('claude ');
          };
          let signaled = 0;
          const livePids = [];
          for (const pid of pids) {
            if (pid === process.pid || pid === process.ppid) continue;
            try {
              process.kill(pid, 0); // exists?
            } catch {
              continue; // dead → drop from pidfile
            }
            if (!isClaudePid(pid)) continue; // alive but NOT claude (recycled pid) → never SIGHUP
            // Busy-session hold: a session orchestrating in-flight subagents can place
            // /tmp/claude-hotswap-hold-<pid> to opt out of SIGHUP — re-exec would kill
            // its in-process agents (observed 2026-06-06: rotation churn killed 4 agent
            // fleets mid-task). Holds auto-expire after 6h (stale holds must never block
            // token reloads forever). Held pids stay in the pidfile for future rotations.
            try {
              const hold = statSync(`/tmp/claude-hotswap-hold-${pid}`);
              if (Date.now() - hold.mtimeMs < 6 * 3600 * 1000) {
                log(`[hot-swap] skipping pid ${pid} — busy hold present`);
                livePids.push(pid);
                continue;
              }
            } catch {}
            try {
              process.kill(pid, 'SIGHUP');
              signaled++;
              livePids.push(pid);
              // Graceful rotation-over: space the reloads so the fleet doesn't
              // all re-auth and hit the new account in the same instant.
              if (SESSION_STAGGER_MS > 0) await sleep(SESSION_STAGGER_MS);
            } catch {}
          }
          // Self-heal the pidfile: keep only confirmed-live Claude pids, else remove it.
          try {
            if (livePids.length > 0) writeFileNoFollowSync(pidFile, `${livePids.join('\n')}\n`);
            else unlinkSync(pidFile);
          } catch {}
          if (signaled > 0) {
            log(`[hot-swap] signaled ${signaled} Claude session(s) on ${sourceEmail} to reload after rotation`);
          } else if (pids.length > 0) {
            log(`[hot-swap] no live Claude sessions to signal on ${sourceEmail} (pruned stale pidfile)`);
          }
        }
      }
    } catch (e) {
      log(`[hot-swap] skipped: ${e.message?.slice(0, 80)}`);
    }
  }

  // Daemon-hosted `claude --bg` sessions have no TTY for /login injection and
  // don't register in the pidfile SIGHUP path — respawn after every successful
  // rotation (including daemon --no-browser without --session).
  if (ok && !dryRun && process.env.CLAUDE_ENABLE_BG_RESPAWN === '1') {
    try {
      const { respawned, deferred } = respawnBgSessions(log);
      if (respawned || deferred) log(`[bg-respawn] fleet: ${respawned} respawned, ${deferred} deferred (busy)`);
    } catch (e) {
      log(`[bg-respawn] pass skipped: ${e.message?.slice(0, 80)}`);
    }
  }

  if (opts.session) {
    if (dryRun) {
      log('[DRY-RUN] Would restart running Claude sessions with --continue and send resume prompt');
    } else {
      await refreshRunningSession(account, opts.noBrowser);
    }
  }
  return verified;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  const config = readConfig();
  const argv = process.argv.slice(2);
  const filter = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const autoMode = argv.includes('--auto');
  const magicLinkMode = autoMode || argv.includes('--magic-link');
  const skipDone = argv.includes('--skip-valid');
  const accounts = (
    filter ? config.accounts.filter((a) => accountKey(a) === filter || a.email === filter) : config.accounts
  ).filter((a) => {
    if (a.disabled === true && !filter) {
      console.log(`⏭  Skipping ${accountKey(a)}: disabled (${a.disabledReason || 'no reason given'})`);
      return false;
    }
    return true;
  });

  if (magicLinkMode) {
    requireMagicLinkInboxReady(createDeadline(15_000));
  }

  console.log('\n=== Claude Account Rotation — Setup ===\n');
  if (autoMode) {
    console.log(`🤖 AUTO MODE — browser driver cascade + magic-link polling via gog/Gmail`);
    console.log(`   Sequential processing (~60-120s per account). Logs → rotation.log.\n`);
  }
  console.log(`Re-capturing ${accounts.length} account(s). For each: OAuth → verify → save to vault.\n`);

  const results = [];
  let consecutiveBrowserCrashes = 0;
  for (const account of accounts) {
    const key = accountKey(account);
    console.log(`\n── ${key} (${account.email}) ──`);

    // --skip-valid: skip accounts whose stored vault token is still good
    if (skipDone) {
      try {
        const existing = readStoredToken(account);
        if (existing && !tokenExpired(existing)) {
          const p = JSON.parse(existing);
          const t = p?.claudeAiOauth?.accessToken;
          if (t) {
            const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${t}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
              },
              signal: AbortSignal.timeout(4000),
            });
            if (res.ok) {
              console.log(`⏭  Skipped: vault token still valid (--skip-valid).`);
              syncStoredTokenToCrs(account);
              results.push({ key, ok: true, skipped: true });
              continue;
            }
          }
        }
      } catch {}
    }

    if (magicLinkMode && account.autoAuthDisabled === true && !filter) {
      console.log(
        `⏭  Skipped: automated reauth disabled (${account.autoAuthDisabledReason || 'manual reauth required'}).`,
      );
      results.push({ key, ok: true, skipped: true, reason: 'auto-auth-disabled' });
      continue;
    }

    let oauthOk = true;
    if (magicLinkMode) {
      // Fully automated: claude auth login subprocess + browser driver cascade
      // + magic-link email polling. No terminal interaction required.
      account.useMagicLink = true;
      console.log(`[auto] Automated OAuth — magic-link email to ${account.email} (routed to Gmail)...`);
      try {
        oauthOk = await browserOAuthFallback(account);
      } catch (e) {
        if (e instanceof RotationSafetyError) throw e;
        const msg = String(e.message || e).slice(0, 120);
        console.error(`❌ Automation threw: ${msg}`);
        if (/page crashed|all browser drivers failed|browser.*failed/i.test(msg)) consecutiveBrowserCrashes += 1;
        oauthOk = false;
      }
      if (!oauthOk) {
        console.error(`❌ ${key}: auto OAuth failed. Retry manually: node rotate.mjs --setup --only=${key}`);
        results.push({ key, ok: false, reason: 'auto-oauth-failed' });
        consecutiveBrowserCrashes += 1;
        if (!filter && consecutiveBrowserCrashes >= 2) {
          console.error('\n❌ Browser OAuth is crashing repeatedly; stopping setup before burning more magic links.');
          console.error('   Use: node rotate.mjs --setup --only=<account-key>');
          break;
        }
        continue;
      }
      consecutiveBrowserCrashes = 0;
    } else {
      console.log('Opening browser for OAuth. Complete the Google login, then come back here.');
      const oauthLoginEnv = { ...process.env };
      for (const name of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_BASE',
      ])
        delete oauthLoginEnv[name];
      const child = spawn('claude', ['auth', 'login', '--email', account.email], {
        env: oauthLoginEnv,
        stdio: 'inherit',
      });
      child.on('error', (err) => {
        logger.error('Failed to spawn subprocess:', err);
      });
      await new Promise((r) => child.on('exit', r));
    }

    // Verify the login succeeded and matches the expected account.
    // NOTE: Claude Code >=2.1.144 returns {email:null,orgId:null,orgName:null}
    // from `claude auth status` even when logged in, so it can no longer be
    // used for identity verification. Verify against the freshly-written
    // keychain token via the OAuth profile API instead, which still returns
    // the real account email.
    try {
      const token = readKeychain();
      let liveEmail = null;
      let profErr = null;
      try {
        const accessToken = JSON.parse(token)?.claudeAiOauth?.accessToken;
        if (accessToken) {
          const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'anthropic-beta': 'oauth-2025-04-20',
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const prof = await res.json();
            liveEmail = prof?.account?.email ?? null;
          } else {
            profErr = `profile HTTP ${res.status}`;
          }
        } else {
          profErr = 'no accessToken in keychain';
        }
      } catch (e) {
        profErr = String(e.message || e).slice(0, 80);
      }

      if (liveEmail) {
        if (liveEmail.toLowerCase() !== account.email.toLowerCase()) {
          console.error(`\n❌ MISMATCH: expected ${account.email}, got ${liveEmail}. Skipping save.`);
          results.push({ key, ok: false, reason: `mismatch:${liveEmail}` });
          continue;
        }
        console.log(`✅ Verified: ${liveEmail}`);
      } else {
        // Profile fetch failed (rate limit / transient). Fail-open ONLY if the
        // keychain token is structurally valid and unexpired — otherwise the
        // rotation would never save a single account whenever the profile API
        // is throttled (which is common mid-rotation).
        if (token?.includes('claudeAiOauth') && !tokenExpired(token)) {
          console.log(
            `⚠  Identity unverified (${profErr || 'no email'}) — token valid & unexpired, saving with caveat.`,
          );
        } else {
          console.error(`\n❌ Verify failed (${profErr || 'no email'}) and token invalid/expired. Skipping save.`);
          results.push({ key, ok: false, reason: `verify-failed:${profErr || 'no-email'}` });
          continue;
        }
      }
      // Save to vault (strip mcpOAuth to keep vault clean)
      try {
        const parsed = JSON.parse(token);
        const clean = { claudeAiOauth: parsed.claudeAiOauth, mcpOAuth: {} };
        writeStoredToken(account, JSON.stringify(clean));
        syncStoredTokenToCrs(account);
      } catch {
        writeStoredToken(account, token);
        syncStoredTokenToCrs(account);
      }
      console.log(`✅ Saved to vault: ${tokenService(account)}`);
      results.push({ key, ok: true });
    } catch (e) {
      console.error(`❌ Error: ${e.message}`);
      results.push({
        key,
        ok: false,
        reason: String(e.message || e).slice(0, 80),
      });
    }
  }

  // Summary
  console.log(`\n=== Setup complete ===`);
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  for (const r of results) {
    const icon = r.ok ? (r.skipped ? '⏭ ' : '✅') : '❌';
    console.log(`  ${icon} ${r.key}${r.reason ? `  (${r.reason})` : ''}`);
  }
  console.log(`\n${okCount}/${results.length} captured${failCount ? `, ${failCount} failed` : ''}.`);

  // Post-setup billing audit (auto mode) — surfaces accounts with extra_usage on
  if (autoMode && okCount > 0) {
    console.log(`\n=== Billing audit (post-setup) ===\n`);
    const liveUtil = await queryAllUtilization(readConfig());
    let risky = 0;
    let unknown = 0;
    for (const a of config.accounts) {
      const k = accountKey(a);
      if (a.disabled === true) {
        console.log(`  ⏸  ${k}: DISABLED — skipped`);
        continue;
      }
      const u = liveUtil[k];
      if (!u) {
        console.log(`  ⚠  ${k}: token invalid/expired — cannot audit`);
        unknown++;
        continue;
      }
      if (u.extra_usage_enabled === true) {
        console.log(`  🔴 ${k}: EXTRA_USAGE=ON — overage billing ACTIVE`);
        risky++;
      } else if (u.extra_usage_enabled === false) {
        console.log(`  🟢 ${k}: extra_usage=off  5h=${u.five_hour_pct}% 7d=${u.seven_day_pct}%`);
      } else {
        console.log(`  ⚠  ${k}: extra_usage=unknown`);
        unknown++;
      }
    }
    if (risky > 0) {
      console.log(
        `\n🚨 ${risky} account(s) have extra_usage ON. Disable at:\n   https://console.anthropic.com/settings/billing`,
      );
    } else if (unknown === 0) {
      console.log(`\n✅ All auditable accounts have extra_usage=off.`);
    }
  }
  console.log(`\nSetup done. Run \`node rotate.mjs --audit-billing\` anytime to re-check.\n`);
}

// ── Status ────────────────────────────────────────────────────────────────────

async function showStatus() {
  const config = readConfig();
  const state = readState();
  // `claude auth status` no longer returns email on CC >=2.1.144 — derive
  // from the live keychain token via /oauth/profile instead.
  let liveEmail = null;
  try {
    const tok = readKeychain();
    const accessToken = JSON.parse(tok)?.claudeAiOauth?.accessToken;
    if (accessToken) {
      const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const prof = await res.json();
        liveEmail = prof?.account?.email || null;
      }
    }
  } catch {}

  const since = (d) => {
    if (!d) return 'never';
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // Read real utilization if available
  let realUtil = null;
  try {
    const rlFile = join(__dirname, '.rate-limits.json');
    if (existsSync(rlFile)) {
      const rl = JSON.parse(readFileSync(rlFile, 'utf8'));
      const age = Date.now() - rl.ts * 1000;
      if (age < 5 * 60_000) realUtil = rl;
    }
  } catch {}

  // Statusline must not depend on Claude Code restart. Token swap is keychain-level;
  // any live/tracked mismatch is surfaced silently via the two separate lines below —
  // no prescriptive "restart Claude Code" nag in the statusline.
  const liveNote = '';

  console.log('\n=== Claude Account Rotation ===\n');
  console.log(`Live auth:       ${liveEmail || 'unknown'}${liveNote}`);
  console.log(`Tracked active:  ${state.activeAccount || 'unknown'}`);
  console.log(`Tool uses:       ${state.toolUses || 0} / ${config.toolUseThreshold}`);
  if (realUtil) {
    console.log(
      `Real utilization: 5h=${realUtil.five_hour?.pct?.toFixed(1) || '?'}%  7d=${realUtil.seven_day?.pct?.toFixed(1) || '?'}%`,
    );
    if (realUtil.five_hour?.reset) {
      const resetIn = Math.max(0, realUtil.five_hour.reset - Math.floor(Date.now() / 1000));
      const hrs = Math.floor(resetIn / 3600);
      const mins = Math.floor((resetIn % 3600) / 60);
      console.log(`5h resets in:    ${hrs}h${mins}m`);
    }
  }
  console.log(`Total rotations: ${state.totalRotations || 0}`);
  console.log(`Last rotation:   ${since(state.lastRotation)}`);

  // CRS is a dependency for CRS-pool accounts only: surface reachability here
  // so a dead relay is visible in --status, but never block the keychain
  // rotation status above on it.
  const hasCrsAccounts = config.accounts.some((a) => a.crsAccountName || a.crsName) || config.crs?.enabled;
  if (hasCrsAccounts) {
    try {
      const crsHealth = await checkCrsHealth(config, { timeoutMs: 3000 });
      console.log(
        `CRS relay:       ${crsHealth.reachable ? '✓ reachable' : '✗ UNREACHABLE'} (${crsHealth.base}${crsHealth.error ? ` — ${crsHealth.error}` : ''})`,
      );
    } catch (e) {
      console.log(`CRS relay:       ✗ healthcheck error — ${e.message}`);
    }
  }
  console.log('');
  console.log('Accounts:');
  for (const a of config.accounts) {
    const key = accountKey(a);
    const s = state.accounts[key] || {};
    const active = key === state.activeAccount ? ' ◀ ACTIVE' : '';
    const prio = a.priority === 'low' ? ' (low priority)' : '';
    const tokenOk = hasStoredToken(a) ? '✓ token stored' : '✗ no token';
    const label = a.label ? ` [${a.label}]` : '';
    const windowInfo = s.windowToolUses ? ` | window: ${s.windowToolUses} uses` : '';
    console.log(`  ${a.email}${label}${active}${prio}`);
    console.log(`    Keychain:    ${tokenOk}`);
    console.log(`    Last active: ${since(s.lastActive)}${windowInfo}`);
  }
  console.log('');
}

// ── --capture: print current token for Dashlane ───────────────────────────────

function captureCmd(targetEmail = null) {
  const state = readState();
  const config = readConfig();
  let account;
  if (targetEmail) {
    const needle = String(targetEmail).trim().toLowerCase();
    account = config.accounts.find((a) => a.email.toLowerCase() === needle);
    if (!account) {
      console.error(`No account in config matching --to ${targetEmail}`);
      process.exit(1);
    }
  } else {
    const activeKey = state.activeAccount;
    account =
      config.accounts.find((a) => accountKey(a) === activeKey) || config.accounts.find((a) => a.email === activeKey);
    if (!account) {
      console.error(`Active account ${activeKey} not in config`);
      process.exit(1);
    }
  }

  try {
    const token = readKeychain();
    if (!token.includes('claudeAiOauth')) {
      console.error('No valid OAuth token in active keychain');
      process.exit(1);
    }
    writeStoredToken(account, token);
    syncStoredTokenToCrs(account);
    console.log(`✓ Token captured and saved to keychain: ${tokenService(account)}`);
    console.log(`  Account: ${account.email}${account.label ? ' [' + account.label + ']' : ''}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node rotate.mjs [command] [options]

Read-only:
  --status
  --utilization [--repair]
  --audit-billing

Mutating:
  --to <email> [--session] [--no-browser] [--dry-run]
  --setup [--auto] [--only=<email>]
  --magic-link --to <email>
  --sync-crs-all`);
} else if (args.includes('--sync-crs-all')) {
  try {
    syncCrsAll();
    process.exit(0);
  } catch (e) {
    console.error(String(e.message || e).slice(0, 500));
    process.exit(1);
  }
} else if (args.includes('--setup')) {
  if (!acquireLock()) {
    console.error('Another rotation or re-auth operation is already running');
    process.exit(3);
  }
  try {
    await setup();
  } finally {
    releaseLock();
  }
} else if (args.includes('--utilization')) {
  // Live utilization query for all accounts (read-only by default — no vault mutation on 401)
  const config = readConfig();
  const state = readState();
  const repair = args.includes('--repair') || process.env.CLAUDE_ROTATION_UTILIZATION_REPAIR === '1';
  console.log('\nQuerying live utilization for all accounts...\n');
  if (repair) {
    console.log(
      'Repair mode: will refresh / magic-link on 401 (set CLAUDE_ROTATION_DESTRUCTIVE_401=1 to purge after failed repair)\n',
    );
  }
  const liveUtil = await queryAllUtilization(config, { readOnly: !repair, repair });
  for (const a of config.accounts) {
    const key = accountKey(a);
    if (a.disabled === true) {
      console.log(`  ⏸  ${key}: DISABLED — ${a.disabledReason || 'no reason given'}`);
      continue;
    }
    const active = state.activeAccount === key ? ' ◀ ACTIVE' : '';
    const u = liveUtil[key];
    if (!u) {
      console.log(`  ${key}: ❌ query failed${active}`);
      continue;
    }
    const s5 = u.five_hour_pct;
    const s7 = u.seven_day_pct;
    const worst = Math.max(s5 ?? 0, s7 ?? 0);
    const icon = worst >= 90 ? '🔴' : worst >= 70 ? '🟡' : '🟢';
    const reset5 = u.resets_at_5h ? `resets ${new Date(u.resets_at_5h).toLocaleTimeString()}` : 'no reset';
    const euIcon =
      u.extra_usage_enabled === true ? ' 💳 EXTRA_USAGE_ON' : u.extra_usage_enabled === false ? '' : ' (eu?)';
    console.log(`  ${icon} ${key}: 5h=${s5}% 7d=${s7}%  (${reset5})${euIcon}${active}`);
  }
  console.log('');
} else if (args.includes('--audit-billing')) {
  // Per-account billing audit — prints extra_usage state + any risk flags
  const config = readConfig();
  const state = readState();
  console.log('\nAuditing billing state for all accounts...\n');
  const liveUtil = await queryAllUtilization(config);
  let risky = 0;
  let unknown = 0;
  for (const a of config.accounts) {
    const key = accountKey(a);
    if (a.disabled === true) {
      console.log(`  ⏸  ${key}: DISABLED — ${a.disabledReason || 'no reason given'}`);
      continue;
    }
    const active = state.activeAccount === key ? ' ◀ ACTIVE' : '';
    const u = liveUtil[key];
    if (!u) {
      console.log(`  ⚠  ${key}: token invalid/expired — cannot audit${active}`);
      unknown++;
      continue;
    }
    const eu = u.extra_usage_enabled;
    const bt = u.billing_type ?? '?';
    const ss = u.subscription_status ?? '?';
    if (eu === true) {
      console.log(`  🔴 ${key}: EXTRA_USAGE=ON billing=${bt} status=${ss}${active}  ← overage billing ACTIVE`);
      risky++;
    } else if (eu === false) {
      console.log(`  🟢 ${key}: extra_usage=off billing=${bt} status=${ss}${active}`);
    } else {
      console.log(`  ⚠  ${key}: extra_usage=unknown billing=${bt}${active}`);
      unknown++;
    }
  }
  console.log('');
  console.log(`Summary: ${risky} risky, ${unknown} unknown, ${config.accounts.length - risky - unknown} safe`);
  if (risky > 0) {
    console.log(`\n⚠  Disable extra_usage at https://console.anthropic.com/settings/billing for each risky account.`);
  }
  console.log('');
} else if (args.includes('--recommend') || args.includes('--pick')) {
  // Live-query all accounts and print the recommended next account WITHOUT
  // swapping. Used as preflight by force-rotate.sh / rotate-magic / daemon-log.
  const config = readConfig();
  const state = readState();
  const json = args.includes('--json');
  if (!json) console.log('Querying live utilization for recommendation...');
  const liveUtil = await queryAllUtilization(config);
  const destCap = destinationUtilHardBlock(config);
  const { pick, allExhausted, allHaveLive, onlyActiveViable, destinationCapStuck } = recommendAccount(
    config,
    state,
    liveUtil,
  );
  const accountsOut = {};
  for (const a of config.accounts) {
    if (a.disabled === true) continue;
    const k = accountKey(a);
    let u = liveUtil[k];
    let isCached = false;
    let liveFailed = false;
    if (!u) {
      // Live query failed — fall back to cached data but flag it so TUI can show
      // "[live-failed, cached]" instead of "query_failed". --no-cache suppresses
      // the cached display label but still shows the stale numbers.
      const cachedUtil = state.accounts?.[k]?.lastUtilization;
      if (cachedUtil) {
        const reset5Ms = cachedUtil.reset ? cachedUtil.reset * 1000 : 0;
        const reset7Ms = cachedUtil.reset7 ? cachedUtil.reset7 * 1000 : 0;
        const fresh5 = reset5Ms && reset5Ms < Date.now();
        const fresh7 = reset7Ms && reset7Ms < Date.now();
        const pct5 = fresh5 ? 0 : (cachedUtil.pct ?? 0);
        const pct7 = fresh7 ? 0 : (cachedUtil.pct7 ?? null);
        u = {
          five_hour_pct: pct5,
          seven_day_pct: pct7,
          extra_usage_enabled: state.accounts?.[k]?.lastBilling?.extra_usage_enabled ?? null,
          resets_at_5h: cachedUtil.reset ? new Date(reset5Ms).toISOString() : null,
          resets_at_7d: cachedUtil.reset7 ? new Date(reset7Ms).toISOString() : null,
          is_cached: true,
          live_failed: true,
        };
        isCached = true;
        liveFailed = true;
      }
    }
    if (!u) {
      accountsOut[k] = { error: 'query_failed' };
      continue;
    }
    const worst = Math.max(u.five_hour_pct ?? 0, u.seven_day_pct ?? 0);
    accountsOut[k] = {
      five_hour: u.five_hour_pct,
      seven_day: u.seven_day_pct,
      extra_usage: u.extra_usage_enabled,
      worst,
      // Cached quota is useful context, but it is not proof that an account
      // can serve inference now. Keep the fleet invariant exact:
      // viable accounts are the same live-confirmed accounts CRS may schedule.
      viable: !liveFailed && worst < destCap,
      destination_cap_pct: destCap,
      resets_at_5h: u.resets_at_5h,
      resets_at_7d: u.resets_at_7d,
      is_cached: isCached,
      live_failed: liveFailed,
    };
  }
  const out = {
    activeAccount: state.activeAccount || null,
    pick: pick ? accountKey(pick) : null,
    pick_email: pick ? pick.email : null,
    allExhausted,
    allHaveLive,
    onlyActiveViable,
    destinationCapStuck,
    destinationMaxUtilPercent: destCap,
    accounts: accountsOut,
  };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    // ── helpers ──────────────────────────────────────────────────────────
    const fmtDur = (isoStr) => {
      if (!isoStr) return null;
      const ms = Date.parse(isoStr);
      if (!ms || ms <= Date.now()) return 'now';
      const diffMs = ms - Date.now();
      const totalMin = Math.round(diffMs / 60_000);
      if (totalMin < 1) return '<1m';
      if (totalMin < 60) return `${totalMin}m`;
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };
    const fmtTime = (isoStr) => {
      if (!isoStr) return null;
      const d = new Date(isoStr);
      return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    const bar = (pct) => {
      const filled = Math.round((pct ?? 0) / 10);
      return '█'.repeat(filled) + '░'.repeat(10 - filled);
    };
    const NOW = Date.now();
    const total = Object.keys(accountsOut).length;
    const exhausted = Object.values(accountsOut).filter((v) => !v.error && v.worst >= EXHAUSTED_THRESHOLD).length;
    const viable = Object.values(accountsOut).filter((v) => !v.error && v.viable).length;

    // ── header ────────────────────────────────────────────────────────────
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  CLAUDE MAX FLEET STATUS  —  ${new Date().toLocaleString().padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Active account : ${out.activeAccount || '(none)'}`);
    console.log(
      `  Fleet size     : ${total} accounts  (${viable} viable · ${exhausted} exhausted · ${total - viable - exhausted} marginal)`,
    );
    console.log(`  Rotation cap   : max(5h,7d) < ${destCap}%  |  hard exhaustion threshold: ≥${EXHAUSTED_THRESHOLD}%`);
    console.log(`  Pick           : ${out.pick ? `→ ${out.pick}` : '(none — see below)'}`);
    console.log('');
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log('  ACCOUNT                                5h          7d        STATUS');
    console.log('  ─────────────────────────────────────────────────────────────');

    // ── per-account rows ──────────────────────────────────────────────────
    for (const [k, v] of Object.entries(accountsOut)) {
      if (v.error) {
        console.log(`  ❌ <${k}>`);
        console.log(`       └─ query failed (token invalid/expired?)`);
        console.log('');
        continue;
      }

      let icon;
      if (v.extra_usage === true) icon = '💳';
      else if (v.worst >= EXHAUSTED_THRESHOLD) icon = '🔴';
      else if (!v.viable) icon = '🟡';
      else if (v.worst >= 70) icon = '🟡';
      else icon = '🟢';

      const isActive = k === out.activeAccount;
      const star = isActive ? ' ◀ ACTIVE' : '';

      const tags = [];
      if (v.extra_usage === true) tags.push('EXTRA_USAGE=ON');
      if (v.worst >= EXHAUSTED_THRESHOLD) tags.push('EXHAUSTED');
      else if (!v.viable) tags.push(`OVER ${destCap}% CAP`);
      if (isActive) tags.push('ACTIVE');
      const tagStr = tags.length ? tags.join(' · ') : 'viable';

      const s5 = v.five_hour ?? '?';
      const s7 = v.seven_day ?? '?';

      // clears-in for both windows
      const clear5 = fmtDur(v.resets_at_5h);
      const clear7 = fmtDur(v.resets_at_7d);
      const time5 = fmtTime(v.resets_at_5h);
      const time7 = fmtTime(v.resets_at_7d);

      // determine which window is the blocker
      const blocked5 = (v.five_hour ?? 0) >= destCap;
      const blocked7 = (v.seven_day ?? 0) >= destCap;
      const blocker = blocked7 ? '7d' : blocked5 ? '5h' : null;
      const clearTime = blocker === '7d' ? clear7 : blocker === '5h' ? clear5 : null;
      const clearAt = blocker === '7d' ? time7 : blocker === '5h' ? time5 : null;

      console.log(`  ${icon} <${k}>${star}`);
      if (v.is_cached) {
        console.log(`       5h: ${String(s5).padStart(5)}%  [cached]   7d: ${String(s7).padStart(5)}%`);
      } else {
        console.log(
          `       5h: ${String(s5).padStart(5)}%  ${bar(v.five_hour)}   7d: ${String(s7).padStart(5)}%  ${bar(v.seven_day)}`,
        );
      }
      console.log(`       Status : ${tagStr}`);
      if (clear5 || clear7) {
        const r5str = clear5 ? `5h window clears in ${clear5}${time5 ? ` (at ${time5})` : ''}` : '5h: n/a';
        const r7str = clear7 ? `7d window clears in ${clear7}${time7 ? ` (at ${time7})` : ''}` : '7d: n/a';
        console.log(`       Resets : ${r5str}`);
        console.log(`              : ${r7str}`);
        if (blocker && clearTime) {
          console.log(
            `       ⏳ Blocker (${blocker}): usable again in ${clearTime}${clearAt ? ` — at ${clearAt}` : ''}`,
          );
        }
      } else if (v.worst >= EXHAUSTED_THRESHOLD) {
        console.log(`       Resets : no reset time available from API`);
      }
      console.log('');
    }

    // ── summary footer ────────────────────────────────────────────────────
    console.log('  ─────────────────────────────────────────────────────────────');
    if (allExhausted) {
      console.log(`  ⚠  ALL ${total} ACCOUNTS EXHAUSTED (live-confirmed, threshold ≥${EXHAUSTED_THRESHOLD}%)`);
      // find earliest any account clears
      const nextClears = Object.values(accountsOut)
        .flatMap((v) => [v.resets_at_5h, v.resets_at_7d].filter(Boolean).map((s) => Date.parse(s)))
        .filter((ms) => ms > NOW)
        .sort((a, b) => a - b)[0];
      if (nextClears) {
        const inMs = nextClears - NOW;
        const inMin = Math.round(inMs / 60_000);
        const h = Math.floor(inMin / 60),
          m = inMin % 60;
        const durStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${inMin}m`;
        console.log(
          `  ⏳ Earliest window clears: in ${durStr}  (${new Date(nextClears).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
        );
      }
      console.log('  ⛔ CRS-only policy: waiting for an OAuth window reset');
    } else if (destinationCapStuck) {
      console.log(`  ⚠  STUCK: every non-active account is ≥${destCap}% destination cap — no Max rotation target`);
      console.log('  ⛔ CRS-only policy: no metered provider fallback is allowed');
    } else if (out.onlyActiveViable) {
      console.log(`  ✅ Already optimal — only viable account is already active: ${out.activeAccount || '?'}`);
    } else if (out.pick) {
      console.log(`  ✅ Recommended next account: ${out.pick}`);
    } else {
      console.log('  ⚠  No viable account (all exhausted or missing utilization data)');
    }
    console.log('');
  }
  // Exit codes: 0 = viable pick available, 2 = live-confirmed CRS capacity exhausted,
  // 3 = no viable pick with incomplete utilization data.
  process.exit(pick || onlyActiveViable ? 0 : allExhausted || destinationCapStuck ? 2 : 3);
} else if (args.includes('--ops-rotate-in-cloud-ops')) {
  const config = readConfig();
  const state = readState();
  console.log('\n=== Claude Session Rotation — Optimized (Ops) ===\n');

  const sessions = listLiveBgSessions();
  if (sessions.length === 0) {
    console.log('No active background sessions to rotate.');
    process.exit(0);
  }

  const leases = readLeases();
  console.log(`Checking ${sessions.length} active session(s)...`);

  let rotatedCount = 0;
  for (const s of sessions) {
    const lease = leases[s.id];
    let needsRotation = false;
    let currentKey = null;

    if (!lease) {
      needsRotation = true;
      console.log(`Session ${s.id} has no lease. Finding candidate...`);
    } else {
      currentKey = lease.accountKey;
      if (currentKey === 'bedrock') {
        needsRotation = true;
        console.log(`Session ${s.id} has a prohibited legacy provider lease; forcing CRS-only reassignment.`);
      } else {
        const cached = state.accounts?.[currentKey]?.lastUtilization;
        const util = cachedUtilizationMax(cached) ?? 0;
        const acct = config.accounts.find((a) => accountKey(a) === currentKey);
        const maxUtil = acct?.maxUtilPercent || config.rateLimits.destinationMaxUtilPercent;

        // Count active leases for this account
        const activeLeaseCount = Object.values(leases).filter((l) => l.accountKey === currentKey).length;
        const SESSION_COST_PCT = 15;
        const projectedUtil = util + activeLeaseCount * SESSION_COST_PCT;

        if (projectedUtil >= maxUtil) {
          needsRotation = true;
          console.log(
            `Session ${s.id} leased account ${currentKey} projected utilization is exhausted (${projectedUtil}% >= ${maxUtil}%).`,
          );
        } else {
          console.log(
            `Session ${s.id} leased account ${currentKey} projected utilization is healthy (${projectedUtil}% < ${maxUtil}%).`,
          );
        }
      }
    }

    if (needsRotation) {
      const originalRouting = process.env.CLAUDE_SESSION_ROUTING;
      process.env.CLAUDE_SESSION_ROUTING = '1';
      const pickedKey = pickAccountForSession(s.id, config, state);
      const newKey = pickedKey === 'bedrock' ? null : pickedKey;
      process.env.CLAUDE_SESSION_ROUTING = originalRouting;

      if (newKey && newKey !== currentKey) {
        console.log(`Rotating session ${s.id} to ${newKey}...`);
        recordSessionLease(s.id, newKey, s.pid);

        if (s.status !== 'busy') {
          process.env.CLAUDE_SESSION_ROUTING = '1';
          doRespawn(s, console.log);
          process.env.CLAUDE_SESSION_ROUTING = originalRouting;
          rotatedCount++;

          console.log('Waiting 5s to stagger next rotation...');
          await sleep(5000);
        } else {
          try {
            const marker = `/tmp/claude-respawn-deferred-${s.id}`;
            // Exclusive create with owner-only permissions: `wx` fails instead
            // of following/overwriting anything already at this path (a prior
            // marker, or a symlink a local attacker planted), and `mode 0o600`
            // means the file another user cannot read or tamper with it once
            // created. Either way, "marker already there" is the correct
            // outcome for this check.
            try {
              writeFileSync(marker, String(Date.now()), { flag: 'wx', mode: 0o600 });
            } catch {}
            console.log(`Session ${s.id} is busy. Deferring rotation.`);
          } catch {}
        }
      } else {
        console.log(`No other viable accounts found for session ${s.id}.`);
      }
    }
  }

  console.log(`\nSession lease rotation completed. Rotated ${rotatedCount} session(s).\n`);
  process.exit(0);
} else if (args.includes('--status')) {
  await showStatus();
} else if (args.includes('--capture')) {
  const capToIdx = args.indexOf('--to');
  const captureTo = capToIdx !== -1 && args[capToIdx + 1] ? args[capToIdx + 1] : null;
  captureCmd(captureTo);
} else if (args.includes('--pin-browser-active')) {
  // Resolve the currently-active rotating account from state.json and delegate
  // to --pin-browser. This is what the PreToolUse hook calls so the chrome
  // bridge follows wherever rotation lands, instead of being hardcoded to a
  // single account. Falls back to a default (env CLAUDE_PIN_BROWSER_DEFAULT or
  // first config account) when state is empty/unreadable.
  const ttlIdx = args.indexOf('--ttl');
  const ttlSec = ttlIdx !== -1 && args[ttlIdx + 1] ? parseInt(args[ttlIdx + 1], 10) : 600;
  let email = null;
  try {
    const st = readState();
    const cfg = readConfig();
    const acct = cfg.accounts.find((a) => accountKey(a) === st.activeAccount);
    email = acct?.email || null;
  } catch {}
  if (!email) {
    email = process.env.CLAUDE_PIN_BROWSER_DEFAULT || (readConfig().accounts[0]?.email ?? null);
  }
  if (!email) {
    log('[pin-browser-active] no resolvable active account — skipping');
    process.exit(0);
  }
  // Re-dispatch into the --pin-browser branch by spawning ourselves. Cleaner
  // than refactoring the whole branch into a function for now; cost is one
  // extra fork. Stays best-effort/silent like the original hook contract.
  const child = spawnSync(
    process.execPath,
    [join(__dirname, 'rotate.mjs'), '--pin-browser', email, '--ttl', String(ttlSec)],
    { stdio: 'ignore', timeout: 30_000 },
  );
  process.exit(child.status || 0);
} else if (args.includes('--pin-browser')) {
  // Pin the active CLI keychain to the browser-extension account and freeze the
  // daemon briefly. claude-in-chrome requires CLI account == claude.ai login, so
  // while the bridge is in use the CLI must stay on the extension's account.
  // Invoked by the PreToolUse hook on mcp__claude-in-chrome__*. Best-effort and
  // fast: never throws, always exits 0 so it can't block the browser tool call.
  //
  // Sync ~/.claude.json oauthAccount + chromeExtension blocks to match the
  // pinned account so the chrome bridge handshake succeeds — see snapshot
  // helpers above. Existing pre-pin blocks are backed up to
  // `.browser-pin-backup.json` and restored on `--release-browser-pin` (called
  // by the daemon once the pin TTL lapses).
  const pinIdx = args.indexOf('--pin-browser');
  const pinEmail = args[pinIdx + 1];
  const ttlIdx = args.indexOf('--ttl');
  const ttlSec = ttlIdx !== -1 && args[ttlIdx + 1] ? parseInt(args[ttlIdx + 1], 10) : 300;
  try {
    const cfg = readConfig();
    const acct = cfg.accounts.find((a) => (a.email || '').toLowerCase() === (pinEmail || '').toLowerCase());
    if (!acct) {
      log(`[pin-browser] no account matching ${pinEmail} — writing pin sentinel only`);
    } else if (acquireLock()) {
      try {
        const swapped = await swapToken(acct);
        if (swapped) {
          const st = readState();
          st.activeAccount = accountKey(acct);
          writeState(st);
          log(`[pin-browser] CLI pinned to ${accountKey(acct)}`);
        } else {
          log(
            `[pin-browser] swapToken false for ${accountKey(acct)} (vault token missing/expired) — likely already active; pinning anyway`,
          );
        }
        // Sync .claude.json oauthAccount/chromeExtension blocks to match.
        const targetKey = accountKey(acct);
        const snapshot = loadOauthSnapshot(targetKey) || loadOauthSnapshot(acct.email);
        const cj = readClaudeJson();
        const currentEmail = cj?.oauthAccount?.emailAddress?.toLowerCase() || null;
        const wantEmail = (acct.email || '').toLowerCase();
        if (currentEmail === wantEmail) {
          // Already in sync — opportunistically capture as snapshot baseline if missing.
          if (!snapshot) {
            captureOauthSnapshot(acct.email);
          }
          log(`[pin-browser] .claude.json oauthAccount already=${currentEmail} — no swap needed`);
        } else if (snapshot) {
          // Back up the outgoing blocks once per pin window (don't clobber existing backup).
          if (!existsSync(BROWSER_PIN_BACKUP_PATH)) backupCurrentOauthBlocks();
          const applied = applyOauthSnapshotToClaudeJson(snapshot);
          if (applied) {
            log(
              `[pin-browser] .claude.json oauthAccount swapped ${currentEmail || 'unknown'} → ${wantEmail}. Restart Claude Code session to apply (chrome bridge reads on startup).`,
            );
          } else {
            log(`[pin-browser] snapshot found but apply failed for ${wantEmail}`);
          }
          // Ensure the matching Chrome profile is running so its extension
          // service worker is alive and can authenticate against the swapped
          // pairedDeviceId. No-op if already running.
          const profileDir = snapshot.chromeProfileDir || chromeProfileDirFor(targetKey);
          if (profileDir && !isChromeProfileRunning(profileDir)) {
            // Navigate to claude.ai/chrome to wake the extension service
            // worker — it only establishes the native-messaging bridge to
            // Claude Code when this page loads. Without it, the extension
            // is installed but dormant and the bridge reports "not connected".
            launchChromeProfile(profileDir, 'https://claude.ai/chrome');
            log(`[pin-browser] launched Chrome profile ${profileDir} for ${wantEmail} (@ claude.ai/chrome)`);
          }
        } else {
          log(
            `[pin-browser] WARNING: no oauth-snapshot for ${targetKey}. Chrome bridge will fail until you: (1) restart Claude Code while keychain is on ${wantEmail}, (2) run: node ${join(__dirname, 'rotate.mjs')} --capture-oauth-snapshot ${wantEmail}`,
          );
        }
      } finally {
        releaseLock();
      }
    } else {
      log('[pin-browser] rotation lock busy — skipping swap, still writing pin sentinel');
    }
    // Always (re)write the freeze sentinel so the daemon won't rotate away while
    // the browser bridge is in use. The hook refreshes this on every tool call.
    writeFileSync(
      BROWSER_PIN_PATH,
      JSON.stringify({ email: pinEmail, until: Date.now() + ttlSec * 1000, ts: Date.now() }),
    );
  } catch (e) {
    log(`[pin-browser] error (non-fatal): ${(e.message || e).toString().slice(0, 120)}`);
  }
  process.exit(0);
} else if (args.includes('--release-browser-pin')) {
  // Restore pre-pin ~/.claude.json oauthAccount/chromeExtension blocks. Called by
  // the daemon once the .browser-pin sentinel's TTL expires. Idempotent: if no
  // backup exists, exits 0 silently.
  try {
    if (existsSync(BROWSER_PIN_BACKUP_PATH)) {
      restoreOauthBlocksFromBackup();
    }
    if (existsSync(BROWSER_PIN_PATH)) {
      try {
        unlinkSync(BROWSER_PIN_PATH);
      } catch {}
    }
  } catch (e) {
    log(`[release-browser-pin] error (non-fatal): ${(e.message || e).toString().slice(0, 120)}`);
  }
  process.exit(0);
} else if (args.includes('--build-snapshot-from-api')) {
  // Construct an oauth-snapshot for an account using its stored vault token
  // plus `https://api.anthropic.com/api/oauth/profile`. This bypasses the
  // Claude Code session restart that --capture-oauth-snapshot requires — the
  // snapshot is built directly from API metadata. The resulting snapshot is
  // ready to be applied by --pin-browser the next time rotation lands here.
  //
  //   node rotate.mjs --build-snapshot-from-api <email>
  //   node rotate.mjs --build-snapshot-from-api --all
  const isAll = args.includes('--all');
  const idx = args.indexOf('--build-snapshot-from-api');
  const wantedEmail = !isAll && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  if (!isAll && !wantedEmail) {
    console.error('Usage: rotate.mjs --build-snapshot-from-api <email>');
    console.error('       rotate.mjs --build-snapshot-from-api --all');
    process.exit(2);
  }
  const cfg = readConfig();
  const targets = isAll
    ? cfg.accounts
    : cfg.accounts.filter((a) => (a.email || '').toLowerCase() === wantedEmail.toLowerCase());
  if (!targets.length) {
    console.error(`No account matching ${wantedEmail}`);
    process.exit(2);
  }
  ensureSnapshotsDir();
  // Seed chromeExtension from current ~/.claude.json — all clones share the
  // inherited pairedDeviceId until each profile re-Links. Acceptable for
  // single-account-at-a-time rotation; multi-account simultaneous bridge
  // requires per-profile Link clicks.
  const seedCj = readClaudeJson();
  const seedExt = seedCj?.chromeExtension?.pairedDeviceId
    ? seedCj.chromeExtension
    : { pairedDeviceId: '', pairedDeviceName: 'ClaudeCode' };
  let okCount = 0;
  let failCount = 0;
  for (const acct of targets) {
    const key = accountKey(acct);
    const tokenJson = readStoredToken(acct);
    if (!tokenJson) {
      console.error(`[skip] ${acct.email}: no vault token in keychain`);
      failCount++;
      continue;
    }
    let accessToken = null;
    try {
      accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
    } catch {}
    if (!accessToken) {
      console.error(`[skip] ${acct.email}: vault token has no accessToken`);
      failCount++;
      continue;
    }
    // Probe /oauth/profile
    const probe = spawnSync(
      'curl',
      [
        '-sS',
        '--max-time',
        '12',
        '-H',
        `Authorization: Bearer ${accessToken}`,
        '-H',
        'anthropic-beta: oauth-2025-04-20',
        'https://api.anthropic.com/api/oauth/profile',
      ],
      { encoding: 'utf8' },
    );
    if (probe.status !== 0 || !probe.stdout) {
      console.error(`[skip] ${acct.email}: /oauth/profile failed (curl exit ${probe.status})`);
      failCount++;
      continue;
    }
    let pf;
    try {
      pf = JSON.parse(probe.stdout);
    } catch (_e) {
      console.error(`[skip] ${acct.email}: /oauth/profile non-JSON response`);
      failCount++;
      continue;
    }
    if (!pf.account?.uuid || !pf.organization?.uuid) {
      console.error(`[skip] ${acct.email}: /oauth/profile missing account/org UUID (token rejected?)`);
      failCount++;
      continue;
    }
    const a = pf.account;
    const o = pf.organization;
    const snapshot = {
      capturedAt: new Date().toISOString(),
      accountKey: key,
      email: a.email,
      chromeProfileDir: chromeProfileDirFor(key),
      blocks: {
        oauthAccount: {
          accountUuid: a.uuid,
          emailAddress: a.email,
          organizationUuid: o.uuid,
          hasExtraUsageEnabled: !!o.has_extra_usage_enabled,
          billingType: o.billing_type || null,
          accountCreatedAt: a.created_at || null,
          subscriptionCreatedAt: o.subscription_created_at || null,
          ccOnboardingFlags: o.cc_onboarding_flags || {},
          claudeCodeTrialEndsAt: o.claude_code_trial_ends_at || null,
          claudeCodeTrialDurationDays: o.claude_code_trial_duration_days || null,
          seatTier: o.seat_tier || null,
          organizationRole: 'admin',
          workspaceRole: null,
          organizationName: o.name || null,
          organizationType: o.organization_type || null,
          organizationRateLimitTier: o.rate_limit_tier || null,
          userRateLimitTier: null,
        },
        chromeExtension: seedExt,
      },
    };
    const out = snapshotPathFor(key);
    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.error(`[ok] ${acct.email.padEnd(38)} → ${out.replace(process.env.HOME || '', '~')}`);
    okCount++;
  }
  console.error(`\nDone: ${okCount} captured, ${failCount} skipped`);
  process.exit(failCount > 0 && okCount === 0 ? 1 : 0);
} else if (args.includes('--capture-oauth-snapshot')) {
  // Manually capture the current ~/.claude.json oauthAccount + chromeExtension
  // blocks under a snapshot keyed by accountKey. Requires the CLI keychain +
  // .claude.json to be in sync (i.e. you just restarted Claude Code with the
  // target account live). Pass --capture-oauth-snapshot <email> to require a
  // match, or pass no arg to capture whatever .claude.json currently holds.
  const idx = args.indexOf('--capture-oauth-snapshot');
  const wantedEmail = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  const ok = captureOauthSnapshot(wantedEmail);
  process.exit(ok ? 0 : 1);
} else if (args.includes('--colorize-chrome-profiles')) {
  // Patch ~/Library/Application Support/Google/Chrome/Local State so each
  // per-account profile gets a clear display name + distinct theme color in
  // Chrome's profile picker. Chrome must be QUIT first — it rewrites Local
  // State on shutdown, clobbering changes made while it is running.
  if (
    isChromeProfileRunning('ClaudeCode') ||
    readdirSync(CHROME_PROFILES_BASE).some((d) => d.startsWith('ClaudeCode') && isChromeProfileRunning(d))
  ) {
    console.error('[colorize] Chrome is running with a ClaudeCode profile. Quit all of them first:');
    console.error('  pkill -f "profile-directory=ClaudeCode"');
    process.exit(2);
  }
  const ls = readChromeLocalState();
  if (!ls) {
    console.error(`[colorize] cannot read ${CHROME_LOCAL_STATE_PATH}`);
    process.exit(2);
  }
  ls.profile = ls.profile || {};
  ls.profile.info_cache = ls.profile.info_cache || {};
  const cfg = readConfig();
  let touched = 0;
  cfg.accounts.forEach((acct, i) => {
    const dir = chromeProfileDirFor(accountKey(acct));
    if (!isChromeProfileBootstrapped(dir)) return;
    const palette = PROFILE_COLOR_PALETTE[i % PROFILE_COLOR_PALETTE.length];
    const name = displayNameFor(acct);
    const entry = ls.profile.info_cache[dir] || {};
    entry.name = name;
    entry.shortcut_name = name;
    entry.gaia_name = name;
    entry.user_name = acct.email;
    entry.profile_highlight_color = colorIntFromHex(palette.hex);
    entry.is_using_default_name = false;
    entry.is_using_default_avatar = false;
    // Use Chrome's built-in flat-color avatar set; index 26+ are the modern set
    entry.avatar_icon = `chrome://theme/IDR_PROFILE_AVATAR_${26 + (i % 24)}`;
    ls.profile.info_cache[dir] = entry;
    touched++;
    console.error(`[colorize] ${dir.padEnd(50)} → "${name}" (${palette.name} ${palette.hex})`);
  });
  if (touched > 0) writeChromeLocalStateAtomic(ls);
  console.error(`[colorize] patched ${touched} profile entries in Local State`);
  process.exit(0);
} else if (args.includes('--bootstrap-chrome-profile') || args.includes('--bootstrap-all-chrome-profiles')) {
  // Per-account Chrome profile bootstrap. Two modes:
  //
  //   --bootstrap-chrome-profile <email>     — one account
  //   --bootstrap-all-chrome-profiles        — every account in config.json
  //
  // Each per-account profile is cloned from a source profile (default
  // `ClaudeCode`, override with `--clone-from <dir>`) so the Claude extension
  // is pre-installed and the operator doesn't have to redo browser setup. After clone,
  // each profile is launched against claude.ai/chrome so the operator can sign out of
  // the inherited account, sign in as the target account, and click Link to
  // pair. A capture step (--capture-oauth-snapshot) then snapshots the new
  // pairing for use by --pin-browser.
  const isAll = args.includes('--bootstrap-all-chrome-profiles');
  const cloneFromIdx = args.indexOf('--clone-from');
  const cloneFromArg =
    cloneFromIdx !== -1 && args[cloneFromIdx + 1] && !args[cloneFromIdx + 1].startsWith('--')
      ? args[cloneFromIdx + 1]
      : 'ClaudeCode';
  const cfg = readConfig();
  let targets;
  if (isAll) {
    targets = cfg.accounts.slice();
  } else {
    const idx = args.indexOf('--bootstrap-chrome-profile');
    const targetEmail = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    if (!targetEmail) {
      console.error('Usage: rotate.mjs --bootstrap-chrome-profile <email>');
      console.error('       rotate.mjs --bootstrap-all-chrome-profiles [--clone-from <dir>]');
      process.exit(2);
    }
    const acct = cfg.accounts.find((a) => (a.email || '').toLowerCase() === targetEmail.toLowerCase());
    if (!acct) {
      console.error(`No account matching ${targetEmail} in config.json`);
      process.exit(2);
    }
    targets = [acct];
  }
  // Refuse to proceed if the clone source is currently running — leveldb of
  // a running Chrome is unsafe to copy and produces a corrupt clone.
  if (isChromeProfileRunning(cloneFromArg)) {
    console.error(
      `[bootstrap-chrome-profile] source profile "${cloneFromArg}" is currently RUNNING.\n` +
        'Cloning a live profile corrupts leveldb. Quit that Chrome window first, then re-run:\n' +
        `  pkill -f "profile-directory=${cloneFromArg}"  &&  node ${join(__dirname, 'rotate.mjs')} ${args.join(' ')}`,
    );
    process.exit(2);
  }
  if (!isChromeProfileBootstrapped(cloneFromArg)) {
    console.error(
      `[bootstrap-chrome-profile] source profile "${cloneFromArg}" does not exist at ${chromeProfilePath(cloneFromArg)}`,
    );
    process.exit(2);
  }
  // Phase 1: clone (no launches yet — Chrome must stay quit while we patch Local State)
  const results = [];
  for (const acct of targets) {
    const key = accountKey(acct);
    const profileDir = chromeProfileDirFor(key);
    let cloneStatus = { ok: true, reason: 'existed' };
    if (!isChromeProfileBootstrapped(profileDir)) {
      console.error(`[bootstrap] cloning ${cloneFromArg} → ${profileDir} (${acct.email})...`);
      cloneStatus = cloneChromeProfile(cloneFromArg, profileDir);
      if (!cloneStatus.ok) {
        console.error(`[bootstrap] FAILED to clone for ${acct.email}: ${cloneStatus.reason}`);
        results.push({ email: acct.email, profileDir, clone: cloneStatus.reason, launched: false });
        continue;
      }
    } else {
      console.error(`[bootstrap] profile ${profileDir} already exists — skipping clone`);
    }
    results.push({ email: acct.email, profileDir, clone: cloneStatus.reason, launched: false });
  }
  // Phase 2: colorize Local State (display name + theme color + avatar per profile)
  try {
    const ls = readChromeLocalState();
    if (ls) {
      ls.profile = ls.profile || {};
      ls.profile.info_cache = ls.profile.info_cache || {};
      cfg.accounts.forEach((acct, i) => {
        const dir = chromeProfileDirFor(accountKey(acct));
        if (!isChromeProfileBootstrapped(dir)) return;
        const palette = PROFILE_COLOR_PALETTE[i % PROFILE_COLOR_PALETTE.length];
        const name = displayNameFor(acct);
        const entry = ls.profile.info_cache[dir] || {};
        entry.name = name;
        entry.shortcut_name = name;
        entry.gaia_name = name;
        entry.user_name = acct.email;
        entry.profile_highlight_color = colorIntFromHex(palette.hex);
        entry.is_using_default_name = false;
        entry.is_using_default_avatar = false;
        entry.avatar_icon = `chrome://theme/IDR_PROFILE_AVATAR_${26 + (i % 24)}`;
        ls.profile.info_cache[dir] = entry;
        console.error(`[colorize] ${dir.padEnd(50)} → "${name}" (${palette.name})`);
      });
      writeChromeLocalStateAtomic(ls);
    }
  } catch (e) {
    console.error(`[colorize] non-fatal: ${(e.message || e).toString().slice(0, 120)}`);
  }
  // Phase 3: launch each cloned profile so user can finish manual sign-in
  for (const r of results) {
    if (r.clone === 'cp-failed' || r.clone === 'src-running' || r.clone === 'src-missing') continue;
    r.launched = launchChromeProfile(r.profileDir, 'https://claude.ai/chrome');
  }
  console.error('');
  console.error('─── Bootstrap summary ───────────────────────────────────────────────────');
  for (const r of results) {
    console.error(
      `  ${r.email.padEnd(38)} profile=${r.profileDir.padEnd(40)} clone=${r.clone.padEnd(10)} launched=${r.launched}`,
    );
  }
  console.error('');
  console.error('─── Manual finalization (per profile) ───────────────────────────────────');
  console.error('In each Chrome window that opened:');
  console.error('  1. Sign out of the inherited claude.ai session');
  console.error('  2. Sign in as the matching account email');
  console.error('  3. Click "Link" on claude.ai/chrome to re-pair the extension');
  console.error('  4. Back in terminal: restart Claude Code while CLI is on that account,');
  console.error('     then run: rotate.mjs --capture-oauth-snapshot <email>');
  console.error('─────────────────────────────────────────────────────────────────────────');
  process.exit(0);
} else {
  const toIdx = args.indexOf('--to');
  const target = toIdx !== -1 ? args[toIdx + 1] : null;
  const session = args.includes('--session');
  const noBrowser = args.includes('--no-browser');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const magicLink = args.includes('--magic-link');
  const allowExhausted = args.includes('--allow-exhausted');
  if (dryRun) log('DRY RUN MODE — no changes will be made');
  // Autonomous magic-link MUST be single-flight. Never kill sibling rotate.mjs
  // processes — that produced exit-137 mid-OAuth and CDP session thrash when
  // batch + launchd + --setup --auto all ran with --force (2026-07-14).
  // --force here only means "ignore soft cooldowns / re-auth even if recently done".
  const magicAuto = process.env.CLAUDE_ROTATION_MAGIC_LINK_AUTO === '1' || magicLink;
  if (force) {
    log('Force mode does not bypass or signal a live rotation lock');
  }

  let exitCode = 1;
  let lockAcquired = false;
  if (!dryRun) {
    lockAcquired = acquireLock();
    if (!lockAcquired) {
      console.error('Rotation in progress.');
      process.exitCode = magicAuto ? 0 : 1;
    }
  }

  if (dryRun || lockAcquired) {
    try {
      const ok = await rotate(target, {
        session,
        noBrowser,
        dryRun,
        magicLink,
        allowExhausted,
      });
      exitCode = ok ? 0 : 1;
    } catch (err) {
      log(`FATAL: ${err.message}`);
      notify('Account Rotation', `FAILED: ${redactSensitiveText(err.message)}`);
      exitCode = 1;
    } finally {
      if (lockAcquired) releaseLock();
    }
    process.exitCode = exitCode;
  }
}
