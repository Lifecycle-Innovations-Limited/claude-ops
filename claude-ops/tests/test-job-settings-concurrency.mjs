import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { registerSettings, registryRoot, reconcileSettings } from '../scripts/account-rotation/job-settings.mjs';
const root = new URL('../scripts/account-rotation/job-settings.mjs', import.meta.url).href;
const tmp = mkdtempSync(join(tmpdir(), 'settings-race-'));
const env = { HOME: tmp };
function run(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(Error(err))));
  });
}
try {
  const dir = join(registryRoot(env), 'documents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'document');
  writeFileSync(path, '{}', { mode: 0o600 });
  const record = registerSettings(path, env);
  const binding = `import {bindSettings} from ${JSON.stringify(root)};for(let n=0;n<20;n++)bindSettings(${JSON.stringify(record)},'abcdef123456');`;
  await Promise.all(Array.from({ length: 12 }, () => run(binding)));
  const row = JSON.parse(readFileSync(record));
  assert.equal(row.sessionId, 'abcdef123456');
  assert.equal(
    readdirSync(registryRoot(env)).some((n) => n.endsWith('.tmp')),
    false,
  );
  console.log('PASS 12 concurrent binders x20 preserve valid record, no shared-temp errors');
  const removal = `import {confirmRemoval} from ${JSON.stringify(root)};confirmRemoval(${JSON.stringify(env)},'abcdef123456',0,'removed abcdef123456\\n');`;
  await Promise.all([
    ...Array.from({ length: 8 }, () => run(binding)),
    ...Array.from({ length: 4 }, () => run(removal)),
  ]);
  // A lock contender is allowed to defer. Retry the already explicit removal
  // once after contenders have finished; never infer removal from missing state.
  await run(removal);
  reconcileSettings(env);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(record), false);
  console.log('PASS concurrent binding/removal never revives removed record; explicit retry cleans');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
