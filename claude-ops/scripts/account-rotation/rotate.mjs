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
 *   node rotate.mjs --utilization             # live 5h/7d utilization per account
 *   node rotate.mjs --audit-billing           # 🔴/🟢 per-account extra_usage (overage billing) audit
 *   node rotate.mjs --setup                   # manual: claude auth login per account (interactive)
 *   node rotate.mjs --setup --auto            # AUTOMATED: magic-link + browser cascade, all configured accounts end-to-end
 *   node rotate.mjs --setup --auto --skip-valid  # skip accounts whose vault token is still alive
 *   node rotate.mjs --setup --only=<key>      # only re-capture one account (e.g. --only=user@example.com)
 *   node rotate.mjs --capture                 # save current active token (print for Dashlane)
 *   node rotate.mjs --session                 # also send /login to running iTerm2 session
 *   node rotate.mjs --magic-link --to <email> # re-auth via email magic link (no Google OAuth)
 *   node rotate.mjs --allow-extra-usage       # BYPASS extra_usage billing guard (opt-in only)
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
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, execFileSync, spawn } from "child_process";
import { tmpdir } from "os";
import { createHmac } from "node:crypto";
import { askAIBrain, executeAIAction, AI_BRAIN_MAX_DECISIONS } from "./ai-brain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const STATE_PATH = join(__dirname, "state.json");
const LOCK_PATH = join(__dirname, ".rotating");
const LOG_PATH = join(__dirname, "rotation.log");

const KEYCHAIN_SERVICE = "Claude Code-credentials";
// Use the OS username so multiple users on the same Mac don't collide on
// keychain entries. Override with CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT if needed.
const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT ||
  process.env.USER ||
  process.env.LOGNAME ||
  "claude-ops";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Bootstrap: verify dependencies ───────────────────────────────────────────
// The only browser driver is Playwright-over-CDP to Chrome or Chrome Beta
// (never Comet — reserved for user, never Chromium — bundled browser banned).
function ensureMCPServersAndTools() {
  const actions = [];
  const earlyLog = (m) => {
    try {
      console.error(`[bootstrap] ${m}`);
    } catch {}
  };

  // 1. Chrome or Chrome Beta binary (Comet is off-limits)
  const realChromes = [
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const foundChrome = realChromes.find((p) => existsSync(p));
  if (foundChrome) {
    actions.push(`chrome-binary: ${foundChrome.split("/").pop()}`);
  } else {
    actions.push("chrome-binary: WARNING — no Chrome/Chrome Beta found");
  }

  // 2. Chrome CDP port 9222 — probe (driver will launch Chrome if needed)
  try {
    execSync(`curl -sf http://localhost:9222/json/version >/dev/null 2>&1`, {
      timeout: 1500,
    });
    actions.push("chrome-cdp: reachable on :9222");
  } catch {
    actions.push("chrome-cdp: not reachable (driver will launch Chrome)");
  }

  // 3. dcli (Dashlane) — required for primary token path
  try {
    execSync(`command -v dcli >/dev/null 2>&1`, { timeout: 1000 });
    actions.push("dcli: available");
  } catch {
    actions.push("dcli: MISSING — primary token path will fail");
  }

  // 4. security (macOS keychain) — required for token writes
  try {
    execSync(`command -v security >/dev/null 2>&1`, { timeout: 1000 });
  } catch {
    actions.push("security(1): MISSING — keychain writes will fail");
  }

  for (const a of actions) earlyLog(a);
}

// Unconditional warmup: every rotate.mjs run starts its MCP servers + tools FIRST.
// Skip only for --help (where nothing runs downstream).
if (
  !process.argv.slice(2).includes("--help") &&
  !process.argv.slice(2).includes("--no-browser")
) {
  ensureMCPServersAndTools();
}

// ── Utilities ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

function notify(title, msg) {
  try {
    execSync(
      `osascript -e 'display notification "${msg.replace(/"/g, '\\"')}" with title "${title}"'`,
    );
  } catch {}
}

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      activeAccount: null,
      accounts: {},
      toolUses: 0,
      totalRotations: 0,
    };
  }
}
function writeState(s, dryRun = false) {
  if (dryRun) {
    log("[DRY-RUN] Would write state");
    return;
  }
  const tmp = STATE_PATH + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH);
}

// Lock format: `<ISO timestamp>\n<pid>` — PID lets us detect dead holders
// regardless of wall-clock age (browser OAuth can legitimately run >30s).
const LOCK_MAX_AGE_MS = 15 * 60_000; // hard ceiling; browser OAuth can take minutes
function readLock() {
  try {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    const [ts, pidStr] = raw.split(/\s+/);
    const pid = parseInt(pidStr || "", 10);
    const when = new Date(ts).getTime();
    return {
      when: Number.isFinite(when) ? when : 0,
      pid: Number.isFinite(pid) ? pid : 0,
    };
  } catch {
    return null;
  }
}
function lockHolderAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const info = readLock();
    if (info && lockHolderAlive(info.pid)) {
      const age = Date.now() - info.when;
      if (age < LOCK_MAX_AGE_MS) {
        log(`Rotation in progress (holder PID ${info.pid}, ${Math.round(age / 1000)}s old)`);
        return false;
      }
      log(`Lock held by PID ${info.pid} but >${Math.round(LOCK_MAX_AGE_MS / 60_000)}min old — breaking`);
    } else if (info) {
      log(`Stale lock (PID ${info.pid || "?"} not running) — breaking`);
    }
  }
  writeFileSync(LOCK_PATH, `${new Date().toISOString()}\n${process.pid}`);
  return true;
}
function releaseLock() {
  try {
    // Only release if we still own it
    const info = readLock();
    if (!info || info.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {}
}

function accountKey(a) {
  return a.label || a.email;
}

// ── Live utilization query ────────────────────────────────────────────────────

// Query all accounts in parallel — best-effort, uses cached fallback.
// Staggered + retry-on-429 to avoid rate-limiting the /oauth/usage endpoint,
// especially right after a token refresh when Anthropic briefly throttles.
async function queryAllUtilization(config) {
  async function queryAccount(a) {
    try {
      const tokenJson = readStoredToken(a);
      if (!tokenJson) return null;
      const parsed = JSON.parse(tokenJson);
      const accessToken = parsed?.claudeAiOauth?.accessToken;
      if (!accessToken) return null;

      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      };

      async function fetchWithRetry(url, attempt = 0) {
        const res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5000),
        });
        // Retry once on 429 — happens transiently right after token refresh
        // or when multiple accounts query in parallel
        if (res.status === 429 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          return fetchWithRetry(url, attempt + 1);
        }
        return res;
      }

      const [usageRes, profileRes] = await Promise.all([
        fetchWithRetry("https://api.anthropic.com/api/oauth/usage"),
        fetchWithRetry("https://api.anthropic.com/api/oauth/profile"),
      ]);

      if (!usageRes.ok) return null;
      const data = await usageRes.json();
      let extraUsageEnabled = null;
      let billingType = null;
      let subscriptionStatus = null;
      if (profileRes.ok) {
        const prof = await profileRes.json();
        extraUsageEnabled = prof?.organization?.has_extra_usage_enabled ?? null;
        billingType = prof?.organization?.billing_type ?? null;
        subscriptionStatus = prof?.organization?.subscription_status ?? null;
      }
      return {
        five_hour_pct:
          Math.round((data.five_hour?.utilization ?? 0) * 100) / 100,
        seven_day_pct:
          Math.round((data.seven_day?.utilization ?? 0) * 100) / 100,
        resets_at_5h: data.five_hour?.resets_at || null,
        resets_at_7d: data.seven_day?.resets_at || null,
        extra_usage_enabled: extraUsageEnabled,
        billing_type: billingType,
        subscription_status: subscriptionStatus,
      };
    } catch {
      return null;
    }
  }

  // Stagger account queries by 150ms to avoid bursting /oauth/usage endpoint,
  // which otherwise 429s on ~5-7 parallel requests from the same IP.
  const results = await Promise.allSettled(
    config.accounts
      .filter((a) => a.disabled !== true)
      .map(async (a, idx) => {
        if (idx > 0) await new Promise((r) => setTimeout(r, 150 * idx));
        return { key: accountKey(a), util: await queryAccount(a) };
      }),
  );
  const map = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.util) {
      map[r.value.key] = r.value.util;
    }
  }
  return map;
}

// liveUtil: optional map from queryAllUtilization() — key → { five_hour_pct, ... }
function pickNextAccount(config, state, liveUtil = {}, opts = {}) {
  const activeKey = state.activeAccount;
  const windowMs = (config.rateLimits?.windowHours || 5) * 3_600_000;
  const now = Date.now();

  // Hard block: account has Anthropic-side extra-usage (pay-per-use overage) enabled.
  // Rotating to such an account risks credit-card charges when the weekly cap is hit.
  // Override with opts.allowExtraUsage=true (CLI flag --allow-extra-usage) only when
  // the user has explicitly opted in for this run.
  const allowExtraUsage = opts.allowExtraUsage === true;
  function hasExtraUsageEnabled(a) {
    const key = accountKey(a);
    const live = liveUtil[key];
    return live && live.extra_usage_enabled === true;
  }

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

  // 7-day weekly cap utilization. Live only — no snapshot fallback because
  // 7d resets are slow and stale data is misleading.
  function getUtil7d(a) {
    const key = accountKey(a);
    if (liveUtil[key] != null && liveUtil[key].seven_day_pct != null) {
      return liveUtil[key].seven_day_pct;
    }
    return null;
  }

  // Score: max of (5h, 7d) — an account is only viable if BOTH windows have
  // headroom. Unknown util → 50 (neutral). Lower is better.
  function score(a) {
    const u5 = getUtil5h(a);
    const u7 = getUtil7d(a);
    if (u5 === null && u7 === null) return 50;
    return Math.max(u5 ?? 0, u7 ?? 0);
  }

  // Log + hard-exclude accounts with extra_usage enabled (pay-per-use overage billing).
  // These are the accounts that silently charge your credit card when the weekly cap
  // is exceeded. Unless --allow-extra-usage was passed, we refuse to rotate to them.
  const extraUsageAccounts = config.accounts.filter(hasExtraUsageEnabled);
  if (extraUsageAccounts.length > 0) {
    log(
      `⚠  EXTRA USAGE ENABLED on ${extraUsageAccounts.length} account(s): ${extraUsageAccounts
        .map((a) => accountKey(a))
        .join(
          ", ",
        )} — these can incur overage charges. Disable at console.anthropic.com/settings/billing.`,
    );
  }

  const excludeKey = (a) =>
    a.disabled === true ||
    accountKey(a) === activeKey ||
    (!allowExtraUsage && hasExtraUsageEnabled(a));

  // Separate normal and low-priority, excluding current active + extra-usage accounts
  const normal = config.accounts.filter(
    (a) => a.priority !== "low" && !excludeKey(a),
  );
  const low = config.accounts.filter(
    (a) => a.priority === "low" && !excludeKey(a),
  );

  const UTIL_HARD_BLOCK = 90; // Skip accounts at/above this util% if possible

  for (const pool of [normal, low]) {
    const fresh = pool.filter((a) => !isExhausted(a));
    const exhausted = pool.filter((a) => isExhausted(a));

    for (const candidates of [fresh, exhausted]) {
      const viable = candidates.filter((a) => score(a) < UTIL_HARD_BLOCK);
      const blocked = candidates.filter((a) => score(a) >= UTIL_HARD_BLOCK);
      const sorted = [...viable].sort((a, b) => score(a) - score(b));
      const pool2 = sorted.length
        ? sorted
        : [...blocked].sort((a, b) => score(a) - score(b));

      if (pool2.length > 0) {
        const best = pool2[0];
        const u5 = getUtil5h(best);
        const u7 = getUtil7d(best);
        const src = liveUtil[accountKey(best)]
          ? "live"
          : state.accounts[accountKey(best)]?.lastUtilization
            ? "cached"
            : "unknown";
        const utilStr = ` 5h=${u5 ?? "?"}% 7d=${u7 ?? "?"}% [${src}]`;
        if (score(best) >= UTIL_HARD_BLOCK) {
          log(
            `WARNING: All candidates near limit — rotating to ${accountKey(best)}${utilStr}`,
          );
        } else {
          log(`Picked ${accountKey(best)}${utilStr}`);
        }
        return best;
      }
    }
  }
  return null;
}

