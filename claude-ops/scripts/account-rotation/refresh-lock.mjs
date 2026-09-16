import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

const DEFAULT_LOCK_DIR = join(
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace'),
  'account-rotation',
  'refresh-locks',
);
// CLAUDE_REFRESH_* are the current names. The CRS_REFRESH_* names are read as a
// fallback so an install that still exports the old ones keeps its pacing.
const envValue = (name) => process.env[`CLAUDE_REFRESH_${name}`] ?? process.env[`CRS_REFRESH_${name}`];

const LOCK_DIR = envValue('LOCK_DIR') || DEFAULT_LOCK_DIR;
const LOCK_TTL_MS = (Number(envValue('LOCK_TTL_SEC')) || 120) * 1000;
const GUARD_TTL_MS = 10_000;
// A guard whose owner process is still alive is only reclaimed after this much
// longer window, which exists solely to resolve a recycled pid. A guard is held
// for the microseconds one filesystem action takes, so a live owner is a live
// guard and wall-clock age must not be allowed to reap it.
const GUARD_ABANDONED_MS = 60_000;
// Every code another worker can hand us by owning, moving or removing the slot
// underneath us. Losing is normal; it must never crash the process.
const LOST_GUARD_RACE_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'ENOENT', 'EINVAL', 'EBUSY']);
const PRODUCTION_MIN_PACE_MS = 1_000;
const MIN_PACE_MS = Math.max(
  envValue('TEST_ALLOW_ZERO_PACE') === '1' ? 0 : PRODUCTION_MIN_PACE_MS,
  Number(envValue('MIN_PACE_MS')) || PRODUCTION_MIN_PACE_MS,
);
const MAX_JITTER_MS = Math.max(0, Math.min(5_000, Number(envValue('JITTER_MS')) || 500));

function safeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.@-]/g, '_');
}

function lockPathFor(key) {
  return join(LOCK_DIR, `${safeKey(key)}.lock.json`);
}

function guardPathFor(key) {
  return join(LOCK_DIR, `${safeKey(key)}.guard`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepBriefly() {
  try {
    execSync('sleep 0.01', { stdio: 'ignore', timeout: 100 });
  } catch {}
}

function directoryAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Build the guard in a private staging directory and move it into place, so the
// guard never exists on disk without the owner record that proves who holds it.
// rename(2) refuses to replace a non-empty directory, which makes the move the
// atomic acquisition: exactly one worker wins and every loser gets an error
// code back instead of a half-built guard another worker can mistake for stale.
function tryCreateGuard(path, owner) {
  // rename(2) still replaces an *empty* target directory, and an empty guard is
  // how an interrupted older process leaves the slot. Decline that outright so
  // the reclaim path, which waits out the guard TTL first, is the only thing
  // allowed to clear it.
  if (existsSync(path)) return false;
  let staging;
  try {
    staging = mkdtempSync(`${path}.new.`);
    writeFileSync(join(staging, 'owner.json'), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    renameSync(staging, path);
    return true;
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (LOST_GUARD_RACE_CODES.has(error.code)) return false;
    throw error;
  }
}

// A guard is reclaimable only once nobody can still be holding it.
function guardIsAbandoned(path, observed) {
  if (observed && pidAlive(Number(observed.pid))) {
    return Date.now() - Number(observed.acquiredAt || 0) >= GUARD_ABANDONED_MS;
  }
  if (observed) return true;
  // No readable owner record. Never assume that means "free": on a legacy
  // install it can be a guard still being built. Give it the full guard TTL.
  return directoryAgeMs(path) >= GUARD_TTL_MS;
}

function reclaimStaleGuard(path) {
  const observed = readJson(join(path, 'owner.json'));
  if (!guardIsAbandoned(path, observed)) return false;
  const tombstone = `${path}.stale.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return false;
  }
  const claimed = readJson(join(tombstone, 'owner.json'));
  if (claimed?.ownerNonce !== observed?.ownerNonce) {
    // Somebody replaced the guard between the read and the move. Put what we
    // took back if the slot is still free, and drop it if it is not.
    try {
      renameSync(tombstone, path);
      return false;
    } catch {}
    rmSync(tombstone, { recursive: true, force: true });
    return false;
  }
  rmSync(tombstone, { recursive: true, force: true });
  return true;
}

// Release by moving the guard aside first, so the owner check and the removal
// cannot be split by a reclaim landing in between.
function releaseGuard(path, ownerNonce) {
  const tombstone = `${path}.done.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return;
  }
  if (readJson(join(tombstone, 'owner.json'))?.ownerNonce !== ownerNonce) {
    try {
      renameSync(tombstone, path);
      return;
    } catch {}
  }
  rmSync(tombstone, { recursive: true, force: true });
}

function withGuard(key, action) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = guardPathFor(key);
  const owner = { ownerNonce: randomBytes(16).toString('hex'), pid: process.pid, acquiredAt: Date.now() };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tryCreateGuard(path, owner)) {
      try {
        return action();
      } finally {
        releaseGuard(path, owner.ownerNonce);
      }
    }
    reclaimStaleGuard(path);
    sleepBriefly();
  }
  return null;
}

/** Acquire one account refresh lease with owner-checked renewal and release. */
export function acquireRefreshLock(key) {
  const lockPath = lockPathFor(key);
  const ownerNonce = randomBytes(16).toString('hex');
  const acquiredAt = Date.now();
  const acquired = withGuard(key, () => {
    const current = readJson(lockPath);
    const renewedAt = Number(current?.renewedAt || current?.acquiredAt || 0);
    if (current && pidAlive(Number(current.pid)) && Date.now() - renewedAt < LOCK_TTL_MS) return false;
    writeJsonAtomic(lockPath, { ownerNonce, pid: process.pid, acquiredAt, renewedAt: acquiredAt });
    return true;
  });
  if (!acquired) return null;

  let active = true;
  const renew = () => {
    if (!active) return false;
    return Boolean(
      withGuard(key, () => {
        const current = readJson(lockPath);
        if (current?.ownerNonce !== ownerNonce || current.pid !== process.pid) return false;
        writeJsonAtomic(lockPath, { ...current, renewedAt: Date.now() });
        return true;
      }),
    );
  };
  const heartbeat = setInterval(renew, Math.max(100, Math.floor(LOCK_TTL_MS / 3)));
  heartbeat.unref?.();

  const release = () => {
    if (!active) return false;
    active = false;
    clearInterval(heartbeat);
    return Boolean(
      withGuard(key, () => {
        const current = readJson(lockPath);
        if (current?.ownerNonce !== ownerNonce || current.pid !== process.pid) return false;
        rmSync(lockPath, { force: true });
        return true;
      }),
    );
  };
  release.renew = renew;
  release.ownerNonce = ownerNonce;
  return release;
}

function pacingPathFor(key) {
  return join(LOCK_DIR, `${safeKey(key)}.next.json`);
}

function readNextEligible(path) {
  return Number(readJson(path)?.nextEligibleAt) || 0;
}

export function claimRefreshPace(key, nowMs = Date.now(), random = Math.random) {
  return withGuard(`${key}.pace`, () => {
    const path = pacingPathFor(key);
    const eligible = readNextEligible(path);
    const startAt = Math.max(nowMs, eligible);
    const jitterMs = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (MAX_JITTER_MS + 1));
    writeJsonAtomic(path, { nextEligibleAt: startAt + MIN_PACE_MS + jitterMs });
    return Math.max(0, startAt - nowMs);
  });
}
