/**
 * injectContinuation tests (node --test).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/inject-continuation.test.mjs
 *
 * F4 is DEFAULT-OFF (CLAUDE_ROTATION_INJECT_CONTINUATION must be '1' to enable).
 * We verify the off path is a true no-op: it never logs and never invokes claude.
 * (The on-path spawns a real `claude --resume` and is intentionally not exercised
 * in unit tests — it is experimental and gated.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { injectContinuation } from '../bg-respawn.mjs';

test('injectContinuation: default-off is a no-op (no log, no throw)', () => {
  // The module reads CLAUDE_ROTATION_INJECT_CONTINUATION at import time; in the
  // test process the flag is unset, so this must short-circuit before any work.
  assert.equal(process.env.CLAUDE_ROTATION_INJECT_CONTINUATION, undefined);
  let logged = false;
  assert.doesNotThrow(() => injectContinuation('unit-test-sid', () => { logged = true; }));
  assert.equal(logged, false, 'must not log or do work when flag is off');
});
