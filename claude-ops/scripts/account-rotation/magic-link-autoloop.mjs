#!/usr/bin/env node
/**
 * magic-link-autoloop.mjs — opt-in unattended re-auth reconciler.
 *
 * Fills a gap crs-401-refresher.mjs deliberately leaves for a human: when an
 * account's refresh_token is confirmed dead (not just expiring), the
 * refresher flags it needs-reauth and stops. This reconciler, if enabled,
 * dispatches ONE unattended browser re-auth per tick (serial, single-flight).
 *
 * OPT-IN. Does nothing (exits 0) unless crs.enableMagicLinkRecovery is true
 * (or $CRS_ENABLE_MAGIC_LINK=1) — installing this plugin never silently
 * starts unattended re-auth attempts.
 *
 * Dispatch modes ($CRS_MAGIC_LINK_DISPATCH / crs.magicLinkDispatch):
 *   setup       (default) — `rotate.mjs --setup --only=<key> --auto --skip-valid`
 *   magic-link  — `rotate.mjs --magic-link --force --allow-exhausted --to <key>`
 *                 (for forks that wire magic-link + captcha cascade in rotate.mjs)
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
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { loadRotationConfig, buildCrsNameMaps, crsFileVaultPath } from './crs-pool-config.mjs';
import { loadJsonState, saveJsonStateAtomic, withOwnStateLock } from './crs-reconciler-state.mjs';
import {
  buildReauthChildEnv,
  resolveReauthTimeoutMs,
  reauthOutputLooksSuccessful,
} from './reauth-env.mjs';

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
const DISPATCH =
  process.env.CRS_MAGIC_LINK_DISPATCH || C.magicLinkDispatch || 'setup';

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const DEFAULT_DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR ||
  join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_DIR =
  expandHome(process.env.CRS_STATE_DIR || C.stateDir) || join(DEFAULT_DATA_DIR, 'account-rotation');
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

/** Read crs-401-refresher's own state file, READ-ONLY, for accounts it flagged needs-reauth. */
function needsReauthKeysFromRefresher() {
  const state = loadJsonState(REFRESHER_STATE_PATH, log);
  const out = new Set();
  for (const [key, entry] of Object.entries(state || {})) {
    if (entry && typeof entry === 'object' && entry.needsReauth) out.add(key);
  }
  return out;
}

/** Fallback when crs-401-refresher isn't enabled: vault missing refresh_token. */
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

function buildRotateArgs(vaultKey) {
  const mode = String(DISPATCH).toLowerCase();
  if (mode === 'magic-link' || mode === 'magic_link' || mode === 'magic') {
    return [
      ROTATE_SCRIPT,
      '--magic-link',
      '--force',
      '--allow-exhausted',
      '--to',
      vaultKey,
    ];
  }
  // Default public path
  return [ROTATE_SCRIPT, '--setup', `--only=${vaultKey}`, '--auto', '--skip-valid'];
}

function spawnRotate(vaultKey) {
  return new Promise((resolve) => {
    const rotateArgs = buildRotateArgs(vaultKey);
    log(`spawn: node ${rotateArgs.join(' ')} (dispatch=${DISPATCH})`);
    const child = spawn(process.execPath, rotateArgs, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...buildReauthChildEnv({ env: process.env, crs: C }),
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      log(`timeout — killing rotate.mjs for ${vaultKey} after ${ROTATE_TIMEOUT_MS}ms`);
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 5000);
    }, ROTATE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function tick() {
  if (rotatingLockBusy()) {
    log('rotate.mjs .rotating lock busy — skip tick (never contend with a live rotation)');
    return;
  }

  const now = Date.now();
  const { skipped, result } = await withOwnStateLock(
    STATE_PATH,
    async () => {
      const state = loadJsonState(STATE_PATH, log);
      const candidate = pickCandidate(now, state);
      if (!candidate) {
        log('no eligible candidates (none flagged needs-reauth, or all on cooldown)');
        return { dispatched: false };
      }

      if (DRY) {
        log(`[dry-run] would dispatch rotate.mjs for ${candidate} (dispatch=${DISPATCH})`);
        return { dispatched: false, candidate };
      }

      state[candidate] = { ...(state[candidate] || {}), lastAttemptAt: now };
      saveJsonStateAtomic(STATE_PATH, state);

      const { code, out } = await spawnRotate(candidate);
      const contended = /Rotation in progress/i.test(out) && !/FATAL:/i.test(out);
      const ok = code === 0 && reauthOutputLooksSuccessful(out) && !contended;
      state[candidate] = {
        ...(state[candidate] || {}),
        lastAttemptAt: now,
        lastCode: code,
        lastOkAt: ok ? now : state[candidate]?.lastOkAt,
        lastFailClass: ok ? undefined : contended ? 'contended' : 'rotate-fail',
      };
      saveJsonStateAtomic(STATE_PATH, state);
      log(`done ${candidate} exit=${code} ok=${ok}${contended ? ' class=contended' : ''}`);
      return { dispatched: true, candidate, ok, contended };
    },
    log,
  );

  if (skipped) log('another tick already holds the lock — skipping (fleet-wide single-flight)');
  return result;
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
