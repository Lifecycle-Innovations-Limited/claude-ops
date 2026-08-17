#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  activateEnrollment,
  canonicalJson,
  consumeApproval,
  createApprovalPayload,
  parseManifestBytes,
  readDeploymentConfig,
  recoverEnrollment,
  rollbackEnrollment,
  sha256,
  signApproval,
  stageEnrollment,
  validateCandidateBytes,
  verifyApproval,
  withOperationLock,
} from '../staged-enrollment.mjs';
import { automatedAuthAllowed } from '../auto-auth-policy.mjs';
import { reauth } from '../../ops-accounts/providers/claude.mjs';
import { verifyRefreshedTokenIdentity } from '../token-identity.mjs';
import { parseStrictJson } from '../strict-json.mjs';
import { requireWriterCapability, withAuthWriterLock } from '../auth-writer-coordination.mjs';
import { writeRotationTokenCoordinated } from '../rotation-vault.mjs';

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
const childResult = (child) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/**
 * Leading state letter from `ps -o state=`, with the flag characters dropped.
 *
 * BSD ps appends flags to the state field: `+` foreground process group, `s`
 * session leader, `N` reduced priority, `<` raised priority. A stopped child on
 * macOS therefore reads `TN` or `T+`, never a bare `T`, so comparing the whole
 * field to 'T' could never match and every waitForStoppedChild call timed out
 * after 5s. Linux CI reports a bare `T`, which is why this only failed locally.
 */
const childProcessState = (child) =>
  spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], { encoding: 'utf8' })
    .stdout.trim()
    .charAt(0);
const waitForStoppedChild = (child, label) => waitFor(() => childProcessState(child) === 'T', label);
const signalChild = (child, signal) => {
  try {
    process.kill(child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};

function fixture(format = JSON.stringify(MANIFEST, null, 2)) {
  // macOS exposes tmpdir() through /var, a system symlink to /private/var.
  // Resolve the fixture root once so trust-root tests exercise canonical paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staged-enrollment-')));
  const names = ['active', 'quarantine', 'quarantine2', 'staging', 'usage', 'rollback', 'locks'];
  const paths = Object.fromEntries(names.map((name) => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  const manifestPath = join(root, 'manifest.json');
  const candidatePath = join(root, 'candidate.json');
  const keyPath = join(root, 'approval.key');
  const approvalPath = join(root, 'approval.json');
  const inventoryPath = join(root, 'consumer-inventory.json');
  const authoritativeConsumerInventoryPath = join(root, 'authoritative-consumer-inventory.json');
  const canaryPath = join(root, 'no-fallback-canary.json');
  const configPath = join(root, 'deployment.json');
  writeFileSync(manifestPath, format, { mode: 0o600 });
  writeFileSync(candidatePath, JSON.stringify(CANDIDATE), { mode: 0o600 });
  writeFileSync(keyPath, 'K'.repeat(32), { mode: 0o600 });
  const digest = parseManifestBytes(readFileSync(manifestPath)).digest;
  const candidateDigest = sha256(readFileSync(candidatePath));
  const inventory = {
    version: 1,
    credential: {
      id: ENTRY.id,
      provider: ENTRY.provider,
      email: ENTRY.email,
      organizationUuid: ENTRY.organizationUuid,
      organizationName: ENTRY.organizationName,
      accountOwner: ENTRY.accountOwner,
      destination: ENTRY.authFilename,
    },
    consumers: [{ id: 'canonical-consumer', type: 'cliproxyapi', path: join(paths.active, ENTRY.authFilename) }],
  };
  const authoritativeConsumerInventory = {
    version: 1,
    consumers: inventory.consumers.map((consumer) => ({
      ...consumer,
      credentialId: ENTRY.id,
      destination: ENTRY.authFilename,
    })),
  };
  const canary = {
    version: 1,
    results: inventory.consumers.map((consumer) => ({
      consumerId: consumer.id,
      consumerPath: consumer.path,
      credentialId: ENTRY.id,
      candidateDigest,
      destination: ENTRY.authFilename,
      noFallback: true,
      pass: true,
    })),
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
  writeFileSync(authoritativeConsumerInventoryPath, JSON.stringify(authoritativeConsumerInventory), { mode: 0o600 });
  writeFileSync(canaryPath, JSON.stringify(canary), { mode: 0o600 });
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
    runtimeInventoryPath: manifestPath,
    runtimeInventoryDigest: sha256(readFileSync(manifestPath)),
    authoritativeConsumerInventoryPath,
    authoritativeConsumerInventoryDigest: sha256(readFileSync(authoritativeConsumerInventoryPath)),
    deploymentPlanDigest: 'd'.repeat(64),
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
        oldTargetDigest:
          action === 'activate' && existsSync(join(paths.active, ENTRY.authFilename))
            ? sha256(readFileSync(join(paths.active, ENTRY.authFilename)))
            : null,
        inventoryDigest: action === 'activate' ? sha256(readFileSync(inventoryPath)) : null,
        canaryDigest: action === 'activate' ? sha256(readFileSync(canaryPath)) : null,
        destination: ENTRY.authFilename,
        ...changes,
      },
      { now: clock.now ?? NOW, ttlMs: clock.ttlMs ?? 300_000 },
    );
    const artifact = signApproval(payload, readFileSync(keyPath));
    writeFileSync(approvalPath, JSON.stringify(artifact), { mode: 0o600 });
    return artifact;
  };
  const common = {
    configPath,
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
    inventoryPath,
    canaryPath,
  };
  return {
    root,
    paths,
    manifestPath,
    candidatePath,
    keyPath,
    approvalPath,
    inventoryPath,
    authoritativeConsumerInventoryPath,
    canaryPath,
    configPath,
    config,
    digest,
    candidateDigest,
    approval,
    common,
  };
}

function authorizeRollback(f, changes = {}) {
  const recordName = readdirSync(f.paths.rollback).find((name) => name.endsWith('.committed-rollback.json'));
  const recordPath = join(f.paths.rollback, recordName);
  const retained = JSON.parse(readFileSync(recordPath, 'utf8')).payload;
  const payload = {
    version: 1,
    id: `rollback-${randomUUID()}`,
    nonce: `rollback-${randomUUID()}`,
    action: 'canonical-rollback',
    manifestDigest: f.digest,
    manifestEntryId: ENTRY.id,
    email: ENTRY.email,
    organizationUuid: ENTRY.organizationUuid,
    organizationName: ENTRY.organizationName,
    accountOwner: ENTRY.accountOwner,
    authorizedOperator: 'operator',
    environment: 'controlled-test',
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    candidateDigest: retained.candidateDigest,
    oldBackupDigest: retained.oldDigest,
    recordDigest: sha256(readFileSync(recordPath)),
    destination: ENTRY.authFilename,
    ...changes,
  };
  const artifact = signApproval(payload, readFileSync(f.keyPath));
  writeFileSync(f.approvalPath, JSON.stringify(artifact), { mode: 0o600 });
  return artifact;
}

// Duplicate decoded keys are rejected recursively in every trust-record class.
{
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    refuses(
      () => parseStrictJson(`{"safe":{"${key}":{"hidden":"signed-out"}}}`, 'DANGEROUS_JSON_KEY'),
      'DANGEROUS_JSON_KEY',
    );
    refuses(() => parseStrictJson(`{"${key}":1}`, 'DANGEROUS_JSON_KEY'), 'DANGEROUS_JSON_KEY');
  }
  refuses(() => parseStrictJson(`{"safe":1}\u00a0`, 'NON_JSON_WHITESPACE'), 'NON_JSON_WHITESPACE');
  refuses(() => parseStrictJson(`${'['.repeat(66)}0${']'.repeat(66)}`, 'JSON_DEPTH_EXCEEDED'), 'JSON_DEPTH_EXCEEDED');
  for (const ambiguousNumber of ['1e400', '-1e400', '-0', '9007199254740993'])
    refuses(() => parseStrictJson(ambiguousNumber, 'AMBIGUOUS_JSON_NUMBER'), 'AMBIGUOUS_JSON_NUMBER');
  const safe = parseStrictJson('{"signed":{"visible":1}}');
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.equal(Object.getPrototypeOf(safe.signed), null);
  assert.equal(JSON.stringify(safe), '{"signed":{"visible":1}}');
  for (const dangerous of [
    JSON.parse('{"__proto__":{"hidden":"unsigned"}}'),
    JSON.parse('{"safe":{"constructor":{"hidden":"unsigned"}}}'),
    { safe: { __proto__: { hidden: 'unsigned' } } },
  ])
    refuses(() => canonicalJson(dangerous), 'UNSAFE_CANONICAL_JSON');
  const arrayWithUnsignedKey = [1];
  arrayWithUnsignedKey.authorization = 'unsigned';
  refuses(() => canonicalJson(arrayWithUnsignedKey), 'UNSAFE_CANONICAL_JSON');
  const arrayWithSymbol = [1];
  arrayWithSymbol[Symbol('unsigned')] = true;
  refuses(() => canonicalJson(arrayWithSymbol), 'UNSAFE_CANONICAL_JSON');
  const arrayWithPrototype = [1];
  Object.setPrototypeOf(arrayWithPrototype, null);
  refuses(() => canonicalJson(arrayWithPrototype), 'UNSAFE_CANONICAL_JSON');
  const hidden = { safe: {} };
  Object.defineProperty(hidden.safe, 'hidden', { value: true });
  refuses(() => canonicalJson(hidden), 'UNSAFE_CANONICAL_JSON');
  for (const property of ['get', 'set']) {
    const accessor = { nested: {} };
    Object.defineProperty(accessor.nested, 'value', { enumerable: true, [property]: () => 1 });
    refuses(() => canonicalJson(accessor), 'UNSAFE_CANONICAL_JSON');
  }
  refuses(() => canonicalJson(Array(1)), 'UNSAFE_CANONICAL_JSON');
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 66; index++) cursor = cursor.next = {};
  refuses(() => canonicalJson(deep), 'UNSAFE_CANONICAL_JSON');
  for (const value of [-0, Number.MAX_SAFE_INTEGER + 1]) refuses(() => canonicalJson(value), 'UNSAFE_CANONICAL_JSON');
  refuses(() => parseManifestBytes('{"version":1,"\\u0065ntries":[],"entries":[]}'), 'INVALID_MANIFEST');
  refuses(
    () =>
      validateCandidateBytes(
        JSON.stringify(CANDIDATE).replace('"access_token":', '"access_token":"x","\\u0061ccess_token":'),
        ENTRY,
        NOW,
      ),
    'INVALID_CANDIDATE',
  );
  const f = fixture();
  writeFileSync(f.configPath, `${JSON.stringify(f.config).slice(0, -1)},"\\u0065nvironment":"duplicate"}`, {
    mode: 0o600,
  });
  refuses(() => readDeploymentConfig(f.configPath), 'INVALID_CONFIG');
}

