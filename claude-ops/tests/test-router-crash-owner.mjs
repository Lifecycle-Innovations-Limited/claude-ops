import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const temp = mkdtempSync(join(tmpdir(), 'router-crash-'));
try {
  const scripts = join(temp, 'scripts');
  cpSync(new URL('../scripts/', import.meta.url), scripts, { recursive: true });
  const rotation = join(scripts, 'account-rotation');
  writeFileSync(
    join(rotation, 'config.json'),
    JSON.stringify({ accounts: [{ label: 'synthetic' }], rateLimits: { destinationMaxUtilPercent: 100 } }),
  );
  writeFileSync(join(rotation, 'state.json'), '{}');
  const home = join(temp, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude/.credentials.json'),
    JSON.stringify({ 'Claude-Rotation-synthetic': { claudeAiOauth: { accessToken: 'synthetic-oauth' } } }),
  );
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'security'),
    '#!/bin/sh\nprintf \'password: "{\\"claudeAiOauth\\":{\\"accessToken\\":\\"synthetic-oauth\\"}}"\\n\'\n',
    { mode: 0o700 },
  );
  const fake = join(bin, 'capture');
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nimport fs from 'node:fs';const a=process.argv.slice(2),p=a[a.indexOf('--settings')+1];fs.writeFileSync(process.env.CAPTURE,p);if(process.env.HOLD==='1')setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${bin}:${process.env.PATH}`,
    ADMISSION_FORCE: '1',
    CLAUDE_REAL_BIN: fake,
    CAPTURE: join(temp, 'capture'),
    HOLD: '1',
  };
  const launcher = join(rotation, 'launch-claude.mjs');
  const child = spawn(process.execPath, [launcher, '-p', '--settings', '{"env":{"SYNTHETIC":"private"}}'], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  const ended = new Promise((resolve) => child.once('close', resolve));
  for (let n = 0; n < 100 && !existsSync(env.CAPTURE); n++) await delay(20);
  assert.ok(existsSync(env.CAPTURE), 'router child reached actual composed file');
  const path = readFileSync(env.CAPTURE, 'utf8');
  assert.ok(existsSync(path));
  process.kill(-child.pid, 'SIGKILL');
  await ended;
  assert.ok(existsSync(path), 'hard kill bypasses synchronous cleanup');
  const recovery = spawnSync(process.execPath, [launcher, '-p', '--settings', '{}'], {
    env: { ...env, HOLD: '0' },
    encoding: 'utf8',
  });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(existsSync(path), false, 'next actual router start recovers dead owner settings');
  console.log('PASS actual launcher/router SIGKILL -> next router start reclaims owner document');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
