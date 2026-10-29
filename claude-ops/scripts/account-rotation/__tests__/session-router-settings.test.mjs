import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyDirectOauthSettings } from '../session-router.mjs';

const TG = '{"enabledPlugins":{"telegram@claude-plugins-official":false}}';
const CRED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

test('no caller --settings: appends the shared override file', () => {
  const out = applyDirectOauthSettings(['-p', 'hi']);
  assert.equal(out[out.length - 2], '--settings');
  const doc = JSON.parse(readFileSync(out[out.length - 1], 'utf8'));
  for (const k of CRED_KEYS) assert.equal(doc.env[k], '');
});

test('caller inline --settings: keeps telegram disable and adds credential overrides', () => {
  const out = applyDirectOauthSettings(['--settings', TG, '-p', 'hi']);
  const doc = JSON.parse(readFileSync(out[1], 'utf8'));
  assert.equal(doc.enabledPlugins['telegram@claude-plugins-official'], false);
  for (const k of CRED_KEYS) assert.equal(doc.env[k], '');
  assert.deepEqual(out.slice(2), ['-p', 'hi']);
});

test('--settings=VALUE form is merged too', () => {
  const out = applyDirectOauthSettings([`--settings=${TG}`, '-p']);
  assert.ok(out[0].startsWith('--settings=') && !out[0].includes('{'));
  const doc = JSON.parse(readFileSync(out[0].slice('--settings='.length), 'utf8'));
  assert.equal(doc.enabledPlugins['telegram@claude-plugins-official'], false);
  assert.equal(doc.env.ANTHROPIC_API_KEY, '');
});

test('unparseable caller --settings is left untouched', () => {
  const args = ['--settings', '/nonexistent/x.json', '-p'];
  assert.deepEqual(applyDirectOauthSettings(args), args);
});