// Every remaining trust-record parser rejects escaped duplicate keys nested in
// its authenticated payload, and reports that record's stable error code.
{
  const duplicate = (
    artifact,
    key,
    escapedKey = `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`,
  ) =>
    JSON.stringify(artifact).replace(`"${key}":`, `"${key}":${JSON.stringify(artifact.payload[key])},"${escapedKey}":`);

  const approval = fixture();
  const approvalArtifact = approval.approval('stage');
  writeFileSync(approval.approvalPath, duplicate(approvalArtifact, 'action'), { mode: 0o600 });
  refuses(() => stageEnrollment({ ...approval.common, candidatePath: approval.candidatePath }), 'INVALID_APPROVAL');

  const active = fixture();
  active.approval('stage');
  stageEnrollment({ ...active.common, candidatePath: active.candidatePath });
  const activeTarget = JSON.stringify(CANDIDATE).replace(
    '"claude_device_ids":',
    '"claude_device_ids":["nested"],"\\u0063laude_device_ids":',
  );
  writeFileSync(join(active.paths.active, ENTRY.authFilename), activeTarget, { mode: 0o600 });
  active.approval('activate');
  refuses(() => activateEnrollment(active.common), 'INVALID_ACTIVE_TARGET');

  const inventory = fixture();
  writeFileSync(
    join(inventory.paths.quarantine, 'nested.json'),
    JSON.stringify(CANDIDATE).replace('"email":', '"email":"other@example.com","\\u0065mail":'),
    { mode: 0o600 },
  );
  inventory.approval('stage');
  refuses(
    () => stageEnrollment({ ...inventory.common, candidatePath: inventory.candidatePath }),
    'MALFORMED_INVENTORY',
  );

  const signedDuplicate = (payload, key, signingKey) => duplicate(signApproval(payload, signingKey), key);
  const processRecord = {
    version: 1,
    host: hostname(),
    pid: 2_147_483_647,
    nonce: 'valid-lock-nonce',
    createdAt: new Date().toISOString(),
  };
  const lock = fixture();
  writeFileSync(lock.common.operationLockPath, signedDuplicate(processRecord, 'nonce', readFileSync(lock.keyPath)), {
    mode: 0o600,
  });
  refuses(() => withOperationLock(lock.common.operationLockPath, lock.keyPath, () => {}), 'OPERATION_LOCKED_MALFORMED');

  const claim = fixture();
  writeFileSync(
    claim.common.operationLockPath,
    JSON.stringify(signApproval(processRecord, readFileSync(claim.keyPath))),
    { mode: 0o600 },
  );
  const claimPayload = { ...processRecord, nonce: 'valid-claim-nonce', lockNonce: processRecord.nonce };
  writeFileSync(
    `${claim.common.operationLockPath}.recovery-claim`,
    signedDuplicate(claimPayload, 'lockNonce', readFileSync(claim.keyPath)),
    { mode: 0o600 },
  );
  refuses(() => withOperationLock(claim.common.operationLockPath, claim.keyPath, () => {}), 'RECOVERY_CLAIM_MALFORMED');

  const journal = fixture();
  const journalPayload = { version: 1, phase: 'PREPARING' };
  writeFileSync(
    `${journal.common.operationLockPath}.journal`,
    signedDuplicate(journalPayload, 'phase', readFileSync(journal.keyPath)),
    { mode: 0o600 },
  );
  refuses(() => recoverEnrollment({ configPath: journal.configPath }), 'INVALID_ACTIVATION_JOURNAL');

  const marker = fixture();
  const markerPayload = { version: 1, approvalId: 'approval-id', nonce: 'approval-nonce', action: 'additive-publish' };
  writeFileSync(
    join(marker.paths.usage, 'approval-id.approval-nonce.used'),
    signedDuplicate(markerPayload, 'action', readFileSync(marker.keyPath)),
    {
      mode: 0o600,
    },
  );
  refuses(
    () =>
      consumeApproval(
        { id: 'approval-id', nonce: 'approval-nonce', action: 'additive-publish' },
        marker.paths.usage,
        marker.keyPath,
      ),
    'INVALID_USE_MARKER',
  );

  const publication = fixture();
  const publicationPath = `${publication.common.operationLockPath}.publication`;
  const publicationPayload = {
    version: 1,
    kind: 'stage',
    stagedPath: join(publication.paths.staging, ENTRY.authFilename),
    stagingDigest: publication.candidateDigest,
    markerPath: join(publication.paths.usage, 'approval-id.approval-nonce.used'),
    approvalId: 'approval-id',
    approvalNonce: 'approval-nonce',
  };
  writeFileSync(publicationPath, signedDuplicate(publicationPayload, 'kind', readFileSync(publication.keyPath)), {
    mode: 0o600,
  });
  publication.approval('stage');
  refuses(
    () => stageEnrollment({ ...publication.common, candidatePath: publication.candidatePath }),
    'INVALID_PUBLICATION_RECORD',
  );
}

// File roles reject hardlink aliases, not merely symlinks and textual overlap.
for (const role of ['manifest', 'key', 'candidate', 'approval']) {
  const f = fixture();
  f.approval('stage');
  const source =
    role === 'manifest'
      ? f.manifestPath
      : role === 'key'
        ? f.keyPath
        : role === 'candidate'
          ? f.candidatePath
          : f.approvalPath;
  const alias = join(f.root, `${role}.hardlink`);
  linkSync(source, alias);
  if (role === 'manifest' || role === 'key') {
    const field = role === 'manifest' ? 'manifestPath' : 'approvalKeyPath';
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, [field]: alias }), { mode: 0o600 });
    refuses(() => readDeploymentConfig(f.configPath), 'INSECURE_TRUST_ROOT');
  } else {
    refuses(
      () =>
        stageEnrollment({
          ...f.common,
          candidatePath: role === 'candidate' ? alias : f.candidatePath,
          approvalPath: role === 'approval' ? alias : f.approvalPath,
        }),
      'INSECURE_TRUST_ROOT|INVALID_APPROVAL',
    );
  }
}

