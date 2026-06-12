#!/usr/bin/env node
/**
 * bg-spawn.mjs — Per-session account router for `claude --bg` dispatches.
 *
 * Called by `ops-bg dispatch` when CLAUDE_SESSION_ROUTING=1.
 * Picks the least-utilized unleased account, injects CLAUDE_CODE_OAUTH_TOKEN
 * into the child environment, and execs `claude` with the supplied args.
 *
 * Falls back to plain `claude` spawn (global keychain) when:
 *   - No healthy unleased account is available (all exhausted / rate-limited)
 *   - Config or state cannot be read
 *   - Any error occurs during routing
 *
 * NEVER modifies the global keychain entry. NEVER touches vault tokens except
 * to read the access token for the assigned account.
 *
 * Usage (called by ops-bg — do not invoke directly):
 *   node bg-spawn.mjs [claude args...]
 *
 * Required env:
 *   CLAUDE_BIN             — path to the claude binary (set by ops-bg)
 *   CLAUDE_SESSION_ROUTING — must equal "1" (ops-bg checks this before calling)
 *
 * Optional env:
 *   CLAUDE_ROTATION_DIR    — directory containing config.json + state.json
 *                            (defaults to same directory as this script)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { applyAccountLeases } from './account-leases.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config paths ───────────────────────────────────────────────────────────────

const ROTATION_DIR = process.env.CLAUDE_ROTATION_DIR || __dirname;
const CONFIG_PATH = join(ROTATION_DIR, 'config.json');
const STATE_PATH = join(ROTATION_DIR, 'state.json');
const ROUTER_PATH = join(__dirname, 'session-router.mjs');

// ── Logging (to stderr so ops-bg output is unaffected) ────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[bg-spawn ${ts}] ${msg}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

const claudeBin = process.env.CLAUDE_BIN;
if (!claudeBin) {
  log('CLAUDE_BIN not set — falling back to global keychain');
  fallback();
}

const claudeArgs = process.argv.slice(2);

// Validate CLAUDE_SESSION_ROUTING is actually set (ops-bg should have checked)
if (process.env.CLAUDE_SESSION_ROUTING !== '1') {
  log('CLAUDE_SESSION_ROUTING != 1 — falling back to global keychain');
  fallback();
}

// Read config + state — fall back on any parse error
let config, state;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
} catch (e) {
  log(`Failed to read config/state (${e.message}) — falling back to global keychain`);
  fallback();
}

applyAccountLeases(config, { log });

// Import router dynamically (same dir as this shim in repo; ROTATION_DIR in production)
let pickAccountForSession, recordSessionLease, releaseSessionLease;
try {
  const routerPath = existsSync(join(ROTATION_DIR, 'session-router.mjs'))
    ? join(ROTATION_DIR, 'session-router.mjs')
    : ROUTER_PATH;
  ({ pickAccountForSession, recordSessionLease, releaseSessionLease } = await import(routerPath));
} catch (e) {
  log(`Failed to import session-router (${e.message}) — falling back to global keychain`);
  fallback();
}

// accountKey helper (mirrors session-router.mjs)
const accountKey = (a) => a.label || a.email;

// Generate a stable session ID for this dispatch
const sessionId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Pick account
const key = pickAccountForSession(sessionId, config, state);

if (!key) {
  log('No healthy unleased account available — falling back to global keychain');
  fallback();
}

// Find the account and read its vault token
const account = config.accounts.find((a) => accountKey(a) === key);
if (!account) {
  log(`Account ${key} not found in config — falling back to global keychain`);
  fallback();
}

const tokenJson = readVaultToken(account);
if (!tokenJson) {
  log(`No vault token for ${key} — falling back to global keychain`);
  fallback();
}

const accessToken = extractAccessToken(tokenJson);
if (!accessToken) {
  log(`Could not extract access token for ${key} — falling back to global keychain`);
  fallback();
}

// Route is confirmed — record the lease and spawn with injected token
log(`Routing bg session ${sessionId} → ${key}`);
recordSessionLease(sessionId, key, null /* pid unknown until spawn */);

const childEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken };
// Ensure the child does NOT inherit our sentinel (avoid nested routing)
delete childEnv.CLAUDE_SESSION_ROUTING;

const result = spawnSync(claudeBin, claudeArgs, {
  env: childEnv,
  stdio: 'inherit',
});

// Release lease on exit (best-effort)
try {
  releaseSessionLease(sessionId);
} catch {}

process.exit(result.status ?? 1);

// ── Helpers ────────────────────────────────────────────────────────────────────

function fallback() {
  // Plain exec — global keychain, existing behavior
  const result = spawnSync(claudeBin || 'claude', claudeArgs, {
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const IS_LINUX = process.platform === 'linux';
const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || process.env.LOGNAME || 'claude-ops';
const LINUX_CRED_PATH = join(process.env.HOME || '', '.claude', '.credentials.json');

function readVaultToken(account) {
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

function extractAccessToken(tokenJson) {
  try {
    return JSON.parse(tokenJson)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}
