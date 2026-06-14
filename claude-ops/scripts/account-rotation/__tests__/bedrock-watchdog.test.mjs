/**
 * bedrock-watchdog tests (node --test).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/bedrock-watchdog.test.mjs
 *
 * These are sandbox-safety + classification tests. The /proc and ss scanners are
 * environment-dependent; the contract we test is that they NEVER throw and NEVER
 * false-alarm, and that verifyBedrockSwaps classifies a dead (re-exec'd) PID as
 * cleared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanBedrockSessions,
  scanBedrockNetwork,
  verifyBedrockSwaps,
} from '../bedrock-watchdog.mjs';

test('scanBedrockSessions: never throws, returns an array', () => {
  const r = scanBedrockSessions();
  assert.ok(Array.isArray(r));
  // Each entry, if any, has the documented shape.
  for (const s of r) {
    assert.equal(typeof s.pid, 'number');
    assert.ok('sessionId' in s);
    assert.equal(typeof s.cmdline, 'string');
  }
});

test('scanBedrockNetwork: graceful fallback, never false-alarms', () => {
  const r = scanBedrockNetwork([999999999]);
  assert.equal(typeof r.available, 'boolean');
  assert.ok(r.pids instanceof Set);
  // For a bogus pid we must never positively report bedrock traffic.
  assert.equal(r.pids.has(999999999), false);
});

test('scanBedrockNetwork: empty pid filter still returns a valid shape', () => {
  const r = scanBedrockNetwork([]);
  assert.equal(typeof r.available, 'boolean');
  assert.ok(r.pids instanceof Set);
});

test('verifyBedrockSwaps: a dead/re-exec PID counts as cleared (not stillBedrock)', () => {
  const logs = [];
  // PID 999999998 is overwhelmingly unlikely to exist → /proc read fails →
  // treated as "process gone" → cleared.
  const { stillBedrock, cleared } = verifyBedrockSwaps([999999998], (m) => logs.push(m));
  assert.deepEqual(stillBedrock, []);
  assert.deepEqual(cleared, [999999998]);
});

test('verifyBedrockSwaps: empty input is a no-op', () => {
  const logs = [];
  const { stillBedrock, cleared } = verifyBedrockSwaps([], (m) => logs.push(m));
  assert.deepEqual(stillBedrock, []);
  assert.deepEqual(cleared, []);
  assert.equal(logs.length, 0);
});