// Lock records are authenticated; only same-host dead-PID holders are reclaimed.
{
  const makeLock = (f, fields, key = readFileSync(f.keyPath)) =>
    writeFileSync(f.common.operationLockPath, `${JSON.stringify(signApproval(fields, key))}\n`, { mode: 0o600 });
  const base = {
    version: 1,
    host: hostname(),
    pid: process.pid,
    nonce: 'lock-nonce',
    createdAt: new Date().toISOString(),
  };
  for (const fields of [{ ...base }, { ...base, host: 'foreign-host.invalid', pid: 2147483647 }]) {
    const f = fixture();
    makeLock(f, fields);
    refuses(() => withOperationLock(f.common.operationLockPath, f.keyPath, () => {}), 'OPERATION_LOCKED');
  }
  const forged = fixture();
  makeLock(forged, { ...base, pid: 2147483647 }, Buffer.from('Z'.repeat(32)));
  refuses(
    () => withOperationLock(forged.common.operationLockPath, forged.keyPath, () => {}),
    'OPERATION_LOCKED_MALFORMED',
  );
  const stale = fixture();
  makeLock(stale, { ...base, pid: 2147483647 });
  assert.equal(
    withOperationLock(stale.common.operationLockPath, stale.keyPath, () => 'reclaimed'),
    'reclaimed',
  );
  assert.equal(existsSync(stale.common.operationLockPath), false);

  for (const suffix of ['.journal', '.publication']) {
    const pending = fixture();
    makeLock(pending, { ...base, pid: 2147483647 });
    writeFileSync(`${pending.common.operationLockPath}${suffix}`, '{}\n', { mode: 0o600 });
    const callbackMarker = join(pending.root, `callback-${suffix.slice(1)}`);
    refuses(
      () =>
        withOperationLock(pending.common.operationLockPath, pending.keyPath, () => {
          writeFileSync(callbackMarker, 'unsafe');
        }),
      suffix === '.journal' ? 'PENDING_ACTIVATION_JOURNAL' : 'PENDING_APPROVAL_PUBLICATION',
    );
    assert.equal(existsSync(callbackMarker), false, `${suffix} was rechecked after stale reclaim`);
  }
}

// A pending journal published only after stale-lock replacement is still
// observed under ownership; the callback never runs after SIGCONT.
{
  const f = fixture();
  const stale = {
    version: 1,
    host: hostname(),
    pid: 2147483647,
    nonce: 'stale-race-nonce',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(f.common.operationLockPath, `${JSON.stringify(signApproval(stale, readFileSync(f.keyPath)))}\n`, {
    mode: 0o600,
  });
  const marker = join(f.root, 'stale-reclaim-callback');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      // Inputs are test-created absolute paths serialized as JS literals.
      // lgtm[js/bad-code-sanitization]
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')))`,
    ],
    {
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGSTOP:LOCK_REPLACEMENT_PUBLISHED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const resultPromise = childResult(child);
  let result;
  try {
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(f.common.operationLockPath, 'utf8')).payload.pid === child.pid;
      } catch {
        return false;
      }
    }, 'replacement lock publication');
    await waitForStoppedChild(child, 'replacement-lock fault stop');
    writeFileSync(`${f.common.operationLockPath}.journal`, '{}\n', { mode: 0o600 });
    signalChild(child, 'SIGCONT');
    result = await resultPromise;
  } finally {
    signalChild(child, 'SIGCONT');
    signalChild(child, 'SIGTERM');
  }
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PENDING_ACTIVATION_JOURNAL/);
  assert.equal(existsSync(marker), false);
}

// Signed-but-malformed lock metadata is never treated as a reclaimable dead process.
for (const mutation of [
  { version: 2 },
  { pid: 0 },
  { pid: -1 },
  { pid: 2_147_483_648 },
  { nonce: '' },
  { nonce: 'short' },
  { nonce: 'x'.repeat(129) },
  { createdAt: 'not-a-time' },
]) {
  const f = fixture();
  const holder = {
    version: 1,
    host: hostname(),
    pid: 2_147_483_647,
    nonce: 'valid-lock-nonce',
    createdAt: new Date().toISOString(),
    ...mutation,
  };
  writeFileSync(f.common.operationLockPath, `${JSON.stringify(signApproval(holder, readFileSync(f.keyPath)))}\n`, {
    mode: 0o600,
  });
  refuses(() => withOperationLock(f.common.operationLockPath, f.keyPath, () => {}), 'OPERATION_LOCKED_MALFORMED');
}

// Recovery claims are independently authenticated and process-bound. Signed
// malformed metadata, forged HMACs, live/foreign claimants, and lock-nonce
// mismatches never authorize reclaim; a valid dead claimant does.
{
  const install = (f, claimChanges, claimKey = readFileSync(f.keyPath)) => {
    const key = readFileSync(f.keyPath);
    const holder = {
      version: 1,
      host: hostname(),
      pid: 2_147_483_647,
      nonce: 'stale-lock-nonce',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(f.common.operationLockPath, JSON.stringify(signApproval(holder, key)), { mode: 0o600 });
    const claim = {
      version: 1,
      host: hostname(),
      pid: 2_147_483_647,
      nonce: 'stale-claim-nonce',
      lockNonce: holder.nonce,
      createdAt: new Date().toISOString(),
      ...claimChanges,
    };
    writeFileSync(`${f.common.operationLockPath}.recovery-claim`, JSON.stringify(signApproval(claim, claimKey)), {
      mode: 0o600,
    });
  };
  for (const mutation of [
    { pid: 0 },
    { pid: 1.5 },
    { createdAt: 'not-a-time' },
    { nonce: 'short' },
    { lockNonce: 'short' },
  ]) {
    const f = fixture();
    install(f, mutation);
    refuses(() => withOperationLock(f.common.operationLockPath, f.keyPath, () => {}), 'RECOVERY_CLAIM_MALFORMED');
  }
  const forged = fixture();
  install(forged, {}, Buffer.from('Z'.repeat(32)));
  refuses(
    () => withOperationLock(forged.common.operationLockPath, forged.keyPath, () => {}),
    'RECOVERY_CLAIM_MALFORMED',
  );
  for (const claimant of [{ pid: process.pid }, { host: 'foreign-host.invalid' }]) {
    const f = fixture();
    install(f, claimant);
    refuses(() => withOperationLock(f.common.operationLockPath, f.keyPath, () => {}), 'OPERATION_LOCKED');
  }
  const dead = fixture();
  install(dead, {});
  assert.equal(
    withOperationLock(dead.common.operationLockPath, dead.keyPath, () => 'recovered'),
    'recovered',
  );
  assert.equal(existsSync(`${dead.common.operationLockPath}.recovery-claim`), false);
}

// Three fresh processes prove that a claimant killed after old-lock removal
// cannot wedge reclaim of a later holder: the orphan is authenticated and
// judged dead independently of its older lock nonce.
{
  const f = fixture();
  const holder = {
    version: 1,
    host: hostname(),
    pid: 2_147_483_647,
    nonce: 'orphan-claim-old-lock',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(f.common.operationLockPath, JSON.stringify(signApproval(holder, readFileSync(f.keyPath))), {
    mode: 0o600,
  });
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const lockCall = `m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>process.kill(process.pid,"SIGKILL"))`;
  const first = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>${lockCall})`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:OLD_LOCK_UNLINKED',
      },
    },
  );
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assert.equal(existsSync(f.common.operationLockPath), false);
  assert.equal(existsSync(`${f.common.operationLockPath}.recovery-claim`), true);
  const second = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>${lockCall})`],
    { encoding: 'utf8' },
  );
  assert.equal(second.signal, 'SIGKILL', second.stderr);
  assert.equal(existsSync(f.common.operationLockPath), true);
  const thirdScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>"reclaimed")))`;
  const third = spawnSync(process.execPath, ['--input-type=module', '-e', thirdScript], { encoding: 'utf8' });
  assert.equal(third.status, 0, third.stderr);
  assert.equal(third.stdout, 'reclaimed');
  assert.equal(existsSync(`${f.common.operationLockPath}.recovery-claim`), false);
}

// Two real processes racing to reclaim one stale lock cannot both enter the
// critical section. The winner holds the replacement lock while the loser probes.
{
  const f = fixture();
  const holder = {
    version: 1,
    host: hostname(),
    pid: 2_147_483_647,
    nonce: 'competing-stale-lock',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(f.common.operationLockPath, JSON.stringify(signApproval(holder, readFileSync(f.keyPath))), {
    mode: 0o600,
  });
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const script = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400)))`;
  const first = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const second = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const results = await Promise.all([childResult(first), childResult(second)]);
  assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => /OPERATION_LOCKED/.test(result.stderr)).length, 1, JSON.stringify(results));
}

// A reclaimer killed after replacement publication leaves no claim wedge; a
// fresh process reclaims the replacement lock owned by the dead child.
{
  const f = fixture();
  const holder = {
    version: 1,
    host: hostname(),
    pid: 2_147_483_647,
    nonce: 'crash-boundary-lock',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(f.common.operationLockPath, JSON.stringify(signApproval(holder, readFileSync(f.keyPath))), {
    mode: 0o600,
  });
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>{}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:LOCK_REPLACEMENT_PUBLISHED',
    },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(existsSync(`${f.common.operationLockPath}.recovery-claim`), false);
  const recoveryScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(m.withOperationLock(${JSON.stringify(f.common.operationLockPath)},${JSON.stringify(f.keyPath)},()=>"reclaimed")))`;
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, 'reclaimed');
}

// Existing destinations are exact-schema and identity checked before approval use.
for (const existing of [
  { ...CANDIDATE, type: 'codex' },
  { ...CANDIDATE, email: 'wrong@example.com' },
  { ...CANDIDATE, extra: 'forbidden' },
  { ...CANDIDATE, disabled: 'false' },
  { ...CANDIDATE, access_token: '' },
  { ...CANDIDATE, claude_device_ids: ['bad-device'] },
  { ...CANDIDATE, organization_name: 42 },
]) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  writeFileSync(join(f.paths.active, ENTRY.authFilename), JSON.stringify(existing), { mode: 0o600 });
  const approval = f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'INVALID_ACTIVE_TARGET|ACTIVE_TARGET_IDENTITY_MISMATCH');
  assert.equal(existsSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`)), false);
}
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  writeFileSync(
    join(f.paths.active, ENTRY.authFilename),
    JSON.stringify({ ...CANDIDATE, expired: '2020-01-01T00:00:00Z' }),
    { mode: 0o600 },
  );
  f.approval('activate');
  assert.equal(activateEnrollment(f.common).ok, true);
}

