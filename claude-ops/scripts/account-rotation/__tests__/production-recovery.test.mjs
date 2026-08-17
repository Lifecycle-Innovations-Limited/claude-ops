#!/usr/bin/env node
/**
 * Retry-After parsing used by every 429/503 recovery path.
 *
 * This file previously also drove three relay-pool daemons (cooldown, priority,
 * 401 refresher). Those daemons are gone: multi-account rotation and OAuth seat
 * management run through CLIProxyAPI, which owns its own backoff.
 */
import assert from 'node:assert/strict';
import { retryAfterDelayMs } from '../retry-after.mjs';

// Delta-seconds form, plus the 2s safety margin.
assert.equal(retryAfterDelayMs('7', 0), 9_000);
// HTTP-date form.
assert.equal(retryAfterDelayMs(new Date(12_000).toUTCString(), 0), 14_000);
// Unparseable value falls back to a fixed minute.
assert.equal(retryAfterDelayMs('invalid-date', 0), 60_000);
// No header at all means "caller decides".
assert.equal(retryAfterDelayMs(null, 0), null);

console.log('Retry-After recovery tests: PASS');
