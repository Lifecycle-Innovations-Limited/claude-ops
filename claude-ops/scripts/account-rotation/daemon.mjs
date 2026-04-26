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
 * Usage:
 *   node daemon.mjs           # Run in foreground
 *   node daemon.mjs --bg      # Daemonize
 *   node daemon.mjs --stop    # Stop running daemon
 *   node daemon.mjs --status  # Show daemon status
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  appendFileSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, execFileSync, spawn } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const STATE_PATH = join(__dirname, "state.json");
const LOG_PATH = join(__dirname, "rotation.log");
const PID_FILE = join(__dirname, ".daemon.pid");
const ROTATE_SCRIPT = join(__dirname, "rotate.mjs");

// Keychain account name — must match rotate.mjs convention.
const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT ||
  process.env.USER ||
  process.env.LOGNAME ||
  "claude-ops";

const POLL_INTERVAL = 15_000; // Check every 15s — fast enough to catch hook-triggered 429 signals (fireAt = now+15s)
const RATE_LIMIT_COOLDOWN = 10_000; // 10s after rate limit before rotating
const POST_ROTATION_BLACKOUT = 180_000; // 3min after rotation: ignore ALL triggers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_LOG_SIZE = 50_000; // 50KB — ~500 lines, enough for debugging
function log(msg) {
  const line = `[${new Date().toISOString()}] [daemon] ${msg}`;
  console.error(line);
  try {
    appendFileSync(LOG_PATH, line + "\n");
    // Truncate: keep last half when exceeding max
    try {
      const { size } = statSync(LOG_PATH);
      if (size > MAX_LOG_SIZE) {
        const content = readFileSync(LOG_PATH, "utf8");
        const lines = content.split("\n");
        writeFileSync(
          LOG_PATH,
          lines.slice(Math.floor(lines.length / 2)).join("\n"),
        );
      }
    } catch {}
  } catch {}
}