// Recovery with no journal is idempotent and leaves no lock behind.
{
  const f = fixture();
  assert.deepEqual(recoverEnrollment({ configPath: f.configPath }), { ok: true, action: 'recover', recovered: false });
  assert.deepEqual(recoverEnrollment({ configPath: f.configPath }), { ok: true, action: 'recover', recovered: false });
}

// Fresh processes recover authenticated journals after SIGKILL at each
// irreversible boundary; committed recovery retains authenticated rollback.
for (const phase of [
  'PREPARING',
  'BACKUP_CREATE_INTENT',
  'BACKUP_CREATED',
  'PREPARED',
  'APPROVAL_INTENT',
  'APPROVAL_CONSUMED',
  'INSTALL_INTENT',
  'INSTALLED',
  'COMMITTED',
]) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: `old-${phase}` });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, configPath: f.configPath, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: `SIGKILL:${phase}`,
    },
  });
  assert.equal(killed.signal, 'SIGKILL', `${phase}: ${killed.stderr}`);
  const recoveryScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(JSON.stringify(m.recoverEnrollment({configPath:${JSON.stringify(f.configPath)}}))))`;
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, `${phase}: ${recovered.stderr}`);
  const receipt = JSON.parse(recovered.stdout);
  assert.equal(receipt.recovered, true);
  assert.equal(readFileSync(target, 'utf8'), phase === 'COMMITTED' ? JSON.stringify(CANDIDATE) : old);
  assert.equal(readdirSync(f.paths.rollback).length, phase === 'COMMITTED' ? 3 : 0);
  if (phase === 'COMMITTED') {
    const beforeRollback = readFileSync(target);
    const rolledBack = spawnSync(
      process.execPath,
      [modulePath, 'rollback', '--config', f.configPath, '--entry', ENTRY.id],
      { encoding: 'utf8' },
    );
    assert.notEqual(rolledBack.status, 0);
    assert.match(rolledBack.stderr, /INVALID_ARGUMENTS/);
    assert.deepEqual(readFileSync(target), beforeRollback, 'unsigned rollback performs zero writes');
    assert.equal(readdirSync(f.paths.rollback).length, 3, 'unsigned rollback retains all evidence');
  }
  const again = recoverEnrollment({ configPath: f.configPath });
  assert.equal(again.recovered, false);
}

// Recovery never removes or replaces an unjournaled active occupant, even if
// another writer copied the exact candidate bytes into a different inode.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'old-before-foreign-replace' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:INSTALLED',
    },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  linkSync(target, join(f.root, 'foreign-held-original-inode'));
  unlinkSync(target);
  writeFileSync(target, old, { mode: 0o600 });
  refuses(() => recoverEnrollment({ configPath: f.configPath }), 'ACTIVATION_RECOVERY_UNCERTAIN');
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.equal(readdirSync(f.paths.rollback).length, 1, 'exact journal-owned backup preserved');
}

// Backup-open crash is recoverable from authenticated creation intent.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'backup-open-old' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:BACKUP_OPENED',
      },
    },
  );
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.ok(
    readdirSync(f.paths.rollback).every((name) => name.startsWith('.evidence-') || name.includes('.preparation-')),
    'rollback cleanup retains only authenticated evidence and deterministic preparations',
  );
}

// Recovery is bound to the authenticated raw M0 digest and complete entry
// snapshot in the journal; a later M1 is neither trusted nor a recovery wedge.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const staged = join(f.paths.staging, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'manifest-swap-old' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const activation = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:PREPARED',
      },
    },
  );
  assert.equal(activation.signal, 'SIGKILL', activation.stderr);
  const m0 = readFileSync(f.manifestPath);
  const m1 = Buffer.concat([m0, Buffer.from('\n')]);
  writeFileSync(f.manifestPath, m1);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.deepEqual(JSON.parse(readFileSync(staged, 'utf8')), CANDIDATE);
  assert.equal(existsSync(`${f.common.operationLockPath}.journal`), false);
  assert.deepEqual(readFileSync(f.manifestPath), m1, 'recovery does not reinterpret or replace M1');
}

// A live unfenced M0→M1 replacement after installation but before commit is
// observed by the post-install CAS and rolls the credential back.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const staged = join(f.paths.staging, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'live-manifest-race-old' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const activation = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`,
    ],
    {
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGSTOP:INSTALLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const resultPromise = childResult(activation);
  let result;
  try {
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(`${f.common.operationLockPath}.journal`, 'utf8')).payload.phase === 'INSTALLED';
      } catch {
        return false;
      }
    }, 'installed journal');
    await waitForStoppedChild(activation, 'installed fault stop');
    writeFileSync(f.manifestPath, Buffer.concat([readFileSync(f.manifestPath), Buffer.from('\n')]));
    signalChild(activation, 'SIGCONT');
    result = await resultPromise;
  } finally {
    signalChild(activation, 'SIGCONT');
    signalChild(activation, 'SIGTERM');
  }
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACTIVATION_ROLLED_BACK/);
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.deepEqual(JSON.parse(readFileSync(staged, 'utf8')), CANDIDATE);
}

// A first-party manifest publisher shares the canonical lock and cannot enter
// the final-CAS-to-COMMITTED interval.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const activation = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`,
    ],
    {
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGSTOP:MANIFEST_CAS_VERIFIED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const activationResult = childResult(activation);
  try {
    await waitForStoppedChild(activation, 'post-manifest-CAS fault stop');
    const publisher = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        // Inputs are test-created absolute paths serialized as JS literals.
        // lgtm[js/bad-code-sanitization]
        `import(${JSON.stringify(`file://${join(import.meta.dirname, '..', 'auth-writer-coordination.mjs')}`)}).then(m=>m.withAuthWriterLock(()=>require('node:fs').appendFileSync(${JSON.stringify(f.manifestPath)},'\\n'),{configPath:${JSON.stringify(f.configPath)}}))`,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(publisher.status, 0);
    assert.match(publisher.stderr, /OPERATION_LOCKED|PENDING_ACTIVATION_JOURNAL/);
    assert.deepEqual(readFileSync(f.manifestPath), Buffer.from(JSON.stringify(MANIFEST, null, 2)));
    signalChild(activation, 'SIGCONT');
    const activated = await activationResult;
    assert.equal(activated.status, 0, activated.stderr);
  } finally {
    signalChild(activation, 'SIGCONT');
    signalChild(activation, 'SIGTERM');
  }
}

// Fresh-process rollback recovery is idempotent when killed immediately after
// its rename or after the first of the two required directory fsyncs.
for (const fault of ['SIGKILL:RECOVERY_ROLLBACK_RENAMED', 'SIGKILL:RECOVERY_ROLLBACK_FIRST_DIR_FSYNC']) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: `old-${fault}` });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const activateScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const activation = spawnSync(process.execPath, ['--input-type=module', '-e', activateScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:INSTALLED',
    },
  });
  assert.equal(activation.signal, 'SIGKILL', activation.stderr);
  const recoveryScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(JSON.stringify(m.recoverEnrollment({configPath:${JSON.stringify(f.configPath)}}))))`;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: fault,
    },
  });
  assert.equal(interrupted.signal, 'SIGKILL', `${fault}: ${interrupted.stderr}`);
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, `${fault}: ${recovered.stderr}`);
  assert.equal(JSON.parse(recovered.stdout).outcome, 'rolled-back');
  assert.equal(readFileSync(target, 'utf8'), old);
  const again = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).recovered, false);
}

// Post-consumption journals without their exact marker are uncertain, never
// guessed rolled back.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const approval = f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:APPROVAL_CONSUMED',
    },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  unlinkSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`));
  refuses(() => recoverEnrollment({ configPath: f.configPath }), 'ACTIVATION_RECOVERY_UNCERTAIN');
}

// COMMITTED cleanup is idempotent when SIGKILL lands after backup deletion and
// before journal deletion, both when an old target existed and when it did not.
for (const hadTarget of [false, true]) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  if (hadTarget) writeFileSync(target, JSON.stringify({ ...CANDIDATE, access_token: 'old-token' }), { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:AFTER_BACKUP_DELETE',
    },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'committed');
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify(CANDIDATE));
  assert.equal(readdirSync(f.paths.rollback).length, hadTarget ? 3 : 0);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).recovered, false);
}

