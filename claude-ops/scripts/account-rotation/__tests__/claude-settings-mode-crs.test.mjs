/**
 * claude-settings-mode CRS-awareness tests (node --test).
 *
 * Run: node --test claude-ops/scripts/account-rotation/__tests__/claude-settings-mode-crs.test.mjs
 *
 * Guards the money-leak fix: a CRS-routed box (cr_ token + ANTHROPIC_BASE_URL)
 * must never be flipped onto metered Bedrock, and an OAuth-mode flip must keep
 * the CRS relay pair intact (a cr_ token with no base URL 401s the relay).
 *
 * These functions read/write ~/.claude/settings.json via $HOME, so each test
 * points HOME at a fresh temp dir. persistBedrockClaudeSettings on a CRS box
 * throws BEFORE any `aws` exec, so no AWS mocking is needed for that path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { persistBedrockClaudeSettings, clearHardcodedModelsForOAuthClaudeSettings } from '../claude-settings-mode.mjs';

const CRS_BASE = 'http://127.0.0.1:3005/api';
const CRS_TOKEN = 'cr_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function withTempHome(initialEnv) {
  const home = mkdtempSync(join(tmpdir(), 'crs-settings-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: initialEnv }, null, 2));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  return {
    readEnv() {
      return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).env || {};
    },
    cleanup() {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('clearHardcodedModelsForOAuth: preserves CRS relay pair across Bedrock→OAuth flip', () => {
  const ctx = withTempHome({
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'us-east-1',
    ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
    ANTHROPIC_BASE_URL: CRS_BASE,
    CLAUDE_CODE_OAUTH_TOKEN: CRS_TOKEN,
  });
  try {
    clearHardcodedModelsForOAuthClaudeSettings();
    const env = ctx.readEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, CRS_BASE, 'CRS base URL restored');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CRS_TOKEN, 'CRS token retained');
    assert.equal('CLAUDE_CODE_USE_BEDROCK' in env, false, 'Bedrock flag cleared');
    assert.equal('ANTHROPIC_MODEL' in env, false, 'hardcoded model cleared');
    assert.equal('AWS_REGION' in env, false, 'AWS region cleared');
  } finally {
    ctx.cleanup();
  }
});

test('clearHardcodedModelsForOAuth: non-CRS box still strips ANTHROPIC_BASE_URL (regression)', () => {
  const ctx = withTempHome({
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://some-proxy.example/api',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-not-a-relay-token',
    ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
  });
  try {
    clearHardcodedModelsForOAuthClaudeSettings();
    const env = ctx.readEnv();
    assert.equal('ANTHROPIC_BASE_URL' in env, false, 'non-cr_ base URL stripped (raw OAuth)');
    assert.equal('CLAUDE_CODE_USE_BEDROCK' in env, false);
  } finally {
    ctx.cleanup();
  }
});

test('persistBedrockClaudeSettings: refuses to flip a CRS-routed box onto Bedrock', () => {
  const ctx = withTempHome({
    ANTHROPIC_BASE_URL: CRS_BASE,
    CLAUDE_CODE_OAUTH_TOKEN: CRS_TOKEN,
  });
  try {
    assert.throws(() => persistBedrockClaudeSettings('us-east-1'), /CRS-routed/, 'throws on CRS box');
    const env = ctx.readEnv();
    // settings must be untouched — no Bedrock vars written, CRS pair intact.
    assert.equal('CLAUDE_CODE_USE_BEDROCK' in env, false, 'no Bedrock flag written');
    assert.equal(env.ANTHROPIC_BASE_URL, CRS_BASE, 'CRS base URL untouched');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CRS_TOKEN, 'CRS token untouched');
  } finally {
    ctx.cleanup();
  }
});

test('persistBedrockClaudeSettings: CLAUDE_ALLOW_BEDROCK_OVER_CRS=1 overrides the refusal', () => {
  const ctx = withTempHome({
    ANTHROPIC_BASE_URL: CRS_BASE,
    CLAUDE_CODE_OAUTH_TOKEN: CRS_TOKEN,
  });
  const prev = process.env.CLAUDE_ALLOW_BEDROCK_OVER_CRS;
  const prevSkip = process.env.BEDROCK_SKIP_RESOLVE;
  process.env.CLAUDE_ALLOW_BEDROCK_OVER_CRS = '1';
  process.env.BEDROCK_SKIP_RESOLVE = '1'; // avoid live `aws bedrock` calls in CI
  try {
    persistBedrockClaudeSettings('us-east-1');
    const env = ctx.readEnv();
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', 'override allows Bedrock flip');
    assert.equal('ANTHROPIC_BASE_URL' in env, false, 'base URL dropped when overridden onto Bedrock');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_ALLOW_BEDROCK_OVER_CRS;
    else process.env.CLAUDE_ALLOW_BEDROCK_OVER_CRS = prev;
    if (prevSkip === undefined) delete process.env.BEDROCK_SKIP_RESOLVE;
    else process.env.BEDROCK_SKIP_RESOLVE = prevSkip;
    ctx.cleanup();
  }
});
