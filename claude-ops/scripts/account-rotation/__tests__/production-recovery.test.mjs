#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryAfterDelayMs } from '../retry-after.mjs';

const cooldownScript = new URL('../crs-429-cooldown.mjs', import.meta.url);
const priorityScript = new URL('../crs-priority-daemon.mjs', import.meta.url);
const retired401Script = new URL('../crs-401-refresher.mjs', import.meta.url);

function run(script, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function startFixture(initialAccounts) {
  let accounts = structuredClone(initialAccounts);
  const toggles = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, value) => {
      const text = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.url === '/web/auth/login' && req.method === 'POST') return json(200, { token: 'fixture-admin' });
    if (req.url === '/admin/claude-accounts' && req.method === 'GET') return json(200, accounts);
    const toggle = req.url?.match(/^\/admin\/claude-accounts\/([^/]+)\/toggle-schedulable$/);
    if (toggle && req.method === 'PUT') {
      const update = JSON.parse(body || '{}');
      toggles.push({ id: toggle[1], update });
      accounts = accounts.map((account) =>
        account.id === toggle[1]
          ? {
              ...account,
              schedulable: update.schedulable,
              rateLimitEndAt: update.rateLimitEndAt ?? account.rateLimitEndAt,
              rateLimitReason: update.rateLimitReason ?? account.rateLimitReason,
            }
          : account,
      );
      return json(200, { success: true });
    }
    if (req.url?.endsWith('/reset-status') && req.method === 'POST') return json(200, { success: true });
    if (req.url?.startsWith('/admin/claude-accounts/') && req.method === 'PUT') return json(200, { success: true });
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
        toggles,
      });
    });
  });
}

assert.equal(retryAfterDelayMs('7', 0), 9_000);
assert.equal(retryAfterDelayMs(new Date(12_000).toUTCString(), 0), 14_000);
assert.equal(retryAfterDelayMs('invalid-date', 0), 60_000);
assert.equal(retryAfterDelayMs(null, 0), null);

function fixtureEnv(root, base, config) {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return {
    HOME: root,
    CLAUDE_ROTATOR_CONFIG: configPath,
    CLAUDE_PLUGIN_DATA_DIR: join(root, 'data'),
    CRS_BASE: base,
    CRS_ADMIN_PASSWORD: 'fixture-password',
    OPS_ACCOUNTS_BACKEND: 'crs',
    OPS_ACCOUNTS_DUAL_WRITE: '0',
  };
}

{
  const root = mkdtempSync(join(tmpdir(), 'retired-401-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ accounts: [], crs: {} }), { mode: 0o600 });
  const result = await run(retired401Script, { HOME: root, CLAUDE_ROTATOR_CONFIG: configPath });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /RETIRED_USE_VERIFIED_TOKEN_FEED/);
}

{
  const root = mkdtempSync(join(tmpdir(), 'cooldown-recovery-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const fixture = await startFixture([
    {
      id: 'limited',
      name: 'limited@example.com',
      platform: 'claude',
      isActive: true,
      schedulable: true,
      rateLimitStatus: { isRateLimited: true, minutesRemaining: 1, rateLimitEndAt: resetAt },
    },
  ]);
  const statePath = join(root, 'state', 'crs-429-state.json');
  const env = {
    ...fixtureEnv(root, fixture.base, { accounts: [], crs: { cooldownEnabled: true } }),
    CRS_COOLDOWN_ENABLED: '1',
    CRS_COOLDOWN_STATE_PATH: statePath,
  };
  try {
    const held = await run(cooldownScript, env);
    assert.equal(held.status, 0, held.stderr);
    assert.equal(fixture.toggles.at(-1)?.update.schedulable, false);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.limited.cooldownUntil > Date.now(), true);

    state.limited.cooldownUntil = Date.now() - 1;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const released = await startFixture([
      {
        id: 'limited',
        name: 'limited@example.com',
        platform: 'claude',
        isActive: true,
        schedulable: false,
        rateLimitStatus: { isRateLimited: false },
      },
    ]);
    try {
      const releaseEnv = { ...env, CRS_BASE: released.base };
      const result = await run(cooldownScript, releaseEnv);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(released.toggles.at(-1)?.update.schedulable, true);
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).limited, undefined);
    } finally {
      await released.close();
    }
  } finally {
    await fixture.close();
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'priority-auth-recovery-'));
  const fixture = await startFixture([
    {
      id: 'invalid-1',
      name: 'invalid-one@example.com',
      platform: 'claude',
      isActive: true,
      schedulable: true,
      status: 'auth_repair',
      tokenExpiresAt: Date.now() - 1,
      lastError: 'HTTP 401 authentication_error invalid token',
    },
    {
      id: 'invalid-2',
      name: 'invalid-two@example.com',
      platform: 'claude',
      isActive: true,
      schedulable: true,
      tokenExpiresAt: Date.now() - 1,
      errorMessage: '403 revoked credential',
    },
  ]);
  const env = {
    ...fixtureEnv(root, fixture.base, { accounts: [], crs: { enabled: true, policy: 'conservative', floor: 2 } }),
    CRS_FLOOR: '2',
    CRS_LIVE_USAGE_TTL_MS: '1',
  };
  try {
    const result = await run(priorityScript, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.toggles.length, 2);
    assert.equal(
      fixture.toggles.every((entry) => entry.update.schedulable === false),
      true,
    );
    assert.match(result.stdout, /all active Claude accounts unavailable; leaving pool honestly unschedulable/);
    assert.match(result.stdout, /schedulable=0/);
  } finally {
    await fixture.close();
  }
}

console.log('Production 401/429 recovery tests: PASS');
