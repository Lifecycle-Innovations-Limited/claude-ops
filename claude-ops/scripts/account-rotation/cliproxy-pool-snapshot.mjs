/**
 * Build a redacted CLIProxy pool snapshot from an auth-dir (json + .cds).
 * No emails, tokens, or auth filenames leak into the census view.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { detectCertainExhaust, parseTimestamp } from './cliproxy-heal-policy.mjs';

/**
 * Stable, non-reversible seat identifier. `stem(name)` below can produce a
 * raw account email straight from the auth/.cds filename; that raw value
 * must never reach persisted state, AI facts, or --json output. Only the
 * internal `rawId` field (used for auth-file mutation and reauth targeting)
 * keeps the original value.
 */
export function opaqueSeatId(rawId) {
  return createHash('sha256').update(String(rawId)).digest('hex').slice(0, 16);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function flattenError(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const nested = value.message || value.error || value.reason || '';
    if (typeof nested === 'string') {
      try {
        const parsed = JSON.parse(nested);
        return flattenError(parsed) || nested;
      } catch {
        return nested;
      }
    }
    if (typeof nested === 'object') return flattenError(nested);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function extractResetsAt(blob) {
  if (!blob) return null;
  const m = String(blob).match(/"resets_at"\s*:\s*(\d+)/);
  if (m) return parseTimestamp(Number(m[1]));
  const iso = String(blob).match(/"resets_at"\s*:\s*"([^"]+)"/);
  if (iso) return parseTimestamp(iso[1]);
  return null;
}

function validRecover(ts) {
  return parseTimestamp(ts);
}

function recordSignals(record, now) {
  const quota = record?.quota && typeof record.quota === 'object' ? record.quota : {};
  const lastError = flattenError(record?.last_error || record?.reason || record?.status);
  const quotaReason = quota.reason || record?.reason || '';
  const remaining = quota.remaining ?? quota.remaining_percent ?? quota.remainingPercent ?? quota.left ?? null;
  const reschedule =
    validRecover(quota.next_recover_at) ||
    validRecover(record?.next_retry_after) ||
    extractResetsAt(lastError) ||
    extractResetsAt(JSON.stringify(quota));
  const retry = validRecover(record?.next_retry_after);
  const recover = validRecover(quota.next_recover_at);
  // cooling must agree with rescheduleAt above: a seat with only
  // quota.next_recover_at in the future (no next_retry_after) was reporting
  // itself as still cooling and must not be treated as currently servable.
  const cooling = (retry != null && retry > now) || (recover != null && recover > now);
  const exceeded = quota.exceeded === true;
  const certain = detectCertainExhaust({
    lastExhaustReason: quotaReason,
    lastExhaustBody: lastError,
    quotaExceeded: exceeded,
    quotaReason,
  });
  return {
    remainingQuota: remaining == null ? null : Number(remaining),
    quotaExceeded: typeof quota.exceeded === 'boolean' ? quota.exceeded : null,
    quotaReason: quotaReason || null,
    lastExhaustReason: quotaReason || record?.reason || null,
    lastExhaustBody: lastError || null,
    rescheduleAt: reschedule != null ? new Date(reschedule).toISOString() : null,
    cooling,
    certainQuotaExhausted: certain,
    hadQuotaSignal: exceeded || certain || remaining != null,
  };
}

function mergeRecords(records, now) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];
  if (!list.length) {
    return {
      remainingQuota: null,
      quotaExceeded: null,
      quotaReason: null,
      lastExhaustReason: null,
      lastExhaustBody: null,
      rescheduleAt: null,
      cooling: false,
      certainQuotaExhausted: false,
      hadQuotaSignal: false,
    };
  }
  const signals = list.map((r) => recordSignals(r, now));
  const cooling = signals.some((s) => s.cooling);
  const certain = signals.some((s) => s.certainQuotaExhausted);
  const remaining = signals.map((s) => s.remainingQuota).find((n) => Number.isFinite(n) && n > 0);
  const anyRemaining = signals.map((s) => s.remainingQuota).find((n) => Number.isFinite(n));
  const exceeded = signals.some((s) => s.quotaExceeded === true)
    ? true
    : signals.every((s) => s.quotaExceeded === false)
      ? false
      : (signals.find((s) => typeof s.quotaExceeded === 'boolean')?.quotaExceeded ?? null);
  const withStamp = signals.find((s) => s.rescheduleAt);
  const withBody = signals.find((s) => s.lastExhaustBody);
  return {
    remainingQuota: remaining ?? anyRemaining ?? null,
    quotaExceeded: exceeded,
    quotaReason: withBody?.quotaReason || signals[0].quotaReason,
    lastExhaustReason: withBody?.lastExhaustReason || signals[0].lastExhaustReason,
    lastExhaustBody: withBody?.lastExhaustBody || signals[0].lastExhaustBody,
    rescheduleAt: withStamp?.rescheduleAt || null,
    cooling,
    certainQuotaExhausted: certain,
    hadQuotaSignal: signals.some((s) => s.hadQuotaSignal),
  };
}