// A SIGKILL after no-replace backup restoration leaves only the journal-bound
// target/backup hardlinks, which fresh-process recovery completes safely.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: 'restore-crash-old' });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW, injectFailure: 'after-digest-verification' })}))`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
        CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:RESTORE_TEMP_FSYNCED',
      },
    },
  );
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.equal(readdirSync(f.paths.rollback).length, 1);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.deepEqual(readdirSync(f.paths.rollback), []);
}

// PREPARING safely removes an operation-unique partial backup after proving the
// authenticated old-target and staged-candidate digests, bounding retention.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const staged = join(f.paths.staging, ENTRY.authFilename);
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = Buffer.from(JSON.stringify({ ...CANDIDATE, access_token: 'pinned-old-token' }));
  const stagedBefore = readFileSync(staged);
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment({ ...f.common, injectFailure: 'partial-backup' }), 'INJECTED_FAILURE');
  assert.deepEqual(readFileSync(target), old);
  assert.deepEqual(readFileSync(staged), stagedBefore);
  assert.equal(readdirSync(f.paths.rollback).length, 1);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  assert.deepEqual(readFileSync(target), old);
  assert.deepEqual(readFileSync(staged), stagedBefore);
  assert.deepEqual(readdirSync(f.paths.rollback), []);
}

// Authenticated pending publication evidence makes both first-directory-fsync
// and cleanup-fsync uncertainty deterministic on the next stage attempt.
for (const fault of ['THROW:PUBLICATION_FIRST_DIR_FSYNC', 'THROW:PUBLICATION_CLEANUP_FSYNC']) {
  const f = fixture();
  const approval = f.approval('stage');
  process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = '1';
  process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = fault;
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'PUBLICATION_RECOVERY_REQUIRED');
  delete process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
  delete process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
  assert.equal(existsSync(`${f.common.operationLockPath}.publication`), true);
  if (fault === 'THROW:PUBLICATION_FIRST_DIR_FSYNC') {
    assert.equal(existsSync(join(f.paths.staging, ENTRY.authFilename)), false);
    assert.equal(stageEnrollment({ ...f.common, candidatePath: f.candidatePath }).ok, true);
  } else {
    assert.equal(existsSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`)), true);
    refuses(
      () => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }),
      'APPROVAL_REPLAY|STAGE_TARGET_EXISTS|DUPLICATE_IDENTITY|INSECURE_TRUST_ROOT',
    );
  }
  assert.equal(existsSync(`${f.common.operationLockPath}.publication`), false);
}

// Fresh subprocess recovery resolves SIGKILL at each stage publication link.
for (const boundary of ['STAGED_LINK', 'MARKER_LINK']) {
  const f = fixture();
  f.approval('stage');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const childScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.stageEnrollment(${JSON.stringify({ ...f.common, candidatePath: f.candidatePath, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: `SIGKILL:${boundary}`,
    },
  });
  assert.equal(killed.signal, 'SIGKILL', `${boundary}: ${killed.stderr}`);
  const recoveryScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>{try{m.stageEnrollment(${JSON.stringify({ ...f.common, candidatePath: f.candidatePath, now: NOW })});process.stdout.write("ok")}catch(e){process.stdout.write(e.message)}})`;
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, `${boundary}: ${recovered.stderr}`);
  assert.match(
    recovered.stdout,
    boundary === 'STAGED_LINK' ? /^ok$/ : /APPROVAL_REPLAY|DUPLICATE_IDENTITY|STAGE_TARGET_EXISTS|INSECURE_TRUST_ROOT/,
  );
  assert.equal(existsSync(`${f.common.operationLockPath}.publication`), false);
}

// A failed post-link durability step removes only descriptor-pinned staged
// bytes. A published signed marker remains authoritative and is never deleted.
for (const fault of ['THROW:STAGE_AFTER_LINK', 'THROW:MARKER_AFTER_LINK']) {
  const f = fixture();
  const approval = f.approval('stage');
  const priorTesting = process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
  const priorFault = process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
  process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = '1';
  process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = fault;
  try {
    refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'INJECTED|CONSUME');
  } finally {
    if (priorTesting === undefined) delete process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
    else process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = priorTesting;
    if (priorFault === undefined) delete process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
    else process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = priorFault;
  }
  assert.equal(existsSync(join(f.paths.staging, ENTRY.authFilename)), false);
  assert.equal(
    existsSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`)),
    fault === 'THROW:MARKER_AFTER_LINK',
  );
}

// An ambiguous activation-marker publication is resolved fail closed: the
// signed marker remains authoritative and the approval cannot be reused.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const approval = f.approval('activate');
  const priorTesting = process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
  const priorFault = process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
  process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = '1';
  process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = 'THROW:MARKER_AFTER_LINK';
  try {
    refuses(() => activateEnrollment(f.common), 'ACTIVATION_RECOVERY_REQUIRED');
  } finally {
    if (priorTesting === undefined) delete process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
    else process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = priorTesting;
    if (priorFault === undefined) delete process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
    else process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = priorFault;
  }
  assert.equal(existsSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`)), true);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  refuses(() => activateEnrollment(f.common), 'APPROVAL_REPLAY|ACTIVATION_RECOVERY_REQUIRED');
}

// Fresh recovery validates the exact deterministic marker preparation alias
// left by SIGKILL after link(2) and retains it as bounded evidence.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const approval = f.approval('activate');
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const activateScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', activateScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGKILL:MARKER_LINK',
    },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const marker = join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`);
  assert.equal(
    readdirSync(f.paths.usage).filter((name) => name.startsWith(`${basename(marker)}.preparation-`)).length,
    1,
  );
  const recoveryScript = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(JSON.stringify(m.recoverEnrollment({configPath:${JSON.stringify(f.configPath)}}))))`;
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).outcome, 'rolled-back');
  assert.equal(existsSync(marker), true);
  assert.equal(
    readdirSync(f.paths.usage).filter((name) => name.startsWith(`${basename(marker)}.preparation-`)).length,
    1,
  );
  assert.equal(recoverEnrollment({ configPath: f.configPath }).recovered, false);
}

// If marker cleanup itself is ambiguous, recovery treats the authenticated
// marker as authoritative consumption: rollback succeeds but retry is replay.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const approval = f.approval('activate');
  process.env.CLAUDE_STAGED_ENROLLMENT_TESTING = '1';
  process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT = 'THROW:MARKER_CLEANUP_UNCERTAIN';
  try {
    refuses(() => activateEnrollment(f.common), 'ACTIVATION_RECOVERY_REQUIRED');
  } finally {
    delete process.env.CLAUDE_STAGED_ENROLLMENT_TESTING;
    delete process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT;
  }
  assert.equal(existsSync(join(f.paths.usage, `${approval.payload.id}.${approval.payload.nonce}.used`)), true);
  assert.equal(recoverEnrollment({ configPath: f.configPath }).outcome, 'rolled-back');
  refuses(() => activateEnrollment(f.common), 'APPROVAL_REPLAY|ACTIVATION_RECOVERY_REQUIRED');
}

// Raw-byte manifest digest, exact 15-entry topology, no parsed mutation.
{
  const raw = ` {\n  "version": 1, "entries": ${JSON.stringify(MANIFEST.entries)}\n}\n`;
  const before = JSON.parse(raw);
  const parsed = parseManifestBytes(Buffer.from(raw));
  assert.equal(parsed.digest, sha256(Buffer.from(raw)));
  assert.equal(JSON.stringify(parsed.manifest), JSON.stringify(before));
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
  assert.equal(JSON.stringify(readDeploymentConfig(f.configPath)), JSON.stringify(f.config));
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
  refuses(
    () => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }),
    'APPROVAL_REPLAY|INSECURE_TRUST_ROOT|PUBLICATION_RECOVERY_UNCERTAIN',
  );
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

// Stage authorization is an exact additive publication, not a generic approval.
{
  const f = fixture();
  f.approval('stage', { candidateDigest: '0'.repeat(64) });
  refuses(() => stageEnrollment({ ...f.common, candidatePath: f.candidatePath }), 'APPROVAL_BINDING_MISMATCH');
}

