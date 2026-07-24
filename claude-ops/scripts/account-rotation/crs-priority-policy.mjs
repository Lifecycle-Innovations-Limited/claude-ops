export function liveUsageWorst(usage) {
  const values = [usage?.u5, usage?.u7, usage?.u7s, usage?.u7o].filter((value) => typeof value === 'number');
  return values.length ? Math.max(...values) : null;
}

export function liveUsageProvesRateLimitRecovery(account, viableCap) {
  if (!account.rateLimitStatus?.isRateLimited || !account._liveUsage) return false;
  const reason = account.rateLimitStatus.reason || account.rateLimitReason;
  const source = account.rateLimitStatus.source || account.rateLimitSource;
  const recoverableReasons = new Set(['anthropic_retry_after', 'anthropic_reset_header']);
  const worst = liveUsageWorst(account._liveUsage);
  return source === 'anthropic_api' && recoverableReasons.has(reason) && worst !== null && worst < viableCap;
}
