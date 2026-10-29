import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  registerSettings,
  bindSettings,
  registryRoot,
  confirmRemoval,
  reconcileSettings,
} from '../scripts/account-rotation/job-settings.mjs';
const tmp = mkdtempSync(join(tmpdir(), 'settings-flock-'));
try {
  const env = { HOME: tmp };
  const root = registryRoot(env);
  mkdirSync(join(root, 'documents'), { recursive: true, mode: 0o700 });
  const path = join(root, 'documents/document');
  writeFileSync(path, '{}', { mode: 0o600 });
  const record = registerSettings(path, env);
  bindSettings(record, 'abcdef123456');
  const locks = join(root, 'locks');
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const ready = join(tmp, 'ready');
  const holder = spawn(
    'python3',
    [
      '-I',
      '-c',
      "import fcntl,os,sys,time;f=open(sys.argv[1],'a');os.chmod(sys.argv[1],0o600);fcntl.flock(f,fcntl.LOCK_EX);open(sys.argv[2],'w').write('ready');time.sleep(60)",
      join(locks, basename(record)),
      ready,
    ],
    { stdio: 'ignore' },
  );
  const ended = new Promise((resolve) => holder.once('close', resolve));
  for (let n = 0; n < 100 && !existsSync(ready); n++) await delay(20);
  assert.ok(existsSync(ready));
  confirmRemoval(env, 'abcdef123456', 0, 'removed abcdef123456\n');
  assert.ok(existsSync(path), 'live lock defers cleanup');
  holder.kill('SIGKILL');
  await ended;
  reconcileSettings(env);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(record), false);
  console.log('PASS real held flock + one explicit removal + SIGKILL + reconcile cleans without second rm');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