function tokenLooksStale(auth, body) {
  const blob = [auth?.disabled_reason, auth?.reconcile_reason, body].filter(Boolean).join(' ');
  return /expired credentials|no auth context|PermissionDenied|invalid_grant/i.test(blob);
}

function providerOf(auth, cds, fileName) {
  const raw = auth?.type || auth?.provider || cds?.provider || cds?.type || fileName.split('-')[0] || 'unknown';
  return String(raw).toLowerCase();
}

function stem(name) {
  return name.replace(/\.(json|cds)$/i, '');
}

/**
 * Compare with the previous tick to mark newly observed quota.
 */
export function markNewQuota(seat, previous) {
  if (!previous) {
    return { ...seat, newQuotaObserved: false, quotaReset: seat.quotaExceeded === false && seat.hadQuotaSignal };
  }
  const remNow = Number(seat.remainingQuota);
  const remPrev = Number(previous.remainingQuota);
  const remainingGrew = Number.isFinite(remNow) && Number.isFinite(remPrev) && remNow > remPrev;
  const remainingAppeared = Number.isFinite(remNow) && remNow > 0 && !(Number.isFinite(remPrev) && remPrev > 0);
  const exceededCleared = previous.quotaExceeded === true && seat.quotaExceeded === false;
  return {
    ...seat,
    newQuotaObserved: remainingGrew || remainingAppeared || exceededCleared,
    quotaReset: exceededCleared || remainingAppeared,
  };
}

function indexKeys(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return [];
  const keys = new Set([raw, raw.replace(/@/g, '_')]);
  return [...keys];
}

function addIndex(map, key, path) {
  for (const k of indexKeys(key)) {
    if (!map.has(k)) map.set(k, path);
  }
}

function buildCdsIndex(authDir, files) {
  const byKey = new Map();
  const all = [];
  for (const name of files) {
    if (!name.endsWith('.cds')) continue;
    const path = join(authDir, name);
    const cds = readJson(path);
    all.push({ path, name, cds });
    addIndex(byKey, name.replace(/\.cds$/i, ''), path);
    if (cds && typeof cds === 'object') {
      addIndex(byKey, cds.auth_id, path);
      addIndex(byKey, cds.email, path);
      for (const rec of cds.records || []) {
        if (rec && typeof rec === 'object') {
          addIndex(byKey, rec.auth_id, path);
          addIndex(byKey, rec.email, path);
        }
      }
    }
  }
  return { byKey, all };
}

function lookupCds(byKey, auth, jsonName) {
  const email = auth?.email || '';
  const id = stem(jsonName);
  for (const candidate of [id, jsonName, email, id.replace(/@/g, '_')]) {
    for (const k of indexKeys(candidate)) {
      if (byKey.has(k)) return byKey.get(k);
    }
  }
  return null;
}

function seatFromParts({ id, provider, auth, authFile, cds, cdsFile, now, previous }) {
  const merged = mergeRecords(cds?.records, now);
  const disabled = auth?.disabled === true;
  const inRotation = !disabled && !merged.cooling;
  const opaque = opaqueSeatId(id);
  return markNewQuota(
    {
      id: opaque,
      rawId: id,
      provider,
      disabled,
      cooling: merged.cooling,
      inRotation,
      remainingQuota: Number.isFinite(merged.remainingQuota) ? merged.remainingQuota : null,
      quotaExceeded: merged.quotaExceeded,
      quotaReason: merged.quotaReason,
      lastExhaustReason: merged.lastExhaustReason,
      lastExhaustBody: merged.lastExhaustBody,
      rescheduleAt: merged.rescheduleAt,
      certainQuotaExhausted: merged.certainQuotaExhausted,
      hadQuotaSignal: merged.hadQuotaSignal,
      tokenStale: tokenLooksStale(auth || {}, merged.lastExhaustBody),
      paidSeat: auth?.paidSeat !== false,
      authFile: authFile || null,
      cdsFile: cdsFile || null,
    },
    previous[opaque],
  );
}