// Canonical switch evidence is mandatory, exact-schema, identity-bound, raw-byte
// digest-bound, and must prove a passing no-fallback candidate canary.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  refuses(() => activateEnrollment({ ...f.common, inventoryPath: undefined }), 'ABSOLUTE_PATH_REQUIRED');
  refuses(() => activateEnrollment({ ...f.common, canaryPath: undefined }), 'ABSOLUTE_PATH_REQUIRED');
  writeFileSync(f.inventoryPath, JSON.stringify({ version: 1, credential: {}, consumers: [] }), { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'INVALID_INVENTORY');
}
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const canary = JSON.parse(readFileSync(f.canaryPath, 'utf8'));
  canary.results[0].noFallback = false;
  writeFileSync(f.canaryPath, JSON.stringify(canary), { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'INVALID_CANARY');
}
for (const mutation of ['invented', 'incomplete', 'duplicate']) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const inventory = JSON.parse(readFileSync(f.inventoryPath, 'utf8'));
  if (mutation === 'invented')
    inventory.consumers.push({ id: 'invented', type: 'foreign', path: join(f.root, 'invented') });
  if (mutation === 'incomplete') inventory.consumers = [];
  if (mutation === 'duplicate') inventory.consumers.push({ ...inventory.consumers[0] });
  writeFileSync(f.inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'INVALID_INVENTORY');
}
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  writeFileSync(f.authoritativeConsumerInventoryPath, '{"version":1,"consumers":[]}', { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'AUTHORITATIVE_INVENTORY_MISMATCH');
}
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const canary = JSON.parse(readFileSync(f.canaryPath, 'utf8'));
  canary.results = [];
  writeFileSync(f.canaryPath, JSON.stringify(canary), { mode: 0o600 });
  f.approval('activate');
  refuses(() => activateEnrollment(f.common), 'INVALID_CANARY');
}
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate', { oldTargetDigest: '0'.repeat(64) });
  refuses(() => activateEnrollment(f.common), 'APPROVAL_BINDING_MISMATCH');
  f.approval('activate', { inventoryDigest: '0'.repeat(64) });
  refuses(() => activateEnrollment(f.common), 'APPROVAL_BINDING_MISMATCH');
  f.approval('activate', { canaryDigest: '0'.repeat(64) });
  refuses(() => activateEnrollment(f.common), 'APPROVAL_BINDING_MISMATCH');
}

// No invalidation/revoke/delete action exists; a later destructive operation
// cannot reuse enrollment authorization.
{
  const f = fixture();
  const cli = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  for (const command of ['invalidate', 'revoke', 'delete']) {
    const run = spawnSync(process.execPath, [cli, command, '--config', f.configPath], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /INVALID_ARGUMENTS/);
  }
}

// Approval authentication, clock, action, and binding checks fail closed.
{
  const f = fixture();
  const artifact = f.approval('stage');
  const expected = {
    action: 'additive-publish',
    manifestDigest: f.digest,
    manifestEntryId: ENTRY.id,
    provider: 'claude',
    email: ENTRY.email,
    organizationUuid: ENTRY.organizationUuid,
    organizationName: ENTRY.organizationName,
    accountOwner: ENTRY.accountOwner,
    authorizedOperator: 'operator',
    environment: 'controlled-test',
    candidateDigest: f.candidateDigest,
    oldTargetDigest: null,
    inventoryDigest: null,
    canaryDigest: null,
    destination: ENTRY.authFilename,
  };
  const verify = (a = artifact, e = expected, now = NOW) =>
    verifyApproval({ artifact: a, keyPath: f.keyPath, expected: e, now, maxTtlMs: 300_000 });
  verify();
  refuses(() => verify({ ...artifact, signature: '0'.repeat(64) }), 'INVALID_SIGNATURE');
  for (const [key, value] of [
    ['action', 'canonical-switch'],
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

// Generic rotation-vault exports never self-authorize from lock ownership and
// live identity. They refuse before profile fetch or filesystem mutation,
// including a coordinated call made from inside the canonical lock.
{
  const f = fixture();
  const vaultPath = join(f.root, 'writer-vault.json');
  writeFileSync(vaultPath, '{}', { mode: 0o600 });
  const writer = join(import.meta.dirname, '..', 'rotation-vault.mjs');
  const writerAccount = {
    email: 'race@example.com',
    orgUuid: 'race-org',
    orgName: 'Race Org',
  };
  const fetchMarker = join(f.root, 'writer-profile-fetch');
  const script = `globalThis.fetch=async()=>{require('node:fs').writeFileSync(${JSON.stringify(fetchMarker)},'unsafe');return {ok:true,json:async()=>({account:{email:'race@example.com'},organization:{uuid:'race-org',name:'Race Org'}})}}; import(${JSON.stringify(`file://${writer}`)}).then(m=>m.writeRotationToken(${JSON.stringify(writerAccount)},JSON.stringify({claudeAiOauth:{accessToken:'synthetic-race-token'}})))`;
  const env = {
    ...process.env,
    CLAUDE_AUTH_COORDINATION_CONFIG: f.configPath,
    CLAUDE_ROTATOR_CONFIG: f.manifestPath,
    CLAUDE_ROTATION_FILE_VAULT: vaultPath,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const denied = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /ROTATION_TOKEN_MUTATION_APPROVAL_REQUIRED/);
    assert.deepEqual(JSON.parse(readFileSync(vaultPath, 'utf8')), {});
    assert.equal(existsSync(fetchMarker), false);
  }
  const previousCoordination = process.env.CLAUDE_AUTH_COORDINATION_CONFIG;
  const previousInventory = process.env.CLAUDE_ROTATOR_CONFIG;
  process.env.CLAUDE_AUTH_COORDINATION_CONFIG = f.configPath;
  process.env.CLAUDE_ROTATOR_CONFIG = f.manifestPath;
  try {
    await withAuthWriterLock((capability) => {
      assert.throws(
        () =>
          writeRotationTokenCoordinated(
            writerAccount,
            JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-race-token' } }),
            capability,
          ),
        /ROTATION_TOKEN_MUTATION_APPROVAL_REQUIRED/,
      );
    });
  } finally {
    if (previousCoordination === undefined) delete process.env.CLAUDE_AUTH_COORDINATION_CONFIG;
    else process.env.CLAUDE_AUTH_COORDINATION_CONFIG = previousCoordination;
    if (previousInventory === undefined) delete process.env.CLAUDE_ROTATOR_CONFIG;
    else process.env.CLAUDE_ROTATOR_CONFIG = previousInventory;
  }
  assert.deepEqual(JSON.parse(readFileSync(vaultPath, 'utf8')), {});
}

// Writer capabilities are scoped to the exact outer lock transaction and are
// unusable after synchronous or asynchronous completion.
for (const asynchronous of [false, true]) {
  const f = fixture();
  let retained;
  const result = withAuthWriterLock(
    async (capability) => {
      retained = capability;
      requireWriterCapability(capability);
      return asynchronous ? Promise.resolve('ok') : 'ok';
    },
    { configPath: f.configPath },
  );
  assert.equal(await result, 'ok');
  assert.throws(() => requireWriterCapability(retained), /AUTH_WRITER_CAPABILITY_REQUIRED/);
}

// A detached async descendant retains AsyncLocalStorage context but not lock
// authority after the outer transaction settles.
{
  const f = fixture();
  let detachedAttempt;
  await withAuthWriterLock(
    () => {
      detachedAttempt = new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await withAuthWriterLock(() => resolve('unsafe-entry'), { configPath: f.configPath });
          } catch (error) {
            resolve(error.message);
          }
        }, 0);
      });
      return 'outer-complete';
    },
    { configPath: f.configPath },
  );
  assert.equal(await detachedAttempt, 'AUTH_WRITER_CAPABILITY_REQUIRED');
}

// Non-native thenables are assimilated and revoked even without `.finally`.
{
  const f = fixture();
  let retained;
  let detachedAttempt;
  const thenable = withAuthWriterLock(
    (capability) => {
      retained = capability;
      detachedAttempt = new Promise((resolve) =>
        setTimeout(() => {
          try {
            withAuthWriterLock(() => resolve('unsafe-entry'), { configPath: f.configPath });
          } catch (error) {
            resolve(error.message);
          }
        }, 0),
      );
      return { then: (resolve) => resolve('assimilated') };
    },
    { configPath: f.configPath },
  );
  assert.equal(await thenable, 'assimilated');
  assert.throws(() => requireWriterCapability(retained), /AUTH_WRITER_CAPABILITY_REQUIRED/);
  assert.equal(await detachedAttempt, 'AUTH_WRITER_CAPABILITY_REQUIRED');
}

