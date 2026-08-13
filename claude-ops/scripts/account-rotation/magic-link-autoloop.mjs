#!/usr/bin/env node
/**
 * magic-link-autoloop.mjs — opt-in unattended re-auth reconciler.
 *
 * Fills the recovery gap left when identity-verified vault refresh confirms an
 * account's refresh_token is dead (not just expiring). The refresher flags it
 * needs-reauth and stops. This reconciler, if enabled,
 * dispatches ONE unattended browser re-auth per tick (serial, single-flight).
 *
 * OPT-IN. Does nothing (exits 0) unless crs.enableMagicLinkRecovery is true
 * (or $CRS_ENABLE_MAGIC_LINK=1) — installing this plugin never silently
 * starts unattended re-auth attempts.
 *
 * Direct reauthentication dispatch has been removed. This reconciler now only
 * reports status and a staged-enrollment handoff.
 *
 * Concurrency (hard rules):
 *   1. Single-flight lock (crs-reconciler-state.mjs) — one tick fleet-wide.
 *   2. Exactly ONE account per tick, always serial.
 *   3. Skips the tick entirely if rotate.mjs's own .rotating lock is held —
 *      never contends with a live rotation. Agents must not spawn parallel
 *      rotate.mjs drivers for the same fleet.
 *
 * Captcha / headed env: see reauth-env.mjs + CAPTCHA-CASCADE.md. All seat
 * paths are env-templated (CLAUDE_DESKTOP_DISPLAY, DESKTOP_ACT_*, etc.).
 *
 * CLI: (none)=one tick · --dry-run · --status
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { loadRotationConfig, buildCrsNameMaps, crsFileVaultPath } from './crs-pool-config.mjs';
import { loadJsonState, saveJsonStateAtomic, withOwnStateLock } from './crs-reconciler-state.mjs';
import { resolveReauthTimeoutMs } from './reauth-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const STATUS = args.has('--status');

const C = loadRotationConfig()?.crs || {};
const ENABLED = process.env.CRS_ENABLE_MAGIC_LINK === '1' || C.enableMagicLinkRecovery === true;
const RETRY_COOLDOWN_MS = Number(
  process.env.CRS_MAGIC_LINK_RETRY_COOLDOWN_MS ?? C.magicLinkRetryCooldownMs ?? 21_600_000,
);
const ROTATE_TIMEOUT_MS = resolveReauthTimeoutMs(process.env, C);
const DISPATCH = process.env.CRS_MAGIC_LINK_DISPATCH || C.magicLinkDispatch || 'setup';

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const DEFAULT_DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_DIR = expandHome(process.env.CRS_STATE_DIR || C.stateDir) || join(DEFAULT_DATA_DIR, 'account-rotation');
const STATE_PATH = join(STATE_DIR, 'crs-magic-link-state.json');
const REFRESHER_STATE_PATH = join(STATE_DIR, 'crs-401-state.json');
const ROTATE_SCRIPT = join(__dirname, 'rotate.mjs');
const ROTATING_LOCK = join(__dirname, '.rotating');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [magic-link-autoloop] ${msg}`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** rotate.mjs owns this lock file for any live rotation — never contend with it. */
function rotatingLockBusy() {
  if (!existsSync(ROTATING_LOCK)) return false;
  try {
    const raw = readFileSync(ROTATING_LOCK, 'utf8').trim();
    // Support both "pid …" plain text and JSON {"pid":N}
    let pid = 0;
    if (raw.startsWith('{')) {
      pid = parseInt(JSON.parse(raw)?.pid || '0', 10) || 0;
    } else {
      const parts = raw.split(/\s+/);
      pid = parseInt(parts[1] || parts[parts.length - 1] || '0', 10) || 0;
    }
    return pidAlive(pid);
  } catch {
    return false;
  }
}

/** Read the legacy needs-reauth state file, READ-ONLY, during migration. */
function needsReauthKeysFromRefresher() {
  const state = loadJsonState(REFRESHER_STATE_PATH, log);
  const out = new Set();
  for (const [key, entry] of Object.entries(state || {})) {
    if (entry && typeof entry === 'object' && entry.needsReauth) out.add(key);
  }
  return out;
}

/** Fallback when no needs-reauth record exists: vault missing refresh_token. */
function needsReauthKeysFromVault(vaultKeys) {
  const cfg = loadRotationConfig();
  const vaultPath = crsFileVaultPath(cfg) || join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(vaultPath)) return new Set();
  let vault;
  try {
    vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const key of vaultKeys) {
    const entry = vault?.[`Claude-Rotation-${key}`] || vault?.[key];
    const oauth = entry?.claudeAiOauth || entry?.oauth || entry;
    const hasRefresh = !!(oauth?.refreshToken || oauth?.refresh_token);
    if (!entry || !hasRefresh) out.add(key);
  }
  return out;
}

function pickCandidate(now, state) {
  const cfg = loadRotationConfig();
  const maps = buildCrsNameMaps(cfg);
  const byKey = maps?.nameByVaultKey || cfg?.crs?.nameByVaultKey || {};
  const vaultKeys = Object.keys(byKey);
  if (!vaultKeys.length) return null;

  const fromRefresher = needsReauthKeysFromRefresher();
  const needy = fromRefresher.size ? fromRefresher : needsReauthKeysFromVault(vaultKeys);

  const eligible = [...needy].filter((key) => {
    const last = state[key];
    if (last?.lastAttemptAt && now - last.lastAttemptAt < RETRY_COOLDOWN_MS) return false;
    return true;
  });
  if (!eligible.length) return null;

  // Oldest-attempted (or never-attempted) first — no account-name heuristics.
  eligible.sort((a, b) => (state[a]?.lastAttemptAt || 0) - (state[b]?.lastAttemptAt || 0));
  return eligible[0];
}

async function tick() {
  log('refused: unattended reauthentication is disabled; use staged enrollment');
  return { dispatched: false, reason: 'staged-enrollment-required' };
}

function printStatus() {
  const state = loadJsonState(STATE_PATH, log);
  const rows = Object.entries(state);
  console.log(
    `enabled=${ENABLED} dispatch=${DISPATCH} retryCooldownMs=${RETRY_COOLDOWN_MS} timeoutMs=${ROTATE_TIMEOUT_MS} stateDir=${STATE_DIR}`,
  );
  if (!rows.length) {
    console.log('(no attempts recorded yet)');
    return;
  }
  for (const [key, s] of rows) {
    const lastAt = s.lastAttemptAt ? new Date(s.lastAttemptAt).toISOString() : 'never';
    console.log(
      `  ${key}: lastAttempt=${lastAt} lastCode=${s.lastCode ?? '?'} lastOk=${s.lastOkAt ? new Date(s.lastOkAt).toISOString() : 'never'}`,
    );
  }
}

async function main() {
  if (STATUS) {
    printStatus();
    return;
  }
  if (!ENABLED) {
    log('disabled (crs.enableMagicLinkRecovery is false) — no-op, exiting');
    return;
  }
  await tick();
}

main().catch((e) => {
  log(`fatal: ${e.message || e}`);
  process.exitCode = 1;
});
