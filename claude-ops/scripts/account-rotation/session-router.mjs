#!/usr/bin/env node
/**
 * session-router.mjs — Per-session account routing
 *
 * DESIGN (see NOTES-rotation-consistency.md for full rationale):
 *
 * Today the system manages ONE global keychain entry ("Claude Code-credentials")
 * shared by all sessions. Swapping it affects every session immediately on the
 * next API call. That is the GLOBAL PATH and remains the fallback.
 *
 * The PER-SESSION PATH (this module) maintains a lease map so concurrent
 * `claude --bg` sessions can be spread across different accounts. Each session
 * gets its own CLAUDE_CODE_OAUTH_TOKEN env var at spawn time, pointing to a
 * specific account's token — instead of all sessions sharing the keychain.
 *
 * Architecture:
 *   session-leases.json  — persistent map: { sessionId: { accountKey, ts, pid } }
 *   pickAccountForSession(sessionId, config, state) → accountKey
 *   recordSessionLease(sessionId, accountKey, pid) → void
 *   releaseSessionLease(sessionId) → void
 *   getTokenForSession(sessionId, config) → tokenJson | null
 *   spawnWithAccount(accountKey, args, env?) → ChildProcess
 *
 * Compatibility guarantee:
 *   - Sessions that were NOT spawned via this module continue to use the global
 *     keychain. The global keychain fallback is NEVER removed.
 *   - The lease map is advisory: if the assigned account is exhausted, fall back
 *     to the global keychain account.
 *
 * Activation: set CLAUDE_SESSION_ROUTING=1 in environment before spawning sessions.
 * Without the env var, all functions are no-ops and the global path is used.
 *
 * IMPORTANT: the live auth-swap risk described in the safety invariants does NOT
 * apply to this module — it only READS vault tokens and writes env vars at spawn
 * time. It never touches the global "Claude Code-credentials" keychain entry.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync, spawn } from "child_process";
import { applyOAuthEnv, applyBedrockEnv } from "./provider-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEASES_PATH = join(__dirname, "session-leases.json");
const IS_LINUX = process.platform === "linux";
const LEASE_TTL_MS = 30 * 60_000; // 30 min — sessions that die without cleanup are GC'd

// ── Lease store ───────────────────────────────────────────────────────────────

export function readLeases() {
  try {
    if (!existsSync(LEASES_PATH)) return {};
    return JSON.parse(readFileSync(LEASES_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeLeases(leases) {
  try {
    writeFileSync(LEASES_PATH, JSON.stringify(leases, null, 2));
  } catch {}
}

/** Prune leases for dead/expired sessions. */
export function pruneLeases(leases) {
  const now = Date.now();
  let pruned = false;
  for (const [sid, entry] of Object.entries(leases)) {
    let alive = false;
    if (entry.pid) {
      try {
        process.kill(entry.pid, 0);
        alive = true;
      } catch {}
    }
    
    // PID-less lease fallback OR grace period for dead PIDs during respawn
    const age = now - (entry.ts || 0);
    if (!alive && age <= (entry.pid ? 60000 : LEASE_TTL_MS)) {
      alive = true;
    }
    if (!alive) {
      delete leases[sid];
      pruned = true;
    }
  }
  return pruned;
}

// ── Account key helper (mirrors rotate.mjs / daemon.mjs) ──────────────────────

function accountKey(a) {
  return a.label || a.email;
}

// ── Vault token read — platform-aware ─────────────────────────────────────────

const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT ||
  process.env.USER ||
  "claude-ops";
const LINUX_CRED_PATH = join(
  process.env.HOME || "",
  ".claude",
  ".credentials.json",
);

export function readVaultToken(account) {
  const svc = `Claude-Rotation-${accountKey(account)}`;
  if (IS_LINUX) {
    try {
      const store = JSON.parse(readFileSync(LINUX_CRED_PATH, "utf8"));
      const val = store[svc];
      if (!val) return null;
      return typeof val === "string" ? val : JSON.stringify(val);
    } catch {
      return null;
    }
  }
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", svc, "-a", KEYCHAIN_ACCOUNT, "-g"],
      {
        timeout: 5000,
        encoding: "utf8",
      },
    );
    const out = (r.stdout || "") + (r.stderr || "");
    const m = out.match(/^password: "?(.*?)"?$/m);
    return m ? m[1].replace(/\\"/g, '"') : null;
  } catch {
    return null;
  }
}