// A real staged activation process excludes an ordinary writer plus protected
// healing-read and delete mutations until activation releases the same lock.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  const rotationVault = join(f.root, 'contended-rotation.json');
  const healService = 'Claude-Rotation-heal@example.com';
  const healToken = { claudeAiOauth: { accessToken: 'unchanged-heal-token', expiresAt: 123 } };
  writeFileSync(rotationVault, JSON.stringify({ [healService]: healToken }), { mode: 0o600 });
  const home = join(f.root, 'contention-home');
  mkdirSync(home, { mode: 0o700 });
  const stagedModule = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const rotationModule = join(import.meta.dirname, '..', 'rotation-vault.mjs');
  const linuxModule = join(import.meta.dirname, '..', 'vault-linux.mjs');
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_AUTH_COORDINATION_CONFIG: f.configPath,
    CLAUDE_ROTATOR_CONFIG: f.manifestPath,
    CLAUDE_ROTATION_FILE_VAULT: rotationVault,
  };
  const deleteVaultDir = join(home, '.local', 'share', 'claude-rotation');
  mkdirSync(deleteVaultDir, { recursive: true, mode: 0o700 });
  const deleteVaultPath = join(deleteVaultDir, `${sha256('delete-me').slice(0, 24)}.json`);
  writeFileSync(deleteVaultPath, 'synthetic-delete-value', { mode: 0o600 });
  const activationScript = `import(${JSON.stringify(`file://${stagedModule}`)}).then(m=>m.activateEnrollment(${JSON.stringify({ ...f.common, now: NOW })}))`;
  const activation = spawn(process.execPath, ['--input-type=module', '-e', activationScript], {
    env: {
      ...env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: 'SIGSTOP:LOCK_ACQUIRED',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const resultPromise = childResult(activation);
  let activated;
  try {
    await waitFor(() => existsSync(f.common.operationLockPath), 'stopped activation lock');
    await waitForStoppedChild(activation, 'lock-acquired fault stop');
    const attempts = [
      `import(${JSON.stringify(`file://${rotationModule}`)}).then(m=>m.writeRotationToken({email:'writer@example.com',orgUuid:'writer-org',orgName:'Writer Org'},JSON.stringify({claudeAiOauth:{accessToken:'blocked-writer-token'}})))`,
      `import(${JSON.stringify(`file://${linuxModule}`)}).then(m=>m.deleteEntry('delete-me'))`,
    ].map((script) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
    for (const [index, attempt] of attempts.entries()) {
      assert.notEqual(attempt.status, 0);
      assert.match(
        attempt.stderr,
        index === 0 ? /ROTATION_TOKEN_MUTATION_APPROVAL_REQUIRED/ : /GENERIC_CREDENTIAL_DELETE_FORBIDDEN/,
      );
    }
    assert.deepEqual(JSON.parse(readFileSync(rotationVault, 'utf8')), { [healService]: healToken });
    assert.equal(readFileSync(deleteVaultPath, 'utf8'), 'synthetic-delete-value');
    signalChild(activation, 'SIGCONT');
    activated = await resultPromise;
  } finally {
    signalChild(activation, 'SIGCONT');
    signalChild(activation, 'SIGTERM');
  }
  assert.equal(activated.status, 0, activated.stderr);
}

// Every generic JS/CLI/shell setter rejects all protected service spellings
// before a backend side effect, while unrelated namespaces remain compatible.
{
  const root = mkdtempSync(join(tmpdir(), 'credential-setter-policy-'));
  const data = join(root, 'data');
  const mjs = join(import.meta.dirname, '..', '..', '..', 'lib', 'credential-store.mjs');
  const sh = join(import.meta.dirname, '..', '..', '..', 'lib', 'credential-store.sh');
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: data, CLAUDE_OPS_CRED_BACKEND: 'plaintext-json' };
  const protectedServices = [
    'Claude-Rotation',
    'Claude-Rotation-user@example.com',
    'Claude Code-credentials',
    'cLaUdE-rOtAtIoN-Mixed',
  ];
  for (const service of protectedServices) {
    const api = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {setCredential} from ${JSON.stringify(`file://${mjs}`)}; await setCredential(${JSON.stringify(service)},'acct','secret')`,
      ],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(api.status, 0);
    for (const command of ['set', 'set-keytar', 'delete', 'delete-keytar']) {
      const run = spawnSync(process.execPath, [mjs, command, service, 'acct', 'secret'], { env, encoding: 'utf8' });
      assert.notEqual(run.status, 0, `${command} accepted ${service}`);
    }
    for (const command of ['set', 'set-stdin', 'delete']) {
      const argv = command === 'set' ? [sh, command, service, 'acct', 'secret'] : [sh, command, service, 'acct'];
      const run = spawnSync('bash', argv, {
        env,
        input: command === 'set-stdin' ? 'secret' : undefined,
        encoding: 'utf8',
      });
      assert.notEqual(run.status, 0, `shell ${command} accepted ${service}`);
    }
  }
  const plain = join(data, 'claude-ops', 'secrets.plain.json');
  assert.equal(existsSync(plain), false, 'protected setters reached a backend');
  const benign = spawnSync(process.execPath, [mjs, 'set', 'Example-Service', 'acct', 'secret'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(benign.status, 0, benign.stderr);
  assert.equal(JSON.parse(readFileSync(plain, 'utf8'))['Example-Service/acct'], 'secret');
}

// Legacy keychain/vault setters fail closed. The only compatible swap path
// verifies full target identity while holding the canonical lock and writes
// nothing on profile mismatch.
{
  const f = fixture();
  const home = join(f.root, 'verified-swap-home');
  const claudeDir = join(home, '.claude');
  const vaultDir = join(home, '.local', 'share', 'claude-rotation');
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  const activePath = join(claudeDir, '.credentials.json');
  const storedPath = join(vaultDir, `${sha256('Claude-Rotation-target@example.com').slice(0, 24)}.json`);
  const previous = { claudeAiOauth: { accessToken: 'previous-token' }, mcpOAuth: {} };
  const target = { claudeAiOauth: { accessToken: 'target-token' }, mcpOAuth: {} };
  writeFileSync(activePath, JSON.stringify(previous), { mode: 0o600 });
  writeFileSync(storedPath, JSON.stringify(target), { mode: 0o600 });
  const swapModule = join(import.meta.dirname, '..', 'keychain-swap.mjs');
  const coordinationModule = join(import.meta.dirname, '..', 'auth-writer-coordination.mjs');
  const linuxModule = join(import.meta.dirname, '..', 'vault-linux.mjs');
  const account = { email: 'target@example.com', orgUuid: 'target-org', orgName: 'Target Org' };
  const previousAccount = { email: 'previous@example.com', orgUuid: 'previous-org', orgName: 'Previous Org' };
  const runSwap = (profileEmail) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `globalThis.fetch=async(_url,options)=>{const previous=String(options.headers.Authorization).includes('previous-token');return {ok:true,json:async()=>previous?{account:{email:'previous@example.com'},organization:{uuid:'previous-org',name:'Previous Org'}}:{account:{email:${JSON.stringify(profileEmail)}},organization:{uuid:'target-org',name:'Target Org'}}}}; const c=await import(${JSON.stringify(`file://${coordinationModule}`)}); const k=await import(${JSON.stringify(`file://${swapModule}`)}); await c.withAuthWriterLock(cap=>k.swapToAccountCoordinated(${JSON.stringify(account)},${JSON.stringify(previousAccount)},cap));`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_AUTH_COORDINATION_CONFIG: f.configPath,
          CLAUDE_ROTATOR_CONFIG: f.manifestPath,
        },
        encoding: 'utf8',
      },
    );
  const mismatch = runSwap('wrong@example.com');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /SIGNED_CREDENTIAL_MUTATION_APPROVAL_REQUIRED/);
  assert.deepEqual(JSON.parse(readFileSync(activePath, 'utf8')), previous);
  const otherwiseValid = runSwap(account.email);
  assert.notEqual(otherwiseValid.status, 0);
  assert.match(otherwiseValid.stderr, /SIGNED_CREDENTIAL_MUTATION_APPROVAL_REQUIRED/);
  assert.deepEqual(JSON.parse(readFileSync(activePath, 'utf8')), previous);
  for (const script of [
    `import(${JSON.stringify(`file://${swapModule}`)}).then(m=>m.writeCurrentToken('{}'))`,
    `import(${JSON.stringify(`file://${swapModule}`)}).then(m=>m.restoreToken('{}'))`,
    `import(${JSON.stringify(`file://${linuxModule}`)}).then(m=>m.writeEntry('Claude Code-credentials','{}'))`,
  ]) {
    const refusal = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /(?:LEGACY|GENERIC)_CREDENTIAL_WRITE_FORBIDDEN/);
  }

  // The claude-p compatibility entrypoint restores exact preverified bytes and
  // releases its legacy lock when the post-swap budget probe refuses.
  writeFileSync(activePath, JSON.stringify(previous), { mode: 0o600 });
  const runtimeConfig = join(home, 'rotation-config.json');
  const runtimeState = join(home, 'state.json');
  const ledger = join(home, 'ledger.json');
  const legacyLock = join(home, 'keychain.lock');
  writeFileSync(runtimeConfig, JSON.stringify({ accounts: [account, previousAccount] }), { mode: 0o600 });
  writeFileSync(runtimeState, JSON.stringify({ activeAccount: previousAccount.email }), { mode: 0o600 });
  writeFileSync(
    ledger,
    JSON.stringify({
      schema_version: 2,
      month: '2030-01',
      accounts: [{ email: account.email, remaining_usd: 100 }],
    }),
    { mode: 0o600 },
  );
  const bin = join(home, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "no budget flag"\n', { mode: 0o700 });
  chmodSync(join(bin, 'claude'), 0o700);
  const claudePAs = join(import.meta.dirname, '..', 'claude-p-as.mjs');
  const compatibility = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch=async(_url,options)=>{const previous=String(options.headers.Authorization).includes('previous-token');return {ok:true,json:async()=>previous?{account:{email:'previous@example.com'},organization:{uuid:'previous-org',name:'Previous Org'}}:{account:{email:'target@example.com'},organization:{uuid:'target-org',name:'Target Org'}}}}; const {main}=await import(${JSON.stringify(`file://${claudePAs}`)}); await main(['--ledger',${JSON.stringify(ledger)},'--config',${JSON.stringify(runtimeConfig)},'--lock',${JSON.stringify(legacyLock)},'--pin','target@example.com','--','test']);`,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_AUTH_COORDINATION_CONFIG: f.configPath,
        CLAUDE_ROTATOR_CONFIG: f.manifestPath,
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(compatibility.status, 0);
  assert.match(compatibility.stderr, /SIGNED_CREDENTIAL_MUTATION_APPROVAL_REQUIRED/);
  assert.deepEqual(JSON.parse(readFileSync(activePath, 'utf8')), previous);
  assert.equal(existsSync(legacyLock), false);
}

// Refreshed-token identity is checked by an injected offline profile fetch and
// requires exact configured email and organization UUID/name.
{
  const account = {
    email: ENTRY.email,
    orgUuid: ENTRY.organizationUuid,
    orgName: ENTRY.organizationName,
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      account: { email: ENTRY.email },
      organization: { uuid: ENTRY.organizationUuid, name: ENTRY.organizationName },
    }),
  });
  assert.equal((await verifyRefreshedTokenIdentity(account, 'synthetic-token', { fetchImpl })).email, ENTRY.email);
  await assert.rejects(
    verifyRefreshedTokenIdentity({ ...account, orgUuid: 'wrong' }, 'synthetic-token', { fetchImpl }),
    /TOKEN_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    verifyRefreshedTokenIdentity({ email: ENTRY.email }, 'synthetic-token', { fetchImpl }),
    /TOKEN_IDENTITY_CONFIG_MISSING/,
  );
}

