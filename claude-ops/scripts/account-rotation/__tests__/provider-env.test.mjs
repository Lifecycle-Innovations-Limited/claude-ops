/**
 * provider-env tests (node --test).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/provider-env.test.mjs
 *
 * Covers: bedrockModelToOAuth mapping (us./eu./apac./global./plain/versioned/
 * unknown), scrubBedrockEnv removing every key, applyOAuthEnv (token added +
 * Bedrock vars removed), applyBedrockEnv (Bedrock vars set + OAuth dropped).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEDROCK_ENV_KEYS,
  scrubBedrockEnv,
  bedrockModelToOAuth,
  applyOAuthEnv,
  applyBedrockEnv,
} from '../provider-env.mjs';

test('bedrockModelToOAuth: us. region-profile prefix', () => {
  assert.equal(bedrockModelToOAuth('us.anthropic.claude-fable-5'), 'claude-fable-5');
});

test('bedrockModelToOAuth: eu. region-profile prefix', () => {
  assert.equal(bedrockModelToOAuth('eu.anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('bedrockModelToOAuth: apac. + global. prefixes', () => {
  assert.equal(bedrockModelToOAuth('apac.anthropic.claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(bedrockModelToOAuth('global.anthropic.claude-opus-4-1'), 'claude-opus-4-1');
});

test('bedrockModelToOAuth: plain anthropic. prefix (no region)', () => {
  assert.equal(bedrockModelToOAuth('anthropic.claude-fable-5'), 'claude-fable-5');
});

test('bedrockModelToOAuth: versioned -vN:N suffix stripped', () => {
  assert.equal(bedrockModelToOAuth('anthropic.claude-fable-5-v1:0'), 'claude-fable-5');
  assert.equal(bedrockModelToOAuth('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'claude-opus-4-1-20250805');
});

test('bedrockModelToOAuth: already-plain claude id passes through', () => {
  assert.equal(bedrockModelToOAuth('claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('bedrockModelToOAuth: unknown / non-claude returns null', () => {
  assert.equal(bedrockModelToOAuth('us.amazon.nova-pro-v1:0'), null);
  assert.equal(bedrockModelToOAuth('gpt-4o'), null);
  assert.equal(bedrockModelToOAuth(''), null);
  assert.equal(bedrockModelToOAuth(null), null);
  assert.equal(bedrockModelToOAuth(undefined), null);
});

test('scrubBedrockEnv: removes every BEDROCK_ENV_KEY, preserves the rest', () => {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_BEDROCK_REGION: 'us-east-1',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_PROFILE: 'default',
    AWS_DEFAULT_PROFILE: 'default',
    AWS_ACCESS_KEY_ID: 'AKIA...',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'token',
    ANTHROPIC_MODEL: 'anthropic.claude-fable-5',
    ANTHROPIC_SMALL_FAST_MODEL: 'anthropic.claude-haiku',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 's',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'o',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'f',
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'keep-me',
  };
  const returned = scrubBedrockEnv(env);
  assert.equal(returned, env, 'mutates and returns the same object');
  for (const k of BEDROCK_ENV_KEYS) {
    assert.equal(k in env, false, `${k} should be deleted`);
  }
  assert.equal(env.PATH, '/usr/bin', 'unrelated vars preserved');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'keep-me', 'OAuth token preserved');
});

test('scrubBedrockEnv: tolerates null/non-object', () => {
  assert.equal(scrubBedrockEnv(null), null);
  assert.equal(scrubBedrockEnv(undefined), undefined);
});

test('applyOAuthEnv: adds token, removes USE_BEDROCK + ANTHROPIC_MODEL + AWS_*', () => {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIA...',
    ANTHROPIC_MODEL: 'anthropic.claude-fable-5',
    PATH: '/usr/bin',
  };
  applyOAuthEnv(env, 'oauth-abc123');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-abc123');
  assert.equal('CLAUDE_CODE_USE_BEDROCK' in env, false);
  assert.equal('AWS_REGION' in env, false);
  assert.equal('AWS_ACCESS_KEY_ID' in env, false);
  assert.equal('ANTHROPIC_MODEL' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('applyBedrockEnv: sets Bedrock vars, drops OAuth token, default region+model', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'old', PATH: '/usr/bin' };
  applyBedrockEnv(env);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.AWS_BEDROCK_REGION, 'us-east-1');
  assert.equal(env.AWS_REGION, 'us-east-1');
  assert.equal(env.ANTHROPIC_MODEL, 'anthropic.claude-fable-5');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('applyBedrockEnv: honors region + model override', () => {
  const env = {};
  applyBedrockEnv(env, 'eu-west-1', { primary: 'eu.anthropic.claude-sonnet-4-6' });
  assert.equal(env.AWS_REGION, 'eu-west-1');
  assert.equal(env.AWS_BEDROCK_REGION, 'eu-west-1');
  assert.equal(env.ANTHROPIC_MODEL, 'eu.anthropic.claude-sonnet-4-6');
});
