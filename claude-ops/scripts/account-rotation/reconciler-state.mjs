#!/usr/bin/env node
/**
 * reconciler-state.mjs — shared own-state-file helper for rotation reconcilers.
 *
 * Each reconciler that watches the account pool (cooldown tracking, token-refresh
 * tracking, priority scoring, ...) MUST persist to its OWN
 * state file — never a file shared with another reconciler. Sharing one file was the
 * root cause of a documented production incident: reconciler A's non-atomic write
 * clobbered reconciler B's cooldown data mid-tick, silently erasing real rate-limit
 * holds and triggering a pool-wide re-enable/429 oscillation.
 *
 * This module gives every reconciler two small, dependency-free guarantees:
 *   1. Atomic write — write to a temp file in the same directory, then rename() over
 *      the real path. rename() is atomic on the same filesystem, so a reader (or a
 *      concurrent tick) never observes a half-written / truncated JSON file.
 *   2. Single-flight lock — a short-lived advisory lock (mkdir-based; no native deps,
 *      works the same on Linux and macOS) around the read-modify-write section, so two
 *      overlapping ticks of the SAME reconciler (a slow tick plus a cron/timer overlap)
 *      can't interleave writes. This is a lightweight stand-in for flock(1), not a
 *      distributed lock — sufficient for a single-host cron/timer cadence. A stale lock
 *      (older than LOCK_STALE_MS, e.g. left behind by a crashed process) is reclaimed
 *      rather than wedging the reconciler forever.
 *
 * Nothing here talks to a provider or knows about account schedules — it is pure state I/O so
 * every reconciler can `import` the same tiny, well-tested primitive instead of each
 * re-implementing tmp+rename by hand.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmdirSync, statSync } from 'fs';
import { dirname } from 'path';

const LOCK_STALE_MS = 30_000;

export function loadJsonState(path, log = console.error) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log(`[reconciler-state] WARN corrupt state at ${path}, resetting: ${e.message}`);
    return {};
  }
}

/** Atomic write: tmp file in the same directory + rename(). */
export function saveJsonStateAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * Run `fn` (sync or async) holding a single-flight advisory lock scoped to `path`.
 * If the lock is already held by a live tick, this returns { skipped: true } instead
 * of blocking — the caller should log and exit 0 (cron will just try again next tick).
 *
 * @returns {Promise<{ skipped: boolean, result?: any }>}
 */
export async function withOwnStateLock(path, fn, log = console.error) {
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const acquired = tryAcquireLock(lockDir, log);
  if (!acquired) return { skipped: true };
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {}
  }
}

function tryAcquireLock(lockDir, log) {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // Lock dir already exists — check whether it's stale (owner crashed mid-tick).
  let ageMs;
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    // Lock dir vanished between the mkdir failure and this stat (owner just
    // released it) — try once more to acquire it fresh.
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  if (ageMs < LOCK_STALE_MS) {
    log(`[reconciler-state] lock held (age ${Math.round(ageMs / 1000)}s) at ${lockDir} — skipping this tick`);
    return false;
  }
  try {
    rmdirSync(lockDir);
    mkdirSync(lockDir);
    log(`[reconciler-state] reclaimed stale lock (age ${Math.round(ageMs / 1000)}s) at ${lockDir}`);
    return true;
  } catch {
    return false;
  }
}