function notify(title, msg) {
  try {
    // Use execFileSync to avoid shell interpretation of quotes in title/msg
    execFileSync("osascript", [
      "-e",
      `display notification "${msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" with title "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    ], { timeout: 5000 });
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
    const pct = util.pct ?? "?";
    if (fresh) {
      summary.push(
        `  ${key}: READY (reset ${Math.round((now - resetMs) / 60_000)}min ago, was ${pct}%)`,
      );
    } else if (resetMs) {
      summary.push(
        `  ${key}: COOLING (${pct}%, resets in ${Math.round((resetMs - now) / 60_000)}min)`,
      );
    } else {
      summary.push(`  ${key}: ${pct}% (no reset info)`);
    }
  }
  return summary.join("\n");
}

function accountKey(a) {
  return a.label || a.email;
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

function readStoredToken(account) {
  const svc = `Claude-Rotation-${accountKey(account)}`;
  try {
    const out = execSync(
      `security find-generic-password -s "${svc}" -a "${KEYCHAIN_ACCOUNT}" -g 2>&1`,
      { timeout: 5000 },
    ).toString();
    const m = out.match(/^password: "?(.*?)"?$/m);
    return m ? m[1].replace(/\\"/g, '"') : null;
  } catch {
    return null;
  }
}

function readActiveKeychainToken() {
  try {
    const out = execSync(
      'security find-generic-password -s "Claude Code-credentials" -g 2>&1',
      { timeout: 5000 },
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
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${liveTok}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const liveEmail = body?.account?.email?.toLowerCase();
    if (!liveEmail) return null;
    // Map email → account key (handle multi-org accounts via label)
    const matches = config.accounts.filter(
      (a) => a.email.toLowerCase() === liveEmail,
    );
    if (matches.length === 1) return accountKey(matches[0]);
    if (matches.length > 1) {
      // Multiple labels for same email (e.g. user-personal vs -team).
      // Use orgName from profile to disambiguate.
      const orgName = body?.organization?.name?.toLowerCase() || "";
      const byOrg = matches.find((a) =>
        (a.orgName || "").toLowerCase() === orgName,
      );
      if (byOrg) return accountKey(byOrg);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Real utilization from Anthropic (via statusline export) ──────────────────

const RATE_LIMITS_FILE = join(__dirname, ".rate-limits.json");
const UTILIZATION_ROTATE_THRESHOLD = 80; // Rotate at 80% — with 8+ concurrent sessions burning tokens fast, 95% was too late (hit 100% between statusline updates)

function readRealUtilization() {
  try {
    if (!existsSync(RATE_LIMITS_FILE)) return null;
    const data = JSON.parse(readFileSync(RATE_LIMITS_FILE, "utf8"));
    const age = Date.now() - data.ts * 1000;
    if (age > 5 * 60_000) return null; // Stale (>5min) — session may be dead
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
    const rateLimitFile = join(tmpdir(), "claude-rate-limited.json");
    if (existsSync(rateLimitFile)) {
      const data = JSON.parse(readFileSync(rateLimitFile, "utf8"));
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
          reason: `429 signal: ${(data.reason || "rate_limit").substring(0, 120)}`,
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

const AUTH_ERROR_FILE = join(tmpdir(), "claude-auth-error.json");

async function shouldRotate(config, state) {
  // 1. Real utilization from statusline (PRIMARY signal for rotation)
  const rl = checkRateLimited();
  if (rl.limited) return { should: true, reason: `Rate limited: ${rl.reason}` };

  // 2. Auth error signal (401) from PostToolUseFailure hook
  try {
    if (existsSync(AUTH_ERROR_FILE)) {
      const sig = JSON.parse(readFileSync(AUTH_ERROR_FILE, "utf8"));
      const age = Date.now() - new Date(sig.timestamp).getTime();
      if (age < 5 * 60_000) {
        unlinkSync(AUTH_ERROR_FILE);
        log(`401 auth error detected: ${sig.reason || "unknown"}`);
        return {
          should: true,
          reason: `Auth error (401): ${sig.reason || "invalid credentials"}`,
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
      log(
        "[active-refresh] Active token expiring — attempting in-place refresh",
      );
      const refreshed = await refreshSingleToken(account);
      if (refreshed) {
        // Also update the active keychain so running sessions pick it up on next /login
        try {
          const freshToken = readStoredToken(account);
          if (freshToken) {
            const svc = "Claude Code-credentials";
            const escaped = freshToken.replace(/"/g, '\\"');
            execSync(
              `security add-generic-password -U -s "${svc}" -a "${KEYCHAIN_ACCOUNT}" -w "${escaped}"`,
              { timeout: 5000 },
            );
            log(
              "[active-refresh] Active keychain updated — sessions will auto-recover",
            );
          }
        } catch (err) {
          log(
            `[active-refresh] Keychain update failed: ${err.message?.substring(0, 60)}`,
          );
        }
        return { should: false }; // Refreshed in-place, no rotation needed
      }
      log("[active-refresh] Refresh failed — triggering rotation");
      return { should: true, reason: "Token expired and refresh failed" };
    }
  }

  return { should: false };
}

// ── Execute rotation ──────────────────────────────────────────────────────────

// Fetch live 5h/7d utilization for one account (no cache). Returns
// {pct5h, pct7d} or null on failure. Cheap — single GET, 4s timeout.
async function queryLiveUtilization(account) {
  try {
    const tokenJson = readStoredToken(account);
    if (!tokenJson) return null;
    const accessToken = JSON.parse(tokenJson)?.claudeAiOauth?.accessToken;
    if (!accessToken) return null;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      pct5h: data?.five_hour?.utilization || 0,
      pct7d: data?.seven_day?.utilization || 0,
    };
  } catch {
    return null;
  }
}

async function findValidRotationTarget(config, state) {
  const now = Date.now();
  const activeKey = state.activeAccount;
  const SAFE_UTIL_5H_PCT = 70; // 5h window is what we rotate around — strict
  const SAFE_UTIL_7D_PCT = 95; // 7d resets weekly — only hard-skip if truly capped

  // Build candidate list: all accounts except the active one AND disabled ones.
  const candidates = config.accounts.filter(
    (a) => accountKey(a) !== activeKey && a.disabled !== true,
  );

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
      log(
        `[pre-rotate] ${key}: token valid (${((expiry - now) / 3_600_000).toFixed(1)}h remaining)`,
      );
    }

    // Live util check — never rotate to a high-utilization account.
    // The cached snapshot may be stale (e.g. lic had pct:0 but live was 100%).
    const live = await queryLiveUtilization(account);
    if (live) {
      const max = Math.max(live.pct5h, live.pct7d);
      const tooHot5h = live.pct5h >= SAFE_UTIL_5H_PCT;
      const tooHot7d = live.pct7d >= SAFE_UTIL_7D_PCT;
      if (tooHot5h || tooHot7d) {
        const reason = tooHot5h
          ? `5h ${live.pct5h.toFixed(0)}% >= ${SAFE_UTIL_5H_PCT}%`
          : `7d ${live.pct7d.toFixed(0)}% >= ${SAFE_UTIL_7D_PCT}%`;
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
      log(
        `[pre-rotate] ${key}: live util 5h=${live.pct5h.toFixed(0)}% 7d=${live.pct7d.toFixed(0)}% — OK`,
      );
    } else {
      log(`[pre-rotate] ${key}: live util query failed — accepting anyway`);
    }

    return account;
  }

  return null; // No valid candidate found
}

async function doRotation(reason) {
  const lockFile = join(__dirname, ".rotating");
  // Lock format written by rotate.mjs: `<ISO timestamp>\n<pid>`. If the holder
  // PID is still alive, skip — don't race even if the wall-clock is ancient
  // (browser OAuth flows can legitimately run several minutes).
  const LOCK_HARD_CEILING_MS = 15 * 60_000;
  if (existsSync(lockFile)) {
    try {
      const raw = readFileSync(lockFile, "utf8").trim();
      const [tsStr, pidStr] = raw.split(/\s+/);
      const age = Date.now() - new Date(tsStr).getTime();
      const pid = parseInt(pidStr || "", 10);
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
      if (!holderAlive) log(`Stale lock (PID ${pid || "?"} dead) — proceeding`);
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
    log("ROTATION ABORTED: no candidate has a valid or refreshable token");
    notify(
      "Account Rotation",
      "ABORTED — all candidate tokens expired/invalid",
    );
    return;
  }

  const targetKey = accountKey(target);
  log(
    `Target account: ${targetKey} — token validated, proceeding with rotation`,
  );
  notify("Claude Account Rotation", `Auto-rotating to ${targetKey}: ${reason}`);

  try {
    // --no-browser: no Chrome, no API calls (works when rate limited)
    // --to: daemon controls which account to rotate to (pre-validated token)
    // NO --session: keychain swap only. Running sessions can't accept /login mid-work.
    // When sessions hit the wall they show "not logged in" — user runs /login → instant
    // success because the fresh token is already in the keychain.
    // --session: inject /login into running sessions (safe — keychain token is pre-validated)
    const result = execFileSync(
      process.execPath,
      [ROTATE_SCRIPT, "--no-browser", "--session", "--to", targetKey],
      {
        cwd: __dirname,
        timeout: 300_000, // 5min — session restart takes ~15s per session × up to 8 sessions
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    ).toString();
    log(`Rotation result: ${result.substring(0, 200)}`);
  } catch (err) {
    log(`Rotation failed: ${err.message}`);
    notify(
      "Account Rotation",
      `Auto-rotation failed: ${err.message.substring(0, 60)}`,
    );
  }
}

// ── Dynamic token refresh ────────────────────────────────────────────────────
// Instead of a fixed hourly launchd job refreshing all accounts, refresh
// on-demand: when utilization is climbing (50%+), pre-refresh candidate
// accounts so they're ready for rotation. Also refresh any token within
// 1h of expiry regardless of utilization.

const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) return false;

    const parsed = JSON.parse(tokenJson);
    parsed.claudeAiOauth.accessToken = body.access_token;
    if (body.refresh_token)
      parsed.claudeAiOauth.refreshToken = body.refresh_token;
    parsed.claudeAiOauth.expiresAt = body.expires_in
      ? Date.now() + body.expires_in * 1000
      : Date.now() + 8 * 3_600_000;

    // Save back to vault
    const svc = `Claude-Rotation-${key}`;
    // Use execFileSync to avoid shell-escaping issues with JSON tokens
    execFileSync("security", [
      "add-generic-password", "-U",
      "-s", svc,
      "-a", KEYCHAIN_ACCOUNT,
      "-w", JSON.stringify(parsed),
    ], { timeout: 5000 });
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
    const preemptive =
      pct5h >= 50 && remaining > 0 && remaining < 3 * 3_600_000;

    if (urgent || preemptive) {
      await refreshSingleToken(account);
      await sleep(2000); // Don't hammer the token endpoint
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function mainLoop() {
  log("Daemon started (v3 — dynamic refresh, no hourly launchd)");
  notify("Claude Rotation Daemon", "Monitoring usage — dynamic refresh");

  let lastRotatedAt = 0; // track when we last rotated
  let lastStatusLog = 0; // periodic status logging
  let lastRefreshCheck = 0; // dynamic refresh check
  let lastDriftCheck = 0; // cheap vault-based drift detection

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

      // Drift detection — every 2 min, find the actual live account.
      // 1) Cheap vault-token compare first (zero network).
      // 2) Fall back to /api/oauth/profile when Claude Code has refreshed
      //    its own token and the live no longer matches any vault.
      // Self-heals when state.json disagrees with the actual active account
      // (crashed rotation, manual /login, leftover lock).
      if (Date.now() - lastDriftCheck > 120_000) {
        lastDriftCheck = Date.now();
        const stateLastRotation2 = state.lastRotation
          ? new Date(state.lastRotation).getTime()
          : 0;
        const inBlackoutDrift =
          stateLastRotation2 &&
          Date.now() - stateLastRotation2 < POST_ROTATION_BLACKOUT;
        if (!inBlackoutDrift) {
          const liveKey = await detectLiveAccountFromVault(config);
          if (liveKey && liveKey !== state.activeAccount) {
            log(
              `⚠️ DRIFT: state=${state.activeAccount || "none"} but keychain=${liveKey} — syncing state.json`,
            );
            state.activeAccount = liveKey;
            writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
          }
        }
      }

      // Dynamic token refresh disabled — only refresh when the active account
      // actually needs rotation (shouldRotate handles in-place refresh, and
      // findValidRotationTarget refreshes candidates lazily). Avoids keychain
      // churn that was disconnecting HTTP MCP sessions every 5 min.

      const { should, reason } = await shouldRotate(config, state);

      // Post-rotation blackout: ALL rotation triggers are suppressed for 90s
      // after any rotation. `claude auth status` returns stale data during this
      // window, which causes drift detection → re-rotation thrashing loops.
      const stateLastRotation = state.lastRotation
        ? new Date(state.lastRotation).getTime()
        : 0;
      const effectiveLastRotated = Math.max(lastRotatedAt, stateLastRotation);
      const inBlackout =
        effectiveLastRotated &&
        Date.now() - effectiveLastRotated < POST_ROTATION_BLACKOUT;

      if (should && inBlackout) {
        const remaining = Math.ceil(
          (POST_ROTATION_BLACKOUT - (Date.now() - effectiveLastRotated)) / 1000,
        );
        log(
          `Post-rotation blackout: ignoring "${reason}" for ${remaining}s more`,
        );
      } else if (should) {
        await doRotation(reason);
        lastRotatedAt = Date.now();
        await sleep(RATE_LIMIT_COOLDOWN);
      }
    } catch (err) {
      log(`Daemon error: ${err.message}`);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--stop")) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, "utf8").trim();
    try {
      process.kill(parseInt(pid));
      log(`Stopped daemon (PID ${pid})`);
    } catch {}
    try {
      unlinkSync(PID_FILE);
    } catch {}
    console.log(`Daemon stopped (PID ${pid})`);
  } else {
    console.log("No daemon running");
  }
} else if (args.includes("--status")) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, "utf8").trim();
    try {
      process.kill(parseInt(pid), 0); // Check if alive
      console.log(`Daemon running (PID ${pid})`);
    } catch {
      console.log("Daemon PID file exists but process is dead");
      unlinkSync(PID_FILE);
    }
  } else {
    console.log("Daemon not running");
  }
} else if (args.includes("--bg")) {
  // Daemonize
  const child = spawn("node", [join(__dirname, "daemon.mjs")], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
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
  process.on("SIGINT", () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  });
  await mainLoop();
}
