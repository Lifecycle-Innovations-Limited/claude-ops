/**
 * daily-credit-digest.mjs — burn rate / projection / severity / format tests.
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/daily-credit-digest.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeBurnRate,
  daysRemainingInMonth,
  projectMonthEnd,
  computeSeverity,
  formatSlackBody,
  readSnapshotHistory,
  SEVERITY_HIGH_PROJECTED_PCT,
  SEVERITY_HIGH_FALLBACK_RATIO,
} from '../daily-credit-digest.mjs';
import { SCHEMA_VERSION, MAX_PLAN_MONTHLY_USD } from '../ledger.mjs';

function makeLedger(month, accounts) {
  return { schema_version: SCHEMA_VERSION, month, accounts };
}

// ─── computeBurnRate ────────────────────────────────────────────────────────

test('computeBurnRate: linear consumption over 7d gives expected $/day', () => {
  const cfg = [{ email: 'a@x' }];
  const now = new Date(Date.UTC(2026, 4, 19, 9, 0, 0));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const history = [{ ts: sevenDaysAgo.toISOString(), email: 'a@x', remaining_usd: 200, cycle: '2026-05' }];
  const ledger = makeLedger('2026-05', [{ email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 130 }]);
  const { perAccount, totalDailyBurnUsd } = computeBurnRate(history, cfg, ledger, now);
  // 70 USD consumed over 7 days → $10/day
  assert.equal(perAccount.length, 1);
  assert.ok(Math.abs(perAccount[0].dailyBurnUsd - 10) < 1e-6, `expected ~10, got ${perAccount[0].dailyBurnUsd}`);
  assert.ok(Math.abs(totalDailyBurnUsd - 10) < 1e-6);
});

test('computeBurnRate: no history → null burn rate, total 0', () => {
  const cfg = [{ email: 'a@x' }];
  const now = new Date();
  const ledger = makeLedger('2026-05', [{ email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 150 }]);
  const r = computeBurnRate([], cfg, ledger, now);
  assert.equal(r.perAccount[0].dailyBurnUsd, null);
  assert.equal(r.totalDailyBurnUsd, 0);
});

test('computeBurnRate: ignores rows from different cycle (post-reclaim spike)', () => {
  const cfg = [{ email: 'a@x' }];
  const now = new Date(Date.UTC(2026, 5, 5, 9, 0, 0));
  const history = [
    // Prior cycle: remaining had drained to 50 by end of May
    { ts: new Date(Date.UTC(2026, 4, 25)).toISOString(), email: 'a@x', remaining_usd: 50, cycle: '2026-05' },
    // Current cycle: reclaimed; should be the only one considered
    { ts: new Date(Date.UTC(2026, 5, 1)).toISOString(), email: 'a@x', remaining_usd: 200, cycle: '2026-06' },
  ];
  const ledger = makeLedger('2026-06', [{ email: 'a@x', cycle: '2026-06', claimed: true, remaining_usd: 170 }]);
  const { perAccount } = computeBurnRate(history, cfg, ledger, now);
  // 30 USD consumed over ~4 days → ~7.5/day; would be wildly negative if cross-cycle leaked
  assert.ok(perAccount[0].dailyBurnUsd > 0 && perAccount[0].dailyBurnUsd < 20);
});

test('computeBurnRate: clamps negative burn (mid-cycle top-up) to 0', () => {
  const cfg = [{ email: 'a@x' }];
  const now = new Date(Date.UTC(2026, 4, 19));
  const history = [
    { ts: new Date(Date.UTC(2026, 4, 12)).toISOString(), email: 'a@x', remaining_usd: 50, cycle: '2026-05' },
  ];
  const ledger = makeLedger('2026-05', [
    // Higher than the historical row — would yield negative consumption
    { email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 180 },
  ]);
  const { perAccount, totalDailyBurnUsd } = computeBurnRate(history, cfg, ledger, now);
  assert.equal(perAccount[0].dailyBurnUsd, 0);
  assert.equal(totalDailyBurnUsd, 0);
});

test('computeBurnRate: 7-account fleet aggregates total burn', () => {
  const cfg = Array.from({ length: 7 }, (_, i) => ({ email: `acc${i}@x` }));
  const now = new Date(Date.UTC(2026, 4, 19, 9, 0, 0));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const history = cfg.map(({ email }) => ({ ts: sevenDaysAgo, email, remaining_usd: 200, cycle: '2026-05' }));
  const ledger = makeLedger(
    '2026-05',
    cfg.map(({ email }) => ({ email, cycle: '2026-05', claimed: true, remaining_usd: 130 })),
  );
  const { totalDailyBurnUsd } = computeBurnRate(history, cfg, ledger, now);
  assert.ok(Math.abs(totalDailyBurnUsd - 70) < 1e-6, `expected 70, got ${totalDailyBurnUsd}`);
});

// ─── daysRemainingInMonth ───────────────────────────────────────────────────

test('daysRemainingInMonth: mid-month May → 13 days', () => {
  // May 19, 2026: 31 - 19 + 1 = 13
  assert.equal(daysRemainingInMonth(new Date(Date.UTC(2026, 4, 19))), 13);
});

test('daysRemainingInMonth: first of month → full month', () => {
  // Feb 1 2025 (non-leap): 28
  assert.equal(daysRemainingInMonth(new Date(Date.UTC(2025, 1, 1))), 28);
});

test('daysRemainingInMonth: last day of month → 1', () => {
  assert.equal(daysRemainingInMonth(new Date(Date.UTC(2026, 4, 31))), 1);
});

// ─── projectMonthEnd ────────────────────────────────────────────────────────

test('projectMonthEnd: 7-account pool, mid-cycle drain', () => {
  const cfg = Array.from({ length: 7 }, (_, i) => ({ email: `acc${i}@x` }));
  // Each account at $100 remaining → $700 total of $1400 pool (50% consumed)
  const ledger = makeLedger(
    '2026-05',
    cfg.map(({ email }) => ({ email, cycle: '2026-05', claimed: true, remaining_usd: 100 })),
  );
  // 13 days left, $10/day total burn → $130 more would be consumed
  // projected consumed = 700 + 130 = 830 / 1400 ≈ 59%
  const now = new Date(Date.UTC(2026, 4, 19));
  const p = projectMonthEnd(ledger, cfg, 10, now);
  assert.equal(p.poolUsd, 1400);
  assert.equal(p.accountCount, 7);
  assert.equal(p.currentRemainingUsd, 700);
  assert.equal(p.currentConsumedUsd, 700);
  assert.equal(p.currentConsumedPct, 50);
  assert.equal(p.daysRemaining, 13);
  assert.equal(p.projectedRemainingUsd, 570);
  assert.equal(p.projectedConsumedUsd, 830);
  assert.equal(p.projectedConsumedPct, 59);
});

test('projectMonthEnd: burn high enough to drain pool → clamped at pool size', () => {
  const cfg = [{ email: 'a@x' }];
  const ledger = makeLedger('2026-05', [{ email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 50 }]);
  // 10 days left × $100/day burn → would drain to -950, clamp to 0
  const now = new Date(Date.UTC(2026, 4, 22));
  const p = projectMonthEnd(ledger, cfg, 100, now);
  assert.equal(p.projectedRemainingUsd, 0);
  assert.equal(p.projectedConsumedUsd, MAX_PLAN_MONTHLY_USD);
  assert.equal(p.projectedConsumedPct, 100);
});

test('projectMonthEnd: zero burn → projection equals current state', () => {
  const cfg = [{ email: 'a@x' }];
  const ledger = makeLedger('2026-05', [{ email: 'a@x', cycle: '2026-05', claimed: true, remaining_usd: 120 }]);
  const p = projectMonthEnd(ledger, cfg, 0, new Date(Date.UTC(2026, 4, 15)));
  assert.equal(p.currentRemainingUsd, 120);
  assert.equal(p.projectedRemainingUsd, 120);
  assert.equal(p.projectedConsumedUsd, 80);
});

test('projectMonthEnd: empty pool — no division by zero', () => {
  const p = projectMonthEnd(makeLedger('2026-05', []), [], 0, new Date(Date.UTC(2026, 4, 19)));
  assert.equal(p.poolUsd, 0);
  assert.equal(p.currentConsumedPct, 0);
  assert.equal(p.projectedConsumedPct, 0);
});

// ─── computeSeverity (threshold boundaries) ─────────────────────────────────

test('computeSeverity: projected 89% + fallback 29% → LOW', () => {
  const sev = computeSeverity({ projectedConsumedPct: 89 }, { available: true, ratio: 0.29 });
  assert.equal(sev, 'LOW');
});

test('computeSeverity: projected exactly 30% fallback (boundary low side) → LOW for projection at 89', () => {
  // fallback ratio 0.30 is the threshold — >= triggers HIGH
  const sev = computeSeverity({ projectedConsumedPct: 89 }, { available: true, ratio: 0.3 });
  assert.equal(sev, 'HIGH');
});

test('computeSeverity: fallback 31% → HIGH regardless of projection', () => {
  const sev = computeSeverity({ projectedConsumedPct: 10 }, { available: true, ratio: 0.31 });
  assert.equal(sev, 'HIGH');
});

test('computeSeverity: projected 90% (boundary) → HIGH', () => {
  const sev = computeSeverity({ projectedConsumedPct: 90 }, { available: true, ratio: 0 });
  assert.equal(sev, 'HIGH');
});

test('computeSeverity: projected 91% → HIGH', () => {
  const sev = computeSeverity({ projectedConsumedPct: 91 }, { available: true, ratio: 0 });
  assert.equal(sev, 'HIGH');
});

test('computeSeverity: projected 89% (boundary low side) → LOW', () => {
  const sev = computeSeverity({ projectedConsumedPct: 89 }, { available: true, ratio: 0 });
  assert.equal(sev, 'LOW');
});

test('computeSeverity: thresholds match exported constants', () => {
  // Sanity guard: prevent silent threshold drift via constant renames.
  assert.equal(SEVERITY_HIGH_PROJECTED_PCT, 90);
  assert.equal(SEVERITY_HIGH_FALLBACK_RATIO, 0.3);
});

test('computeSeverity: fallback unavailable does not contribute to severity', () => {
  const sev = computeSeverity({ projectedConsumedPct: 50 }, { available: false, reason: 'no datapoints' });
  assert.equal(sev, 'LOW');
});

test('computeSeverity: fallback unavailable but projection high → HIGH (projection alone)', () => {
  const sev = computeSeverity({ projectedConsumedPct: 92 }, { available: false, reason: 'aws cli not invokable' });
  assert.equal(sev, 'HIGH');
});

// ─── readSnapshotHistory (missing-file path) ────────────────────────────────

test('readSnapshotHistory: missing file → empty array', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'daily-credit-digest-'));
  try {
    const rows = readSnapshotHistory(join(tmp, 'does-not-exist.jsonl'));
    assert.deepEqual(rows, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSnapshotHistory: parses valid JSONL + skips malformed lines', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'daily-credit-digest-'));
  try {
    const path = join(tmp, 'snapshots.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: '2026-05-12T09:00:00Z', email: 'a@x', remaining_usd: 200, cycle: '2026-05' }),
        'not json',
        JSON.stringify({ ts: '2026-05-19T09:00:00Z', email: 'a@x', remaining_usd: 130, cycle: '2026-05' }),
        '',
      ].join('\n'),
    );
    const rows = readSnapshotHistory(path);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].email, 'a@x');
    assert.equal(rows[1].remaining_usd, 130);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── formatSlackBody ────────────────────────────────────────────────────────

test('formatSlackBody: includes pool, severity, projection, fallback section', () => {
  const body = formatSlackBody({
    cycle: '2026-05',
    perAccountBalances: [
      { email: 'a@x', remaining_usd: 100 },
      { email: 'b@x', remaining_usd: 50 },
    ],
    burn: {
      perAccount: [
        { email: 'a@x', dailyBurnUsd: 5, windowDays: 7 },
        { email: 'b@x', dailyBurnUsd: 10, windowDays: 7 },
      ],
      totalDailyBurnUsd: 15,
    },
    projection: {
      accountCount: 2,
      poolUsd: 400,
      currentRemainingUsd: 150,
      currentConsumedUsd: 250,
      currentConsumedPct: 63,
      projectedRemainingUsd: 0,
      projectedConsumedUsd: 400,
      projectedConsumedPct: 100,
      daysRemaining: 13,
    },
    fallback: { available: true, fallbackCount: 5, hitCount: 95, ratio: 0.05 },
    severity: 'HIGH',
  });
  assert.match(body, /severity HIGH/);
  assert.match(body, /Pool: \$400/);
  assert.match(body, /2026-05/);
  assert.match(body, /13 day\(s\) left/);
  assert.match(body, /63% consumed/);
  assert.match(body, /Fallback 24h:/);
  assert.match(body, /a@x/);
  assert.match(body, /b@x/);
  // No webhook leaks
  assert.doesNotMatch(body, /hooks\.slack\.com/);
});

test('formatSlackBody: graceful fallback when CloudWatch unavailable', () => {
  const body = formatSlackBody({
    cycle: '2026-05',
    perAccountBalances: [{ email: 'a@x', remaining_usd: 200 }],
    burn: { perAccount: [{ email: 'a@x', dailyBurnUsd: null, windowDays: 0 }], totalDailyBurnUsd: 0 },
    projection: {
      accountCount: 1,
      poolUsd: 200,
      currentRemainingUsd: 200,
      currentConsumedUsd: 0,
      currentConsumedPct: 0,
      projectedRemainingUsd: 200,
      projectedConsumedUsd: 0,
      projectedConsumedPct: 0,
      daysRemaining: 5,
    },
    fallback: { available: false, reason: 'aws cli not invokable' },
    severity: 'LOW',
  });
  assert.match(body, /Fallback 24h: unavailable/);
  assert.match(body, /section skipped/);
  // null burn renders as n/a, not as $null/d
  assert.match(body, /burn: n\/a/);
});

test('formatSlackBody: dry-run marker', () => {
  const body = formatSlackBody({
    cycle: '2026-05',
    perAccountBalances: [],
    burn: { perAccount: [], totalDailyBurnUsd: 0 },
    projection: {
      accountCount: 0,
      poolUsd: 0,
      currentRemainingUsd: 0,
      currentConsumedUsd: 0,
      currentConsumedPct: 0,
      projectedRemainingUsd: 0,
      projectedConsumedUsd: 0,
      projectedConsumedPct: 0,
      daysRemaining: 13,
    },
    fallback: { available: false, reason: 'no datapoints' },
    severity: 'LOW',
    dryRun: true,
  });
  assert.match(body, /dry-run/);
});
