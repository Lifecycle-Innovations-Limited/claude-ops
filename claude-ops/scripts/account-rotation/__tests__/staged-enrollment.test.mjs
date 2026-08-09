#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  activateEnrollment,
  consumeApproval,
  createApprovalPayload,
  parseManifestBytes,
  readDeploymentConfig,
  sha256,
  signApproval,
  stageEnrollment,
  validateCandidateBytes,
  verifyApproval,
} from '../staged-enrollment.mjs';
import { automatedAuthAllowed } from '../auto-auth-policy.mjs';
import { reauth } from '../../ops-accounts/providers/claude.mjs';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const SECRET_VALUES = [
  'fake-access-token-SECRET',
  'fake-refresh-token-SECRET',
  'fake-id-token-SECRET',
  'oauth-state-SECRET',
  'oauth-code-SECRET',
  'magic-link-SECRET',
  'otp-SECRET',
];
const ENTRY = {
  id: 'claude-example-1',
  authFilename: 'claude-user-1.json',
  provider: 'claude',
  email: 'user1@example.com',
  organizationUuid: '00000000-0000-4000-8000-000000000001',
  organizationName: 'Example Organization 1',
  accountOwner: 'owner',
};
const claudeEntry = (n) => ({
  ...ENTRY,
  id: `claude-example-${n}`,
  authFilename: `claude-user-${n}.json`,
  email: `user${n}@example.com`,
  organizationUuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  organizationName: `Example Organization ${n}`,
});
const MANIFEST = {
  version: 1,
  entries: [
    ...Array.from({ length: 9 }, (_, i) => claudeEntry(i + 1)),
    {
      id: 'antigravity-1',
      authFilename: 'antigravity-one.json',
      provider: 'antigravity',
      opaque: { preserve: ' byte-for-byte ' },
    },
    ...Array.from({ length: 2 }, (_, i) => ({
      id: `codex-${i + 1}`,
      authFilename: `codex-${i + 1}.json`,
      provider: 'codex',
      metadata: ['untouched', i],
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `xai-${i + 1}`,
      authFilename: `xai-${i + 1}.json`,
      provider: 'xai',
      anything: { n: i },
    })),
  ],
};
const CANDIDATE = {
  access_token: SECRET_VALUES[0],
  account_uuid: 'account-uuid',
  claude_device_ids: ['a'.repeat(64)],
  disabled: false,
  email: ENTRY.email,
  expired: new Date(NOW + 3_600_000).toISOString(),
  expires_in: 3600,
  id_token: SECRET_VALUES[2],
  last_refresh: new Date(NOW - 1000).toISOString(),
  organization_name: ENTRY.organizationName,
  organization_uuid: ENTRY.organizationUuid,
  refresh_token: SECRET_VALUES[1],
  type: 'claude',
};
const refuses = (fn, code) => assert.throws(fn, new RegExp(code));

