/**
 * Pure CLIProxy seat rotate / re-entry / heal policy.
 *
 * Hard rules (cannot be overridden by the AI advisor):
 *   1. Remaining, reset, or newly observed quota → in rotation immediately.
 *      No high-water / low-water hysteresis.
 *   2. Out of rotation only when quota is known-certain exhausted AND a
 *      parseable reschedule datetime is recorded. At that stamp, re-enter.
 *   3. Uncertain exhaust (no proven "quota exhausted", or no stamp) → keep
 *      serving / heal back in.
 *   4. A paid seat with leftover quota stays serving.
 */
export const ACTIONS = {
  ENTER: 'enter_rotation',
  LEAVE: 'leave_rotation',
  KEEP_IN: 'keep_in_rotation',
  KEEP_OUT: 'keep_out_until_reschedule',
  HEAL: 'heal_into_rotation',
};

const CERTAIN_EXHAUST_RE =
  /quota\s*exhausted|credential_quota|usage_limit_reached|usage limit has been reached|quota_exceeded|\bquota exceeded\b/i;

export function parseTimestamp(value, now = Date.now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const raw = String(value).trim();
  if (!raw || raw.startsWith('0001-01-01')) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const parsed = Date.parse(raw.replace('Z', '+00:00'));
  if (!Number.isFinite(parsed)) return null;
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2020 || year > 2100) return null;
  return parsed;
}

export function detectCertainExhaust({
  certainQuotaExhausted,
  lastExhaustReason,
  lastExhaustBody,
  quotaExceeded,
  quotaReason,
} = {}) {
  if (certainQuotaExhausted === true) return true;
  if (certainQuotaExhausted === false) return false;
  const blob = [lastExhaustReason, lastExhaustBody, quotaReason].filter(Boolean).join(' ');
  if (CERTAIN_EXHAUST_RE.test(blob)) return true;
  // CLIProxy writes quota.exceeded=true on a credential/usage window. That is
  // the certain-exhaust signal; the stamp is checked separately.
  if (quotaExceeded === true) return true;
  return false;
}

export function hasRemainingOrResetQuota(seat = {}) {
  if (seat.newQuotaObserved === true) return true;
  if (seat.quotaReset === true) return true;
  const rem = Number(seat.remainingQuota);
  if (Number.isFinite(rem) && rem > 0) return true;
  // Exceeded flipped off (or remaining appeared) while a cooldown sidecar still
  // exists — leftover/reset quota, re-enter immediately. Stream-error cooling
  // with quotaExceeded null/undefined is not leftover quota.
  if (seat.quotaExceeded === false && seat.hadQuotaSignal === true) return true;
  return false;
}

function pickAction(inRotation, currentlyIn, heal) {
  if (inRotation) {
    if (currentlyIn) return ACTIONS.KEEP_IN;
    return heal ? ACTIONS.HEAL : ACTIONS.ENTER;
  }
  return currentlyIn ? ACTIONS.LEAVE : ACTIONS.KEEP_OUT;
}

/**
 * Decide whether a seat belongs in rotation. Pure. now is epoch ms.
 */
export function decideSeat(seat, now = Date.now()) {
  const currentlyIn = seat.inRotation === true;
  if (hasRemainingOrResetQuota(seat)) {
    return {
      inRotation: true,
      action: pickAction(true, currentlyIn, false),
      reason: 'remaining_or_reset_quota',
      rescheduleAt: null,
    };
  }

  const certain = detectCertainExhaust(seat);
  const until = parseTimestamp(seat.rescheduleAt, now);

  if (certain && until != null && until > now) {
    return {
      inRotation: false,
      action: pickAction(false, currentlyIn, false),
      reason: 'certain_exhaust_until_reschedule',
      rescheduleAt: new Date(until).toISOString(),
    };
  }

  if (certain && until != null && until <= now) {
    return {
      inRotation: true,
      action: pickAction(true, currentlyIn, false),
      reason: 'reschedule_elapsed',
      rescheduleAt: new Date(until).toISOString(),
    };
  }

  return {
    inRotation: true,
    action: pickAction(true, currentlyIn, !currentlyIn),
    reason: 'uncertain_exhaust_keep_serving',
    rescheduleAt: until != null ? new Date(until).toISOString() : null,
  };
}

function adviceWantsIn(advice) {
  if (!advice || typeof advice !== 'object') return null;
  if (typeof advice.inRotation === 'boolean') return advice.inRotation;
  const action = String(advice.action || '');
  if (action === ACTIONS.LEAVE || action === ACTIONS.KEEP_OUT || action === 'leave' || action === 'out') {
    return false;
  }
  if (
    action === ACTIONS.ENTER ||
    action === ACTIONS.KEEP_IN ||
    action === ACTIONS.HEAL ||
    action === 'enter' ||
    action === 'heal' ||
    action === 'in'
  ) {
    return true;
  }
  return null;
}

/**
 * Overlay advisor output on a hard decision. Advisor cannot flip inRotation.
 */
export function applyAdviceIfLegal(hard, advice) {
  const wantsIn = adviceWantsIn(advice);
  if (wantsIn == null) {
    return { ...hard, ai: { invoked: true, applied: false, reason: 'unparseable' } };
  }
  if (Boolean(wantsIn) !== Boolean(hard.inRotation)) {
    return {
      ...hard,
      ai: { invoked: true, applied: false, reason: 'violates_hard_rules', advice },
    };
  }
  const next = { ...hard, ai: { invoked: true, applied: true, advice } };
  if (advice.action && Object.values(ACTIONS).includes(advice.action)) {
    next.action = advice.action;
  }
  if (advice.reason) next.aiReason = String(advice.reason).slice(0, 240);
  return next;
}

export async function adviseSeat(seat, hard, ask) {
  if (typeof ask !== 'function') {
    return { ...hard, ai: { invoked: false, applied: false, reason: 'no_ask' } };
  }
  try {
    const advice = await ask({
      id: seat.id,
      provider: seat.provider,
      disabled: seat.disabled === true,
      cooling: seat.cooling === true,
      remainingQuota: seat.remainingQuota ?? null,
      quotaExceeded: seat.quotaExceeded ?? null,
      certainQuotaExhausted: detectCertainExhaust(seat),
      rescheduleAt: seat.rescheduleAt ?? null,
      lastExhaustReason: seat.lastExhaustReason ?? null,
      tokenStale: seat.tokenStale === true,
      paidSeat: seat.paidSeat !== false,
      hard,
    });
    return applyAdviceIfLegal(hard, advice);
  } catch (err) {
    return {
      ...hard,
      ai: { invoked: true, applied: false, reason: `ask_failed:${String(err?.message || err).slice(0, 80)}` },
    };
  }
}

/**
 * Decision entry for a pool snapshot. Always invokes `ask` per seat when given.
 */
export async function healPool(seats, { now = Date.now(), ask } = {}) {
  const list = Array.isArray(seats) ? seats : [];
  const decisions = await Promise.all(
    list.map(async (seat) => {
      const hard = decideSeat(seat, now);
      const advised = await adviseSeat(seat, hard, ask);
      return {
        id: seat.id,
        provider: seat.provider || null,
        tokenStale: seat.tokenStale === true,
        disabled: seat.disabled === true,
        cooling: seat.cooling === true,
        authFile: seat.authFile || null,
        cdsFile: seat.cdsFile || null,
        ...advised,
      };
    }),
  );
  return { now, decisions };
}