// Deprecated capture exits before configuration reads, vault/keychain writes,
// or rotation-data creation.
{
  const root = mkdtempSync(join(tmpdir(), 'rotate-capture-refusal-'));
  const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'rotate.mjs'), '--capture'], {
    env: { ...process.env, HOME: root, CLAUDE_PLUGIN_DATA_DIR: join(root, 'plugin-data') },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /staged enrollment is required/);
  assert.equal(existsSync(join(root, 'plugin-data')), false);
}

// Reads are side-effect free; deletion remains a coordinated mutation and fails
// before changing its vault when coordination is unavailable.
{
  const root = mkdtempSync(join(tmpdir(), 'writer-coordination-required-'));
  const rotationVault = join(root, 'rotation.json');
  const service = 'Claude-Rotation-heal@example.com';
  const token = { claudeAiOauth: { accessToken: 'synthetic', expiresAt: 123 } };
  writeFileSync(rotationVault, JSON.stringify({ [service]: token }), { mode: 0o600 });
  const rotationModule = join(import.meta.dirname, '..', 'rotation-vault.mjs');
  const heal = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${rotationModule}`)}).then(m=>m.readRotationToken('heal@example.com'))`,
    ],
    {
      env: {
        ...process.env,
        HOME: root,
        CLAUDE_ROTATION_FILE_VAULT: rotationVault,
        CLAUDE_AUTH_COORDINATION_CONFIG: '',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(heal.status, 0, heal.stderr);
  assert.deepEqual(JSON.parse(readFileSync(rotationVault, 'utf8')), { [service]: token });

  const linuxModule = join(import.meta.dirname, '..', 'vault-linux.mjs');
  const deletion = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(`file://${linuxModule}`)}).then(m=>m.deleteEntry('some-service'))`,
    ],
    { env: { ...process.env, HOME: root, CLAUDE_AUTH_COORDINATION_CONFIG: '' }, encoding: 'utf8' },
  );
  assert.notEqual(deletion.status, 0);
}

// Authorized rollback is recoverable in a fresh process at every durable
// intent/switch/cleanup boundary without reusing the external approval.

// A retained staging proof is re-homed as the rollback anchor rather than
// copied to a third link, so a second complete rotation remains valid.
{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  activateEnrollment(f.common);

  const secondCandidate = { ...CANDIDATE, access_token: 'second-rotation-access-token' };
  writeFileSync(f.candidatePath, JSON.stringify(secondCandidate), { mode: 0o600 });
  const secondDigest = sha256(readFileSync(f.candidatePath));
  const secondCanary = JSON.parse(readFileSync(f.canaryPath, 'utf8'));
  secondCanary.results.forEach((result) => (result.candidateDigest = secondDigest));
  writeFileSync(f.canaryPath, JSON.stringify(secondCanary), { mode: 0o600 });
  f.approval('stage', { id: 'second-stage', nonce: 'second-stage-nonce', candidateDigest: secondDigest });
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate', {
    id: 'second-activate',
    nonce: 'second-activate-nonce',
    candidateDigest: secondDigest,
    canaryDigest: sha256(readFileSync(f.canaryPath)),
  });
  activateEnrollment(f.common);
  assert.equal(
    sha256(readFileSync(join(f.paths.active, ENTRY.authFilename))),
    secondDigest,
    'second rotation becomes canonical',
  );
}

{
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  f.approval('activate');
  activateEnrollment(f.common);
  const active = join(f.paths.active, ENTRY.authFilename);
  const activeDigest = sha256(readFileSync(active));
  const activeProof = `${join(f.paths.staging, ENTRY.authFilename)}.preparation-${activeDigest}`;
  const secondCandidate = { ...CANDIDATE, access_token: 'proof-race-second-token' };
  writeFileSync(f.candidatePath, JSON.stringify(secondCandidate), { mode: 0o600 });
  const secondDigest = sha256(readFileSync(f.candidatePath));
  const secondCanary = JSON.parse(readFileSync(f.canaryPath, 'utf8'));
  secondCanary.results.forEach((result) => (result.candidateDigest = secondDigest));
  writeFileSync(f.canaryPath, JSON.stringify(secondCanary), { mode: 0o600 });
  f.approval('stage', { id: 'proof-race-stage', nonce: 'proof-race-stage-nonce', candidateDigest: secondDigest });
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const activation = f.approval('activate', {
    id: 'proof-race-activate',
    nonce: 'proof-race-activate-nonce',
    candidateDigest: secondDigest,
    canaryDigest: sha256(readFileSync(f.canaryPath)),
  });
  refuses(
    () =>
      activateEnrollment({
        ...f.common,
        beforeCas: () => {
          unlinkSync(activeProof);
          writeFileSync(activeProof, readFileSync(active), { mode: 0o600 });
        },
      }),
    'ACTIVE_TARGET_CAS_FAILED',
  );
  assert.equal(sha256(readFileSync(active)), activeDigest, 'proof replacement cannot switch the active target');
  assert.equal(
    existsSync(join(f.paths.usage, `${activation.payload.id}.${activation.payload.nonce}.used`)),
    false,
    'proof replacement is rejected before approval consumption',
  );
}

for (const fault of [
  'SIGKILL:ROLLBACK_PREPARING_INTENT',
  'SIGKILL:ROLLBACK_TEMP_LINK',
  'SIGKILL:ROLLBACK_SWITCH',
  'SIGKILL:ROLLBACK_CLEANUP',
]) {
  const f = fixture();
  f.approval('stage');
  stageEnrollment({ ...f.common, candidatePath: f.candidatePath });
  const target = join(f.paths.active, ENTRY.authFilename);
  const old = JSON.stringify({ ...CANDIDATE, access_token: `rollback-old-${fault}` });
  writeFileSync(target, old, { mode: 0o600 });
  f.approval('activate');
  activateEnrollment(f.common);
  authorizeRollback(f);
  const modulePath = join(import.meta.dirname, '..', 'staged-enrollment.mjs');
  const invoke = `import(${JSON.stringify(`file://${modulePath}`)}).then(m=>process.stdout.write(JSON.stringify(m.rollbackEnrollment(${JSON.stringify({ configPath: f.configPath, entryId: ENTRY.id, approvalPath: f.approvalPath, now: NOW })}))))`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', invoke], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_STAGED_ENROLLMENT_TESTING: '1',
      CLAUDE_STAGED_ENROLLMENT_TEST_FAULT: fault,
    },
  });
  assert.equal(killed.signal, 'SIGKILL', `${fault}: ${killed.stderr}`);
  writeFileSync(f.approvalPath, '{}', { mode: 0o600 });
  const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', invoke], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, `${fault}: ${recovered.stderr}`);
  assert.equal(JSON.parse(recovered.stdout).recovered, true);
  assert.equal(readFileSync(target, 'utf8'), old);
  assert.ok(
    readdirSync(f.paths.rollback).every((name) => name.startsWith('.evidence-') || name.includes('.preparation-')),
    `${fault}: rollback retains only authenticated evidence`,
  );
}

console.log('staged-enrollment.test.mjs: ok');