function fixture(format = JSON.stringify(MANIFEST, null, 2)) {
  const root = mkdtempSync(join(tmpdir(), 'staged-enrollment-'));
  const names = ['active', 'quarantine', 'quarantine2', 'staging', 'usage', 'rollback', 'locks'];
  const paths = Object.fromEntries(names.map((name) => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  const manifestPath = join(root, 'manifest.json');
  const candidatePath = join(root, 'candidate.json');
  const keyPath = join(root, 'approval.key');
  const approvalPath = join(root, 'approval.json');
  const configPath = join(root, 'deployment.json');
  writeFileSync(manifestPath, format, { mode: 0o600 });
  writeFileSync(candidatePath, JSON.stringify(CANDIDATE), { mode: 0o600 });
  writeFileSync(keyPath, 'K'.repeat(32), { mode: 0o600 });
  const digest = parseManifestBytes(readFileSync(manifestPath)).digest;
  const candidateDigest = sha256(readFileSync(candidatePath));
  const config = {
    manifestPath,
    approvalKeyPath: keyPath,
    usageDir: paths.usage,
    stagingDir: paths.staging,
    activeDir: paths.active,
    quarantineDirs: [paths.quarantine, paths.quarantine2],
    rollbackDir: paths.rollback,
    operationLockPath: join(paths.locks, 'operation.lock'),
    environment: 'controlled-test',
    authorizedOperator: 'operator',
    maxApprovalTtlMs: 300_000,
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const approval = (action, changes = {}, clock = {}) => {
    const payload = createApprovalPayload(
      {
        action,
        manifestDigest: digest,
        manifestEntryId: ENTRY.id,
        email: ENTRY.email,
        organizationUuid: ENTRY.organizationUuid,
        organizationName: ENTRY.organizationName,
        accountOwner: ENTRY.accountOwner,
        authorizedOperator: 'operator',
        environment: 'controlled-test',
        candidateDigest,
        writersQuiesced: action === 'activate' ? true : null,
        ...changes,
      },
      { now: clock.now ?? NOW, ttlMs: clock.ttlMs ?? 300_000 },
    );
    const artifact = signApproval(payload, readFileSync(keyPath));
    writeFileSync(approvalPath, JSON.stringify(artifact), { mode: 0o600 });
    return artifact;
  };
  const common = {
    manifestPath,
    entryId: ENTRY.id,
    approvalPath,
    keyPath,
    usageDir: paths.usage,
    stagingDir: paths.staging,
    activeDir: paths.active,
    quarantineDirs: [paths.quarantine, paths.quarantine2],
    rollbackDir: paths.rollback,
    operationLockPath: config.operationLockPath,
    environment: 'controlled-test',
    operator: 'operator',
    maxTtlMs: 300_000,
    now: NOW,
  };
  return {
    root,
    paths,
    manifestPath,
    candidatePath,
    keyPath,
    approvalPath,
    configPath,
    config,
    digest,
    candidateDigest,
    approval,
    common,
  };
}

// Raw-byte manifest digest, exact 15-entry topology, no parsed mutation.
{
  const raw = ` {\n  "version": 1, "entries": ${JSON.stringify(MANIFEST.entries)}\n}\n`;
  const before = JSON.parse(raw);
  const parsed = parseManifestBytes(Buffer.from(raw));
  assert.equal(parsed.digest, sha256(Buffer.from(raw)));
  assert.deepEqual(parsed.manifest, before);
  refuses(
    () => parseManifestBytes(JSON.stringify({ ...MANIFEST, entries: MANIFEST.entries.slice(1) })),
    'INVALID_MANIFEST',
  );
  refuses(
    () =>
      parseManifestBytes(
        JSON.stringify({
          ...MANIFEST,
          entries: [
            ...MANIFEST.entries.slice(0, -1),
            { id: 'codex-extra', authFilename: 'codex-extra.json', provider: 'codex' },
          ],
        }),
      ),
    'INVALID_PROVIDER_COUNTS',
  );
  refuses(
    () =>
      parseManifestBytes(
        JSON.stringify({
          ...MANIFEST,
          entries: MANIFEST.entries.map((e, i) => (i === 1 ? { ...e, authFilename: ENTRY.authFilename } : e)),
        }),
      ),
    'DUPLICATE_MANIFEST_BINDING',
  );
}

// Actual CLIProxy schema allowlist and structural/identity validation.
validateCandidateBytes(JSON.stringify(CANDIDATE), ENTRY, NOW);
validateCandidateBytes(
  JSON.stringify({ ...CANDIDATE, id_token: '', expired: '2030-01-01T01:00:00Z', last_refresh: '2029-12-31T23:59:59Z' }),
  ENTRY,
  NOW,
);
for (const mutation of [
  { disabled: true },
  { type: 'codex' },
  { expires_in: 0 },
  { expires_in: 1.5 },
  { expires_in: Number.MAX_SAFE_INTEGER + 1 },
  { expired: new Date(NOW - 1).toISOString() },
  { expired: '2030-01-01 01:00:00Z' },
  { expired: '2030-02-30T01:00:00Z' },
  { expired: '2100-02-29T01:00:00Z' },
  { expired: '2032-02-29T24:00:00Z' },
  { expired: '2032-02-29T01:00:00+24:00' },
  { email: 'Other@example.com' },
  { organization_uuid: 'wrong-organization' },
  { claude_device_ids: [] },
  { claude_device_ids: ['A'.repeat(64)] },
  { claude_device_ids: ['a'.repeat(63)] },
  { last_refresh: null },
  { last_refresh: 'not-a-time' },
  { last_refresh: '2029-02-29T23:59:59Z' },
  { extra: SECRET_VALUES[3] },
])
  refuses(() => validateCandidateBytes(JSON.stringify({ ...CANDIDATE, ...mutation }), ENTRY, NOW), 'INVALID|IDENTITY');
{
  const { refresh_token: _removed, ...missing } = CANDIDATE;
  refuses(() => validateCandidateBytes(JSON.stringify(missing), ENTRY, NOW), 'INVALID_SCHEMA');
}

// Config pins all trust roots and rejects permissions, missing roots and unsafe TTLs.
{
  const f = fixture();
  assert.deepEqual(readDeploymentConfig(f.configPath), f.config);
  chmodSync(f.configPath, 0o644);
  refuses(() => readDeploymentConfig(f.configPath), 'INSECURE_TRUST_ROOT');
}
// Physical trust roots cannot be aliased through a symlinked ancestor.
{
  const f = fixture();
  const alias = join(f.root, 'active-alias');
  symlinkSync(f.paths.active, alias);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, stagingDir: alias }), { mode: 0o600 });
  refuses(() => readDeploymentConfig(f.configPath), 'INSECURE_TRUST_ROOT');
}
// CLI-supplied candidate and approval artifacts reject symlinked ancestors too.
for (const kind of ['candidate', 'approval']) {
  const f = fixture();
  f.approval('stage');
  const alias = join(f.root, `${kind}-ancestor`);
  mkdirSync(alias, { mode: 0o700 });
  const realDir = join(f.root, `${kind}-real`);
  mkdirSync(realDir, { mode: 0o700 });
  const source = kind === 'candidate' ? f.candidatePath : f.approvalPath;
  const name = kind === 'candidate' ? 'candidate.json' : 'approval.json';
  writeFileSync(join(realDir, name), readFileSync(source), { mode: 0o600 });
  rmdirSync(alias);
  symlinkSync(realDir, alias);
  refuses(
    () =>
      stageEnrollment({
        ...f.common,
        candidatePath: kind === 'candidate' ? join(alias, name) : f.candidatePath,
        approvalPath: kind === 'approval' ? join(alias, name) : f.approvalPath,
      }),
    'INSECURE_TRUST_ROOT',
  );
}
for (const ttl of [0, Infinity, 900_001]) {
  const f = fixture();
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, maxApprovalTtlMs: ttl }), { mode: 0o600 });
  refuses(() => readDeploymentConfig(f.configPath), 'INVALID');
}
for (const mutate of [
  (f) => ({ ...f.config, activeDir: 'relative' }),
  (f) => ({ ...f.config, stagingDir: f.paths.active }),
  (f) => ({ ...f.config, rollbackDir: join(f.paths.active, 'nested') }),
  (f) => ({ ...f.config, quarantineDirs: [f.paths.quarantine, f.paths.quarantine] }),
  (f) => ({ ...f.config, operationLockPath: join(f.paths.active, 'operation.lock') }),
]) {
  const f = fixture();
  writeFileSync(f.configPath, JSON.stringify(mutate(f)), { mode: 0o600 });
  refuses(() => readDeploymentConfig(f.configPath), 'INVALID_CONFIG|MISSING_TRUST_ROOT');
}
{
  const f = fixture();
  f.config.quarantineDirs.push(join(f.root, 'missing'));
  writeFileSync(f.configPath, JSON.stringify(f.config), { mode: 0o600 });
  f.approval('stage');
  refuses(
    () => stageEnrollment({ ...f.common, quarantineDirs: f.config.quarantineDirs, candidatePath: f.candidatePath }),
    'MISSING_TRUST_ROOT',
  );
}
{
  const f = fixture();
  const realKey = join(f.root, 'real.key');
  writeFileSync(realKey, 'K'.repeat(32), { mode: 0o600 });
  unlinkSync(f.keyPath);
  symlinkSync(realKey, f.keyPath);
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'INSECURE_TRUST_ROOT');
}

