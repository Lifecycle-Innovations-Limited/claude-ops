/**
 * monthly-credit-reclaim.mjs — summary math tests (HEA-4049).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/monthly-credit-reclaim.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPriorMonthSummary,
  summarizePostClaim,
  formatSlackBody,
  ymKey,
  priorMonthKey,
} from '../monthly-credit-reclaim.mjs';
import { SCHEMA_VERSION, MAX_PLAN_MONTHLY_USD } from '../ledger.mjs';

function makeLedger(month, accounts) {
  return { schema_version: SCHEMA_VERSION, month, accounts };
}

test('buildPriorMonthSummary: all claimed + half consumed → 0% waste', () => {
  const cfg = [{ email: 'a@x' }, { email: 'b@x' }];
  const ledger = makeLedger('2026-05', [
    { email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 100 },
    { email: 'b@x', cycle: '2026-05', claimed: true, remaining_usd: 100 },
  ]);
  const s = buildPriorMonthSummary(ledger, cfg);
  assert.equal(s.poolUsd, 400);
  assert.equal(s.claimedUsd, 400);
  assert.equal(s.unclaimedPoolUsd, 0);
  assert.equal(s.wastePct, 0);
  assert.equal(s.consumedUsd, 200);
  assert.equal(s.unclaimedCount, 0);
});

test('buildPriorMonthSummary: one unclaimed → 50% waste', () => {
  const cfg = [{ email: 'a@x' }, { email: 'b@x' }];
  const ledger = makeLedger('2026-05', [
    { email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 50 },
    { email: 'b@x', cycle: '2026-05', claimed: false, remaining_usd: null },
  ]);
  const s = buildPriorMonthSummary(ledger, cfg);
  assert.equal(s.poolUsd, 400);
  assert.equal(s.claimedUsd, 200);
  assert.equal(s.unclaimedPoolUsd, 200);
  assert.equal(s.wastePct, 50);
  assert.equal(s.consumedUsd, 150);
  assert.equal(s.unclaimedCount, 1);
});

test('buildPriorMonthSummary: 7-account $1400 pool — all unclaimed → 100% waste', () => {
  const cfg = Array.from({ length: 7 }, (_, i) => ({ email: `acc${i}@x` }));
  const ledger = makeLedger('2026-05', []);
  const s = buildPriorMonthSummary(ledger, cfg);
  assert.equal(s.poolUsd, 7 * MAX_PLAN_MONTHLY_USD);
  assert.equal(s.poolUsd, 1400);
  assert.equal(s.claimedUsd, 0);
  assert.equal(s.unclaimedPoolUsd, 1400);
  assert.equal(s.wastePct, 100);
  assert.equal(s.unclaimedCount, 7);
});

test('buildPriorMonthSummary: 7-account fully optimized → 0% waste', () => {
  const cfg = Array.from({ length: 7 }, (_, i) => ({ email: `acc${i}@x` }));
  const ledger = makeLedger(
    '2026-05',
    cfg.map(({ email }) => ({ email, cycle: '2026-05', claimed: true, remaining_usd: 0 })),
  );
  const s = buildPriorMonthSummary(ledger, cfg);
  assert.equal(s.claimedUsd, 1400);
  assert.equal(s.consumedUsd, 1400);
  assert.equal(s.wastePct, 0);
});

test('buildPriorMonthSummary: empty pool → 0% waste, no division by zero', () => {
  const s = buildPriorMonthSummary(makeLedger('2026-05', []), []);
  assert.equal(s.poolUsd, 0);
  assert.equal(s.wastePct, 0);
});

test('summarizePostClaim: counts only entries with current cycle', () => {
  const cfg = [{ email: 'a@x' }, { email: 'b@x' }, { email: 'c@x' }];
  const cycle = ymKey();
  const ledger = makeLedger(cycle, [
    { email: 'a@x', cycle, claimed: true, remaining_usd: 200 },
    { email: 'b@x', cycle: '2026-04', claimed: true, remaining_usd: 200 }, // stale cycle
    { email: 'c@x', cycle, claimed: false, remaining_usd: null },
  ]);
  const r = summarizePostClaim(ledger, cfg);
  assert.equal(r.claimedCount, 1);
  assert.deepEqual(r.failed.sort(), ['b@x', 'c@x']);
});

test('formatSlackBody: includes pool, waste %, prior cycle, no secrets', () => {
  const cfg = [{ email: 'a@x' }, { email: 'b@x' }];
  const ledger = makeLedger('2026-05', [
    { email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 0 },
    { email: 'b@x', cycle: '2026-05', claimed: false, remaining_usd: null },
  ]);
  const s = buildPriorMonthSummary(ledger, cfg);
  const body = formatSlackBody(s, { claimedCount: 2, failed: [] });
  assert.match(body, /Pool: \$400/);
  assert.match(body, /50% waste/);
  assert.match(body, /2026-05/);
  assert.match(body, /2\/2 accounts re-claimed/);
  // Ensure no API token / webhook leaks
  assert.doesNotMatch(body, /hooks\.slack\.com/);
});

test('formatSlackBody: reports failed accounts', () => {
  const cfg = [{ email: 'a@x' }, { email: 'b@x' }];
  const ledger = makeLedger('2026-05', []);
  const s = buildPriorMonthSummary(ledger, cfg);
  const body = formatSlackBody(s, { claimedCount: 1, failed: ['b@x'] });
  assert.match(body, /Failed: b@x/);
});

test('priorMonthKey: returns prior YYYY-MM', () => {
  assert.equal(priorMonthKey(new Date(Date.UTC(2026, 5, 15))), '2026-05'); // Jun 15 → May
  assert.equal(priorMonthKey(new Date(Date.UTC(2026, 0, 15))), '2025-12'); // Jan → Dec prev year
});
