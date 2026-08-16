#!/usr/bin/env node
/**
 * magic-link-autoloop.mjs — opt-in unattended re-auth reconciler.
 *
 * Fills the recovery gap left when identity-verified vault refresh confirms an
 * account's refresh_token is dead (not just expiring). The refresher flags it
 * needs-reauth and stops. This reconciler, if enabled,
 * dispatches ONE unattended browser re-auth per tick (serial, single-flight).
 *
 * OPT-IN. Does nothing (exits 0) unless rotation.enableMagicLinkRecovery is true
 * (or $CLAUDE_ROTATION_ENABLE_MAGIC_LINK=1) — installing this plugin never
 * silently starts unattended re-auth attempts.
 *
 * Direct reauthentication dispatch has been removed. This reconciler now only
 * reports status and a staged-enrollment handoff.
 *
 * Concurrency (hard rules):
 *   1. Single-flight lock (reconciler-state.mjs) — one tick fleet-wide.
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
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { loadRotationConfig, rotationSection } from './rotation-config.mjs';
import { loadJsonState } from './reconciler-state.mjs';
import { resolveReauthTimeoutMs } from './reauth-env.mjs';

const args = new Set(process.argv.slice(2));
const STATUS = args.has('--status');

const C = rotationSection(loadRotationConfig());
const ENABLED =
  process.env.CLAUDE_ROTATION_ENABLE_MAGIC_LINK === '1' ||
  process.env.CRS_ENABLE_MAGIC_LINK === '1' ||
  C.enableMagicLinkRecovery === true;
const RETRY_COOLDOWN_MS = Number(
  process.env.CLAUDE_ROTATION_MAGIC_LINK_RETRY_COOLDOWN_MS ?? C.magicLinkRetryCooldownMs ?? 21_600_000,
);
const ROTATE_TIMEOUT_MS = resolveReauthTimeoutMs(process.env, C);
const DISPATCH = process.env.CLAUDE_REAUTH_DISPATCH || C.magicLinkDispatch || 'setup';

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const DEFAULT_DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_DIR =
  expandHome(process.env.CLAUDE_ROTATION_STATE_DIR || process.env.CRS_STATE_DIR || C.stateDir) ||
  join(DEFAULT_DATA_DIR, 'account-rotation');

/** Prefer the current filename; fall back to a legacy file already on disk. */
function statePath(current, legacy) {
  const currentPath = join(STATE_DIR, current);
  const legacyPath = join(STATE_DIR, legacy);
  if (!existsSync(currentPath) && existsSync(legacyPath)) return legacyPath;
  return currentPath;
}

const STATE_PATH = statePath('magic-link-state.json', 'crs-magic-link-state.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [magic-link-autoloop] ${msg}`);
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
    log('disabled (rotation.enableMagicLinkRecovery is false) — no-op, exiting');
    return;
  }
  await tick();
}

main().catch((e) => {
  log(`fatal: ${e.message || e}`);
  process.exitCode = 1;
});