// Stage preserves six cross-brand records exactly, consumes once, and publishes no-replace.
{
  const f = fixture();
  const files = Array.from({ length: 6 }, (_, i) => join(f.paths.active, `codex-brand-${i}.json`));
  files.forEach((path, i) => writeFileSync(path, ` {"type":"codex","opaque":"${i}"}\n`, { mode: 0o600 }));
  const before = files.map((path) => readFileSync(path));
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  assert.deepEqual(
    files.map((path) => readFileSync(path)),
    before,
  );
  const replay = f.approval('stage', { id: 'replay-id', nonce: 'replay-nonce' });
  consumeApproval(replay.payload, f.paths.usage);
  refuses(() => consumeApproval(replay.payload, f.paths.usage), 'APPROVAL_REPLAY');
}
// The actual stage approval cannot be replayed.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  unlinkSync(join(f.paths.staging, ENTRY.authFilename));
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'APPROVAL_REPLAY');
}
{
  const f = fixture();
  writeFileSync(join(f.paths.staging, ENTRY.authFilename), 'occupied', { mode: 0o600 });
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'STAGE_TARGET_EXISTS|MALFORMED');
}
{
  const f = fixture();
  writeFileSync(f.common.operationLockPath, 'held', { mode: 0o600 });
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'OPERATION_LOCKED');
}