// ── Keychain ─────────────────────────────────────────────────────────────────

function readKeychain(svc = KEYCHAIN_SERVICE, acct = KEYCHAIN_ACCOUNT) {
  const out = execSync(
    `security find-generic-password -s "${svc}" -a "${acct}" -g 2>&1`,
    { timeout: 5000 },
  ).toString();
  const m = out.match(/^password: "?(.*?)"?$/m);
  if (!m) throw new Error(`No keychain entry ${svc}/${acct}`);
  return m[1].replace(/\\"/g, '"');
}

function writeKeychain(json, svc = KEYCHAIN_SERVICE, acct = KEYCHAIN_ACCOUNT) {
  try {
    execSync(
      `security delete-generic-password -s "${svc}" -a "${acct}" 2>/dev/null`,
    );
  } catch {}
  execSync(
    `security add-generic-password -s "${svc}" -a "${acct}" -w ${JSON.stringify(json)}`,
    { timeout: 5000 },
  );
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

const TOKEN_PREFIX = "Claude-Rotation";

function tokenService(account) {
  return `${TOKEN_PREFIX}-${accountKey(account)}`;
}

function readStoredToken(account) {
  try {
    return readKeychain(tokenService(account));
  } catch {
    return null;
  }
}

function writeStoredToken(account, json) {
  writeKeychain(json, tokenService(account));
}

function hasStoredToken(account) {
  try {
    readKeychain(tokenService(account));
    return true;
  } catch {
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
    const match = creds.find(
      (c) => (c.email || "").toLowerCase() === account.email.toLowerCase(),
    );
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
      return execSync(`dcli read "${account.dashlaneGooglePath}" 2>/dev/null`, {
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
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32Secret.replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const i = base32chars.indexOf(c);
    if (i === -1) continue;
    bits += i.toString(2).padStart(5, "0");
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

  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

// Read the latest SMS verification code from Messages.app for the Google 2FA number.
// Returns a 6-digit code string or null.
// Read latest SMS verification code from Messages.app.
// Modern iMessages store text in `attributedBody` (NSKeyedArchiver blob), not `text`.
// We hex-dump both and extract G-XXXXXX or a 6-digit code.
function readLatestSMSCode({ maxAgeSec = 300 } = {}) {
  try {
    const db = join(process.env.HOME || "", "Library/Messages/chat.db");
    if (!existsSync(db)) return null;
    // Apple timestamp = seconds since 2001-01-01, stored as nanoseconds
    const cutoffAppleNs =
      (Math.floor(Date.now() / 1000) - 978307200 - maxAgeSec) * 1_000_000_000;
    const sql = `SELECT hex(attributedBody), text FROM message WHERE date > ${cutoffAppleNs} AND service IN ('SMS','iMessage') ORDER BY date DESC LIMIT 10;`;
    const rows = execSync(`sqlite3 "${db}" "${sql}"`, { timeout: 5000 })
      .toString()
      .split("\n")
      .filter(Boolean);
    for (const row of rows) {
      const [hex, text] = row.split("|");
      // Plain text column (older macOS)
      if (text) {
        const m = text.match(/G-(\d{6})/) || text.match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
      // attributedBody blob — decode as latin-1 and regex-match
      if (hex && hex.length > 20) {
        const decoded = Buffer.from(hex, "hex").toString("latin1");
        const m =
          decoded.match(/G-(\d{6})/) ||
          decoded.match(/(\d{6})\s+is your (?:Google )?verification code/);
        if (m) return m[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── PRIMARY: local keychain token swap ───────────────────────────────────────

async function swapToken(account) {
  const token = readStoredToken(account);
  if (!token) {
    log("[primary] No stored token — need browser fallback");
    return false;
  }
  if (tokenExpired(token)) {
    log("[primary] Token expired — need browser fallback");
    return false;
  }
  log(`[primary] Swapping active keychain for ${accountKey(account)}...`);

  // Preserve mcpOAuth from current active token (Figma, Shake etc.)
  // so MCP connectors don't break on account swap
  try {
    const current = readKeychain();
    const currentParsed = JSON.parse(current);
    const newParsed = JSON.parse(token);
    if (
      currentParsed.mcpOAuth &&
      Object.keys(currentParsed.mcpOAuth).length > 0
    ) {
      // Merge: keep current mcpOAuth, only swap claudeAiOauth
      newParsed.mcpOAuth = { ...newParsed.mcpOAuth, ...currentParsed.mcpOAuth };
      writeKeychain(JSON.stringify(newParsed));
      log("[primary] Preserved mcpOAuth from previous session");
      return true;
    }
  } catch {}

  writeKeychain(token);
  return true;
}

// Save current active token back to the account's vault entry
// Strips mcpOAuth so vault tokens are clean (mcpOAuth merged at swap time)
function saveCurrentToken(account) {
  try {
    const token = readKeychain();
    if (token.includes("claudeAiOauth")) {
      // Store only claudeAiOauth, not mcpOAuth (that's session-specific)
      try {
        const parsed = JSON.parse(token);
        const clean = { claudeAiOauth: parsed.claudeAiOauth, mcpOAuth: {} };
        writeStoredToken(account, JSON.stringify(clean));
      } catch {
        writeStoredToken(account, token);
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
const _fallbacksEnabled = process.env.CLAUDE_ROTATION_ENABLE_FALLBACKS === "1";
const DRIVER_CASCADE = [
  ["playwright", makePlaywrightDriver], // CDP to Chrome/Chrome Beta with real profile
  ...(_fallbacksEnabled
    ? [
        ["kapture", makeKaptureDriver],
        ["chrome-jxa", makeChromeJXADriver],
        ["manual", makeManualDriver],
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
  throw new Error("All browser drivers failed");
}

// ─── Driver 1: Kapture MCP (WebSocket → real Chrome, all Google sessions) ────

async function makeKaptureDriver() {
  const { default: WebSocket } = await import("ws");

  // Auto-start Kapture server if not running
  let ws;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket("ws://localhost:61822/mcp");
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("timeout"));
        }, 4000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      break;
    } catch {
      if (attempt === 0) {
        log("Kapture not running — starting server...");
        spawn("npx", ["kapture-mcp"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        await sleep(3000);
      }
    }
  }
  if (!ws) throw new Error("Kapture unavailable");

  // JSON-RPC over WebSocket
  let msgId = 0;
  const pending = new Map();

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error
          ? reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          : resolve(msg.result);
      }
    } catch {}
  });

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
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
    return rpc("tools/call", { name, arguments: args });
  }

  // MCP handshake
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "claude-rotation", version: "1.0" },
  });
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  );

  // Get existing tab or open new one
  let tabId;
  try {
    const tabsResult = await tool("list_tabs", {});
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
    const result = await tool("new_tab", { browser: "chrome" });
    const text = extractText(result);
    const m =
      text.match(/[Tt]ab\s+[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)/) ||
      text.match(/([a-zA-Z0-9_-]{8,})/);
    tabId = m?.[1] || "tab1";
    await sleep(2000);
  }

  log(`Kapture using tab: ${tabId}`);

  return {
    name: "kapture",
    _tabId: tabId,
    async goto(url) {
      await tool("navigate", { tabId, url, timeout: 30_000 });
      await sleep(2500);
    },
    async currentUrl() {
      try {
        const r = await tool("tab_detail", { tabId });
        const text = extractText(r);
        const m =
          text.match(/[Uu][Rr][Ll][:\s]+(\S+)/) ||
          text.match(/https?:\/\/[^\s"',]+/);
        return m?.[1] || m?.[0] || "";
      } catch {
        return "";
      }
    },
    async findAndClick(texts) {
      for (const t of texts) {
        // CSS selector? Try that first — most reliable.
        const isCss =
          /^[\[#.]/.test(t) ||
          t.includes("data-testid") ||
          t.includes("[type=");
        if (isCss) {
          try {
            await tool("click", { tabId, selector: t });
            log(`[kapture] clicked via CSS: ${t}`);
            return true;
          } catch {}
          continue;
        }
        const clean = t
          .replace(/button:has-text\("?([^"]+)"?\)/g, "$1")
          .replace(/['"]/g, "")
          .trim();
        const escaped = clean.replace(/'/g, "\\'");
        const xpaths = [
          `//button[.//*[contains(normalize-space(.),'${escaped}')] or contains(normalize-space(.),'${escaped}')]`,
          `//a[.//*[contains(normalize-space(.),'${escaped}')] or contains(normalize-space(.),'${escaped}')]`,
          `//*[@role='button' and (.//*[contains(normalize-space(.),'${escaped}')] or contains(normalize-space(.),'${escaped}'))]`,
          `//*[@aria-label='${escaped}' or contains(@aria-label,'${escaped}')]`,
          `//*[normalize-space(text())='${escaped}']`,
          `//*[contains(normalize-space(text()),'${escaped}')]`,
          `//*[@data-identifier='${escaped}']`,
          `//*[@placeholder='${escaped}']`,
        ];
        for (const xpath of xpaths) {
          try {
            await tool("click", { tabId, xpath });
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
        await tool("fill", { tabId, selector: sel, value: val });
        return true;
      } catch {}
      // XPath fallback
      try {
        const xpath = `//*[self::input or self::textarea][@type='${sel.includes("password") ? "password" : "email"}']`;
        await tool("fill", { tabId, xpath, value: val });
        return true;
      } catch {
        return false;
      }
    },
    async screenshot(path) {
      try {
        const r = await tool("screenshot", {
          tabId,
          format: "png",
          scale: 0.5,
        });
        const content = r?.content?.[0];
        if (content?.type === "image" && content.data) {
          writeFileSync(path, Buffer.from(content.data, "base64"));
        }
      } catch {}
    },
    async readPageText() {
      try {
        const r = await tool("dom", { tabId });
        return extractText(r);
      } catch {
        return "";
      }
    },
    // Poll list_tabs for a new tab that appears after a Google OAuth click.
    // Returns a new driver bound to the popup's tab ID.
    async waitForPopup(timeoutMs = 15_000) {
      // Snapshot current tabs
      const snapshotTabs = async () => {
        try {
          const r = await tool("list_tabs", {});
          const text = extractText(r);
          // Parse all tab IDs from the response
          const ids = [];
          const re =
            /[Tt]ab\s+[Ii][Dd][:\s]+([a-zA-Z0-9_-]+)|\(([a-zA-Z0-9_-]{6,})\)|"id"\s*:\s*"([a-zA-Z0-9_-]+)"/g;
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
        const newTabs = [...after].filter(
          (id) => !before.has(id) && id !== tabId,
        );
        if (newTabs.length > 0) {
          const popupTabId = newTabs[0];
          log(`Popup detected, switching to tab: ${popupTabId}`);
          // Return a minimal driver bound to the popup tab
          return {
            name: "kapture-popup",
            _tabId: popupTabId,
            async goto(url) {
              await tool("navigate", {
                tabId: popupTabId,
                url,
                timeout: 30_000,
              });
              await sleep(2500);
            },
            async currentUrl() {
              try {
                const r = await tool("tab_detail", { tabId: popupTabId });
                const text = extractText(r);
                const m =
                  text.match(/[Uu][Rr][Ll][:\s]+(\S+)/) ||
                  text.match(/https?:\/\/[^\s"',]+/);
                return m?.[1] || m?.[0] || "";
              } catch {
                return "";
              }
            },
            async findAndClick(texts) {
              for (const t of texts) {
                const clean = t
                  .replace(/button:has-text\("?([^"]+)"?\)/g, "$1")
                  .replace(/['"]/g, "")
                  .trim();
                const xpaths = [
                  `//*[normalize-space(text())='${clean}']`,
                  `//*[contains(normalize-space(text()),'${clean}')]`,
                  `//*[@data-identifier='${clean}']`,
                  `//*[@placeholder='${clean}']`,
                ];
                for (const xpath of xpaths) {
                  try {
                    await tool("click", { tabId: popupTabId, xpath });
                    return true;
                  } catch {}
                }
              }
              return false;
            },
            async fillInput(sel, val) {
              if (!val) return false;
              try {
                await tool("fill", {
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
      log("No popup appeared within timeout");
      return null;
    },
    async close() {
      ws.close();
    },
  };
}

// Helper: extract text from MCP tool result
function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content || result;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.data || "").join("\n");
  }
  return JSON.stringify(result);
}

// ─── Driver 2: Playwright attached to REAL Chrome via CDP ───────────────────
// Attaches to the user's real Chrome/Comet profile (with all Google logins).
// Strategy:
//   1. If CDP is already up on :9222 → attach directly
//   2. Else: gracefully quit Chrome, relaunch with CDP + the real user profile
//   3. NEVER uses bundled Chromium, NEVER uses a separate profile dir
//
// The real user profile has all Google accounts signed in, so claude.ai's
// OAuth account picker shows all of them.

// Chrome Beta ONLY — dedicated automation browser.
// Uses an ISOLATED profile (not linked to Chrome Beta's default). Starts empty;
// rotation logs into Google accounts from scratch using dcli passwords + TOTP.
// Comet = user's browser (never touch). Chrome = user's browser (never touch).
const REAL_BROWSERS = [
  {
    name: "Google Chrome Beta",
    bin: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    profile: join(__dirname, ".chrome-beta-automation"),
    appName: "Google Chrome Beta",
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
    const browser = await chromium.connectOverCDP(
      `http://localhost:${CDP_PORT}`,
    );
    const contexts = browser.contexts();
    const ctx = contexts[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    log(`[playwright] Attached to running Chrome via CDP :${CDP_PORT}`);
    return { browser, ctx, page };
  } catch {
    return null;
  }
}

function isAppRunning(appName) {
  try {
    execSync(`pgrep -f "${appName.replace(/ /g, ".")}" > /dev/null 2>&1`, {
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function gracefullyQuitApp(appName) {
  try {
    execSync(
      `osascript -e 'tell application "${appName}" to quit' 2>/dev/null`,
      { timeout: 8000 },
    );
    // Wait up to 5s for it to actually quit
    for (let i = 0; i < 10; i++) {
      if (!isAppRunning(appName)) return true;
      execSync("sleep 0.5");
    }
  } catch {}
  return false;
}

async function makePlaywrightDriver() {
  const { chromium } = await import("playwright");

  // 1. Try attaching to already-running Chrome on CDP
  let attached = await tryConnectCDP(chromium);
  let weSpawnedChrome = false;
  let spawnedProfile = null;

  if (!attached) {
    const browser = findRealBrowser();
    if (!browser)
      throw new Error("No Comet / Chrome Beta / Chrome binary found");

    // 2. Ensure symlinked profile exists (Chrome CDP requires non-default user-data-dir)
    ensureSymlinkedProfile(browser);

    // 3. Quit any running Chrome Beta that might be holding the real profile
    //    (the symlinked profile shares Cookies/LoginData files with the real one).
    if (isAppRunning(browser.appName)) {
      log(
        `[playwright] ${browser.name} running — quitting to release profile files...`,
      );
      gracefullyQuitApp(browser.appName);
      await sleep(1500);
      // Force kill if still alive
      try {
        execSync(`pkill -f "${browser.appName}.app/Contents/MacOS"`);
      } catch {}
      await sleep(500);
    }

    // 4. Launch visible (NOT headless — Cloudflare blocks headless Chrome)
    //    Positioned off-screen + 1x1 size so the window is effectively invisible
    //    even on multi-monitor / retina setups where 3000,3000 clamps onto a display.
    log(
      `[playwright] Launching ${browser.name} hidden (1x1 off-screen) with CDP :${CDP_PORT}...`,
    );
    spawn(
      browser.bin,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${browser.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-notifications",
        "--window-position=9000,9000",
        "--window-size=1,1",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    weSpawnedChrome = true;
    spawnedProfile = browser.profile;

    // 4. Poll CDP until it comes up
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      attached = await tryConnectCDP(chromium);
      if (attached) break;
    }
    if (!attached)
      throw new Error(`CDP didn't come up on :${CDP_PORT} within 15s`);
  }

  const { browser: pwBrowser, ctx, page } = attached;
  return buildPageDriver(
    "playwright",
    page,
    async () => {
      try {
        await pwBrowser.close();
      } catch {}
      // Kill Chrome Beta if WE spawned it — don't leave zombie Chromes
      if (weSpawnedChrome && spawnedProfile) {
        try {
          execSync(`pkill -f "${spawnedProfile}"`, { timeout: 5000 });
        } catch {}
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
  if (!test.startsWith("ok:")) throw new Error("Chrome JXA test failed");

  function jxaJs(js) {
    return execSync(
      `osascript -l JavaScript -e '
      var chrome = Application("Google Chrome");
      chrome.windows[0].activeTab().execute({javascript: ${JSON.stringify(js)}});
    '`,
      { timeout: 10_000 },
    )
      .toString()
      .trim();
  }

  return {
    name: "chrome-jxa",
    async goto(url) {
      // Do NOT activate Chrome — focus-steal would interrupt the user's work.
      // URL assignment alone is enough to drive navigation via JXA.
      execSync(`osascript -l JavaScript -e '
        var c = Application("Google Chrome");
        c.windows[0].activeTab().url = ${JSON.stringify(url)};
      '`);
      await sleep(3000);
    },
    async currentUrl() {
      return execSync(`osascript -l JavaScript -e '
        Application("Google Chrome").windows[0].activeTab().url();
      '`)
        .toString()
        .trim();
    },
    async findAndClick(texts) {
      for (const t of texts) {
        const clean = t
          .replace(/button:has-text\("?([^"]+)"?\)/g, "$1")
          .replace(/['"]/g, "")
          .trim();
        try {
          const r = jxaJs(
            `(function(){var els=document.querySelectorAll('button,a,[role=button],input[type=submit]');` +
              `for(var e of els){if((e.textContent||e.value||'').trim().toLowerCase().includes('${clean.toLowerCase()}')){e.click();return'ok';}}return'miss';})()`,
          );
          if (r === "ok") return true;
        } catch {}
      }
      return false;
    },
    async fillInput(sel, val) {
      if (!val) return false;
      try {
        jxaJs(
          `(function(){var e=document.querySelector('${sel}');if(e){e.value='${val.replace(/'/g, "\\'")}';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}})()`,
        );
        return true;
      } catch {
        return false;
      }
    },
    async screenshot(path) {
      try {
        execSync(`screencapture -x "${path}"`);
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
    name: "manual",
    async goto(url) {
      execSync(`open "${url}"`);
      notify("Account Rotation", "Complete Google sign-in → click Allow");
    },
    async currentUrl() {
      return "";
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page
        .waitForLoadState?.("networkidle", { timeout: 10_000 })
        .catch(() => {});
    },
    async currentUrl() {
      return page.url();
    },
    async findAndClick(texts) {
      for (const t of texts) {
        // If it looks like a CSS selector (starts with [, #, ., or contains data-testid), use directly
        const isCss =
          /^[\[#.]/.test(t) ||
          t.includes("data-testid") ||
          t.includes("[type=");
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
          .replace(/button:has-text\("?([^"]+)"?\)/g, "$1")
          .replace(/['"]/g, "")
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
        return await page.evaluate(() => document.body?.innerText || "");
      } catch {
        return "";
      }
    },
    async waitForPopup(timeout = 10_000) {
      return ctx
        ? ctx.waitForEvent("page", { timeout }).catch(() => null)
        : null;
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
    const hash = url.split("#")[1] || "";
    const b64 = hash.split(":")[1] || "";
    if (!b64) return null;
    return Buffer.from(b64, "base64").toString("utf-8").trim().toLowerCase();
  } catch {
    return null;
  }
}

async function pollGmailForMagicLink(accountEmail, maxWaitMs = 120_000) {
  const startTime = Date.now();
  // Anchor to "now" so we never accept a magic-link email older than this call.
  const requestedAt = Math.floor(Date.now() / 1000);
  const targetLower = accountEmail.toLowerCase();
  log(
    `[magic-link] Polling Gmail for login email to ${accountEmail} (max ${maxWaitMs / 1000}s)...`,
  );

  // Track skipped (stale/wrong-target) thread IDs so we don't re-evaluate them every poll
  const seenSkip = new Set();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Pull up to 10 recent matches so a stale top-result doesn't block us.
      const searchResult = execFileSync(
        "gog",
        [
          "gmail",
          "search",
          'subject:"Secure link to log in to Claude" newer_than:5m',
          "--max",
          "10",
          "-j",
        ],
        { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
      )
        .toString()
        .trim();

      const parsedSearch = JSON.parse(searchResult);
      const list = Array.isArray(parsedSearch)
        ? parsedSearch
        : parsedSearch.threads || parsedSearch.results || [];

      for (const item of list) {
        const threadIdRaw = item.id || item.threadId;
        if (!threadIdRaw) continue;
        // Sanitize: Gmail IDs are alphanumeric. Reject anything else.
        if (!/^[A-Za-z0-9_-]+$/.test(threadIdRaw)) continue;
        if (seenSkip.has(threadIdRaw)) continue;

        const threadJson = execFileSync(
          "gog",
          ["gmail", "read", threadIdRaw, "-j"],
          { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
        ).toString();

        const parsed = JSON.parse(threadJson);
        const messages = parsed?.thread?.messages || [];

        // Reject any message older than our requestedAt (stale link from prior call)
        const msgTimes = messages
          .map((m) => parseInt(m.internalDate || "0", 10) / 1000)
          .filter((t) => t > 0);
        const newestMsg = msgTimes.length ? Math.max(...msgTimes) : 0;
        if (newestMsg && newestMsg < requestedAt - 5) {
          seenSkip.add(threadIdRaw);
          continue;
        }

        const decodedBodies = [];
        const walkParts = (part) => {
          const data = part?.body?.data;
          if (data) {
            try {
              decodedBodies.push(
                Buffer.from(data, "base64url").toString("utf-8"),
              );
            } catch {}
          }
          for (const p of part?.parts || []) walkParts(p);
        };
        for (const msg of messages) walkParts(msg.payload);
        const fullBody = decodedBodies.join("\n");

        const linkPatterns = [
          /https:\/\/claude\.ai\/magic-link#[^\s"'<>)}\]]+/,
          /https:\/\/claude\.ai\/api\/auth\/verify[^\s"'<>)}\]]+/,
          /https:\/\/claude\.ai\/login\/verify[^\s"'<>)}\]]+/,
          /https:\/\/claude\.ai\/auth\/verify[^\s"'<>)}\]]+/,
          /https:\/\/claude\.ai\/[^\s"'<>)}\]]*(?:verify|confirm|magic-link|login\?code)[^\s"'<>)}\]]*/,
        ];

        let url = null;
        for (const pattern of linkPatterns) {
          const m = fullBody.match(pattern);
          if (m) {
            url = m[0];
            break;
          }
        }

        if (!url) {
          const codeMatch = fullBody.match(/\b(\d{6,8})\b/);
          if (codeMatch) {
            log(`[magic-link] Found login code: ${codeMatch[1]}`);
            return `code:${codeMatch[1]}`;
          }
          seenSkip.add(threadIdRaw);
          continue;
        }

        // Validate the embedded target email matches our account.
        // Without this, polling can grab a stale magic-link from a prior call
        // (subject is identical for every account) and rotate to the wrong one.
        const linkTarget = magicLinkTargetEmail(url);
        if (linkTarget && linkTarget !== targetLower) {
          log(
            `[magic-link] Skipping stale link for ${linkTarget} (waiting for ${targetLower})`,
          );
          seenSkip.add(threadIdRaw);
          continue;
        }

        log(
          `[magic-link] Found login link: ${url.substring(0, 100)}...`,
        );
        return url;
      }
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      log(`[magic-link] Gmail poll error: ${err.message}${stderr ? " | stderr: " + stderr : ""}`);
    }
    await sleep(5000);
  }
  log(`[magic-link] Timed out waiting for magic link email for ${accountEmail}`);
  return null;
}

// ── Auth flow (driver-agnostic) ───────────────────────────────────────────────

async function runAuthFlow(driver, account) {
  const creds = fetchGoogleCreds(account) || {};
  const googlePassword = creds.password || fetchGooglePassword(account);
  const googleOtpSecret = creds.otpSecret || null;
  const googleSmsPhone =
    (process.env.CLAUDE_ROTATION_GOOGLE_SMS_PHONE || "").trim() ||
    (account.googleSmsPhone || "").trim() ||
    (creds.phone || "").trim() ||
    null;
  if (googlePassword)
    log(
      `dcli Google password available for ${account.email}${googleOtpSecret ? " (+TOTP)" : ""}`,
    );

  // AI-brain stall detector: when the URL doesn't advance for N consecutive
  // steps, hand the page to Claude to decide what to do. Kept separate from
  // the hard-coded URL branches below — the branches stay fast + free for the
  // common case; Claude only fires on genuinely unseen pages.
  //
  // Threshold is low (2) because each iteration's findAndClick/fillInput
  // retries can take 20-60s on a page with nothing to match — we want Claude
  // to intervene on the second stagnant step, not the fourth.
  let lastStallUrl = "";
  let stallCount = 0;
  const STALL_THRESHOLD = 2;
  const aiBrainHistory = [];
  const aiBrainEnabled =
    driver._page &&
    process.env.CLAUDE_ROTATOR_DISABLE_AI_BRAIN !== "1";

  for (let step = 0; step < 20; step++) {
    await sleep(2500);
    const url = await driver.currentUrl().catch(() => "");
    log(`Step ${step} [${driver.name}]: ${url.substring(0, 100)}`);

    // Stall check — run BEFORE the URL pattern dispatcher so an unknown
    // challenge page gets escalated to the AI brain. Skip on the very first
    // step (no history yet) and skip inside the manual driver.
    if (aiBrainEnabled && step > 0 && driver.name !== "manual") {
      if (url && url === lastStallUrl) {
        stallCount++;
      } else {
        stallCount = 0;
      }
      lastStallUrl = url;
      if (
        stallCount >= STALL_THRESHOLD &&
        aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS
      ) {
        const stallReason = `url stagnant for ${stallCount} steps: ${url.substring(0, 100)}`;
        log(`[ai-brain] STALL DETECTED — ${stallReason}`);
        const action = await askAIBrain({
          page: driver._page,
          account,
          history: aiBrainHistory,
          stallReason,
          logger: (m) => log(`[ai-brain] ${m}`),
        });
        aiBrainHistory.push(
          `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ""} — ${String(action.reason || "").slice(0, 60)}`,
        );
        if (action.action === "abort") {
          log(
            `[ai-brain] aborted — reason: ${action.reason}. Returning to caller.`,
          );
          return false;
        }
        const ok = await executeAIAction(driver, action, { googlePassword });
        log(`[ai-brain] executed ${action.action}: ${ok ? "ok" : "no-op"}`);
        stallCount = 0;
        await sleep(3000);
        continue;
      }
    }

    // Success: redirected to localhost callback (check hostname, not query string)
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        log("Auth callback reached (localhost) — success");
        return true;
      }
    } catch {}

    // Success: landed on platform.claude.com success page
    if (url.includes("/oauth/code/success")) {
      log("Auth success page reached");
      return true;
    }

    // Anthropic fallback redirect — extract code and replay to CLI's localhost
    if (url.includes("/oauth/code/callback") && url.includes("code=")) {
      log(
        "Auth callback reached (platform.claude.com) — replaying to localhost",
      );
      const codeMatch = url.match(/[?&]code=([^&]+)/);
      const stateMatch = url.match(/[?&]state=([^&]+)/);
      if (codeMatch && driver._localhostPort) {
        const replayUrl = `http://localhost:${driver._localhostPort}/callback?code=${codeMatch[1]}${stateMatch ? "&state=" + stateMatch[1] : ""}`;
        try {
          execSync(`curl -s "${replayUrl}" -o /dev/null`, { timeout: 5000 });
        } catch {}
      }
      return true;
    }
    if (driver.name === "manual") {
      await sleep(12_000);
      continue;
    }

    // Google 2FA: push notification to phone (/challenge/dp) — can't automate, must switch
    if (url.includes("accounts.google.com") && url.includes("challenge/dp")) {
      log(`Push-notification 2FA detected — clicking "Try another way"`);
      const clicked = await driver.findAndClick([
        "Try another way",
        "Probeer een andere manier",
      ]);
      if (!clicked) {
        log(`Could not find "Try another way" button`);
        return false;
      }
      await sleep(4000);
      continue;
    }

    // Google passkey challenge (/challenge/pk/presend, /challenge/pk/verify).
    // No hardware key available — bail out via "Try another way".
    if (url.includes("accounts.google.com") && url.includes("/challenge/pk")) {
      log(`Passkey challenge detected — clicking "Try another way"`);
      const clicked = await driver.findAndClick([
        "Try another way",
        "Try another method",
        "Use password instead",
        "Use your password instead",
        "Probeer een andere manier",
        "Gebruik wachtwoord",
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
    if (
      url.includes("accounts.google.com") &&
      url.includes("challenge/selection")
    ) {
      log(`On 2FA selection page — prefer password, then TOTP, then SMS`);
      const selectors = [];
      if (googlePassword)
        selectors.push(
          'div[data-challengetype="1"]',
          'li:has-text("Enter your password")',
          "Enter your password",
          "Wachtwoord invoeren",
        );
      if (googleOtpSecret)
        selectors.push(
          'div[data-challengetype="6"]',
          'li:has-text("Google Authenticator")',
          "Google Authenticator",
          "Authenticator app",
        );
      selectors.push(
        'div[data-challengetype="9"]',
        'li:has-text("Get a verification code")',
        "Get a verification code",
        "Text message",
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
    if (url.includes("accounts.google.com") && url.includes("challenge/totp")) {
      if (googleOtpSecret) {
        const code = generateTOTP(googleOtpSecret);
        log(`Entering TOTP code from dcli secret`);
        await driver.fillInput(
          'input[type="tel"], input[name=totpPin], #totpPin',
          code,
        );
        await sleep(500);
        await driver.findAndClick(["Next", "#totpNext button", "Verify"]);
        await sleep(3000);
        continue;
      }
      log(`No TOTP secret — trying alternate verification`);
      await driver.findAndClick(["Try another way"]);
      await sleep(2000);
      continue;
    }

    // Google 2FA: SMS phone collect (/challenge/ipp/collect) — enter phone, click Send
    if (
      url.includes("accounts.google.com") &&
      url.includes("challenge/ipp/collect")
    ) {
      if (!googleSmsPhone) {
        log(
          `SMS phone collect page — no phone (set CLAUDE_ROTATION_GOOGLE_SMS_PHONE, account.googleSmsPhone, or dcli phone on google.com cred)`,
        );
        return false;
      }
      log(`SMS phone collect — entering configured number and clicking Send`);
      await driver.fillInput(
        '#phoneNumberId, input[type="tel"]',
        googleSmsPhone,
      );
      await sleep(500);
      await driver.findAndClick(["Send", "Next", "Verstuur"]);
      await sleep(4000);
      continue;
    }

    // Google 2FA: SMS code verify (/challenge/ipp/verify or /challenge/sms)
    if (
      url.includes("accounts.google.com") &&
      (url.includes("challenge/ipp/verify") || url.includes("challenge/sms"))
    ) {
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
      await driver.fillInput(
        '#idvPin, input[name="Pin"], input[type="tel"]',
        smsCode,
      );
      await sleep(500);
      await driver.findAndClick(["Next", "Verify"]);
      await sleep(4000);
      continue;
    }

    // Google consent page (/signin/oauth/id or /signin/oauth/consent) — click Continue
    if (
      url.includes("accounts.google.com") &&
      (url.includes("/signin/oauth/id") ||
        url.includes("/signin/oauth/consent") ||
        url.includes("/signin/oauth/legacy"))
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
        "Continue",
        "Allow",
        "Approve",
        "Confirm",
        "Doorgaan",
        "Toestaan",
      ]);
      if (!clicked) {
        log(`Continue button not found on consent page — waiting and retrying`);
      }
      await sleep(3000);
      continue;
    }

    // Google password prompt (standalone /challenge/pwd — must run BEFORE the
    // broad accounts.google.com account-chooser branch below).
    if (url.includes("accounts.google.com") && url.includes("challenge/pwd")) {
      if (googlePassword) {
        await driver.fillInput('input[type="password"]', googlePassword);
        await sleep(500);
        await driver.findAndClick(["Next", "#passwordNext button"]);
        continue;
      }
    }

    // Google account chooser — click the target account
    if (url.includes("accounts.google.com")) {
      // Detect "Signed out" next to the target account (needs re-login)
      let targetSignedOut = false;
      if (driver.readPageText) {
        try {
          const txt = (await driver.readPageText()).toLowerCase();
          const emailIdx = txt.indexOf(account.email.toLowerCase());
          if (emailIdx >= 0) {
            const nearby = txt.substring(emailIdx, emailIdx + 200);
            targetSignedOut = nearby.includes("signed out");
          }
        } catch {}
      }

      const picked = await driver.findAndClick([
        account.email,
        `data-identifier="${account.email}"`,
      ]);
      if (picked && targetSignedOut && googlePassword) {
        // Account was signed out — click picked it, now password prompt will appear
        log(
          `Account ${account.email} was signed out — password flow will handle`,
        );
      }
      if (!picked) {
        // Not in list — add manually
        await driver.findAndClick(["Use another account", "Add account"]);
        await sleep(2000);
        await driver.fillInput(
          'input[type="email"], #identifierId',
          account.email,
        );
        await sleep(500);
        await driver.findAndClick(["Next", "#identifierNext button"]);
        await sleep(2000);
        if (googlePassword) {
          await driver.fillInput('input[type="password"]', googlePassword);
          await sleep(500);
          await driver.findAndClick(["Next", "#passwordNext button"]);
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
      url.includes("claude.ai") &&
      (url.includes("select-organization") ||
        url.includes("/onboarding/organization") ||
        url.includes("choose-organization") ||
        url.includes("select-workspace") ||
        url.includes("choose-workspace") ||
        url.includes("workspaces") ||
        url.includes("select-account") ||
        url.includes("switch-org"));
    let isOrgChooserByText = false;
    if (!isOrgChooserUrl && url.includes("claude.ai") && driver.readPageText) {
      try {
        const t = (await driver.readPageText()).toLowerCase();
        isOrgChooserByText =
          (t.includes("choose an organization") ||
            t.includes("select an organization") ||
            t.includes("choose a workspace") ||
            t.includes("select a workspace") ||
            t.includes("which organization")) &&
          (t.includes("personal") || t.includes("organization"));
      } catch {}
    }
    if (isOrgChooserUrl || isOrgChooserByText) {
      const orgLabel = account.organization || account.orgName || "Personal";
      log(
        `Claude organization chooser (${isOrgChooserByText ? "via page-text" : "via URL"}) — selecting "${orgLabel}"`,
      );
      // Dump all visible button/link labels so we can see the real workspace
      // names claude.ai is showing (vs what's configured as orgName).
      if (driver.readPageText) {
        try {
          const t = await driver.readPageText();
          const labels = [
            ...new Set(
              (t || "")
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0 && l.length < 80),
            ),
          ].slice(0, 40);
          log(`[org-chooser] Visible lines: ${JSON.stringify(labels)}`);
        } catch {}
      }
      const picked = await driver.findAndClick([
        `button:has-text("${orgLabel}")`,
        `[role="button"]:has-text("${orgLabel}")`,
        `text="${orgLabel}"`,
        orgLabel,
        // Only fall back to "Personal" / "Continue" if the configured label
        // is itself Personal — never silently default a team account to Personal.
        ...(orgLabel === "Personal" ? ["Personal", "Continue"] : []),
      ]);
      if (!picked) {
        log(
          `No organization button matched "${orgLabel}" — the account may land on the wrong org`,
        );
      }
      await sleep(3000);
      continue;
    }

    // Claude OAuth consent page — MUST check account BEFORE clicking Authorize.
    // Match by pathname only — URL params (like redirect_uri=...callback) would
    // false-match a substring check on the full URL.
    let oauthPath = "";
    try {
      oauthPath = new URL(url).pathname;
    } catch {}
    if (
      oauthPath.includes("/oauth/authorize") ||
      (oauthPath.endsWith("/authorize") && url.includes("claude"))
    ) {
      // Step 1: Read page to verify "Logged in as <correct email>"
      let pageText = "";
      if (driver.readPageText) {
        try {
          pageText = (await driver.readPageText()).toLowerCase();
        } catch {}
      }

      const hasCorrectAccount =
        pageText && pageText.includes(account.email.toLowerCase());
      const hasAnyOtherEmail =
        pageText &&
        /[\w.+-]+@[\w.-]+\.\w+/.test(pageText) &&
        !hasCorrectAccount;

      // If we can't read the page OR we see the wrong account, force switch
      if (!pageText || hasAnyOtherEmail) {
        log(
          `Page text: ${pageText ? "wrong account" : "unreadable"} — clicking Switch account / Logout`,
        );
        const switched = await driver.findAndClick([
          "Switch account",
          "Log out",
          "Logout",
          "Sign out",
          "Use another account",
        ]);
        if (switched) {
          await sleep(3000);
          continue;
        }
        // Couldn't find switch button — the page may already be the account chooser
        // Try clicking the email we want directly
        const picked = await driver.findAndClick([account.email]);
        if (picked) {
          await sleep(3000);
          continue;
        }
        // Last resort: log and click authorize anyway (may fail)
        log(`WARNING: Could not verify account — clicking Authorize blind`);
      } else if (hasCorrectAccount) {
        log(`Correct account confirmed: ${account.email}`);
      }

      // Step 2: Click Authorize — wait for button to become enabled (up to 30s)
      let authorized = false;
      for (let wait = 0; wait < 6; wait++) {
        if (
          await driver.findAndClick(["Authorize", "Allow", "Approve", "Accept"])
        ) {
          log("Clicked Authorize");
          authorized = true;
          break;
        }
        // Button might exist but be disabled — wait for page to finish loading
        log(
          `Authorize button not clickable — waiting (attempt ${wait + 1}/6)...`,
        );
        await sleep(5000);
      }
      if (authorized) {
        await sleep(4000);
        continue;
      }
      log(
        "Authorize button still not clickable after 30s — escalating to ai-brain",
      );
      // Fast-path ai-brain escalation: don't wait for stall detector to catch up
      // on the next loop iter. The page is stuck on OAuth authorize and Haiku
      // can usually pick the right org/continue button immediately.
      if (aiBrainEnabled && aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS) {
        const action = await askAIBrain({
          page: driver._page,
          account,
          history: aiBrainHistory,
          stallReason: `authorize button not clickable on ${url.substring(0, 100)}`,
          logger: (m) => log(`[ai-brain] ${m}`),
        });
        aiBrainHistory.push(
          `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ""} — ${String(action.reason || "").slice(0, 60)}`,
        );
        if (action.action !== "abort") {
          const ok = await executeAIAction(driver, action, { googlePassword });
          log(`[ai-brain] executed ${action.action}: ${ok ? "ok" : "no-op"}`);
          stallCount = 0;
          await sleep(3000);
          continue;
        }
        log(`[ai-brain] aborted — reason: ${action.reason}`);
      }
      await sleep(3000);
      continue;
    }

    // Dismiss cookie consent banner if present (blocks clicks on everything else)
    if (url.includes("claude.ai")) {
      await driver.findAndClick([
        '[data-testid="consent-reject"]',
        '[data-testid="consent-accept"]',
        "Reject All Cookies",
        "Accept All Cookies",
      ]);
      await sleep(500);
    }

    // Claude.ai login → Magic link path (when account.useMagicLink is set)
    // The email input is always visible on /login — no button click needed first.
    if (account.useMagicLink && url.includes("claude.ai/login")) {
      // Fill the email input directly
      const filled = await driver.fillInput(
        '[data-testid="email"], #email, input[type="email"]',
        account.email,
      );
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

          // Poll Gmail for the magic link
          const magicLink = await pollGmailForMagicLink(account.email);
          if (magicLink) {
            if (magicLink.startsWith("code:")) {
              const code = magicLink.replace("code:", "");
              log(`[magic-link] Entering verification code: ${code}`);
              await driver.fillInput(
                'input[type="text"], input[type="number"], input[name="code"], input[placeholder*="code" i]',
                code,
              );
              await driver.findAndClick([
                "Continue",
                "Verify",
                "Submit",
                'button[type="submit"]',
              ]);
            } else {
              log(`[magic-link] Navigating to login link`);
              await driver.goto(magicLink);
            }
            await sleep(4000);
            // After magic link login, session is now valid — re-navigate to authUrl
            // so the OAuth flow can complete (org chooser → authorize → callback)
            if (driver._authUrl) {
              // For multi-org accounts (same email, multiple workspaces like
              // user-personal vs user-team), force an explicit org
              // pick BEFORE hitting /oauth/authorize. Otherwise claude.ai uses
              // the "last active" org silently, and both sibling vaults end up
              // holding the same org's token.
              const isMultiOrg =
                account.label &&
                account.orgName &&
                account.orgName.toLowerCase() !==
                  account.email.toLowerCase();
              if (isMultiOrg) {
                log(
                  `[magic-link] Multi-org account — forcing org pick for "${account.orgName}" via claude.ai/home detour`,
                );
                try {
                  await driver.goto("https://claude.ai/home");
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
                  log(
                    `[magic-link] Pre-selected org "${account.orgName}" before OAuth`,
                  );
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
            `[magic-link] No magic link found in Gmail — falling through to Google OAuth`,
          );
        }
      }
    }

    // Claude.ai login → Continue with Google (button has data-testid="login-with-google")
    const popupP = driver.waitForPopup
      ? driver.waitForPopup(15_000)
      : Promise.resolve(null);
    if (
      await driver.findAndClick([
        '[data-testid="login-with-google"]',
        "Continue with Google",
        "Sign in with Google",
      ])
    ) {
      const popup = await popupP;
      if (popup) {
        // Kapture popup is already a full driver; Playwright returns a raw Page
        const pd = popup.name
          ? popup
          : buildPageDriver(driver.name + "-popup", popup, () => {}, null);
        await runAuthFlow(pd, account);
        if (popup.waitForEvent) {
          await popup
            .waitForEvent("close", { timeout: 30_000 })
            .catch(() => {});
        }
      }
      continue;
    }

    // Email input
    if (
      await driver.fillInput(
        '#identifierId, input[type="email"]',
        account.email,
      )
    ) {
      await driver.findAndClick(["Next", "#identifierNext button"]);
    }
  }

  // Loop exhausted — final AI-brain attempt before giving up. Some flows
  // legitimately exceed 20 steps (multi-factor + workspace chooser + consent),
  // so give Claude up to its remaining decision budget to unstick us.
  if (aiBrainEnabled && aiBrainHistory.length < AI_BRAIN_MAX_DECISIONS) {
    const url = await driver.currentUrl().catch(() => "");
    log(`[ai-brain] loop exhausted — final rescue attempt`);
    for (
      let rescue = 0;
      rescue < AI_BRAIN_MAX_DECISIONS - aiBrainHistory.length && rescue < 3;
      rescue++
    ) {
      const action = await askAIBrain({
        page: driver._page,
        account,
        history: aiBrainHistory,
        stallReason: `loop exhausted at ${url.substring(0, 80)} (rescue ${rescue + 1})`,
        logger: (m) => log(`[ai-brain] ${m}`),
      });
      aiBrainHistory.push(
        `${action.action}${action.selector ? `(${String(action.selector).slice(0, 40)})` : ""} — ${String(action.reason || "").slice(0, 60)}`,
      );
      if (action.action === "abort") break;
      await executeAIAction(driver, action, { googlePassword });
      await sleep(4000);
      // Re-check success conditions after each rescue action
      const newUrl = await driver.currentUrl().catch(() => "");
      try {
        const parsed = new URL(newUrl);
        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
          log("[ai-brain] rescue SUCCEEDED — localhost callback reached");
          return true;
        }
      } catch {}
      if (newUrl.includes("/oauth/code/success")) {
        log("[ai-brain] rescue SUCCEEDED — claude.ai success page");
        return true;
      }
    }
  }
  return false;
}

// ── Browser OAuth fallback ────────────────────────────────────────────────────

async function browserOAuthFallback(account) {
  log(`[fallback] Browser OAuth for ${account.email}...`);

  const pid = process.pid;
  const capScript = join(tmpdir(), `claude-url-cap-${pid}.sh`);
  const urlFile = join(tmpdir(), `claude-auth-url-${pid}.txt`);
  writeFileSync(capScript, `#!/bin/bash\necho "$1" > "${urlFile}"\n`);
  chmodSync(capScript, 0o755);

  const proc = spawn("claude", ["auth", "login", "--email", account.email], {
    env: { ...process.env, BROWSER: capScript },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // BROWSER script gets the URL with localhost redirect (what we want).
  // stderr gets a fallback URL with platform.claude.com redirect (don't use that).
  // Prefer the file-captured URL — wait up to 15s for it, then fall back to stdout.
  let authUrl = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (existsSync(urlFile)) {
      const u = readFileSync(urlFile, "utf8").trim();
      try {
        unlinkSync(urlFile);
      } catch {}
      if (u.startsWith("http")) {
        authUrl = u;
        break;
      }
    }
  }
  if (!authUrl) {
    // Fallback: parse from stderr (has platform.claude.com redirect, but still works)
    authUrl = await new Promise((resolve) => {
      const scan = (d) => {
        const m = d.toString().match(/https?:\/\/[^\s\])"'\n]+/);
        if (m) resolve(m[0]);
      };
      proc.stdout.on("data", scan);
      proc.stderr.on("data", scan);
      setTimeout(() => resolve(null), 15_000);
    });
  }
  try {
    unlinkSync(capScript);
  } catch {}

  if (!authUrl) {
    proc.kill();
    return false;
  }
  log(`Auth URL captured: ${authUrl.substring(0, 80)}...`);

  // Extract localhost port from redirect_uri in the auth URL for code replay
  const portMatch = authUrl.match(
    /redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/,
  );
  const localhostPort = portMatch ? portMatch[1] : null;
  log(`Localhost callback port: ${localhostPort || "unknown"}`);

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

    try {
      log(`[${driver._driverName}] Logging out existing claude.ai session...`);
      try {
        await driver.goto("https://claude.ai/api/auth/logout");
      } catch {}
      await sleep(1500);
      try {
        await driver.goto("https://claude.ai/logout");
      } catch {}
      await sleep(1500);

      // Page may have been destroyed by logout redirect — try navigating,
      // and if the page is dead, get a fresh driver (new tab)
      try {
        await driver.goto(authUrl);
      } catch (navErr) {
        log(
          `[${driver._driverName}] Page died after logout (${navErr.message}) — getting fresh driver`,
        );
        try {
          await driver.close();
        } catch {}
        try {
          driver = await getBrowserDriver(failed);
          driver._localhostPort = localhostPort;
          await driver.goto(authUrl);
        } catch (freshErr) {
          log(
            `[${driver._driverName}] Fresh driver also failed: ${freshErr.message}`,
          );
          failed.add(driver._driverName || "unknown");
          continue;
        }
      }
      success = await runAuthFlow(driver, account);

      if (!success) {
        log(
          `[${driver._driverName}] runAuthFlow returned false — trying next driver`,
        );
        failed.add(driver._driverName);
        continue;
      }

      // Wait for claude auth login process to finish writing the keychain
      await new Promise((r) => {
        const t = setTimeout(() => {
          proc.kill();
          r();
        }, 30_000);
        proc.on("exit", () => {
          clearTimeout(t);
          r();
        });
        if (proc.exitCode !== null) {
          clearTimeout(t);
          r();
        }
      });
    } catch (err) {
      log(`[${driver._driverName}] threw: ${err.message}`);
      failed.add(driver._driverName);
    } finally {
      try {
        await driver.close();
      } catch {}
    }
  }

  return success;
}

// ── Session restart via tmux ─────────────────────────────────────────────────

function findClaudeSessions() {
  const sessions = [];
  try {
    const psOut = execSync(
      `ps -eo pid,tty,args | grep -E '[c]laude.*--dangerously' | grep -v 'mcp ' | grep -v '\\-p '`,
      { timeout: 5000 },
    )
      .toString()
      .trim();
    if (!psOut) return sessions;

    const ttyMap = {};
    try {
      const paneOut = execSync(
        `tmux list-panes -a -F '#{pane_tty}|#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null`,
        { timeout: 3000 },
      )
        .toString()
        .trim();
      for (const line of paneOut.split("\n")) {
        const [tty, pane] = line.split("|");
        if (tty && pane) ttyMap[tty] = pane;
      }
    } catch {}

    for (const line of psOut.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(ttys?\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, ttyShort, args] = match;
      const tty = `/dev/${ttyShort}`;
      const resumeMatch = args.match(/--resume\s+(\S+)/);
      const resumeId = resumeMatch ? resumeMatch[1] : null;
      const pane = ttyMap[tty] || null;
      sessions.push({ pid: parseInt(pid), tty, pane, resumeId, args });
    }
  } catch (e) {
    log(
      `[session] Failed to enumerate sessions: ${e.message.substring(0, 80)}`,
    );
  }
  return sessions;
}

function sendKeysToPane(pane, txt) {
  if (!pane) return false;
  try {
    execSync(
      `tmux send-keys -t ${JSON.stringify(pane)} ${JSON.stringify(txt)} C-m 2>/dev/null`,
      { timeout: 3000 },
    );
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
  const escaped = txt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    const result = execSync(
      `osascript -e '${script.replace(/'/g, "'\"'\"'")}'`,
      { timeout: 5000 },
    )
      .toString()
      .trim();
    return result === "ok";
  } catch {
    return false;
  }
}

// Walk up the process tree from `pid` and return the terminal app that owns
// the session (e.g. "Ghostty", "iTerm2", "Terminal", "Alacritty", "WezTerm")
// or "unknown" if none matched. Used to gate AppleScript injection to
// terminals we know actually support it without launching a new app.
function detectTerminalForPid(pid) {
  try {
    const out = execSync(`ps -eo pid,ppid,comm`, { timeout: 3000 })
      .toString()
      .trim();
    const byPid = new Map();
    for (const line of out.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (m) byPid.set(parseInt(m[1]), { ppid: parseInt(m[2]), comm: m[3] });
    }
    let cur = parseInt(pid);
    for (let i = 0; i < 40 && cur > 1; i++) {
      const entry = byPid.get(cur);
      if (!entry) break;
      const c = entry.comm.toLowerCase();
      if (c.includes("ghostty")) return "Ghostty";
      if (c.includes("iterm2") || c.includes("iterm")) return "iTerm2";
      if (c.includes("terminal.app") || /\/terminal$/.test(c)) return "Terminal";
      if (c.includes("alacritty")) return "Alacritty";
      if (c.includes("wezterm")) return "WezTerm";
      if (c.includes("kitty")) return "kitty";
      cur = entry.ppid;
    }
  } catch {}
  return "unknown";
}

async function refreshRunningSession(rotatedAccount = null, noBrowser = false) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sessions = findClaudeSessions();

  if (sessions.length === 0) {
    log("[session] No running Claude Code sessions found");
    return;
  }

  // Tag each session with its owning terminal app. We only have a reliable
  // AppleScript injection path for tmux + iTerm2. For Ghostty/Terminal/others,
  // writing to the raw TTY shows as OUTPUT (garbles the live display) and
  // `tell application "iTerm2"` would spuriously *launch* iTerm2 — so we skip.
  for (const s of sessions) {
    if (!s.pane && s.pid) s.terminal = detectTerminalForPid(s.pid);
  }

  const sendKeys = (s, txt) => {
    if (s.pane) return sendKeysToPane(s.pane, txt);
    if (s.terminal === "iTerm2" && s.tty)
      return sendKeysToITerm(s.tty, txt);
    // Ghostty, Terminal.app, Alacritty, WezTerm, kitty, unknown: skip.
    // Raw TTY write would render "/login" as on-screen output text, not
    // stdin — corrupting the session without triggering the re-auth.
    return false;
  };

  // Reachable = tmux pane OR known-good terminal (iTerm2). Everyone else
  // is logged + skipped so we never pop a visual window or garble Ghostty.
  const reachable = sessions.filter(
    (s) => s.pane || (s.terminal === "iTerm2" && s.tty),
  );
  const skipped = sessions.filter(
    (s) => !s.pane && s.terminal && s.terminal !== "iTerm2",
  );
  for (const s of skipped) {
    log(
      `[session] Skipping PID ${s.pid} (${s.terminal}) — no safe inject path; token-refresh daemon keeps keys fresh so restart isn't required`,
    );
  }
  if (reachable.length === 0) {
    log(
      `[session] Found ${sessions.length} sessions but none have a reachable TTY`,
    );
    return;
  }

  log(`[session] Injecting /login into ${reachable.length} session(s):`);
  for (const s of reachable) {
    log(`  PID ${s.pid} ${s.pane ? "pane=" + s.pane : "tty=" + s.tty}`);
  }

  // Keychain was already swapped to the fresh account's valid token.
  // /login re-reads the keychain → picks up the new token → "Login successful" instantly.
  // No /exit, no process restart, no OAuth browser flow needed (token is already valid).
  // Stagger slightly to avoid all sessions hitting the API at the exact same millisecond.
  for (const s of reachable) {
    if (sendKeys(s, "/login")) {
      log(`[session] Sent /login to PID ${s.pid} (${s.pane || s.tty})`);
    } else {
      log(
        `[session] Failed to inject /login to PID ${s.pid} (${s.pane || s.tty})`,
      );
    }
    await sleep(500); // 500ms stagger between sessions
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
        const url = await driver.currentUrl().catch(() => "");
        if (
          url &&
          (url.includes("oauth") ||
            url.includes("authorize") ||
            url.includes("claude.ai/login"))
        ) {
          log(
            `[session] Detected post-restart OAuth page (${url.substring(0, 60)}) — driving flow`,
          );
          if (rotatedAccount) await runAuthFlow(driver, rotatedAccount);
        }
        try {
          await driver.close?.();
        } catch {}
      }
    } catch (e) {
      log(
        `[session] Post-restart browser check skipped: ${e.message.substring(0, 60)}`,
      );
    }
  }

  log(`[session] Restart complete: ${reachable.length} session(s) cycled`);
}

// ── Main rotation ─────────────────────────────────────────────────────────────

async function rotate(targetEmail, opts = {}) {
  const config = readConfig();
  const state = readState();
  const dryRun = opts.dryRun || false;

  if (!targetEmail) {
    // Query live utilization for all accounts before picking — best-effort, ~2s
    log("Querying live utilization for all accounts...");
    const liveUtil = await queryAllUtilization(config);
    const utilSummary = Object.entries(liveUtil)
      .map(([k, v]) => `${k}:5h=${v.five_hour_pct}%/7d=${v.seven_day_pct}%`)
      .join(", ");
    if (utilSummary) log(`Live util: ${utilSummary}`);
    // Snapshot live data into state for future daemon decisions
    for (const [key, util] of Object.entries(liveUtil)) {
      state.accounts[key] = state.accounts[key] || {};
      state.accounts[key].lastUtilization = {
        pct: util.five_hour_pct,
        reset: util.resets_at_5h
          ? Math.floor(new Date(util.resets_at_5h).getTime() / 1000)
          : null,
        ts: Date.now(),
      };
    }
    const next = pickNextAccount(config, state, liveUtil, {
      allowExtraUsage: opts.allowExtraUsage === true,
    });
    if (!next) {
      log("No account available (all excluded — extra_usage enabled?)");
      return false;
    }
    targetEmail = accountKey(next);
  }

  // Hard safety gate: even when the user passes --to <email> explicitly,
  // refuse to activate a Max account where the Anthropic org has
  // has_extra_usage_enabled=true (overage billing). Requires --allow-extra-usage
  // to bypass.
  try {
    if (!opts.allowExtraUsage) {
      const target = config.accounts.find(
        (a) => accountKey(a) === targetEmail || a.email === targetEmail,
      );
      if (target) {
        const tokenJson = readStoredToken(target);
        if (tokenJson) {
          const parsed = JSON.parse(tokenJson);
          const accessToken = parsed?.claudeAiOauth?.accessToken;
          if (accessToken) {
            const res = await fetch(
              "https://api.anthropic.com/api/oauth/profile",
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "anthropic-beta": "oauth-2025-04-20",
                  "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(5000),
              },
            );
            if (res.ok) {
              const prof = await res.json();
              const euEnabled =
                prof?.organization?.has_extra_usage_enabled === true;
              if (euEnabled) {
                log(
                  `REFUSED: target ${targetEmail} has extra_usage enabled (pay-per-use). Pass --allow-extra-usage to override.`,
                );
                notify(
                  "Rotation BLOCKED",
                  `${targetEmail}: extra_usage enabled — would risk credit-card overage. Disable at console.anthropic.com/settings/billing`,
                );
                return false;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    log(`Extra-usage preflight error (non-fatal): ${e.message?.slice(0, 80)}`);
  }

  // Find by label first, then by email
  const account =
    config.accounts.find((a) => accountKey(a) === targetEmail) ||
    config.accounts.find((a) => a.email === targetEmail);
  if (!account) {
    log(`Account ${targetEmail} not in config`);
    return false;
  }
  if (opts.magicLink) account.useMagicLink = true;
  const key = accountKey(account);

  log(
    `=== ROTATING: ${state.activeAccount || "none"} → ${key} (${account.email}) ===`,
  );
  notify("Claude Account Rotation", `Switching to ${key}...`);

  // Clear statsig cache to prevent device-level rate limit stickiness (anthropics/claude-code#12786)
  try {
    const statsigDir = join(process.env.HOME || "", ".claude", "statsig");
    if (existsSync(statsigDir)) {
      const files = readdirSync(statsigDir).filter((f) =>
        f.startsWith("statsig.cached.evaluations."),
      );
      for (const f of files) {
        try {
          unlinkSync(join(statsigDir, f));
        } catch {}
      }
      if (files.length > 0)
        log(
          `Cleared ${files.length} statsig cache files (device-level stickiness fix)`,
        );
    }
  } catch {}

  // Save outgoing token to the vault slot matching the active account.
  // In --no-browser mode (daemon), skip the `claude auth status` call — it
  // hits the Anthropic API and fails when we're already rate limited.
  // Trust state.activeAccount instead.
  if (opts.noBrowser) {
    const trackedAccount = config.accounts.find(
      (a) => accountKey(a) === state.activeAccount,
    );
    if (trackedAccount) {
      if (!dryRun) saveCurrentToken(trackedAccount);
      log(
        `[no-browser] Saved outgoing token for tracked ${accountKey(trackedAccount)}`,
      );
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
          const liveAccessToken =
            JSON.parse(liveTokenJson)?.claudeAiOauth?.accessToken;
          if (liveAccessToken) {
            const res = await fetch(
              "https://api.anthropic.com/api/oauth/profile",
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${liveAccessToken}`,
                  "anthropic-beta": "oauth-2025-04-20",
                },
                signal: AbortSignal.timeout(5000),
              },
            );
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
          liveAccount = config.accounts.find(
            (a) => a.email === liveEmail && a.orgUuid === liveOrgUuid,
          );
        }
        if (!liveAccount) {
          liveAccount = config.accounts.find((a) => a.email === liveEmail);
        }
        if (liveAccount) {
          if (!dryRun) saveCurrentToken(liveAccount);
          log(
            `${dryRun ? "[DRY-RUN] Would save" : "Saved"} outgoing token for LIVE account ${accountKey(liveAccount)} (was tracked as ${state.activeAccount || "none"})`,
          );
          // Keep state in sync with reality
          if (state.activeAccount !== accountKey(liveAccount)) {
            log(
              `State drift corrected: activeAccount ${state.activeAccount} → ${accountKey(liveAccount)}`,
            );
            state.activeAccount = accountKey(liveAccount);
          }
        } else {
          log(
            `WARNING: live account ${liveEmail} not in config — skipping outgoing save`,
          );
        }
      }
    } catch (e) {
      log(`Could not determine live account: ${e.message.substring(0, 80)}`);
    }

  // Snapshot outgoing account's utilization before clearing the rate-limits file.
  // This lets pickNextAccount avoid rotating back to an exhausted account.
  try {
    const rlPath = join(__dirname, ".rate-limits.json");
    if (existsSync(rlPath)) {
      const rl = JSON.parse(readFileSync(rlPath, "utf8"));
      const outKey = state.activeAccount;
      if (outKey && rl.five_hour) {
        state.accounts[outKey] = state.accounts[outKey] || {};
        state.accounts[outKey].lastUtilization = {
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
      unlinkSync(join(__dirname, ".rate-limits.json"));
    } catch {}
  } else {
    log("[DRY-RUN] Would clear .rate-limits.json");
  }

  let ok;
  if (dryRun) {
    log("[DRY-RUN] Would swap token via swapToken()");
    ok = true;
  } else {
    ok = await swapToken(account);
    if (!ok && !opts.noBrowser) {
      ok = await browserOAuthFallback(account);
    } else if (!ok) {
      log(
        "[no-browser] Token swap failed — skipping browser fallback (daemon mode)",
      );
    }
  }

  if (!ok) {
    log("Rotation failed");
    notify("Account Rotation", `FAILED for ${targetEmail}`);
    return false;
  }

  // POST-SWAP BILLING SAFETY CHECK
  // The fresh token is now in the active keychain. Query /api/oauth/profile to
  // verify has_extra_usage_enabled=false. If true, revert the swap by restoring
  // the previous account's token — this prevents silent credit-card overages.
  if (!opts.allowExtraUsage && !dryRun) {
    try {
      const freshJson = readKeychain();
      const fresh = JSON.parse(freshJson);
      const freshToken = fresh?.claudeAiOauth?.accessToken;
      if (freshToken) {
        const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${freshToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const prof = await res.json();
          const euOn =
            prof?.organization?.has_extra_usage_enabled === true;
          if (euOn) {
            log(
              `POST-SWAP BLOCK: ${targetEmail} has extra_usage=ON (overage billing). Reverting swap.`,
            );
            notify(
              "Rotation REVERTED",
              `${targetEmail}: extra_usage enabled — charges would hit your card. Rollback in progress.`,
            );
            // Revert: restore previous account's stored token to active slot
            const prevKey = state.activeAccount;
            const prevAccount = prevKey
              ? config.accounts.find((a) => accountKey(a) === prevKey)
              : null;
            if (prevAccount) {
              const prevToken = readStoredToken(prevAccount);
              if (prevToken) {
                writeKeychain(prevToken);
                log(`Reverted keychain to previous account ${prevKey}`);
              }
            }
            return false;
          }
        } else {
          log(
            `POST-SWAP profile check returned ${res.status} — unable to verify extra_usage; proceeding (fail-open for transient errors)`,
          );
        }
      }
    } catch (e) {
      log(
        `POST-SWAP billing check error (non-fatal): ${e.message?.slice(0, 80)}`,
      );
    }
  }

  // Verify by reading back what's now in the active keychain
  let verified = false;
  try {
    const active = readKeychain();
    const stored = readStoredToken(account);
    // Token swap: verify the active keychain matches what we wrote.
    // Guard against empty `stored` — substring("", 20, 80) === "" and
    // active.includes("") is always true, which would spuriously verify.
    if (stored && stored.length > 80 && active.includes(stored.substring(20, 80))) verified = true;
    // Browser fallback: verify via CLI (skip in --no-browser mode — API may be rate limited)
    if (!verified && !opts.noBrowser) {
      const out = execSync("claude auth status 2>&1", {
        timeout: 10_000,
      }).toString();
      verified = out.includes(account.email);
    }
  } catch {}
  log(
    `Rotation ${verified ? "VERIFIED" : "UNVERIFIED"}: ${key} (${account.email})`,
  );

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
        const res = await fetch(
          "https://api.anthropic.com/api/oauth/profile",
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "anthropic-beta": "oauth-2025-04-20",
            },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (res.ok) {
          const prof = await res.json();
          const liveOrg = prof?.organization?.name || "";
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
      execSync("claude auth status 2>&1", { timeout: 10_000 });
      log("Token refresh triggered via auth status");
    } catch {}
  }

  // Save verified (and possibly refreshed) token to vault for future fast swaps
  if (verified && !dryRun) saveCurrentToken(account);
  if (verified && dryRun) log("[DRY-RUN] Would save verified token to vault");

  // Update state — track cumulative window usage per account
  const now = new Date().toISOString();
  const windowMs = (config.rateLimits?.windowHours || 5) * 3_600_000;
  if (state.activeAccount) {
    const prev = (state.accounts[state.activeAccount] =
      state.accounts[state.activeAccount] || {});
    prev.lastActive = now;
    // Accumulate tool uses into the account's window total
    const windowAge = prev.windowStart
      ? Date.now() - new Date(prev.windowStart).getTime()
      : Infinity;
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
  const targetWindowAge = target.windowStart
    ? Date.now() - new Date(target.windowStart).getTime()
    : Infinity;
  if (targetWindowAge >= windowMs) {
    // Window expired — fresh start
    target.windowStart = now;
    target.windowToolUses = 0;
  }
  // else: keep existing window data (cumulative uses carry over)
  state.activeAccount = key;
  state.toolUses = 0;
  state.lastRotation = now;
  state.totalRotations = (state.totalRotations || 0) + 1;
  writeState(state, dryRun);

  notify("Claude Account Rotation", `${verified ? "✓" : "⚠"} Now using ${key}`);

  if (opts.session) {
    if (dryRun) {
      log(
        "[DRY-RUN] Would restart running Claude sessions with --continue and send resume prompt",
      );
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
  const filter = argv.find((a) => a.startsWith("--only="))?.slice(7);
  const autoMode = argv.includes("--auto");
  const magicLinkMode = autoMode || argv.includes("--magic-link");
  const skipDone = argv.includes("--skip-valid");
  const accounts = (filter
    ? config.accounts.filter(
        (a) => accountKey(a) === filter || a.email === filter,
      )
    : config.accounts
  ).filter((a) => {
    if (a.disabled === true && !filter) {
      console.log(`⏭  Skipping ${accountKey(a)}: disabled (${a.disabledReason || "no reason given"})`);
      return false;
    }
    return true;
  });

  console.log("\n=== Claude Account Rotation — Setup ===\n");
  if (autoMode) {
    console.log(
      `🤖 AUTO MODE — browser driver cascade + magic-link polling via gog/Gmail`,
    );
    console.log(
      `   Sequential processing (~60-120s per account). Logs → rotation.log.\n`,
    );
  }
  console.log(
    `Re-capturing ${accounts.length} account(s). For each: OAuth → verify → save to vault.\n`,
  );

  const results = [];
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
            const res = await fetch(
              "https://api.anthropic.com/api/oauth/profile",
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${t}`,
                  "anthropic-beta": "oauth-2025-04-20",
                  "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(4000),
              },
            );
            if (res.ok) {
              console.log(
                `⏭  Skipped: vault token still valid (--skip-valid).`,
              );
              results.push({ key, ok: true, skipped: true });
              continue;
            }
          }
        }
      } catch {}
    }

    let oauthOk = true;
    if (magicLinkMode) {
      // Fully automated: claude auth login subprocess + browser driver cascade
      // + magic-link email polling. No terminal interaction required.
      account.useMagicLink = true;
      console.log(
        `[auto] Automated OAuth — magic-link email to ${account.email} (routed to Gmail)...`,
      );
      try {
        oauthOk = await browserOAuthFallback(account);
      } catch (e) {
        console.error(
          `❌ Automation threw: ${String(e.message || e).slice(0, 120)}`,
        );
        oauthOk = false;
      }
      if (!oauthOk) {
        console.error(
          `❌ ${key}: auto OAuth failed. Retry manually: node rotate.mjs --setup --only=${key}`,
        );
        results.push({ key, ok: false, reason: "auto-oauth-failed" });
        continue;
      }
    } else {
      console.log(
        "Opening browser for OAuth. Complete the Google login, then come back here.",
      );
      const child = spawn(
        "claude",
        ["auth", "login", "--email", account.email],
        {
          stdio: "inherit",
        },
      );
      await new Promise((r) => child.on("exit", r));
    }

    // Verify the login succeeded and matches the expected account
    try {
      const status = JSON.parse(
        execSync("claude auth status 2>&1", { timeout: 10_000 }).toString(),
      );
      if (status.email !== account.email) {
        console.error(
          `\n❌ MISMATCH: expected ${account.email}, got ${status.email}. Skipping save.`,
        );
        results.push({ key, ok: false, reason: `mismatch:${status.email}` });
        continue;
      }
      console.log(`✅ Verified: ${status.email}`);
      // Save to vault (strip mcpOAuth to keep vault clean)
      const token = readKeychain();
      try {
        const parsed = JSON.parse(token);
        const clean = { claudeAiOauth: parsed.claudeAiOauth, mcpOAuth: {} };
        writeStoredToken(account, JSON.stringify(clean));
      } catch {
        writeStoredToken(account, token);
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
    const icon = r.ok ? (r.skipped ? "⏭ " : "✅") : "❌";
    console.log(`  ${icon} ${r.key}${r.reason ? `  (${r.reason})` : ""}`);
  }
  console.log(
    `\n${okCount}/${results.length} captured${failCount ? `, ${failCount} failed` : ""}.`,
  );

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
        console.log(
          `  🟢 ${k}: extra_usage=off  5h=${u.five_hour_pct}% 7d=${u.seven_day_pct}%`,
        );
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
  console.log(
    `\nSetup done. Run \`node rotate.mjs --audit-billing\` anytime to re-check.\n`,
  );
}

// ── Status ────────────────────────────────────────────────────────────────────

function showStatus() {
  const config = readConfig();
  const state = readState();
  let liveEmail = null;
  try {
    const m = execSync("claude auth status 2>&1", { timeout: 10_000 })
      .toString()
      .match(/"email":\s*"([^"]+)"/);
    if (m) liveEmail = m[1];
  } catch {}

  const since = (d) => {
    if (!d) return "never";
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  // Read real utilization if available
  let realUtil = null;
  try {
    const rlFile = join(__dirname, ".rate-limits.json");
    if (existsSync(rlFile)) {
      const rl = JSON.parse(readFileSync(rlFile, "utf8"));
      const age = Date.now() - rl.ts * 1000;
      if (age < 5 * 60_000) realUtil = rl;
    }
  } catch {}

  // Determine if the mismatch is expected (rotation just ran, session hasn't reloaded)
  const recentRotation = state.lastRotation
    ? Date.now() - new Date(state.lastRotation).getTime() < 90_000
    : false;
  const mismatch =
    liveEmail &&
    state.activeAccount &&
    !state.activeAccount.startsWith(liveEmail) &&
    !liveEmail.startsWith(state.activeAccount);
  const liveNote =
    mismatch && recentRotation
      ? " (stale session — restart Claude Code to apply)"
      : "";

  console.log("\n=== Claude Account Rotation ===\n");
  console.log(`Live auth:       ${liveEmail || "unknown"}${liveNote}`);
  console.log(`Tracked active:  ${state.activeAccount || "unknown"}`);
  console.log(
    `Tool uses:       ${state.toolUses || 0} / ${config.toolUseThreshold}`,
  );
  if (realUtil) {
    console.log(
      `Real utilization: 5h=${realUtil.five_hour?.pct?.toFixed(1) || "?"}%  7d=${realUtil.seven_day?.pct?.toFixed(1) || "?"}%`,
    );
    if (realUtil.five_hour?.reset) {
      const resetIn = Math.max(
        0,
        realUtil.five_hour.reset - Math.floor(Date.now() / 1000),
      );
      const hrs = Math.floor(resetIn / 3600);
      const mins = Math.floor((resetIn % 3600) / 60);
      console.log(`5h resets in:    ${hrs}h${mins}m`);
    }
  }
  console.log(`Total rotations: ${state.totalRotations || 0}`);
  console.log(`Last rotation:   ${since(state.lastRotation)}\n`);
  console.log("Accounts:");
  for (const a of config.accounts) {
    const key = accountKey(a);
    const s = state.accounts[key] || {};
    const active = key === state.activeAccount ? " ◀ ACTIVE" : "";
    const prio = a.priority === "low" ? " (low priority)" : "";
    const tokenOk = hasStoredToken(a) ? "✓ token stored" : "✗ no token";
    const label = a.label ? ` [${a.label}]` : "";
    const windowInfo = s.windowToolUses
      ? ` | window: ${s.windowToolUses} uses`
      : "";
    console.log(`  ${a.email}${label}${active}${prio}`);
    console.log(`    Keychain:    ${tokenOk}`);
    console.log(`    Last active: ${since(s.lastActive)}${windowInfo}`);
  }
  console.log("");
}

// ── --capture: print current token for Dashlane ───────────────────────────────

function captureCmd(targetEmail = null) {
  const state = readState();
  const config = readConfig();
  let account;
  if (targetEmail) {
    const needle = String(targetEmail).trim().toLowerCase();
    account = config.accounts.find(
      (a) => a.email.toLowerCase() === needle,
    );
    if (!account) {
      console.error(`No account in config matching --to ${targetEmail}`);
      process.exit(1);
    }
  } else {
    const activeKey = state.activeAccount;
    account =
      config.accounts.find((a) => accountKey(a) === activeKey) ||
      config.accounts.find((a) => a.email === activeKey);
    if (!account) {
      console.error(`Active account ${activeKey} not in config`);
      process.exit(1);
    }
  }

  try {
    const token = readKeychain();
    if (!token.includes("claudeAiOauth")) {
      console.error("No valid OAuth token in active keychain");
      process.exit(1);
    }
    writeStoredToken(account, token);
    console.log(
      `✓ Token captured and saved to keychain: ${tokenService(account)}`,
    );
    console.log(
      `  Account: ${account.email}${account.label ? " [" + account.label + "]" : ""}`,
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--setup")) {
  await setup();
} else if (args.includes("--utilization")) {
  // Live utilization query for all accounts
  const config = readConfig();
  const state = readState();
  console.log("\nQuerying live utilization for all accounts...\n");
  const liveUtil = await queryAllUtilization(config);
  for (const a of config.accounts) {
    const key = accountKey(a);
    if (a.disabled === true) {
      console.log(`  ⏸  ${key}: DISABLED — ${a.disabledReason || "no reason given"}`);
      continue;
    }
    const active = state.activeAccount === key ? " ◀ ACTIVE" : "";
    const u = liveUtil[key];
    if (!u) {
      console.log(`  ${key}: ❌ query failed${active}`);
      continue;
    }
    const s5 = u.five_hour_pct;
    const s7 = u.seven_day_pct;
    const worst = Math.max(s5 ?? 0, s7 ?? 0);
    const icon = worst >= 90 ? "🔴" : worst >= 70 ? "🟡" : "🟢";
    const reset5 = u.resets_at_5h
      ? `resets ${new Date(u.resets_at_5h).toLocaleTimeString()}`
      : "no reset";
    const euIcon =
      u.extra_usage_enabled === true
        ? " 💳 EXTRA_USAGE_ON"
        : u.extra_usage_enabled === false
          ? ""
          : " (eu?)";
    console.log(
      `  ${icon} ${key}: 5h=${s5}% 7d=${s7}%  (${reset5})${euIcon}${active}`,
    );
  }
  console.log("");
} else if (args.includes("--audit-billing")) {
  // Per-account billing audit — prints extra_usage state + any risk flags
  const config = readConfig();
  const state = readState();
  console.log("\nAuditing billing state for all accounts...\n");
  const liveUtil = await queryAllUtilization(config);
  let risky = 0;
  let unknown = 0;
  for (const a of config.accounts) {
    const key = accountKey(a);
    if (a.disabled === true) {
      console.log(`  ⏸  ${key}: DISABLED — ${a.disabledReason || "no reason given"}`);
      continue;
    }
    const active = state.activeAccount === key ? " ◀ ACTIVE" : "";
    const u = liveUtil[key];
    if (!u) {
      console.log(
        `  ⚠  ${key}: token invalid/expired — cannot audit${active}`,
      );
      unknown++;
      continue;
    }
    const eu = u.extra_usage_enabled;
    const bt = u.billing_type ?? "?";
    const ss = u.subscription_status ?? "?";
    if (eu === true) {
      console.log(
        `  🔴 ${key}: EXTRA_USAGE=ON billing=${bt} status=${ss}${active}  ← overage billing ACTIVE`,
      );
      risky++;
    } else if (eu === false) {
      console.log(
        `  🟢 ${key}: extra_usage=off billing=${bt} status=${ss}${active}`,
      );
    } else {
      console.log(`  ⚠  ${key}: extra_usage=unknown billing=${bt}${active}`);
      unknown++;
    }
  }
  console.log("");
  console.log(
    `Summary: ${risky} risky, ${unknown} unknown, ${config.accounts.length - risky - unknown} safe`,
  );
  if (risky > 0) {
    console.log(
      `\n⚠  Disable extra_usage at https://console.anthropic.com/settings/billing for each risky account.`,
    );
  }
  console.log("");
} else if (args.includes("--status")) {
  showStatus();
} else if (args.includes("--capture")) {
  const capToIdx = args.indexOf("--to");
  const captureTo =
    capToIdx !== -1 && args[capToIdx + 1] ? args[capToIdx + 1] : null;
  captureCmd(captureTo);
} else {
  const toIdx = args.indexOf("--to");
  const target = toIdx !== -1 ? args[toIdx + 1] : null;
  const session = args.includes("--session");
  const noBrowser = args.includes("--no-browser");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const magicLink = args.includes("--magic-link");
  const allowExtraUsage = args.includes("--allow-extra-usage");
  if (dryRun) log("DRY RUN MODE — no changes will be made");
  if (force) {
    log("Force mode — bypassing lock and killing any competing rotations");
    // Kill other rotate.mjs processes (not this one)
    try {
      execSync(
        `pgrep -f 'node.*rotate.mjs' | grep -v ${process.pid} | xargs -r kill -9 2>/dev/null`,
      );
    } catch {}
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  }
  if (!dryRun && !acquireLock()) {
    console.error("Rotation in progress.");
    process.exit(1);
  }
  try {
    const ok = await rotate(target, {
      session,
      noBrowser,
      dryRun,
      magicLink,
      allowExtraUsage,
    });
    process.exit(ok ? 0 : 1);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    notify("Account Rotation", `FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    releaseLock();
  }
}
