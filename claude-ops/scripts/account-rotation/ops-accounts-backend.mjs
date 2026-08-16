/**
 * ops-accounts-backend.mjs — resolve the seat-state backend.
 *
 * Env / config:
 *   OPS_ACCOUNTS_BACKEND | rotation.backend
 *     local | seat-state | file  → local seat-state file
 *     cliproxy | proxy           → CLIProxyAPI seat inventory
 *     auto (default)             → try CLIProxyAPI, fall back to local
 *
 * The retired relay values (crs, relay, claude-relay) resolve to 'local' so an
 * install that still exports one keeps reading its own seat state instead of
 * failing on an unknown backend.
 *
 * Dual-write into seat-state.json is on by default unless
 * OPS_ACCOUNTS_DUAL_WRITE=0.
 */
export function resolveAccountsBackend({ env = process.env, cfgBackend } = {}) {
  const raw = String(env.OPS_ACCOUNTS_BACKEND || cfgBackend || 'auto')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (raw === 'local' || raw === 'seat-state' || raw === 'file' || raw === 'seatstate') {
    return 'local';
  }
  if (raw === 'cliproxy' || raw === 'cliproxyapi' || raw === 'proxy') {
    return 'cliproxy';
  }
  if (raw === 'crs' || raw === 'relay' || raw === 'claude-relay') {
    return 'local';
  }
  return 'auto';
}

export function dualWriteEnabled({ env = process.env } = {}) {
  return env.OPS_ACCOUNTS_DUAL_WRITE !== '0';
}

/**
 * Mirror backend decisions into seat-state shape.
 * @param {Array<{ email: string, schedulable: boolean, util5h?: number|null, util7d?: number|null, lastError?: string|null }>} seats
 * @param {object} opts
 */
export function mergeSeatsIntoState(state, seats, { provider = 'claude' } = {}) {
  const next = state && typeof state === 'object' ? structuredClone(state) : { version: 1, providers: {} };
  if (!next.providers) next.providers = {};
  if (!next.providers[provider]) next.providers[provider] = { seats: {} };
  if (!next.providers[provider].seats) next.providers[provider].seats = {};
  const now = new Date().toISOString();
  for (const s of seats || []) {
    if (!s?.email) continue;
    const prev = next.providers[provider].seats[s.email] || {};
    next.providers[provider].seats[s.email] = {
      ...prev,
      schedulable: s.schedulable !== false,
      util5h: s.util5h ?? prev.util5h ?? null,
      util7d: s.util7d ?? prev.util7d ?? null,
      exhaustedUntil: s.exhaustedUntil ?? prev.exhaustedUntil ?? null,
      lastError: s.lastError ?? prev.lastError ?? null,
      updatedAt: now,
    };
  }
  next.version = next.version || 1;
  next.updatedAt = now;
  return next;
}