// Recursive duplicate and symlink/ambiguous inventories fail closed.
{
  const f = fixture();
  const nested = join(f.paths.quarantine, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  writeFileSync(join(nested, 'other.json'), JSON.stringify(CANDIDATE), { mode: 0o600 });
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'DUPLICATE_IDENTITY');
}
{
  const f = fixture();
  const nested = join(f.paths.quarantine, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  writeFileSync(join(nested, ENTRY.authFilename), JSON.stringify(CANDIDATE), { mode: 0o600 });
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'DUPLICATE_IDENTITY');
}
{
  const f = fixture();
  symlinkSync(f.candidatePath, join(f.paths.quarantine, 'link.json'));
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'UNSAFE_INVENTORY');
}
{
  const f = fixture();
  writeFileSync(join(f.paths.active, 'ambiguous.json'), JSON.stringify({ ...CANDIDATE, provider: 'codex' }), {
    mode: 0o600,
  });
  f.approval('stage');
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'AMBIGUOUS_INVENTORY');
}

// Raw formatting-only CAS and pre-consumption failures leave approvals reusable.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  refuses(
    () =>
      activateEnrollment({
        ...f.common,
        beforeCas: () => writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath)}\n`),
      }),
    'MANIFEST_CAS_FAILED',
  );
  writeFileSync(f.manifestPath, readFileSync(f.manifestPath, 'utf8').trimEnd(), { mode: 0o600 });
  const receipt = activateEnrollment(f.common);
  assert.equal(receipt.candidateDigest, f.candidateDigest);
}
// A target-present stale CAS leaves both approval and rollback directory untouched.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  writeFileSync(join(f.paths.active, ENTRY.authFilename), JSON.stringify({ ...CANDIDATE, access_token: 'old' }), {
    mode: 0o600,
  });
  f.approval('activate');
  refuses(
    () =>
      activateEnrollment({
        ...f.common,
        beforeCas: () => writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath)}\n`),
      }),
    'MANIFEST_CAS_FAILED',
  );
  assert.deepEqual(readdirSync(f.paths.rollback), []);
  writeFileSync(f.manifestPath, readFileSync(f.manifestPath, 'utf8').trimEnd(), { mode: 0o600 });
  assert.equal(activateEnrollment(f.common).ok, true);
}
// Activation approval is bound to the exact staged candidate bytes.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate', { candidateDigest: '0'.repeat(64) });
  refuses(() => activateEnrollment(f.common), 'APPROVAL_BINDING_MISMATCH');
}

