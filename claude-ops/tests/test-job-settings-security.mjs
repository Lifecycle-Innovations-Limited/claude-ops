import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  registryRoot,
  registerSettings,
  bindSettings,
  confirmRemoval,
  reconcileSettings,
} from '../scripts/account-rotation/job-settings.mjs';
const tmp = mkdtempSync(join(tmpdir(), 'registry-security-'));
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ': ' + e.message);
  }
}
try {
  const env = { HOME: tmp };
  const root = registryRoot(env);
  mkdirSync(join(root, 'documents'), { recursive: true, mode: 0o700 });
  const outside = join(tmp, 'outside');
  writeFileSync(outside, 'private');
  check('untrusted external record cannot unlink outside documentdir', () => {
    const record = join(root, 'bad.json');
    writeFileSync(record, JSON.stringify({ path: outside, removed: 'abcdef12' }));
    reconcileSettings(env);
    assert.equal(existsSync(outside), true);
    rmSync(record, { force: true });
  });
  check('symlink document cannot authorize deletion', () => {
    const path = join(root, 'documents/link');
    symlinkSync(outside, path);
    const record = join(root, 'link.json');
    writeFileSync(record, JSON.stringify({ path, removed: 'abcdef12' }));
    reconcileSettings(env);
    assert.equal(existsSync(path), true);
    rmSync(record, { force: true });
  });
  check('removal output must exactly equal requested ID', () => {
    const path = join(root, 'documents/exact');
    writeFileSync(path, '{}', { mode: 0o600 });
    const record = registerSettings(path, env);
    bindSettings(record, 'abcdef123456');
    assert.equal(confirmRemoval(env, 'abcdef12', 0, 'removed abcdef123456\n'), 0);
    assert.ok(existsSync(path));
  });
  check('binding cannot revive a confirmed removed record', () => {
    const path = join(root, 'documents/removed');
    writeFileSync(path, '{}', { mode: 0o600 });
    const record = registerSettings(path, env);
    writeFileSync(record, JSON.stringify({ path, sessionId: 'abcdef12', removed: 'abcdef12' }));
    bindSettings(record, '99999999');
    assert.equal(JSON.parse(readFileSync(record)).removed, 'abcdef12');
    assert.equal(JSON.parse(readFileSync(record)).sessionId, 'abcdef12');
  });
  check('Python helper never receives inline credential in argv', () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const capture = join(tmp, 'helper-argv');
    writeFileSync(join(bin, 'python3'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE"\nexit 2\n`, { mode: 0o700 });
    const sentinel = 'synthetic-inline-secret';
    spawnSync(
      'bash',
      [
        '-c',
        '. "$1"; claude_invoke -p --settings "$2"',
        'test',
        new URL('../scripts/lib/claude-invoke.sh', import.meta.url).pathname,
        JSON.stringify({ env: { KEY: sentinel } }),
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture }, encoding: 'utf8' },
    );
    assert.equal(readFileSync(capture, 'utf8').includes(sentinel), false);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failures) process.exit(1);
