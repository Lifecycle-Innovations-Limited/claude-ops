/**
 * Shared rotation / recovery policy — keep daemon + rotate.mjs aligned.
 */

/** Max(5h,7d) must stay strictly below this to be a pickNextAccount target (rotate.mjs). */
export function destinationUtilHardBlock(config) {
  const v = config.rateLimits?.destinationMaxUtilPercent;
  if (typeof v === 'number' && v > 0 && v <= 100) return v;
  return 95;
}

/** Daemon pre-rotate strict pass — same as findValidRotationTarget first loop. */
export const DAEMON_SAFE_5H_PCT = 95;
export const DAEMON_SAFE_7D_PCT = 95;

/** Daemon pre-rotate relaxed pass. */
export const DAEMON_RELAXED_BAR = 94;

/** True when live usage allows daemon keychain rotation to this account (strict bars). */
export function isDaemonRotationViable(live) {
  if (!live || live.ok !== true) return false;
  return live.pct5h < DAEMON_SAFE_5H_PCT && live.pct7d < DAEMON_SAFE_7D_PCT;
}

export function isLiveUtilOk(u) {
  return u != null && u.ok === true;
}

export function liveUtilMax(u) {
  if (!isLiveUtilOk(u)) return null;
  return Math.max(u.pct5h, u.pct7d);
}

/**
 * Return max(5h, 7d) from a persisted utilization snapshot.
 *
 * New snapshots store `pct`/`reset` for 5h and `pct7`/`reset7` for 7d.
 * Older daemon snapshots stored the already-combined max in `pct`, so the
 * missing weekly field remains backward compatible.
 */
export function cachedUtilizationMax(cached, now = Date.now()) {
  if (!cached || typeof cached !== 'object') return null;

  const windowValue = (pctField, resetField) => {
    const pct = Number(cached[pctField]);
    if (!Number.isFinite(pct)) return null;
    const reset = Number(cached[resetField]);
    if (Number.isFinite(reset) && reset > 0 && reset * 1000 <= now) return 0;
    return pct;
  };

  const values = [windowValue('pct', 'reset'), windowValue('pct7', 'reset7')].filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}
