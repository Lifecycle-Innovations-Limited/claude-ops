#!/usr/bin/env node
// Guard acquisition must be atomic. Two workers racing for the same key means
// one wins and one loses; a loser must never touch a guard it does not own and
// must never crash the process it is running in.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const worker = new URL('./refresh-pacing-worker.mjs', import.meta.url).pathname;
const now = 1_000_000;

function envFor(lockDir) {
  return {
    ...process.env,
    CLAUDE_REFRESH_LOCK_DIR: lockDir,
    CLAUDE_REFRESH_MIN_PACE_MS: '40',
    CLAUDE_REFRESH_JITTER_MS: '0',
    CLAUDE_REFRESH_TEST_ALLOW_ZERO_PACE: '1',
  };
}

function runWorker(lockDir, key = 'shared@example.com') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, key, String(now)], { env: envFor(lockDir) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

// 1. A guard directory with no owner record yet is a guard mid-acquisition, not
// a free slot. Reaping it on sight is what leaves the winner writing owner.json
// into a directory that no longer exists.
const halfBuilt = mkdtempSync(join(tmpdir(), 'refresh-guard-halfbuilt-'));
const guardPath = join(halfBuilt, 'shared@example.com.pace.guard');
mkdirSync(guardPath);
const blocked = await runWorker(halfBuilt);
assert.equal(blocked.code, 0, blocked.stderr);
assert.equal(blocked.stdout, 'null', `a worker must not claim a guard it did not build: ${blocked.stdout}`);
assert.equal(existsSync(guardPath), true, 'a guard still being acquired must not be reclaimed');
assert.equal(existsSync(join(halfBuilt, 'shared@example.com.next.json')), false);

// 2. Under real contention every loser exits cleanly and the pacing state stays
// consistent with the number of claims that were handed out.
for (let round = 0; round < 4; round += 1) {
  const lockDir = mkdtempSync(join(tmpdir(), 'refresh-guard-contention-'));
  const runs = await Promise.all(Array.from({ length: 16 }, () => runWorker(lockDir)));
  const crashed = runs.filter((run) => run.code !== 0);
  assert.equal(crashed.length, 0, crashed.map((run) => run.stderr).join('\n'));

  const claimed = runs
    .map((run) => Number(run.stdout))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  assert.equal(claimed.length >= 2, true, `round ${round} handed out ${claimed.length} claims`);
  assert.equal(claimed[0], 0);
  for (let i = 1; i < claimed.length; i += 1) {
    assert.equal(claimed[i] >= claimed[i - 1] + 40, true, claimed);
  }
  const paceState = JSON.parse(readFileSync(join(lockDir, 'shared@example.com.next.json'), 'utf8'));
  assert.equal(paceState.nextEligibleAt >= now + claimed.length * 40, true);
}

// 3. A live owner keeps its guard. Age alone must not hand it to somebody else.
const liveDir = mkdtempSync(join(tmpdir(), 'refresh-guard-live-'));
const livePath = join(liveDir, 'live@example.com.pace.guard');
mkdirSync(livePath);
const liveOwner = { ownerNonce: 'live-owner-nonce', pid: process.pid, acquiredAt: Date.now() - 30_000 };
writeFileSync(join(livePath, 'owner.json'), JSON.stringify(liveOwner), { mode: 0o600 });
const denied = await runWorker(liveDir, 'live@example.com');
assert.equal(denied.code, 0, denied.stderr);
assert.equal(denied.stdout, 'null', 'a guard held by a live process must not be reclaimed on age');
assert.equal(JSON.parse(readFileSync(join(livePath, 'owner.json'), 'utf8')).ownerNonce, 'live-owner-nonce');

console.log('Refresh guard contention tests: PASS');
