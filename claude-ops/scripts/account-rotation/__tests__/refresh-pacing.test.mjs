#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const lockDir = mkdtempSync(join(tmpdir(), 'refresh-pacing-'));
const worker = new URL('./refresh-pacing-worker.mjs', import.meta.url);
const now = 1_000_000;
const env = {
  ...process.env,
  CRS_REFRESH_LOCK_DIR: lockDir,
  CRS_REFRESH_MIN_PACE_MS: '40',
  CRS_REFRESH_JITTER_MS: '0',
  CRS_REFRESH_TEST_ALLOW_ZERO_PACE: '1',
};

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker.pathname, 'shared@example.com', String(now)], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `worker exit ${code}`));
      else resolve(Number(stdout.trim()));
    });
  });
}

const waits = await Promise.all(Array.from({ length: 6 }, runWorker));
const claimed = waits.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
assert.equal(claimed.length >= 2, true, waits);
assert.equal(claimed[0], 0);
for (let i = 1; i < claimed.length; i += 1) {
  assert.equal(claimed[i] >= claimed[i - 1] + 40, true, claimed);
}
const paceState = JSON.parse(readFileSync(join(lockDir, 'shared@example.com.next.json'), 'utf8'));
assert.equal(paceState.nextEligibleAt >= now + claimed.length * 40, true);

const productionLockDir = mkdtempSync(join(tmpdir(), 'refresh-production-min-'));
const production = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker.pathname, 'production@example.com', String(now)], {
    env: {
      ...process.env,
      CRS_REFRESH_LOCK_DIR: productionLockDir,
      CRS_REFRESH_MIN_PACE_MS: '0',
      CRS_REFRESH_JITTER_MS: '0',
      CRS_REFRESH_TEST_ALLOW_ZERO_PACE: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `worker exit ${code}`))));
});
void production;
const productionState = JSON.parse(readFileSync(join(productionLockDir, 'production@example.com.next.json'), 'utf8'));
assert.equal(productionState.nextEligibleAt >= now + 1_000, true);

console.log('Refresh pacing contention tests: PASS');
