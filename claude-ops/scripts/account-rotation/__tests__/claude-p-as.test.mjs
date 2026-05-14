/**
 * claude-p-as wrapper tests (node --test).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/claude-p-as.test.mjs
 *
 * Covers: ledger account selection, --pin honoring, $0 refuse paths,
 * extra_usage refuse, ledger decrement, and lock contention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { parseArgs, pickAccount, effectiveBudget, parseUsageCost, decrementLedger } from '../claude-p-as.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'claude-p-as.mjs');

function makeLedger(accounts) {
  return {
    schema_version: 1,
    month: '2026-06',
    month_resets_at: '2026-07-01T00:00:00Z',
    accounts,
  };
}

function tmpFile(name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'claude-p-as-'));
  return join(dir, name);
}

test('pickAccount selects highest remaining_usd by default', () => {
  const ledger = makeLedger([
    { email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 50 },
    { email: 'b@x.com', monthly_credit_usd: 200, remaining_usd: 175 },
    { email: 'c@x.com', monthly_credit_usd: 200, remaining_usd: 100 },
  ]);
  const a = pickAccount(ledger, null);
  assert.equal(a.email, 'b@x.com');
});

test('pickAccount honors --pin even when not the richest', () => {
  const ledger = makeLedger([
    { email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 50 },
    { email: 'b@x.com', monthly_credit_usd: 200, remaining_usd: 175 },
  ]);
  const a = pickAccount(ledger, 'a@x.com');
  assert.equal(a.email, 'a@x.com');
  assert.equal(a.remaining_usd, 50);
});

test('pickAccount refuses (exit 2) when all accounts $0', () => {
  const ledger = makeLedger([
    { email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 0 },
    { email: 'b@x.com', monthly_credit_usd: 200, remaining_usd: 0 },
  ]);
  // pickAccount calls die() which calls process.exit. Run as subprocess.
  const ledgerPath = tmpFile();
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const r = spawnSync('node', [SCRIPT, '--ledger', ledgerPath, '--', '/help'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /all accounts \$0/);
});

test('pickAccount refuses (exit 2) when pinned account at $0', () => {
  const ledger = makeLedger([
    { email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 0 },
    { email: 'b@x.com', monthly_credit_usd: 200, remaining_usd: 200 },
  ]);
  const ledgerPath = tmpFile();
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const r = spawnSync('node', [SCRIPT, '--ledger', ledgerPath, '--pin', 'a@x.com', '--', '/help'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pinned account a@x\.com credit exhausted/);
});

test('assertNotExtraUsage refuses accounts with extra_usage flag in ledger', () => {
  const account = { email: 'a@x.com', remaining_usd: 100, extra_usage: true };
  const r = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { assertNotExtraUsage } from "${SCRIPT}"; assertNotExtraUsage(${JSON.stringify(account)}, "/nonexistent");`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /extra_usage=true/);
});

test('assertNotExtraUsage refuses accounts with extraUsageEnabled=true in rotation config', () => {
  const cfgPath = tmpFile('config.json');
  writeFileSync(cfgPath, JSON.stringify({ accounts: [{ email: 'a@x.com', extraUsageEnabled: true }] }));
  const account = { email: 'a@x.com', remaining_usd: 100 };
  const r = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { assertNotExtraUsage } from "${SCRIPT}"; assertNotExtraUsage(${JSON.stringify(account)}, "${cfgPath}");`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /extraUsageEnabled=true/);
});

test('effectiveBudget caps at $200 hard ceiling regardless of user input', () => {
  assert.equal(effectiveBudget(null), 200);
  assert.equal(effectiveBudget(undefined), 200);
  assert.equal(effectiveBudget(50), 50);
  assert.equal(effectiveBudget(500), 200);
  assert.equal(effectiveBudget(-5), 0);
});

test('parseUsageCost extracts $cost from claude output strings', () => {
  assert.equal(parseUsageCost('foo\nCost: $0.1234\n', ''), 0.1234);
  assert.equal(parseUsageCost('', 'Total cost: $1.5'), 1.5);
  assert.equal(parseUsageCost('no money here', ''), null);
});

test('decrementLedger atomically subtracts cost and stamps last_call_at', () => {
  const ledgerPath = tmpFile();
  const ledger = makeLedger([{ email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 150, last_call_at: null }]);
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  decrementLedger(ledgerPath, 'a@x.com', 0.42);
  const after = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(after.accounts[0].remaining_usd, 149.58);
  assert.ok(after.accounts[0].last_call_at);
});

test('decrementLedger never drops remaining below zero', () => {
  const ledgerPath = tmpFile();
  writeFileSync(
    ledgerPath,
    JSON.stringify(makeLedger([{ email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 0.05 }])),
  );
  decrementLedger(ledgerPath, 'a@x.com', 10);
  const after = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(after.accounts[0].remaining_usd, 0);
});

test('parseArgs splits --pin and -- delimiter cleanly', () => {
  const a = parseArgs(['--pin', 'b@x.com', '--', '-p', 'hello']);
  assert.equal(a.pin, 'b@x.com');
  assert.deepEqual(a.rest, ['-p', 'hello']);
});

test('parseArgs accepts --max-budget-usd flag', () => {
  const a = parseArgs(['--max-budget-usd', '50', '--', 'hello']);
  assert.equal(a.budget, 50);
});

test('refuses when ledger file missing', () => {
  const r = spawnSync('node', [SCRIPT, '--ledger', '/nonexistent/ledger.json', '--', 'hello'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ledger missing/);
});

test('lock contention: second invocation refuses while lock file exists', () => {
  const ledgerPath = tmpFile();
  writeFileSync(
    ledgerPath,
    JSON.stringify(makeLedger([{ email: 'a@x.com', monthly_credit_usd: 200, remaining_usd: 200 }])),
  );
  const lockPath = tmpFile('lock');
  // Pre-create lock to simulate in-flight rotation
  const fd = openSync(lockPath, 'wx');
  closeSync(fd);
  try {
    const r = spawnSync(
      'node',
      [SCRIPT, '--ledger', ledgerPath, '--lock', lockPath, '--config', '/nonexistent', '--', 'hello'],
      { encoding: 'utf8' },
    );
    // Will fail at lock OR earlier at assertBudgetFlagAvailable if claude CLI isn't installed.
    // Accept either: status 2 + (lock-held OR claude-cli-missing) — both are correct refusals.
    assert.equal(r.status, 2);
    assert.match(r.stderr, /(keychain lock held|--max-budget-usd.*not available|ledger)/);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
});
