const MAX_RETRY_AFTER_MS = 15 * 60_000;
const MIN_RETRY_AFTER_MS = 2_000;

export function retryAfterDelayMs(value, nowMs = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  let delayMs;
  if (/^\d+$/.test(raw)) delayMs = Number(raw) * 1000;
  else {
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return 60_000;
    delayMs = retryAt - nowMs;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, delayMs + 2_000));
}
