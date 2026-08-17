#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node --input-type=module - "$ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.argv[2];
const policy = await import(pathToFileURL(join(root, 'scripts/account-rotation/auto-auth-policy.mjs')));

assert.equal(policy.directOAuthWriterAllowed('cliproxy'), false);
assert.equal(policy.directOAuthWriterAllowed('unknown'), false);
assert.equal(policy.directOAuthWriterAllowed('claude-code'), false);
assert.equal(policy.directOAuthWriterAllowed('manual-setup'), false);
assert.equal(policy.directOAuthWriterAllowed('magic-link'), false);
assert.equal(policy.directOAuthWriterAllowed(), false);
assert.equal(policy.automatedAuthAllowed(), false);
assert.equal(policy.automatedAuthAllowed({}), false);
assert.equal(policy.automatedAuthAllowed({ automatedCredentialMutation: false }), false);
assert.equal(policy.automatedAuthAllowed({ automatedCredentialMutation: true }), false);
assert.equal(policy.automatedAuthAllowed({ automatedCredentialMutation: true, autoAuthDisabled: true }), false);

// Default-denied refresh performs no OAuth request subprocess and leaves the
// credential vault byte-identical, even for an otherwise configured account.
const temp = mkdtempSync(join(tmpdir(), 'default-denied-refresh-'));
const bin = join(temp, 'bin');
mkdirSync(bin);
const subprocessMarker = join(temp, 'auth-subprocess-spawned');
for (const name of ['security', 'claude']) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho spawned > ${JSON.stringify(subprocessMarker)}\nexit 91\n`, { mode: 0o700 });
}
const config = join(temp, 'config.json');
const vault = join(temp, 'vault.json');
writeFileSync(config, JSON.stringify({ accounts: [{ email: 'denied@example.com', orgUuid: 'org', orgName: 'Org' }] }));
const original = Buffer.from('{\n  "Claude-Rotation-denied@example.com": "opaque-credential-bytes"\n}\n');
writeFileSync(vault, original, { mode: 0o600 });
const denied = spawnSync(process.execPath, [join(root, 'scripts/account-rotation/refresh-tokens.mjs')], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: temp,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_ROTATOR_CONFIG: config,
    CLAUDE_ROTATION_FILE_VAULT: vault,
  },
});
assert.equal(denied.status, 0, denied.stderr);
assert.deepEqual(readFileSync(vault), original);
assert.equal(denied.stdout.includes('automatic credential mutation not approved'), true);
assert.equal(existsSync(subprocessMarker), false);

// Setup and magic-link entrypoints refuse before config/runtime reads and
// before an executable can mutate the canonical Claude credential.
for (const authArg of ['--setup', '--magic-link']) {
  const setupMarker = join(temp, `setup-${authArg.slice(2)}-spawned`);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho spawned > ${JSON.stringify(setupMarker)}\nexit 91\n`, { mode: 0o700 });
  const before = readFileSync(vault);
  const setup = spawnSync(process.execPath, [join(root, 'scripts/account-rotation/rotate.mjs'), authArg], {
    encoding: 'utf8',
    env: { ...process.env, HOME: temp, PATH: `${bin}:${process.env.PATH}`, CLAUDE_ROTATION_FILE_VAULT: vault },
  });
  assert.equal(setup.status, 2, setup.stderr);
  assert.match(setup.stderr, /authentication is disabled/);
  assert.equal(existsSync(setupMarker), false);
  assert.deepEqual(readFileSync(vault), before);
}

console.log('CLIProxy direct-writer policy tests: PASS');
NODE
