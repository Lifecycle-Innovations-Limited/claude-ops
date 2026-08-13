#!/usr/bin/env node
/**
 * crs-refresh-lock.mjs — per-account single-writer OAuth refresh lock.
 *
 * crs-token-feed.mjs calls acquireRefreshLock(key) before refreshing a rotator
 * account's OAuth token, so an overlapping run (e.g. a slow tick plus a
 * cron/timer overlap) can't send two concurrent refresh_token grants for the
 * same account — the second grant would race the first and could invalidate
 * a token the first request is still using.
 *
 * Local, mkdir-based advisory lock (no native deps, same approach as
 * crs-reconciler-state.mjs's withOwnStateLock): synchronous, per-key, with a
 * TTL-based stale-lock reclaim so a crashed process can't wedge a key
 * forever. This is a single-host lock — sufficient for the default
 * single-timer cadence this ships with. A distributed lock (e.g. Redis, for
 * multiple hosts sharing one vault/pool) is a possible future extension, not
 * implemented here.
 *
 * CONFIG (env only, no config.json keys — this lock is infrastructure, not a
 * feature to toggle):
 *   CRS_REFRESH_LOCK_DIR      default: <plugin-data-dir>/account-rotation/refresh-locks
 *   CRS_REFRESH_LOCK_TTL_SEC  default: 120 — age after which a lock is considered
 *                             stale (owner crashed mid-refresh) and reclaimed.
 */

import { mkdirSync, rmdirSync, statSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_LOCK_DIR = join(
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace'),
  'account-rotation',
  'refresh-locks',
);
const LOCK_DIR = process.env.CRS_REFRESH_LOCK_DIR || DEFAULT_LOCK_DIR;
const LOCK_TTL_MS = (Number(process.env.CRS_REFRESH_LOCK_TTL_SEC) || 120) * 1000;
const PRODUCTION_MIN_PACE_MS = 1_000;
const MIN_PACE_MS = Math.max(
  process.env.CRS_REFRESH_TEST_ALLOW_ZERO_PACE === '1' ? 0 : PRODUCTION_MIN_PACE_MS,
  Number(process.env.CRS_REFRESH_MIN_PACE_MS) || PRODUCTION_MIN_PACE_MS,
);
const MAX_JITTER_MS = Math.max(0, Math.min(5_000, Number(process.env.CRS_REFRESH_JITTER_MS) || 500));

function lockPathFor(key) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_.@-]/g, '_');
  return join(LOCK_DIR, `${safeKey}.lock`);
}

/**
 * Try to acquire the refresh lock for `key`.
 * @returns {(() => void) | null} a release() function on success, or null if
 *   the lock is already held by a live (non-stale) refresh for this key.
 */
export function acquireRefreshLock(key) {
  const lockPath = lockPathFor(key);
  mkdirSync(LOCK_DIR, { recursive: true });

  if (tryMkdir(lockPath)) return () => release(lockPath);

  // Lock already exists — reclaim it if stale (owner crashed mid-refresh),
  // otherwise report held.
  let ageMs;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between our failed mkdir and this stat (owner just released
    // it) — try once more.
    return tryMkdir(lockPath) ? () => release(lockPath) : null;
  }
  if (ageMs < LOCK_TTL_MS) return null;

  try {
    rmdirSync(lockPath);
  } catch {
    // Someone else reclaimed it first — treat as held.
    return null;
  }
  return tryMkdir(lockPath) ? () => release(lockPath) : null;
}

function tryMkdir(lockPath) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function release(lockPath) {
  try {
    if (existsSync(lockPath)) rmdirSync(lockPath);
  } catch {
    // Already gone (e.g. reclaimed as stale by another process) — fine.
  }
}

function pacingPathFor(key) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_.@-]/g, '_');
  return join(LOCK_DIR, `${safeKey}.next.json`);
}

function readNextEligible(path) {
  try {
    return Number(JSON.parse(readFileSync(path, 'utf8')).nextEligibleAt) || 0;
  } catch {
    return 0;
  }
}

function writeNextEligible(path, nextEligibleAt) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ nextEligibleAt }));
  renameSync(tmp, path);
}

/**
 * Claim the next cross-process refresh slot for `key`.
 * @returns {number|null} milliseconds to wait before the caller may refresh,
 *   or null if another process currently owns the pacing state.
 */
export function claimRefreshPace(key, nowMs = Date.now(), random = Math.random) {
  const paceLock = `${lockPathFor(key)}.pace`;
  mkdirSync(LOCK_DIR, { recursive: true });
  if (!tryMkdir(paceLock)) return null;
  try {
    const path = pacingPathFor(key);
    const eligible = readNextEligible(path);
    const startAt = Math.max(nowMs, eligible);
    const jitterMs = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (MAX_JITTER_MS + 1));
    writeNextEligible(path, startAt + MIN_PACE_MS + jitterMs);
    return Math.max(0, startAt - nowMs);
  } finally {
    release(paceLock);
  }
}
