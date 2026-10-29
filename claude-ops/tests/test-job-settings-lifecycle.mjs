import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const work = mkdtempSync(join(tmpdir(), 'job-settings-'));
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const rotation = join(work, 'rotation');
  cpSync(join(root, 'scripts/account-rotation'), rotation, { recursive: true });
  cpSync(join(root, 'scripts/lib'), join(work, 'lib'), { recursive: true });
  if (process.env.TEST_BASELINE_ROUTER) cpSync(process.env.TEST_BASELINE_ROUTER, join(rotation, 'session-router.mjs'));
  const { spawnWithAccount } = await import(pathToFileURL(join(rotation, 'session-router.mjs')));
  const { confirmRemoval, reconcileSettings, registryRoot } = await import(
    pathToFileURL(join(rotation, 'job-settings.mjs'))
  );
  const env = { PATH: process.env.PATH, HOME: work, POCKET_RECORDING_ID: 'synthetic-recording' };
  const fake = join(work, 'claude');
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2),path=args[args.indexOf('--settings')+1];fs.writeFileSync(process.env.CAPTURE,path);console.log('backgrounded · abcdef123456');\n`,
    { mode: 0o700 },
  );
  const capture = join(work, 'capture');
  const { proc } = spawnWithAccount(
    ['--bg', '--settings', '{"env":{"PRIVATE_TEST":"synthetic-secret"}}'],
    { accounts: [] },
    {},
    { env: { ...env, CLAUDE_REAL_BIN: fake, CAPTURE: capture }, stdio: 'ignore' },
  );
  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(Error('dispatch failed'))));
  });
  const path = readFileSync(capture, 'utf8');
  assert.equal(existsSync(path), true, 'dispatcher exit must preserve restart settings');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).env.PRIVATE_TEST, 'synthetic-secret', 'restart reads same file');
  const records = readdirSync(registryRoot(env)).filter((n) => n.endsWith('.json'));
  assert.equal(records.length, 1);
  const record = JSON.parse(readFileSync(join(registryRoot(env), records[0]), 'utf8'));
  assert.equal(record.sessionId, 'abcdef123456');
  assert.equal(record.owner, 'synthetic-recording');
  // Replay the persisted settings flag after the dispatcher has exited, just
  // as the installed CLI's restart builder replays row.respawnFlags.
  const restart = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import fs from 'node:fs'; const args=JSON.parse(process.env.SAVED_FLAGS);const doc=JSON.parse(fs.readFileSync(args[1],'utf8'));if(doc.env.PRIVATE_TEST!=='synthetic-secret')process.exit(1);",
    ],
    { env: { PATH: process.env.PATH, SAVED_FLAGS: JSON.stringify(['--settings', path]) }, encoding: 'utf8' },
  );
  assert.equal(restart.status, 0, restart.stderr);
  // A missing banner is recoverable from the existing job's persisted flags.
  const recordPath = join(registryRoot(env), records[0]);
  writeFileSync(recordPath, JSON.stringify({ ...record, sessionId: null }), { mode: 0o600 });
  const jobDir = join(work, '.claude/jobs/abcdef123456');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ respawnFlags: ['--settings', path], status: 'stopped' }));
  reconcileSettings(env);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).sessionId, 'abcdef123456');
  for (const status of ['stopped', 'completed', 'done', null]) {
    reconcileSettings({ ...env, TEST_STATUS: status });
    assert.equal(existsSync(path), true, 'status or absence is not removal');
  }
  assert.equal(confirmRemoval(env, 'abcdef12', 1, 'removed abcdef123456\n'), 0);
  assert.equal(confirmRemoval(env, 'abcdef12', 0, 'No job matching abcdef12\n'), 0);
  assert.equal(confirmRemoval(env, 'abcdef12', 0, 'removed 99999999\n'), 0);
  assert.equal(existsSync(path), true, 'failed or unmatched removal retains settings');
  const removeBinary = join(work, 'remove-cli');
  writeFileSync(removeBinary, '#!/bin/sh\nprintf "removed abcdef123456\\n"\n', { mode: 0o700 });
  const removal = spawnSync(process.execPath, [join(rotation, 'launch-claude.mjs'), 'rm', 'abcdef123456'], {
    env: { ...env, ADMISSION_FORCE: '1', CLAUDE_REAL_BIN: removeBinary },
    encoding: 'utf8',
  });
  assert.equal(removal.status, 0, removal.stderr);
  assert.equal(existsSync(path), false, 'verified explicit launcher removal cleans settings');
  assert.equal(readdirSync(registryRoot(env)).filter((n) => n.endsWith('.json')).length, 0);
  console.log('Background settings dispatch/restart/explicit-removal lifecycle: PASS');
} finally {
  rmSync(work, { recursive: true, force: true });
}