// Approval authentication, clock, action, and binding checks fail closed.
{
  const f = fixture();
  const artifact = f.approval('stage');
  const expected = {
    action: 'stage',
    manifestDigest: f.digest,
    manifestEntryId: ENTRY.id,
    provider: 'claude',
    email: ENTRY.email,
    organizationUuid: ENTRY.organizationUuid,
    organizationName: ENTRY.organizationName,
    accountOwner: ENTRY.accountOwner,
    authorizedOperator: 'operator',
    environment: 'controlled-test',
    candidateDigest: null,
    writersQuiesced: null,
  };
  const verify = (a = artifact, e = expected, now = NOW) =>
    verifyApproval({ artifact: a, keyPath: f.keyPath, expected: e, now, maxTtlMs: 300_000 });
  verify();
  refuses(() => verify({ ...artifact, signature: '0'.repeat(64) }), 'INVALID_SIGNATURE');
  for (const [key, value] of [
    ['action', 'activate'],
    ['environment', 'wrong'],
    ['organizationUuid', 'wrong'],
  ])
    refuses(() => verify(artifact, { ...expected, [key]: value }), 'APPROVAL_BINDING_MISMATCH');
  refuses(() => verify(artifact, expected, NOW + 300_001), 'INVALID_APPROVAL_CLOCK');
  const future = f.approval('stage', {}, { now: NOW + 1 });
  refuses(() => verify(future), 'INVALID_APPROVAL_CLOCK');
  const overlong = signApproval(
    { ...artifact.payload, expiresAt: new Date(NOW + 300_001).toISOString() },
    readFileSync(f.keyPath),
  );
  refuses(() => verify(overlong), 'INVALID_APPROVAL_CLOCK');
  for (const timestamp of [
    '2030-01-01 00:00:00Z',
    '2030-01-01T00:00:00',
    '2030-02-31T00:00:00Z',
    '2030-01-01T24:00:00Z',
    '2030-01-01T00:00:00+24:00',
  ]) {
    const invalidIssuedAt = signApproval({ ...artifact.payload, issuedAt: timestamp }, readFileSync(f.keyPath));
    refuses(() => verify(invalidIssuedAt), 'INVALID_APPROVAL_CLOCK');
    const invalidExpiresAt = signApproval({ ...artifact.payload, expiresAt: timestamp }, readFileSync(f.keyPath));
    refuses(() => verify(invalidExpiresAt), 'INVALID_APPROVAL_CLOCK');
  }
  writeFileSync(f.keyPath, 'short', { mode: 0o600 });
  refuses(() => verify(), 'APPROVAL_KEY_TOO_SHORT');
}

// Rollback at each injected boundary, with target present and absent.
for (const injection of [
  'before-rename',
  'initial-rename-failure',
  'after-rename-before-dir-fsync',
  'after-source-dir-fsync',
  'after-digest-verification',
]) {
  for (const present of [false, true]) {
    const f = fixture();
    f.approval('stage');
    stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
    const target = join(f.paths.active, ENTRY.authFilename);
    const old = JSON.stringify({ ...CANDIDATE, access_token: 'old-synthetic-value' });
    if (present) writeFileSync(target, old, { mode: 0o600 });
    f.approval('activate');
    refuses(
      () => activateEnrollment({ ...f.common, injectFailure: injection }),
      'INJECTED_FAILURE|ACTIVATION_ROLLED_BACK',
    );
    assert.equal(existsSync(target), present);
    if (present) assert.equal(readFileSync(target, 'utf8'), old);
  }
}

// A rollback fsync failure reports the stable unproven-recovery code while still restoring bytes.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'durable-old-value' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  refuses(
    () => activateEnrollment({ ...f.common, injectFailure: 'rollback-fsync-failure' }),
    'ACTIVATION_ROLLBACK_FAILED',
  );
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.equal(sha256(readFileSync(join(f.paths.staging, ENTRY.authFilename))), f.candidateDigest);
}

