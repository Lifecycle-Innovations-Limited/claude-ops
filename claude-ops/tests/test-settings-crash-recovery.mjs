import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerSettings,
  bindSettings,
  confirmRemoval,
  reconcileSettings,
  registryRoot,
} from '../scripts/account-rotation/job-settings.mjs';
const tmp = mkdtempSync(join(tmpdir(), 'settings-crash-'));
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ': ' + e.message);
  }
}
try {
  const env = { HOME: tmp };
  const root = registryRoot(env);
  mkdirSync(join(root, 'documents'), { recursive: true, mode: 0o700 });
  function fixture(name) {
    const path = join(root, 'documents', name);
    writeFileSync(path, '{}', { mode: 0o600 });
    const record = registerSettings(path, env);
    bindSettings(record, 'abcdef123456');
    return { path, record };
  }
  check('successful removal survives contention without second rm', () => {
    const { path, record } = fixture('contended');
    mkdirSync(record + '.lock');
    confirmRemoval(env, 'abcdef123456', 0, 'removed abcdef123456\n');
    rmSync(record + '.lock', { recursive: true });
    reconcileSettings(env);
    assert.equal(existsSync(path), false);
  });
  check('hard-crashed directory lock cannot block recovery forever', () => {
    const { path, record } = fixture('crashed');
    mkdirSync(record + '.lock');
    confirmRemoval(env, 'abcdef123456', 0, 'removed abcdef123456\n');
    reconcileSettings(env);
    assert.equal(existsSync(path), false);
    rmSync(record + '.lock', { recursive: true, force: true });
  });
  check('missing owned removed document clears record', () => {
    const { path, record } = fixture('absent');
    writeFileSync(record, JSON.stringify({ path, sessionId: 'abcdef123456', removed: 'abcdef123456' }), {
      mode: 0o600,
    });
    rmSync(path);
    reconcileSettings(env);
    assert.equal(existsSync(record), false);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exit(1);
