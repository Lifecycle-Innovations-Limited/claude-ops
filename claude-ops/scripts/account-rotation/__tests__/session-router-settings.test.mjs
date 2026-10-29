import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { applyDirectOauthSettings } from '../session-router.mjs';

const TG = '{"enabledPlugins":{"telegram@claude-plugins-official":false}}';
const CRED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// Exactly one settings option; returns its parsed document and path, then removes the file.
function settingsOf(out) {
  const hits = out.filter((a) => a === '--settings' || a.startsWith('--settings='));
  assert.equal(hits.length, 1, 'exactly one --settings');
  const i = out.findIndex((a) => a === '--settings' || a.startsWith('--settings='));
  const path = out[i] === '--settings' ? out[i + 1] : out[i].slice('--settings='.length);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  unlinkSync(path);
  return doc;
}

test('no caller --settings: adds the credential overlay', () => {
  const doc = settingsOf(applyDirectOauthSettings(['-p', 'hi']));
  for (const k of CRED_KEYS) assert.equal(doc.env[k], '');
});

test('caller inline --settings: keeps telegram disable and adds credential overrides', () => {
  const out = applyDirectOauthSettings(['--settings', TG, '-p', 'hi']);
  assert.deepEqual(out.slice(2), ['-p', 'hi']);
  const doc = settingsOf(out);
  assert.equal(doc.enabledPlugins['telegram@claude-plugins-official'], false);
  for (const k of CRED_KEYS) assert.equal(doc.env[k], '');
});

test('--settings=VALUE form is merged too', () => {
  const out = applyDirectOauthSettings([`--settings=${TG}`, '-p']);
  const doc = settingsOf(out);
  assert.equal(doc.enabledPlugins['telegram@claude-plugins-official'], false);
  assert.equal(doc.env.ANTHROPIC_API_KEY, '');
});

test('unreadable caller --settings fails closed with a typed, redacted error', () => {
  assert.throws(
    () => applyDirectOauthSettings(['--settings', '/nonexistent/x.json', '-p']),
    (e) => e.code === 'DIRECT_OAUTH_SETTINGS_COMPOSITION_FAILED' && !e.message.includes('/nonexistent'),
  );
});
