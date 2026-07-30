/**
 * Shared OAuth token freshness policy — single source of truth for "when is
 * a Claude account token stale enough to need a proactive refresh" across
 * refresh-tokens.mjs, crs-token-feed.mjs, and any other refresh call site.
 */

/** Proactively refresh once remaining TTL drops below this. */
export const REFRESH_WHEN_BELOW_MS = 6 * 3_600_000; // 6h

/** Below this remaining TTL a token is no longer "healthy" even if unexpired. */
export const MIN_HEALTHY_TTL_MS = 1 * 3_600_000; // 1h

function parseExpiresAt(tokenJson) {
  try {
    const parsed = JSON.parse(tokenJson);
    const raw = parsed?.claudeAiOauth?.expiresAt;
    const numeric = Number(raw);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  } catch {
    return null;
  }
}

/** Ms remaining until expiry; null if the token is missing/unparseable/has no expiry. */
export function remainingMs(tokenJson, now = Date.now()) {
  const expiresAt = parseExpiresAt(tokenJson);
  return expiresAt === null ? null : expiresAt - now;
}

/** True when this token should be proactively refreshed now. */
export function needsProactiveRefresh(tokenJson, now = Date.now(), force = false) {
  if (force) return true;
  const rem = remainingMs(tokenJson, now);
  if (rem === null) return true;
  return rem < REFRESH_WHEN_BELOW_MS;
}

/** One of FRESH | REFRESH_SOON | EXPIRING | EXPIRED. */
export function freshnessLabel(tokenJson, now = Date.now()) {
  const rem = remainingMs(tokenJson, now);
  if (rem === null || rem <= 0) return 'EXPIRED';
  if (rem < MIN_HEALTHY_TTL_MS) return 'EXPIRING';
  if (rem < REFRESH_WHEN_BELOW_MS) return 'REFRESH_SOON';
  return 'FRESH';
}
