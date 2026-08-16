#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockDir = mkdtempSync(join(tmpdir(), 'refresh-lock-owner-'));
process.env.CLAUDE_REFRESH_LOCK_DIR = lockDir;
process.env.CLAUDE_REFRESH_LOCK_TTL_SEC = '0.15';
const { acquireRefreshLock } = await import(`../refresh-lock.mjs?test=${Date.now()}`);

const release = acquireRefreshLock('owner@example.com');
assert.ok(release);
const lockPath = join(lockDir, 'owner@example.com.lock.json');
const old = JSON.parse(readFileSync(lockPath, 'utf8'));
await new Promise((resolve) => setTimeout(resolve, 180));
writeFileSync(lockPath, JSON.stringify({ ...old, ownerNonce: 'replacement-owner', renewedAt: Date.now() }), {
  mode: 0o600,
});
assert.equal(release(), false);
assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).ownerNonce, 'replacement-owner');

const longRelease = acquireRefreshLock('long@example.com');
assert.ok(longRelease);
await new Promise((resolve) => setTimeout(resolve, 400));
assert.equal(acquireRefreshLock('long@example.com'), null);
assert.equal(longRelease(), true);

console.log('Refresh lock ownership and heartbeat tests: PASS');
