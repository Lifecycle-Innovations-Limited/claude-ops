import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const work = mkdtempSync(join(tmpdir(), 'router-settings-test-'));
const source = fileURLToPath(new URL('../', import.meta.url));
cpSync(source, join(work, 'rotation'), { recursive: true });
cpSync(fileURLToPath(new URL('../../lib/', import.meta.url)), join(work, 'lib'), { recursive: true });
const { spawnWithAccount } = await import(pathToFileURL(join(work, 'rotation/session-router.mjs')));
after(() => rmSync(work, { recursive: true, force: true }));
const TG = '{"enabledPlugins":{"telegram@claude-plugins-official":false}}';
const CRED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const fake = join(work, 'capture.mjs');
writeFileSync(
  fake,
  `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2),path=args[args.indexOf('--settings')+1];fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,doc:JSON.parse(fs.readFileSync(path,'utf8')),mode:fs.statSync(path).mode&511}));\n`,
  { mode: 0o700 },
);
async function run(args) {
  const capture = join(work, 'capture.json');
  const { proc } = spawnWithAccount(
    args,
    { accounts: [] },
    {},
    {
      env: {
        PATH: process.env.PATH,
        HOME: work,
        CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
        CLAUDE_REAL_BIN: fake,
        CAPTURE: capture,
      },
      stdio: 'ignore',
    },
  );
  await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code) => (code === 0 ? resolve() : reject(new Error('synthetic child failed'))));
  });
  const out = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(out.args.filter((a) => a === '--settings').length, 1);
  assert.equal(out.mode, 0o600);
  for (const key of CRED_KEYS) assert.equal(out.doc.env[key], '');
  return out;
}
test('no caller --settings: adds the credential overlay in isolated fixture', async () => {
  await run(['-p', 'hi']);
});
test('caller inline --settings: keeps telegram disable and credential overrides', async () => {
  const out = await run(['--settings', TG, '-p', 'hi']);
  assert.deepEqual(out.args.slice(2), ['-p', 'hi']);
  assert.equal(out.doc.enabledPlugins['telegram@claude-plugins-official'], false);
});
test('--settings=VALUE form is merged too', async () => {
  const out = await run([`--settings=${TG}`, '-p']);
  assert.equal(out.doc.enabledPlugins['telegram@claude-plugins-official'], false);
});
test('unreadable caller --settings fails closed with typed redacted error', () => {
  assert.throws(
    () =>
      spawnWithAccount(
        ['--settings', join(work, 'missing.json')],
        { accounts: [] },
        {},
        { env: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' } },
      ),
    (e) => e.code === 'DIRECT_OAUTH_SETTINGS_COMPOSITION_FAILED' && !e.message.includes(work),
  );
});