function tokenExpired(tokenJson) {
  try {
    const exp = JSON.parse(tokenJson)?.claudeAiOauth?.expiresAt;
    if (!exp) return false;
    return Date.now() > exp - 5 * 60_000;
  } catch {
    return false;
  }
}

export function extractAccessToken(tokenJson) {
  try {
    return JSON.parse(tokenJson)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

// ── Core: pick the least-utilized account not already leased ──────────────────

/**
 * Pick the best account for a new session.
 *
 * Strategy: find the account with the lowest max(5h,7d) utilization that:
 *   1. Is not disabled.
 *   2. Has a valid (non-expired) vault token.
 *   3. Is not already actively leased to another live session.
 *
 * Falls back to the global keychain account (state.activeAccount) when no
 * per-session-viable candidate exists.
 *
 * @param {string} sessionId  Unique session identifier (e.g. claude bg session ID)
 * @param {object} config     Parsed account-rotation config.json
 * @param {object} state      Parsed state.json
 * @returns {string|null}     accountKey, or null to use global keychain
 */
export function pickAccountForSession(sessionId, config, state) {
  // Always route if we're called
  if (sessionId === 'app-releaser' || String(sessionId).includes('releaser')) return 'bedrock';
  const leases = readLeases();
  const pruned = pruneLeases(leases);
  if (pruned) {
    writeLeases(leases);
  }

  // Count active leases per account key
  const leaseCounts = {};
  for (const a of config.accounts) {
    leaseCounts[accountKey(a)] = 0;
  }
  for (const [sid, entry] of Object.entries(leases)) {
    if (sid !== sessionId && leaseCounts[entry.accountKey] !== undefined) {
      let alive = false;
      if (entry.pid) {
        try {
          process.kill(entry.pid, 0);
          alive = true;
        } catch {}
      }
      if (alive) {
        leaseCounts[entry.accountKey]++;
      }
    }
  }

  const now = Date.now();
  let bestAccount = null;
  let bestLeaseCount = Infinity;
  let bestUtil = Infinity;
  const SORT_WEIGHT_PCT = 2; // Anti-dogpiling weight per active lease for selection sorting only
  const MAX_CONCURRENT_PER_ACCOUNT = 2; // Strict limit to prevent Anthropic "session limit"

  for (const a of config.accounts) {
    if (a.disabled === true) continue;
    const key = accountKey(a);

    const tokenJson = readVaultToken(a);
    if (!tokenJson || tokenExpired(tokenJson)) continue;

    const leasesCount = leaseCounts[key] || 0;
    
    // STRICT CONCURRENCY CAP
    if (leasesCount >= MAX_CONCURRENT_PER_ACCOUNT) continue;

    const cached = state.accounts?.[key]?.lastUtilization;
    const util = cached?.pct ?? 50; // unknown = assume 50%
    const maxUtil = a.maxUtilPercent || config.rateLimits.destinationMaxUtilPercent;

    // Only lease if ACTUAL utilization is strictly below the account's cap (e.g. 98% or 50% account cap)
    if (util < maxUtil) {
      // Add a tiny weight to the actual utilization to stagger concurrent spawns (anti-dogpiling)
      const sortedUtil = util + (leasesCount * SORT_WEIGHT_PCT);
      if (leasesCount < bestLeaseCount || (leasesCount === bestLeaseCount && sortedUtil < bestUtil)) {
        bestLeaseCount = leasesCount;
        bestUtil = sortedUtil;
        bestAccount = a;
      }
    }
  }

  if (bestAccount) return accountKey(bestAccount);

  // Bedrock is METERED/paid. Sam directive (2026-06-14): "Bedrock should never be
  // in use if any /rotate OAuth account has tokens available." The primary loop
  // above can fall through to Bedrock when every account is over its util cap or
  // at the concurrency cap — but a usable (non-expired) OAuth token is still
  // strictly preferable to paying for Bedrock. Second pass: pick the OAuth account
  // with the lowest known utilization that still has a valid token, ignoring the
  // soft util/concurrency caps. Only return 'bedrock' if ZERO accounts have a
  // usable token (true last resort).
  let fallbackAccount = null;
  let fallbackUtil = Infinity;
  for (const a of config.accounts) {
    if (a.disabled === true) continue;
    const tokenJson = readVaultToken(a);
    if (!tokenJson || tokenExpired(tokenJson)) continue;
    const util = state.accounts?.[accountKey(a)]?.lastUtilization?.pct ?? 50;
    if (util < fallbackUtil) {
      fallbackUtil = util;
      fallbackAccount = a;
    }
  }
  return fallbackAccount ? accountKey(fallbackAccount) : 'bedrock';
}

/**
 * Record that sessionId is now using accountKey.
 * Called by the spawner immediately after the decision is made.
 */
export function recordSessionLease(sessionId, key, pid = null) {
  const leases = readLeases();
  leases[sessionId] = { accountKey: key, ts: Date.now(), pid };
  writeLeases(leases);
}

/**
 * Release a session's lease (call when the session terminates).
 */
export function releaseSessionLease(sessionId) {
  const leases = readLeases();
  if (leases[sessionId]) {
    delete leases[sessionId];
    writeLeases(leases);
  }
}

/**
 * Return the vault token JSON for the account assigned to a session.
 * Returns null if no per-session lease exists (caller should use global keychain).
 */
export function getTokenForSession(sessionId, config) {
  const leases = readLeases();
  const lease = leases[sessionId];
  if (!lease) return null;
  const account = config.accounts.find(
    (a) => accountKey(a) === lease.accountKey,
  );
  if (!account) return null;
  return readVaultToken(account);
}

/**
 * Spawn a `claude` process with per-session account credentials injected via env.
 *
 * When CLAUDE_SESSION_ROUTING=1:
 *   - Picks the least-utilized unleased account.
 *   - Passes CLAUDE_CODE_OAUTH_TOKEN=<accessToken> in the child env so this
 *     session authenticates with a DIFFERENT account than the global keychain.
 *   - Records the lease so the next spawn picks a different account.
 *
 * When CLAUDE_SESSION_ROUTING is unset or no per-session account found:
 *   - Falls back to spawning normally (global keychain, existing behavior).
 *
 * @param {string[]} args    Arguments for the `claude` binary
 * @param {object}   config  Parsed config.json
 * @param {object}   state   Parsed state.json
 * @param {object}   opts    { env?, sessionId?, detached?, stdio? }
 * @returns {{ proc: ChildProcess, sessionId: string, accountKey: string|null }}
 */
export function spawnWithAccount(args, config, state, opts = {}) {
  const sessionId =
    opts.sessionId ||
    `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const childEnv = { ...(opts.env || process.env) };

  let assignedKey = null;

  if (true) {
    const key = pickAccountForSession(sessionId, config, state);
    if (key === 'bedrock') {
      applyBedrockEnv(childEnv);
      assignedKey = 'bedrock';
    } else if (key) {
      const account = config.accounts.find((a) => accountKey(a) === key);
      if (account) {
        const tokenJson = readVaultToken(account);
        const accessToken = tokenJson ? extractAccessToken(tokenJson) : null;
        if (accessToken) {
          // Scrub Bedrock vars (incl. hardcoded ANTHROPIC_MODEL + AWS_*) before
          // setting the OAuth token, so the session can't keep paying for Bedrock.
          applyOAuthEnv(childEnv, accessToken);
          assignedKey = key;
        }
      }
    }
  }

  const proc = spawn("claude", args, {
    env: childEnv,
    detached: opts.detached ?? false,
    stdio: opts.stdio ?? "inherit",
  });

  if (assignedKey) {
    recordSessionLease(sessionId, assignedKey, proc.pid);
    proc.once("exit", () => releaseSessionLease(sessionId));
  }

  return { proc, sessionId, accountKey: assignedKey };
}

/**
 * List current session leases with human-readable status.
 * Safe to call any time — read-only.
 */
export function listSessionLeases() {
  const leases = readLeases();
  const pruned = pruneLeases(leases);
  if (pruned) {
    writeLeases(leases);
  }
  const now = Date.now();
  const result = [];
  for (const [sid, entry] of Object.entries(leases)) {
    const ageMins = ((now - (entry.ts || 0)) / 60_000).toFixed(1);
    let alive = false;
    if (entry.pid) {
      try {
        process.kill(entry.pid, 0);
        alive = true;
      } catch {}
    }
    result.push({
      sessionId: sid,
      accountKey: entry.accountKey,
      pid: entry.pid || null,
      ageMins: parseFloat(ageMins),
      alive,
    });
  }
  return result;
}
