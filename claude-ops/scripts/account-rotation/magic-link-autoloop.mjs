#!/usr/bin/env node
/**
 * magic-link-autoloop.mjs — opt-in unattended re-auth reconciler.
 *
 * Fills a gap crs-401-refresher.mjs deliberately leaves for a human: when an
 * account's refresh_token is confirmed dead (not just expiring), the
 * refresher flags it needs-reauth and stops — someone has to log back in.
 * This reconciler, if enabled, takes that one further step: it dispatches
 * `rotate.mjs --setup --only=<key> --auto --skip-valid` (the same generic,
 * already-Gmail-via-`gog` setup flow `/ops:rotate-setup` uses) for ONE
 * needs-reauth account per tick, serially, with a per-account cooldown so a
 * genuinely broken account isn't retried in a tight loop.
 *
 * OPT-IN. Does nothing (exits 0) unless crs.enableMagicLinkRecovery is true
 * (or $CRS_ENABLE_MAGIC_LINK=1) — installing this plugin never silently
 * starts unattended re-auth attempts.
 *
 * Provider note: this reconciler's own logic (candidate detection, locking,
 * cooldowns) has no email-provider dependency at all — it only decides WHICH
 * account to retry and WHEN. The actual email polling happens inside
 * rotate.mjs's setup flow, which is Gmail-via-`gog` today. Making THAT
 * provider-agnostic (e.g. IMAP) is a rotate.mjs-internals change, tracked
 * separately (see AUR-1555) — this reconciler will pick up such a change for
 * free once it lands, since it only calls rotate.mjs's public --setup
 * interface and never touches its internals.
 *
 * Concurrency (hard rules, ported from a documented incident where two
 * autoloop ticks raced the same account's browser session):
 *   1. Single-flight lock (crs-reconciler-state.mjs) — one tick fleet-wide.
 *   2. Exactly ONE account per tick, always serial.
 *   3. Skips the tick entirely (no error) if rotate.mjs's own .rotating lock
 *      is held — never contends with a live manual rotation.
 *
 * CONFIG (config.json "crs" block; every key overridable by env — see
 * config.example.json for the full annotated schema):
 *   enableMagicLinkRecovery   default false — must be true (or
 *                             $CRS_ENABLE_MAGIC_LINK=1) to do anything.
 *   magicLinkRetryCooldownMs  default 21600000 (6h) — minimum time between
 *                             retry attempts for the SAME account, success
 *                             or failure, so a persistently-broken account
 *                             doesn't get hammered.
 *
 * CLI: (none)=one tick · --dry-run=log the candidate, don't dispatch · --status
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { existsSync, readFileSync } from 'fs';
import { loadRotationConfig, buildCrsNameMaps, crsFileVaultPath } from './crs-pool-config.mjs';
import { loadJsonState, saveJsonStateAtomic, withOwnStateLock } from './crs-reconciler-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const STATUS = args.has('--status');

const C = loadRotationConfig()?.crs || {};
const ENABLED = process.env.CRS_ENABLE_MAGIC_LINK === '1' || C.enableMagicLinkRecovery === true;
const RETRY_COOLDOWN_MS = Number(
  process.env.CRS_MAGIC_LINK_RETRY_COOLDOWN_MS ?? C.magicLinkRetryCooldownMs ?? 21_600_000,
);
const ROTATE_TIMEOUT_MS = Number(process.env.CRS_MAGIC_LINK_ROTATE_TIMEOUT_MS ?? 12 * 60_000);

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

/** rotate.mjs owns this lock file for any live manual/scripted rotation — never contend with it. */
function rotatingLockBusy() {
  if (!existsSync(ROTATING_LOCK)) return false;
  try {
    const raw = readFileSync(ROTATING_LOCK, 'utf8').trim().split(/\s+/);
    const pid = parseInt(raw[1] || raw[raw.length - 1] || '0', 10) || 0;
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

/** Fallback candidate source when crs-401-refresher isn't enabled: vault expiry, generic. */
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

function spawnRotateSetup(vaultKey) {
  return new Promise((resolve) => {
    const args = [ROTATE_SCRIPT, '--setup', `--only=${vaultKey}`, '--auto', '--skip-valid'];
    log(`spawn: node ${args.join(' ')}`);
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      log(`timeout — killing rotate.mjs setup for ${vaultKey}`);
      try {
        child.kill('SIGTERM');
      } catch {}
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
        log(`[dry-run] would dispatch rotate.mjs --setup for ${candidate}`);
        return { dispatched: false, candidate };
      }

      state[candidate] = { ...(state[candidate] || {}), lastAttemptAt: now };
      saveJsonStateAtomic(STATE_PATH, state);

      const { code, out } = await spawnRotateSetup(candidate);
      const ok = code === 0 && /"ok"\s*:\s*true/i.test(out);
      state[candidate] = {
        ...(state[candidate] || {}),
        lastAttemptAt: now,
        lastCode: code,
        lastOkAt: ok ? now : state[candidate]?.lastOkAt,
      };
      saveJsonStateAtomic(STATE_PATH, state);
      log(`done ${candidate} exit=${code} ok=${ok}`);
      return { dispatched: true, candidate, ok };
    },
    log,
  );

  if (skipped) log('another tick already holds the lock — skipping (fleet-wide single-flight)');
  return result;
}

function printStatus() {
  const state = loadJsonState(STATE_PATH, log);
  const rows = Object.entries(state);
  console.log(`enabled=${ENABLED} retryCooldownMs=${RETRY_COOLDOWN_MS} stateDir=${STATE_DIR}`);
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
