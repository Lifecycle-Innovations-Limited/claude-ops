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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';
import { cachedUtilizationMax } from './rotation-policy.mjs';
import { isLegacyRelayToken, scrubLegacyRelayEnv } from './route-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEASES_PATH = join(__dirname, 'session-leases.json');
const IS_LINUX = process.platform === 'linux';
const LEASE_TTL_MS = 30 * 60_000; // 30 min — sessions that die without cleanup are GC'd
const DIRECT_OAUTH_SETTINGS_DIR = join(__dirname, '.settings-overrides');

// ── Lease store ───────────────────────────────────────────────────────────────

export function readLeases() {
  try {
    if (!existsSync(LEASES_PATH)) return {};
    return JSON.parse(readFileSync(LEASES_PATH, 'utf8'));
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

export function accountKey(a) {
  return a.label || a.email;
}

// ── Vault token read — platform-aware ─────────────────────────────────────────

const KEYCHAIN_ACCOUNT = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
const LINUX_CRED_PATH = join(process.env.HOME || '', '.claude', '.credentials.json');

export function readVaultToken(account) {
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
    const r = spawnSync('security', ['find-generic-password', '-s', svc, '-a', KEYCHAIN_ACCOUNT, '-g'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
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
  // BEDROCK FALLBACK DISABLED (2026-06-13): Bedrock served the hardcoded
  // `anthropic.claude-fable-5`, which Bedrock cannot serve ("Claude Fable 5 is
  // currently unavailable") → sessions flipped to Bedrock wedged permanently.
  // The releaser→bedrock special-case is removed; releaser sessions now route to
  // a normal OAuth account like everything else.
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
  const MAX_CONCURRENT_PER_ACCOUNT = 4; // Sam 2026-07-20: raised from 2 to 4 to maximize fleet throughput. Real ceiling is the Anthropic API quota-reached response, not a soft heuristic.

  for (const a of config.accounts) {
    if (a.disabled === true) continue;
    const key = accountKey(a);

    const tokenJson = readVaultToken(a);
    if (!tokenJson || tokenExpired(tokenJson)) continue;

    const leasesCount = leaseCounts[key] || 0;

    // STRICT CONCURRENCY CAP
    if (leasesCount >= MAX_CONCURRENT_PER_ACCOUNT) continue;

    const cached = state.accounts?.[key]?.lastUtilization;
    const util = cachedUtilizationMax(cached) ?? 50; // unknown = assume 50%
    const maxUtil = a.maxUtilPercent || config.rateLimits.destinationMaxUtilPercent;

    // Only lease if ACTUAL utilization is strictly below the account's cap.
    if (util < maxUtil) {
      // COOLEST-ACCOUNT-FIRST: sort PRIMARILY by utilization (plus a small
      // per-lease anti-dogpile weight), NOT by lease count. The old sort keyed
      // on fewest-leases first, so a 97%-but-0-lease account beat a 0%-but-1-lease
      // account → sessions were leased onto near-exhausted accounts and 429'd
      // almost immediately even while cooler accounts sat idle. The strict
      // MAX_CONCURRENT_PER_ACCOUNT cap above still bounds dogpiling. (Sam 2026-06-13)
      const sortedUtil = util + leasesCount * SORT_WEIGHT_PCT;
      if (sortedUtil < bestUtil) {
        bestUtil = sortedUtil;
        bestLeaseCount = leasesCount;
        bestAccount = a;
      }
    }
  }

  if (bestAccount) return accountKey(bestAccount);

  // No account is under both the util cap AND the concurrency cap. Bedrock
  // fallback is DISABLED (unservable model stranded the fleet), so instead of
  // returning 'bedrock' we fall back to the COOLEST token-valid OAuth account,
  // ignoring the concurrency cap. An over-leased OAuth account still serves
  // requests; an unservable Bedrock model does not. Per-account egress IPs
  // (Phase 1) are the real fix for the concurrency/IP-reputation ceiling.
  let coolest = null;
  let coolestUtil = Infinity;
  for (const a of config.accounts) {
    if (a.disabled === true) continue;
    const tokenJson = readVaultToken(a);
    if (!tokenJson || tokenExpired(tokenJson)) continue;
    const util = cachedUtilizationMax(state.accounts?.[accountKey(a)]?.lastUtilization) ?? 50;
    if (util < coolestUtil) {
      coolestUtil = util;
      coolest = a;
    }
  }
  // null → caller uses the global keychain (existing behavior); never bedrock.
  return coolest ? accountKey(coolest) : null;
}

/**
 * Claude Code re-applies settings.json's env block internally at startup,
 * whatever env the spawning process set. If that block pins ANTHROPIC_BASE_URL
 * or an API key, a per-session OAuth token gets overridden and the session
 * fails to authenticate.
 *
 * Rather than mutate the shared settings.json, generate a settings copy with
 * those keys blanked and point THIS spawn at it via --settings, only when we
 * have actually assigned a direct OAuth token.
 */
function buildDirectOauthSettingsOverride() {
  try {
    // --settings loads ADDITIONAL settings merged on top of the base
    // settings.json (confirmed empirically: "--help" says "load additional
    // settings from", and omitting a key does NOT unset the base file's
    // value — deleting keys here is a no-op). To actually neutralize a pinned
    // base URL for this one spawn, explicitly override the keys to "".
    // The API-key fields go too: if we only clear BASE_URL, Claude Code
    // dual-auths (OAuth + external API key) and surfaces "Invalid API key".
    const overrideDoc = {
      env: {
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_API_BASE: '',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    };
    if (!existsSync(DIRECT_OAUTH_SETTINGS_DIR)) {
      mkdirSync(DIRECT_OAUTH_SETTINGS_DIR, { recursive: true });
    }
    const outPath = join(DIRECT_OAUTH_SETTINGS_DIR, 'direct-oauth.settings.json');
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(overrideDoc, null, 2));
    renameSync(tmpPath, outPath); // atomic replace — safe under concurrent spawns
    return outPath;
  } catch {
    return null;
  }
}

/**
 * Every spawned session authenticates directly, with its own OAuth token.
 *
 * The removed relay backend paired a loopback base URL with a `cr_` bearer
 * token. Both are stripped here so a leftover pair on an upgraded machine can
 * never re-point a child at a relay that is no longer managed.
 */
export function enforceDirectAuth(childEnv) {
  scrubLegacyRelayEnv(childEnv);
  return childEnv;
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
  const account = config.accounts.find((a) => accountKey(a) === lease.accountKey);
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
  const sessionId = opts.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const childEnv = { ...(opts.env || process.env) };
  enforceDirectAuth(childEnv);

  let assignedKey = null;

  // The bg daemon keeps whatever credential it was started with; every other
  // spawn gets a per-account OAuth token.
  const isDaemon = Array.isArray(args) && args.includes('daemon');
  const usePerAccountRouting = !isDaemon;

  if (usePerAccountRouting) {
    const key = pickAccountForSession(sessionId, config, state);
    // BEDROCK FALLBACK DISABLED (2026-06-13): pickAccountForSession never returns
    // 'bedrock' anymore. Defensively strip any inherited Bedrock env so a child
    // never boots on the unservable model. key===null → global keychain.
    delete childEnv.CLAUDE_CODE_USE_BEDROCK;
    delete childEnv.ANTHROPIC_MODEL;
    delete childEnv.ANTHROPIC_API_KEY;
    if (key && key !== 'bedrock' && !isDaemon) {
      const account = config.accounts.find((a) => accountKey(a) === key);
      if (account) {
        const tokenJson = readVaultToken(account);
        const accessToken = tokenJson ? extractAccessToken(tokenJson) : null;
        if (accessToken) {
          childEnv.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
          assignedKey = key;
        }
      }
    }
  }

  enforceDirectAuth(childEnv);

  const directOauthToken = childEnv.CLAUDE_CODE_OAUTH_TOKEN && !isLegacyRelayToken(childEnv.CLAUDE_CODE_OAUTH_TOKEN);
  let spawnArgs = args;
  if (directOauthToken && !childEnv.ANTHROPIC_BASE_URL && !args.includes('--settings')) {
    const overridePath = buildDirectOauthSettingsOverride();
    if (overridePath) {
      spawnArgs = [...args, '--settings', overridePath];
    }
  }

  const proc = spawn(childEnv.CLAUDE_REAL_BIN || 'claude', spawnArgs, {
    env: childEnv,
    detached: opts.detached ?? false,
    stdio: opts.stdio ?? 'inherit',
  });

  if (assignedKey) {
    recordSessionLease(sessionId, assignedKey, proc.pid);
    proc.once('exit', () => releaseSessionLease(sessionId));
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