// Real CLI is secret-safe for malformed candidates and secret-bearing paths.
{
  const f = fixture();
  f.approval('stage');
  const secretPath = join(f.root, SECRET_VALUES.slice(3).join('-'));
  writeFileSync(secretPath, `{ "access_token":"${SECRET_VALUES[0]}", "refresh_token":"${SECRET_VALUES[1]}"`, {
    mode: 0o600,
  });
  const cli = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const r = spawnSync(
    process.execPath,
    [
      cli,
      'stage',
      '--config',
      f.configPath,
      '--entry',
      ENTRY.id,
      '--approval',
      f.approvalPath,
      '--candidate',
      secretPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  const output = `${r.stdout}${r.stderr}`;
  SECRET_VALUES.forEach((secret) => assert(!output.includes(secret)));
  assert.match(output, /^staged enrollment refused: [A-Z_]+\n$/);
  const override = spawnSync(
    process.execPath,
    [
      cli,
      'activate',
      '--config',
      f.configPath,
      '--entry',
      ENTRY.id,
      '--approval',
      f.approvalPath,
      '--active-dir',
      secretPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(override.status, 1);
  assert.match(override.stderr, /INVALID_ARGUMENTS/);
}

// Legacy auth entrypoints and behavioral blocks.
assert.equal(automatedAuthAllowed({ autoAuthDisabled: true, explicitFilter: true }), false);
assert.equal((await reauth({ dryRun: false }, { accountId: ENTRY.email })).ok, false);
const wrapper = spawnSync(
  process.execPath,
  [join(import.meta.dirname, '..', 'rotate-magic.mjs'), '--to', ENTRY.email],
  { encoding: 'utf8' },
);
assert.equal(wrapper.status, 2);
// Retired direct credential creation entrypoints fail before filesystem or child-command side effects.
{
  const f = fixture();
  const home = join(f.root, 'isolated-home');
  const bin = join(f.root, 'mock-bin');
  const marker = join(f.root, 'child-side-effect');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  for (const command of ['aws', 'claude', 'gog', 'expect', 'open']) {
    const mock = join(bin, command);
    writeFileSync(mock, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const scripts = [
    ['bulk-setup-token.mjs'],
    ['setup-account.mjs', '--email', ENTRY.email],
    ['rotate.mjs', '--bootstrap-chrome-profile', ENTRY.email],
    ['rotate.mjs', '--bootstrap-all-chrome-profiles'],
  ];
  for (const [name, ...args] of scripts) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', name), ...args], {
      encoding: 'utf8',
      env,
    });
    assert.notEqual(result.status, 0, name);
    assert.equal(existsSync(marker), false, `${name} spawned a side-effect command`);
    assert.deepEqual(readdirSync(home), [], `${name} wrote under HOME`);
  }
}
const sources = Object.fromEntries(
  [
    'rotate.mjs',
    'rotate-magic.mjs',
    'refresh-tokens.mjs',
    'magic-link-autoloop.mjs',
    'force-rotate.sh',
    '../ops-accounts/providers/claude.mjs',
  ].map((name) => [name, readFileSync(join(import.meta.dirname, '..', name), 'utf8')]),
);
assert.doesNotMatch(sources['force-rotate.sh'], /fall(?:ing)?\s+back\s+to\s+(?:the\s+)?(?:full\s+)?browser/i);
for (const line of sources['force-rotate.sh']
  .split('\n')
  .filter((line) => /run_with_watchdog\s+node.*rotate\.mjs/.test(line)))
  assert.match(line, /--no-browser/);

// A failed force rotation launches only the browserless writer, exits nonzero,
// and never emits the success notification.
{
  const root = mkdtempSync(join(tmpdir(), 'force-rotate-'));
  const bin = join(root, 'bin');
  const data = join(root, 'data');
  const calls = join(root, 'calls');
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  for (const [name, body] of [
    ['node', `#!/bin/sh\necho "node $*" >>"${calls}"\ncase " $* " in *" --status "*) exit 0;; *) exit 9;; esac\n`],
    ['launchctl', '#!/bin/sh\nexit 0\n'],
    ['security', '#!/bin/sh\nexit 1\n'],
    ['osascript', `#!/bin/sh\necho osascript >>"${calls}"\nexit 0\n`],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, body, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const run = spawnSync('bash', [join(import.meta.dirname, '..', 'force-rotate.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_ROTATION_DATA_DIR: data,
      FORCE_ROTATE_TIMEOUT: '2',
    },
  });
  assert.notEqual(run.status, 0);
  const launched = readFileSync(calls, 'utf8');
  assert.equal(
    launched.split('\n').filter((line) => line.includes('rotate.mjs') && !line.includes('--status')).length,
    1,
  );
  assert.match(launched, /--no-browser/);
  assert.doesNotMatch(launched, /osascript/);
}
const refreshBody = sources['rotate.mjs'].slice(
  sources['rotate.mjs'].indexOf('async function refreshRunningSession'),
  sources['rotate.mjs'].indexOf('// ── Main rotation'),
);
assert.doesNotMatch(refreshBody, /runAuthFlow\s*\(/);
for (const name of [
  'rotate-magic.mjs',
  'refresh-tokens.mjs',
  'magic-link-autoloop.mjs',
  '../ops-accounts/providers/claude.mjs',
])
  assert.doesNotMatch(
    sources[name],
    /spawn(?:Sync)?\s*\([^)]*(?:rotate\.mjs|runAuthFlow)|execFileSync\s*\([^)]*rotate\.mjs/s,
  );

console.log('staged-enrollment.test.mjs: ok');
