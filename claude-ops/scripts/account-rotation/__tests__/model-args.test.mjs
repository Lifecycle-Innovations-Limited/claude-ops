#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeClaudeModelArgs, normalizeClaudeModelValue } from '../model-args.mjs';

const accountRotationDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = dirname(accountRotationDir);

for (const stale of ['fable', 'FABLE', 'fable[1m]', 'claude-fable-5', 'claude-fable-5[1m]']) {
  assert.equal(normalizeClaudeModelValue(stale), 'gpt-5.4');
}

for (const supported of ['opus', 'opus[1m]', 'gpt-5.4', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
  assert.equal(normalizeClaudeModelValue(supported), supported);
}

assert.deepEqual(normalizeClaudeModelArgs(['-p', 'hello', '--model', 'fable[1m]', '--effort', 'high']), [
  '-p',
  'hello',
  '--model',
  'gpt-5.4',
  '--effort',
  'high',
]);
assert.deepEqual(normalizeClaudeModelArgs(['--model=claude-fable-5', '--model', 'claude-sonnet-4-6']), [
  '--model=gpt-5.4',
  '--model',
  'claude-sonnet-4-6',
]);

const temp = mkdtempSync(join(tmpdir(), 'launch-claude-model-'));
const fakeClaude = join(temp, 'bin', 'claude');
const capturedArgs = join(temp, 'captured-args.json');
mkdirSync(dirname(fakeClaude), { recursive: true });
writeFileSync(
  fakeClaude,
  `#!/bin/sh\nprintf '%s\\n' "$@" | node -e "const fs=require('fs');const lines=fs.readFileSync(0,'utf8').trimEnd().split('\\n');fs.writeFileSync(process.env.CAPTURED_ARGS,JSON.stringify(lines));"\n`,
);
chmodSync(fakeClaude, 0o700);
const launched = spawnSync(process.execPath, [join(scriptsDir, 'launch-claude.mjs'), 'status', '--model=fable[1m]'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: temp,
    CLAUDE_REAL_BIN: fakeClaude,
    CAPTURED_ARGS: capturedArgs,
    ADMISSION_FORCE: '1',
  },
});
assert.equal(launched.status, 0, launched.stderr);
const launchedArgs = JSON.parse(readFileSync(capturedArgs, 'utf8'));
assert.equal(launchedArgs.includes('--model=gpt-5.4'), true);
assert.equal(
  launchedArgs.some((arg) => /fable/i.test(arg)),
  false,
);

const launcherSource = readFileSync(join(scriptsDir, 'launch-claude.mjs'), 'utf8');
assert.match(launcherSource, /const rawArgs = normalizeClaudeModelArgs\(process\.argv\.slice\(2\)\);/);
assert.ok(
  launcherSource.indexOf('normalizeClaudeModelArgs(process.argv.slice(2))') <
    launcherSource.indexOf('spawnSync(CLAUDE_BIN, args'),
  'launcher normalizes raw CLI args before spawning Claude',
);

const respawnSource = readFileSync(join(scriptsDir, 'bg-respawn.mjs'), 'utf8');
assert.match(respawnSource, /const flags = originalFlags \? normalizeClaudeModelArgs\(originalFlags\) : null;/);
assert.ok(
  respawnSource.indexOf('state.respawnFlags = flags') <
    respawnSource.indexOf("execFileSync(claudeBin(), ['respawn', String(session.id)]"),
  'background respawn persists normalized flags before claude respawn',
);

console.log('Claude model argument normalization tests: PASS');