export function snapshotFromAuthDir(authDir, { now = Date.now(), previous = {} } = {}) {
  if (!authDir || !existsSync(authDir)) return { seats: [], census: emptyCensus(now) };
  const files = readdirSync(authDir);
  const jsonFiles = files.filter((n) => n.endsWith('.json') && !n.includes('.bak') && !n.endsWith('.tmp'));
  const cdsIndex = buildCdsIndex(authDir, files);
  const usedCds = new Set();
  const seats = [];

  for (const name of jsonFiles) {
    const authFile = join(authDir, name);
    const auth = readJson(authFile);
    if (!auth || typeof auth !== 'object') continue;
    const id = stem(name);
    const cdsFile = lookupCds(cdsIndex.byKey, auth, name);
    const cds = cdsFile ? readJson(cdsFile) : null;
    if (cdsFile) usedCds.add(cdsFile);
    seats.push(
      seatFromParts({
        id,
        provider: providerOf(auth, cds, name),
        auth,
        authFile,
        cds,
        cdsFile,
        now,
        previous,
      }),
    );
  }

  for (const entry of cdsIndex.all) {
    if (usedCds.has(entry.path)) continue;
    const cds = entry.cds && typeof entry.cds === 'object' ? entry.cds : {};
    const id = stem(entry.name);
    seats.push(
      seatFromParts({
        id,
        provider: providerOf(null, cds, entry.name),
        auth: { disabled: false },
        authFile: null,
        cds,
        cdsFile: entry.path,
        now,
        previous,
      }),
    );
  }

  return { seats, census: censusFromSeats(seats, now) };
}

function emptyCensus(now) {
  return {
    generatedAt: new Date(now).toISOString(),
    providers: {},
    totals: { seats: 0, enabled: 0, disabled: 0, cooling: 0, remainingQuota: 0, certainExhaust: 0 },
  };
}

export function censusFromSeats(seats, now = Date.now()) {
  const providers = {};
  const totals = { seats: 0, enabled: 0, disabled: 0, cooling: 0, remainingQuota: 0, certainExhaust: 0 };
  for (const seat of seats) {
    const p = seat.provider || 'unknown';
    if (!providers[p]) {
      providers[p] = {
        seats: 0,
        enabled: 0,
        disabled: 0,
        cooling: 0,
        remainingQuota: 0,
        certainExhaust: 0,
        nextRescheduleAt: null,
      };
    }
    const row = providers[p];
    row.seats += 1;
    totals.seats += 1;
    if (seat.disabled) {
      row.disabled += 1;
      totals.disabled += 1;
    } else {
      row.enabled += 1;
      totals.enabled += 1;
    }
    if (seat.cooling) {
      row.cooling += 1;
      totals.cooling += 1;
    }
    if (Number.isFinite(Number(seat.remainingQuota)) && Number(seat.remainingQuota) > 0) {
      row.remainingQuota += 1;
      totals.remainingQuota += 1;
    }
    if (seat.certainQuotaExhausted) {
      row.certainExhaust += 1;
      totals.certainExhaust += 1;
    }
    if (seat.rescheduleAt && (!row.nextRescheduleAt || seat.rescheduleAt < row.nextRescheduleAt)) {
      row.nextRescheduleAt = seat.rescheduleAt;
    }
  }
  return { generatedAt: new Date(now).toISOString(), providers, totals };
}

export function redactSeat(seat) {
  return {
    id: seat.id,
    provider: seat.provider,
    disabled: seat.disabled === true,
    cooling: seat.cooling === true,
    inRotation: seat.inRotation === true,
    remainingQuota: seat.remainingQuota ?? null,
    quotaExceeded: seat.quotaExceeded ?? null,
    certainQuotaExhausted: seat.certainQuotaExhausted === true,
    rescheduleAt: seat.rescheduleAt ?? null,
    tokenStale: seat.tokenStale === true,
    newQuotaObserved: seat.newQuotaObserved === true,
  };
}
