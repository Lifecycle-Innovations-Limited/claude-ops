#!/usr/bin/env node
/** Offline plan/apply/preflight for the mandatory auth-writer coordination deployment. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  constants,
  fstatSync,
  unlinkSync,
} from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson, parseManifestBytes, readDeploymentConfig } from './staged-enrollment.mjs';
import { parseStrictJson } from './strict-json.mjs';

const VERSION = 1;
const PATH_FLAGS = [
  'manifest',
  'active',
  'staging',
  'usage',
  'rollback',
  'lock',
  'provision-lock',
  'trust',
  'config',
  'linux-env',
  'macos-env',
  'linux-unit',
  'macos-plist',
  'runtime-inventory',
  'authoritative-consumer-inventory',
  'linux-refresh-unit',
];

function fail(code) {
  throw new Error(code);
}
function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function rawDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i] === key || argv[i + 1] === undefined || out[key] !== undefined) fail('INVALID_ARGUMENTS');
    out[key] = argv[i + 1];
  }
  return out;
}
function json(path, code = 'INVALID_JSON') {
  try {
    return parseStrictJson(readFileSync(path, 'utf8'), code);
  } catch {
    fail(code);
  }
}
function contained(parent, child) {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
function canonicalProspective(path) {
  if (!isAbsolute(path) || path.includes('\0')) fail('PATH_NOT_ABSOLUTE');
  let cursor = resolve(path);
  const tail = [];
  while (!existsSync(cursor)) {
    tail.unshift(cursor.split('/').pop());
    cursor = dirname(cursor);
  }
  return join(realpathSync(cursor), ...tail);
}
function sameCanonicalPath(left, right) {
  return (
    typeof left === 'string' && typeof right === 'string' && canonicalProspective(left) === canonicalProspective(right)
  );
}
function assertSafeAncestorChain(path) {
  let cursor = dirname(path);
  while (!existsSync(cursor)) cursor = dirname(cursor);
  let immediate = true;
  for (;;) {
    const st = lstatSync(cursor);
    if (st.isSymbolicLink() || !st.isDirectory() || (st.uid !== process.getuid() && st.uid !== 0))
      fail('UNSAFE_PATH_ANCESTOR');
    if (immediate && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) fail('UNSAFE_PATH_ANCESTOR');
    if ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0)) fail('UNSAFE_PATH_ANCESTOR');
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
    immediate = false;
  }
}
function assertSafeAncestors(path) {
  const raw = resolve(path);
  const canonical = canonicalProspective(path);
  // macOS system paths contain root-owned compatibility symlinks such as /var.
  if (platform() !== 'darwin') assertSafeAncestorChain(raw);
  assertSafeAncestorChain(canonical);
}
function mode(path) {
  return statSync(path).mode & 0o777;
}
function fsyncDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function processStart(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === 'ESRCH' ? { state: 'dead' } : { state: 'unknown' };
  }
  try {
    if (platform() === 'darwin') {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      });
      const startedAt = result.status === 0 ? Date.parse(result.stdout.trim().replace(/\s+/g, ' ')) : Number.NaN;
      return Number.isSafeInteger(startedAt) ? { state: 'live', value: String(startedAt) } : { state: 'unknown' };
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    if (!/^\d+$/.test(fields[19] || '')) return { state: 'unknown' };
    return { state: 'live', value: fields[19] };
  } catch {
    return { state: 'unknown' };
  }
}
function bootstrapAttemptPath(plan) {
  return `${plan.paths['provision-lock']}.bootstrap-attempt`;
}
function validateProvisionLockRecord(record) {
  if (
    !record ||
    Object.keys(record).sort().join(',') !== 'nonce,pid,planDigest,start,version' ||
    record.version !== 1 ||
    typeof record.planDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.planDigest || '') ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.start !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(record.start || '') ||
    typeof record.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record.nonce || '')
  )
    fail('INVALID_PROVISION_LOCK');
  return record;
}
function withProvisionLock(plan, callback) {
  const path = plan.paths['provision-lock'];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let owned;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const nonce = randomBytes(16).toString('hex');
      const self = processStart(process.pid);
      if (self.state !== 'live') fail('PROVISION_LOCK_LIVENESS_UNKNOWN');
      owned = publishExclusiveRecord(
        path,
        `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: process.pid, start: self.value, nonce })}\n`,
        'PROVISION_LOCK_PUBLICATION_FAILED',
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw error;
      validateExistingTarget(path, 'file');
      const descriptor = secureReadDescriptor(path, 'INVALID_PROVISION_LOCK');
      if (!plan.provisionLockSnapshot || !descriptorEquals(descriptor, plan.provisionLockSnapshot))
        fail('PROVISION_LOCK_REVIEW_REQUIRED');
      const stale = validateProvisionLockRecord(parseStrictJson(descriptor.bytes, 'INVALID_PROVISION_LOCK'));
      if (
        ![plan.digest, plan.recoverySnapshot?.planDigest, plan.provisionLockSnapshot?.planDigest]
          .filter(Boolean)
          .includes(stale.planDigest)
      )
        fail('INVALID_PROVISION_LOCK');
      const current = processStart(stale.pid);
      if (current.state === 'unknown' || (current.state === 'live' && current.value === stale.start))
        fail('PROVISION_LOCK_HELD');
      removeOwnedPath(path, descriptor, 'PROVISION_LOCK_OWNERSHIP_LOST');
    }
  }
  if (!owned) fail('PROVISION_LOCK_HELD');
  try {
    return callback();
  } finally {
    if (!removeOwnedPath(path, owned, 'PROVISION_LOCK_OWNERSHIP_LOST')) fail('PROVISION_LOCK_OWNERSHIP_LOST');
  }
}
function descriptorIdentity(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}
function descriptorEquals(actual, expected) {
  return ['dev', 'ino', 'birthtimeNs', 'digest', 'length'].every((key) => actual[key] === expected[key]);
}
function secureReadDescriptor(path, code, requireSingleLink = true) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const pre = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const post = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    const identity = descriptorIdentity(pre);
    const preparation = `${path}.preparation-${rawDigest(bytes)}`;
    const boundedLinks =
      pre.nlink === 2n &&
      existsSync(preparation) &&
      canonicalJson(identity) === canonicalJson(descriptorIdentity(lstatSync(preparation, { bigint: true })));
    if (
      !pre.isFile() ||
      !named.isFile() ||
      canonicalJson(identity) !== canonicalJson(descriptorIdentity(post)) ||
      canonicalJson(identity) !== canonicalJson(descriptorIdentity(named)) ||
      pre.uid !== BigInt(process.getuid()) ||
      (requireSingleLink && pre.nlink !== 1n && !boundedLinks) ||
      (pre.mode & 0o077n) !== 0n
    )
      fail(code);
    return { ...identity, digest: rawDigest(bytes), length: bytes.length, bytes };
  } catch {
    fail(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function secureReadPublishedRecord(path, code) {
  const descriptor = secureReadDescriptor(path, code, false);
  const proof = `${path}.preparation-${descriptor.digest}`;
  const named = lstatSync(path, { bigint: true });
  if (named.nlink === 1n) return descriptor;
  if (named.nlink !== 2n || !existsSync(proof) || !descriptorMatches(proof, descriptor, code)) fail(code);
  return { ...descriptor, proof };
}
function secureReadSource(path, code) {
  return secureReadPublishedRecord(path, code).bytes;
}
function descriptorMatches(path, expected, code = 'PROVISION_RECOVERY_UNCERTAIN') {
  const actual = secureReadDescriptor(path, code, false);
  return descriptorEquals(actual, expected);
}
function completionReceiptPath(plan) {
  return `${plan.paths.config}.provision-receipt.${plan.digest}`;
}
function completionPayload(plan, trust) {
  return {
    version: 1,
    planDigest: plan.digest,
    trustSnapshot: plan.trustSnapshot,
    trustDescriptor: Object.fromEntries(
      ['dev', 'ino', 'birthtimeNs', 'digest', 'length'].map((key) => [key, trust[key]]),
    ),
  };
}
function reviewedTrust(plan) {
  if (plan.trustSnapshot?.state !== 'present' || !existsSync(plan.paths.trust)) fail('TRUST_SNAPSHOT_CHANGED');
  const trust = secureReadDescriptor(plan.paths.trust, 'TRUST_SNAPSHOT_CHANGED');
  if (!descriptorEquals(trust, plan.trustSnapshot)) fail('TRUST_SNAPSHOT_CHANGED');
  return trust;
}
function validateCompletionReceipt(plan, trust = reviewedTrust(plan)) {
  const path = completionReceiptPath(plan);
  if (!existsSync(path)) fail('INVALID_PROVISION_RECEIPT');
  if (!descriptorMatches(plan.paths.trust, trust, 'TRUST_SNAPSHOT_CHANGED')) fail('TRUST_SNAPSHOT_CHANGED');
  const receiptDescriptor = secureReadPublishedRecord(path, 'INVALID_PROVISION_RECEIPT');
  let receipt;
  try {
    receipt = parseStrictJson(receiptDescriptor.bytes, 'INVALID_PROVISION_RECEIPT');
  } catch {
    fail('INVALID_PROVISION_RECEIPT');
  }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'payload,signature') fail('INVALID_PROVISION_RECEIPT');
  const expected = completionPayload(plan, trust);
  if (canonicalJson(receipt.payload) !== canonicalJson(expected) || !/^[a-f0-9]{64}$/.test(receipt.signature || ''))
    fail('INVALID_PROVISION_RECEIPT');
  const signature = createHmac('sha256', trust.bytes).update(canonicalJson(expected)).digest();
  if (!timingSafeEqual(Buffer.from(receipt.signature, 'hex'), signature)) fail('INVALID_PROVISION_RECEIPT');
  return true;
}
function publishCompletionReceipt(plan, trust) {
  if (plan.trustSnapshot?.state !== 'present') return false;
  const path = completionReceiptPath(plan);
  trust ||= reviewedTrust(plan);
  if (!descriptorMatches(plan.paths.trust, trust, 'TRUST_SNAPSHOT_CHANGED')) fail('TRUST_SNAPSHOT_CHANGED');
  const payload = completionPayload(plan, trust);
  const bytes = Buffer.from(
    `${canonicalJson({ payload, signature: createHmac('sha256', trust.bytes).update(canonicalJson(payload)).digest('hex') })}\n`,
  );
  if (existsSync(path)) return validateCompletionReceipt(plan, trust);
  publishExclusiveRecord(path, bytes, 'INVALID_PROVISION_RECEIPT');
  return validateCompletionReceipt(plan, trust);
}
function publishExclusiveRecord(path, bytes, code) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const expectedBytes = Buffer.from(bytes);
  const temp = `${path}.preparation-${rawDigest(expectedBytes)}`;
  let descriptor;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (fd === undefined) {
    descriptor = secureReadDescriptor(temp, code, false);
    if (!descriptor.bytes.equals(expectedBytes)) fail(code);
  } else {
    try {
      writeFileSync(fd, expectedBytes);
      fsyncSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      descriptor = {
        ...descriptorIdentity(stat),
        digest: rawDigest(expectedBytes),
        length: expectedBytes.length,
      };
    } finally {
      closeSync(fd);
    }
  }
  fsyncDirectory(dirname(path));
  if (
    process.env.CLAUDE_COORDINATION_TESTING === '1' &&
    sameCanonicalPath(process.env.CLAUDE_COORDINATION_TEST_RECORD_TARGET, path) &&
    process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:RECORD_PRE_LINK'
  )
    process.kill(process.pid, 'SIGKILL');
  if (existsSync(path)) {
    if (!descriptorMatches(path, descriptor, code)) linkSync(temp, path);
  } else linkSync(temp, path);
  if (
    process.env.CLAUDE_COORDINATION_TESTING === '1' &&
    sameCanonicalPath(process.env.CLAUDE_COORDINATION_TEST_RECORD_TARGET, path) &&
    process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:RECORD_LINKED'
  )
    process.kill(process.pid, 'SIGKILL');
  fsyncDirectory(dirname(path));
  if (!descriptorMatches(path, descriptor, code)) fail(code);
  if (
    process.env.CLAUDE_COORDINATION_TESTING === '1' &&
    sameCanonicalPath(process.env.CLAUDE_COORDINATION_TEST_RECORD_TARGET, path) &&
    process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:RECORD_DIR_FSYNCED'
  )
    process.kill(process.pid, 'SIGKILL');
  // Retain the exact preparation alias. Readers permit only this digest-derived
  // two-link topology and reject arbitrary hardlinks.
  return descriptor;
}

function beginAbsentTrustBootstrap(plan) {
  const path = bootstrapAttemptPath(plan);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${canonicalJson({ version: 1, planDigest: plan.digest })}\n`);
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('BOOTSTRAP_ATTEMPT_REVIEW_REQUIRED');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
function removeOwnedPath(path, expected, code = 'PROVISION_RECOVERY_UNCERTAIN') {
  const detached = `${path}.detached-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, detached);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!descriptorMatches(detached, expected, code)) {
    fsyncDirectory(dirname(path));
    fail(code);
  }
  // Retain the detached inode as evidence. Restoring or automatically deleting
  // it would reopen the replacement race this cleanup is intended to close.
  fsyncDirectory(dirname(path));
  return true;
}
function validateExistingTarget(path, kind) {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== process.getuid()) fail('UNSAFE_EXISTING_TARGET');
  if (kind === 'file' && (!st.isFile() || ![1, 2].includes(st.nlink) || (st.mode & 0o077) !== 0))
    fail('UNSAFE_EXISTING_TARGET');
  if (kind === 'file' && st.nlink === 2) secureReadPublishedRecord(path, 'UNSAFE_EXISTING_TARGET');
  if (kind === 'directory' && (!st.isDirectory() || (st.mode & 0o077) !== 0)) fail('UNSAFE_EXISTING_TARGET');
}
function validateTopology(paths, quarantine) {
  const all = [...PATH_FLAGS.map((k) => paths[k]), ...quarantine];
  if (all.some((p) => typeof p !== 'string' || !p)) fail('MISSING_PATH');
  all.forEach(assertSafeAncestors);
  const canonical = Object.fromEntries(PATH_FLAGS.map((k) => [k, canonicalProspective(paths[k])]));
  const q = quarantine.map(canonicalProspective);
  const mutable = [canonical.active, canonical.staging, canonical.usage, canonical.rollback, ...q];
  const files = PATH_FLAGS.filter((key) => !['active', 'staging', 'usage', 'rollback'].includes(key)).map(
    (key) => canonical[key],
  );
  for (const root of [...mutable]) validateExistingTarget(root, 'directory');
  for (const file of files) validateExistingTarget(file, 'file');
  for (let i = 0; i < mutable.length; i++)
    for (let j = i + 1; j < mutable.length; j++)
      if (contained(mutable[i], mutable[j]) || contained(mutable[j], mutable[i])) fail('MUTABLE_ROOTS_OVERLAP');
  if (files.some((p) => mutable.some((root) => contained(root, p) || contained(p, root))))
    fail('FILE_INSIDE_MUTABLE_ROOT');
  if (new Set(files).size !== files.length) fail('FILE_TARGET_ALIAS');
  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++)
      if (contained(files[i], files[j]) || contained(files[j], files[i])) fail('FILE_TARGET_OVERLAP');
  if (mutable.some((r) => contained(r, canonical.lock) || contained(dirname(canonical.lock), r)))
    fail('LOCK_TOPOLOGY_INVALID');
  return { ...canonical, quarantine: q };
}
function accountsFromInventoryBytes(bytes) {
  let inventory;
  try {
    inventory = parseStrictJson(bytes, 'INVALID_INVENTORY');
  } catch {
    fail('INVALID_INVENTORY');
  }
  if (!Array.isArray(inventory.accounts) || !inventory.accounts.length) fail('INVALID_INVENTORY');
  return inventory.accounts.map((a) => {
    for (const k of ['email', 'orgUuid', 'orgName'])
      if (typeof a?.[k] !== 'string' || !a[k].trim()) fail('ACCOUNT_IDENTITY_REQUIRED');
    return { email: a.email.trim().toLowerCase(), orgUuid: a.orgUuid.trim(), orgName: a.orgName.trim() };
  });
}
function accountsFromInventory(path) {
  return accountsFromInventoryBytes(readFileSync(path));
}
function consumersFromInventoryBytes(bytes) {
  let inventory;
  try {
    inventory = parseStrictJson(bytes, 'INVALID_CONSUMER_INVENTORY');
  } catch {
    fail('INVALID_CONSUMER_INVENTORY');
  }
  if (
    !inventory ||
    Object.keys(inventory).sort().join(',') !== 'consumers,version' ||
    inventory.version !== 1 ||
    !Array.isArray(inventory.consumers) ||
    !inventory.consumers.length
  )
    fail('INVALID_CONSUMER_INVENTORY');
  const ids = new Set();
  const paths = new Set();
  for (const consumer of inventory.consumers) {
    if (
      !consumer ||
      Object.keys(consumer).sort().join(',') !== 'credentialId,destination,id,path,type' ||
      !['credentialId', 'destination', 'id', 'path', 'type'].every(
        (key) => typeof consumer[key] === 'string' && consumer[key].trim() === consumer[key] && consumer[key],
      ) ||
      !isAbsolute(consumer.path) ||
      resolve(consumer.path) !== consumer.path ||
      ids.has(consumer.id) ||
      paths.has(consumer.path)
    )
      fail('INVALID_CONSUMER_INVENTORY');
    ids.add(consumer.id);
    paths.add(consumer.path);
  }
  return inventory;
}
function assertManifestInventory(manifestBytes, accounts) {
  const { manifest, digest: manifestDigest } = parseManifestBytes(manifestBytes);
  const expected = new Set(
    manifest.entries
      .filter((entry) => entry.provider === 'claude')
      .map((entry) => `${entry.email.toLowerCase()}\0${entry.organizationUuid}\0${entry.organizationName}`),
  );
  const actual = new Set(accounts.map((account) => `${account.email}\0${account.orgUuid}\0${account.orgName}`));
  if (expected.size !== actual.size || [...expected].some((identity) => !actual.has(identity)))
    fail('MANIFEST_INVENTORY_MISMATCH');
  return manifestDigest;
}
function buildPlan(args) {
  if (
    !args.inventory ||
    !args['consumer-inventory-source'] ||
    !args['manifest-source'] ||
    !args.quarantine ||
    !args.operator ||
    !args.environment ||
    !args['runtime-home']
  )
    fail('INVALID_ARGUMENTS');
  const paths = Object.fromEntries(PATH_FLAGS.map((k) => [k, args[k]]));
  const quarantine = args.quarantine.split(',').filter(Boolean);
  const canonicalPaths = validateTopology(paths, quarantine);
  const trustSnapshot = existsSync(canonicalPaths.trust)
    ? { state: 'present', ...secureReadDescriptor(canonicalPaths.trust, 'INVALID_TRUST_SNAPSHOT') }
    : { state: 'absent' };
  delete trustSnapshot.bytes;
  const recoveryJournalPath = `${canonicalPaths.config}.provision-journal`;
  const transitionPath = `${recoveryJournalPath}.transition`;
  const transitionSnapshot = existsSync(transitionPath)
    ? secureReadDescriptor(transitionPath, 'INVALID_PROVISION_JOURNAL_TRANSITION')
    : null;
  let transition;
  if (transitionSnapshot) {
    transition = parseStrictJson(transitionSnapshot.bytes, 'INVALID_PROVISION_JOURNAL_TRANSITION');
    delete transitionSnapshot.bytes;
  }
  if (trustSnapshot.state === 'absent' && (transitionSnapshot || existsSync(recoveryJournalPath)))
    fail('BOOTSTRAP_JOURNAL_REVIEW_REQUIRED');
  let recoverySnapshot = existsSync(recoveryJournalPath)
    ? secureReadDescriptor(recoveryJournalPath, 'INVALID_PROVISION_JOURNAL')
    : null;
  if (transition) {
    if (
      transition.version !== 1 ||
      transition.path !== recoveryJournalPath ||
      transition.nextProof !== `${recoveryJournalPath}.preparation-${transition.next?.digest}` ||
      !descriptorMatches(transition.nextProof, transition.next, 'INVALID_PROVISION_JOURNAL_TRANSITION')
    )
      fail('INVALID_PROVISION_JOURNAL_TRANSITION');
    recoverySnapshot = {
      ...transition.next,
      bytes: secureReadDescriptor(transition.nextProof, 'INVALID_PROVISION_JOURNAL_TRANSITION', false).bytes,
    };
  }
  if (recoverySnapshot) {
    let recoveryState;
    try {
      recoveryState = parseStrictJson(recoverySnapshot.bytes, 'INVALID_PROVISION_JOURNAL');
    } catch {
      fail('INVALID_PROVISION_JOURNAL');
    }
    validateProvisionJournalState(recoveryState, canonicalPaths);
    recoverySnapshot.topology = provisionRecoveryTopology(recoveryState);
    recoverySnapshot.planDigest = recoveryState.planDigest;
    recoverySnapshot.state = recoveryState;
    delete recoverySnapshot.bytes;
  }
  const provisionLockSnapshot = existsSync(canonicalPaths['provision-lock'])
    ? secureReadDescriptor(canonicalPaths['provision-lock'], 'INVALID_PROVISION_LOCK')
    : null;
  if (provisionLockSnapshot) {
    const lockState = validateProvisionLockRecord(
      parseStrictJson(provisionLockSnapshot.bytes, 'INVALID_PROVISION_LOCK'),
    );
    provisionLockSnapshot.planDigest = lockState.planDigest;
    delete provisionLockSnapshot.bytes;
  }
  const manifestSource = canonicalProspective(args['manifest-source']);
  validateExistingTarget(manifestSource, 'file');
  const provisionJournal = canonicalProspective(`${canonicalPaths.config}.provision-journal`);
  if (
    !existsSync(manifestSource) ||
    Object.values(canonicalPaths).flat().includes(manifestSource) ||
    Object.values(canonicalPaths).flat().includes(provisionJournal)
  )
    fail('MANIFEST_SOURCE_INVALID');
  const inventorySource = canonicalProspective(args.inventory);
  const consumerInventorySource = canonicalProspective(args['consumer-inventory-source']);
  const runtimeHome = canonicalProspective(args['runtime-home']);
  if (!existsSync(runtimeHome) || !lstatSync(runtimeHome).isDirectory()) fail('RUNTIME_HOME_INVALID');
  validateExistingTarget(inventorySource, 'file');
  validateExistingTarget(consumerInventorySource, 'file');
  const inventoryBytes = secureReadSource(inventorySource, 'INVALID_INVENTORY');
  const accounts = accountsFromInventoryBytes(inventoryBytes);
  const inventoryDigest = rawDigest(inventoryBytes);
  const consumerInventoryBytes = secureReadSource(consumerInventorySource, 'INVALID_CONSUMER_INVENTORY');
  const consumerInventory = consumersFromInventoryBytes(consumerInventoryBytes);
  const consumerInventoryDigest = rawDigest(consumerInventoryBytes);
  const manifestEntries = parseManifestBytes(secureReadSource(manifestSource, 'MANIFEST_SOURCE_INVALID')).manifest
    .entries;
  for (const consumer of consumerInventory.consumers) {
    const credential = manifestEntries.find(
      (entry) => entry.id === consumer.credentialId && entry.provider === 'claude',
    );
    if (!credential || credential.authFilename !== consumer.destination) fail('CONSUMER_CREDENTIAL_MISMATCH');
  }
  const manifestDigest = assertManifestInventory(secureReadSource(manifestSource, 'MANIFEST_SOURCE_INVALID'), accounts);
  const body = {
    version: VERSION,
    accounts,
    inventorySource,
    inventoryDigest,
    consumerInventorySource,
    consumerInventoryDigest,
    manifestSource,
    manifestDigest,
    paths: canonicalPaths,
    runtimeHome,
    operator: args.operator,
    environment: args.environment,
    maxApprovalTtlMs: 900000,
    trustSnapshot,
    recoverySnapshot,
    provisionLockSnapshot,
    transitionSnapshot,
  };
  const intentDigest = digest(body);
  const withIntent = { ...body, intentDigest };
  const artifactDigests = Object.fromEntries(
    Object.entries(artifactBytes(withIntent)).map(([path, bytes]) => [path, rawDigest(bytes)]),
  );
  const reviewed = { ...withIntent, artifactDigests };
  return { ...reviewed, digest: digest(reviewed) };
}
function atomicWrite(path, data, written, onPrepared, modeBits = 0o600) {
  if (existsSync(path)) {
    if (readFileSync(path).equals(Buffer.from(data)) && mode(path) === modeBits) return false;
    fail('EXISTING_FILE_MISMATCH');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.preparation-${rawDigest(Buffer.from(data))}`;
  let descriptor;
  let journaled = false;
  let fd;
  try {
    fd = openSync(temp, 'wx', modeBits);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (fd === undefined) {
    descriptor = secureReadDescriptor(temp, 'PROVISION_RECOVERY_UNCERTAIN', false);
    if (!descriptor.bytes.equals(Buffer.from(data)) || mode(temp) !== modeBits || lstatSync(temp).nlink !== 1)
      fail('PROVISION_RECOVERY_UNCERTAIN');
    descriptor.proof = temp;
  } else {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
      const st = fstatSync(fd, { bigint: true });
      descriptor = {
        ...descriptorIdentity(st),
        digest: rawDigest(Buffer.from(data)),
        length: Buffer.byteLength(data),
        proof: temp,
      };
    } finally {
      closeSync(fd);
    }
  }
  fsyncDirectory(dirname(temp));
  try {
    // Journal proof-inode ownership before publishing its final hardlink.
    onPrepared(descriptor);
    journaled = true;
    if (
      process.env.CLAUDE_COORDINATION_TESTING === '1' &&
      process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:PROVISION_PRE_LINK'
    )
      process.kill(process.pid, 'SIGKILL');
    // hard-link publication is atomic and never replaces a concurrently
    // created final target (unlike rename(2)).
    // Test-only adversarial writer used to prove link publication fails closed.
    // CodeQL[js/file-system-race]
    if (
      process.env.CLAUDE_COORDINATION_TESTING === '1' &&
      sameCanonicalPath(process.env.CLAUDE_COORDINATION_TEST_RACE_TARGET, path)
    )
      writeFileSync(path, process.env.CLAUDE_COORDINATION_TEST_RACE_SAME === '1' ? data : 'competing-owner\n', {
        flag: 'wx',
        mode: 0o600,
      });
    linkSync(temp, path);
    if (
      process.env.CLAUDE_COORDINATION_TESTING === '1' &&
      process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:PROVISION_LINKED'
    )
      process.kill(process.pid, 'SIGKILL');
    fsyncDirectory(dirname(path));
    if (
      process.env.CLAUDE_COORDINATION_TESTING === '1' &&
      process.env.CLAUDE_COORDINATION_TEST_FAULT === 'SIGKILL:PROVISION_LINK_FSYNCED'
    )
      process.kill(process.pid, 'SIGKILL');
    if (
      process.env.CLAUDE_COORDINATION_TESTING === '1' &&
      sameCanonicalPath(process.env.CLAUDE_COORDINATION_TEST_POST_LINK_REPLACE, path)
    ) {
      unlinkSync(path);
      // Test-only post-publication inode replacement.
      // CodeQL[js/file-system-race]
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
    }
    if (!descriptorMatches(path, descriptor, 'PUBLICATION_OWNERSHIP_LOST'))
      throw new Error('PUBLICATION_OWNERSHIP_LOST');
    written.push(path);
    return true;
  } catch (error) {
    throw error?.code === 'EEXIST' ? new Error('EXISTING_FILE_MISMATCH') : error;
  } finally {
    // Deterministic preparations are retained. If journal publication did not
    // complete, the unbound owner-only inode is harmless recovery evidence.
    if (!journaled) fsyncDirectory(dirname(temp));
  }
}
function rendered(plan) {
  const p = plan.paths;
  const env = `CLAUDE_AUTH_COORDINATION_CONFIG=${p.config}\n` + `CLAUDE_ROTATOR_CONFIG=${p['runtime-inventory']}\n`;
  const templatePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'templates',
    'com.claude-ops.account-rotation.plist',
  );
  const macosPlist = readFileSync(templatePath, 'utf8')
    .replaceAll('${HOME}', plan.runtimeHome)
    .replaceAll('__CLAUDE_AUTH_COORDINATION_CONFIG__', p.config)
    .replaceAll('__CLAUDE_ROTATOR_CONFIG__', p['runtime-inventory']);
  return {
    [p['linux-env']]: env,
    [p['macos-env']]: env,
    [p['linux-unit']]:
      `[Unit]\nDescription=Claude account rotation daemon\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=${p['linux-env']}\nExecStart=/usr/bin/env node ${resolve(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')}\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n`,
    [p['linux-refresh-unit']]:
      `[Service]\nType=oneshot\nEnvironmentFile=${p['linux-env']}\nExecStart=/usr/bin/env node ${resolve(dirname(fileURLToPath(import.meta.url)), 'refresh-tokens.mjs')}\n`,
    [p['macos-plist']]: macosPlist,
  };
}
function artifactBytes(plan) {
  return {
    [plan.paths.config]: Buffer.from(`${JSON.stringify(configFor(plan), null, 2)}\n`),
    [plan.paths.manifest]: secureReadSource(plan.manifestSource, 'MANIFEST_SOURCE_INVALID'),
    [plan.paths['runtime-inventory']]: secureReadSource(plan.inventorySource, 'INVALID_INVENTORY'),
    [plan.paths['authoritative-consumer-inventory']]: secureReadSource(
      plan.consumerInventorySource,
      'INVALID_CONSUMER_INVENTORY',
    ),
    ...Object.fromEntries(Object.entries(rendered(plan)).map(([path, value]) => [path, Buffer.from(value)])),
  };
}
function readReviewedPlan(path, expected) {
  const plan = json(path, 'INVALID_PLAN');
  const { digest: supplied, ...body } = plan;
  if (supplied !== digest(body) || supplied !== expected) fail('PLAN_DIGEST_MISMATCH');
  const { artifactDigests, intentDigest, ...intentBody } = body;
  if (intentDigest !== digest(intentBody) || !artifactDigests || Array.isArray(artifactDigests))
    fail('PLAN_DIGEST_MISMATCH');
  return plan;
}
function configFor(plan) {
  const p = plan.paths;
  const {
    trustSnapshot: _reviewedTrust,
    recoverySnapshot: _reviewedRecovery,
    provisionLockSnapshot: _reviewedProvisionLock,
    transitionSnapshot: _reviewedTransition,
    ...stableIntent
  } = Object.fromEntries(
    Object.entries(plan).filter(([key]) => !['digest', 'artifactDigests', 'intentDigest'].includes(key)),
  );
  return {
    manifestPath: p.manifest,
    approvalKeyPath: p.trust,
    usageDir: p.usage,
    stagingDir: p.staging,
    activeDir: p.active,
    quarantineDirs: p.quarantine,
    rollbackDir: p.rollback,
    operationLockPath: p.lock,
    environment: plan.environment,
    authorizedOperator: plan.operator,
    maxApprovalTtlMs: plan.maxApprovalTtlMs,
    runtimeInventoryPath: p['runtime-inventory'],
    runtimeInventoryDigest: plan.inventoryDigest,
    authoritativeConsumerInventoryPath: p['authoritative-consumer-inventory'],
    authoritativeConsumerInventoryDigest: plan.consumerInventoryDigest,
    deploymentPlanDigest: digest(stableIntent),
  };
}
function journalPath(plan) {
  return `${plan.paths.config}.provision-journal`;
}
function journalTransitionPath(plan) {
  return `${journalPath(plan)}.transition`;
}
function provisionTargetPaths(paths) {
  return new Set([
    paths.manifest,
    paths.trust,
    paths.config,
    paths['runtime-inventory'],
    paths['authoritative-consumer-inventory'],
    paths['linux-env'],
    paths['macos-env'],
    paths['linux-unit'],
    paths['linux-refresh-unit'],
    paths['macos-plist'],
  ]);
}
function validateProvisionJournalState(state, paths, acceptedPlanDigests) {
  const keys = Object.keys(state || {}).sort();
  const allowed = provisionTargetPaths(paths);
  if (
    keys.join(',') !== 'operationId,ownedTargets,phase,planDigest,version' ||
    state.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(state.operationId || '') ||
    !/^[a-f0-9]{64}$/.test(state.planDigest || '') ||
    (acceptedPlanDigests && !acceptedPlanDigests.includes(state.planDigest)) ||
    !['APPLYING', 'COMPLETE'].includes(state.phase) ||
    !Array.isArray(state.ownedTargets) ||
    state.ownedTargets.some(
      (target) =>
        !target ||
        Object.keys(target).sort().join(',') !== 'birthtimeNs,dev,digest,ino,length,path,proof' ||
        !allowed.has(target.path) ||
        target.proof !== `${target.path}.preparation-${target.digest}` ||
        !/^[a-f0-9]{64}$/.test(target.digest) ||
        !['birthtimeNs', 'dev', 'ino'].every((key) => /^\d+$/.test(target[key])) ||
        !Number.isSafeInteger(target.length) ||
        target.length < 0,
    ) ||
    new Set(state.ownedTargets.map((target) => target.path)).size !== state.ownedTargets.length
  )
    fail('INVALID_PROVISION_JOURNAL');
}
function provisionRecoveryTopology(state) {
  return state.ownedTargets.map((target) => {
    if (!existsSync(target.proof) || !descriptorMatches(target.proof, target, 'PROVISION_RECOVERY_UNCERTAIN'))
      fail('PROVISION_RECOVERY_UNCERTAIN');
    const finalPresent = existsSync(target.path);
    if (finalPresent && !descriptorMatches(target.path, target, 'PROVISION_RECOVERY_UNCERTAIN'))
      fail('PROVISION_RECOVERY_UNCERTAIN');
    const proofNlink = lstatSync(target.proof).nlink;
    if (proofNlink !== (finalPresent ? 2 : 1)) fail('PROVISION_RECOVERY_UNCERTAIN');
    return { path: target.path, finalPresent, proofNlink };
  });
}
function writeProvisionJournal(plan, state) {
  const path = journalPath(plan);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  const temp = `${path}.preparation-${rawDigest(bytes)}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (fd !== undefined) {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const descriptor = secureReadDescriptor(temp, 'INVALID_PROVISION_JOURNAL', false);
  if (!descriptor.bytes.equals(bytes)) fail('INVALID_PROVISION_JOURNAL');
  let prior = null;
  if (existsSync(path)) {
    prior = secureReadDescriptor(path, 'INVALID_PROVISION_JOURNAL', false);
    if (!state.journalDescriptor || !descriptorEquals(prior, state.journalDescriptor))
      fail('PROVISION_JOURNAL_OWNERSHIP_LOST');
    if (descriptorEquals(prior, descriptor)) {
      if (lstatSync(temp).nlink !== 2) fail('INVALID_PROVISION_JOURNAL');
      fsyncDirectory(dirname(path));
      Object.defineProperty(state, 'journalDescriptor', { value: descriptor, writable: true, configurable: true });
      return;
    }
    if (lstatSync(temp).nlink !== 1) fail('INVALID_PROVISION_JOURNAL');
  } else if (lstatSync(temp).nlink !== 1) fail('INVALID_PROVISION_JOURNAL');
  const transitionPath = journalTransitionPath(plan);
  const clean = (value) =>
    value && Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'digest', 'length'].map((key) => [key, value[key]]));
  const transition = { version: 1, path, prior: clean(prior), next: clean(descriptor), nextProof: temp };
  const transitionDescriptor = publishExclusiveRecord(
    transitionPath,
    `${canonicalJson(transition)}\n`,
    'INVALID_PROVISION_JOURNAL_TRANSITION',
  );
  if (prior) removeOwnedPath(path, prior, 'INVALID_PROVISION_JOURNAL');
  linkSync(temp, path);
  fsyncDirectory(dirname(path));
  if (!descriptorMatches(path, descriptor, 'INVALID_PROVISION_JOURNAL')) fail('INVALID_PROVISION_JOURNAL');
  removeOwnedPath(transitionPath, transitionDescriptor, 'INVALID_PROVISION_JOURNAL_TRANSITION');
  Object.defineProperty(state, 'journalDescriptor', { value: descriptor, writable: true, configurable: true });
}
function recoverProvisionJournalTransition(plan) {
  const path = journalTransitionPath(plan);
  if (!existsSync(path)) return;
  if (
    !plan.transitionSnapshot ||
    !descriptorMatches(path, plan.transitionSnapshot, 'INVALID_PROVISION_JOURNAL_TRANSITION')
  )
    fail('PROVISION_JOURNAL_TRANSITION_REVIEW_REQUIRED');
  const descriptor = secureReadDescriptor(path, 'INVALID_PROVISION_JOURNAL_TRANSITION');
  const transition = parseStrictJson(descriptor.bytes, 'INVALID_PROVISION_JOURNAL_TRANSITION');
  if (
    transition.version !== 1 ||
    transition.path !== journalPath(plan) ||
    transition.nextProof !== `${transition.path}.preparation-${transition.next?.digest}` ||
    !descriptorMatches(transition.nextProof, transition.next, 'INVALID_PROVISION_JOURNAL_TRANSITION')
  )
    fail('INVALID_PROVISION_JOURNAL_TRANSITION');
  if (existsSync(transition.path)) {
    if (descriptorMatches(transition.path, transition.next, 'INVALID_PROVISION_JOURNAL_TRANSITION')) {
      // already published
    } else if (
      transition.prior &&
      descriptorMatches(transition.path, transition.prior, 'INVALID_PROVISION_JOURNAL_TRANSITION')
    )
      removeOwnedPath(transition.path, transition.prior, 'INVALID_PROVISION_JOURNAL_TRANSITION');
    else fail('INVALID_PROVISION_JOURNAL_TRANSITION');
  }
  if (!existsSync(transition.path)) linkSync(transition.nextProof, transition.path);
  fsyncDirectory(dirname(transition.path));
  if (!descriptorMatches(transition.path, transition.next, 'INVALID_PROVISION_JOURNAL_TRANSITION'))
    fail('INVALID_PROVISION_JOURNAL_TRANSITION');
  removeOwnedPath(path, descriptor, 'INVALID_PROVISION_JOURNAL_TRANSITION');
}
function readProvisionJournal(plan) {
  const path = journalPath(plan);
  if (!existsSync(path)) return null;
  if (!plan.recoverySnapshot) fail('PROVISION_JOURNAL_REVIEW_REQUIRED');
  const descriptor = secureReadDescriptor(path, 'INVALID_PROVISION_JOURNAL');
  if (!descriptorMatches(path, plan.recoverySnapshot, 'INVALID_PROVISION_JOURNAL')) fail('INVALID_PROVISION_JOURNAL');
  let state;
  try {
    state = parseStrictJson(descriptor.bytes, 'INVALID_PROVISION_JOURNAL');
  } catch {
    fail('INVALID_PROVISION_JOURNAL');
  }
  validateProvisionJournalState(state, plan.paths, [plan.recoverySnapshot.planDigest]);
  if (plan.recoverySnapshot?.state && canonicalJson(state) !== canonicalJson(plan.recoverySnapshot.state))
    fail('INVALID_PROVISION_JOURNAL');
  if (
    plan.recoverySnapshot?.topology &&
    canonicalJson(provisionRecoveryTopology(state)) !== canonicalJson(plan.recoverySnapshot.topology)
  )
    fail('PROVISION_RECOVERY_UNCERTAIN');
  Object.defineProperty(state, 'journalDescriptor', { value: descriptor, writable: true, configurable: true });
  return state;
}
function removeProvisionJournal(plan, state) {
  const descriptor = state?.journalDescriptor || plan.recoverySnapshot;
  if (!descriptor) fail('PROVISION_RECOVERY_UNCERTAIN');
  removeOwnedPath(journalPath(plan), descriptor, 'PROVISION_RECOVERY_UNCERTAIN');
}
function cleanupOwned(plan, ownedTargets) {
  const allowed = new Set([
    plan.paths.manifest,
    plan.paths.trust,
    plan.paths.config,
    plan.paths['runtime-inventory'],
    plan.paths['authoritative-consumer-inventory'],
    ...Object.keys(rendered(plan)),
  ]);
  if (ownedTargets.some((target) => !allowed.has(target.path))) fail('INVALID_PROVISION_JOURNAL');
  for (const target of [...ownedTargets].reverse()) {
    if (!existsSync(target.proof)) fail('PROVISION_RECOVERY_UNCERTAIN');
    if (!descriptorMatches(target.proof, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
    if (existsSync(target.path)) {
      if (!descriptorMatches(target.path, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
      removeOwnedPath(target.path, target);
    }
    removeOwnedPath(target.proof, target);
    if (existsSync(dirname(target.path))) fsyncDirectory(dirname(target.path));
  }
}
function applyReviewed(plan) {
  const supplied = plan.digest;
  let trust;
  // Trust is the precondition for interpreting any mutable progress record.
  if (plan.trustSnapshot?.state === 'absent') {
    if (existsSync(journalPath(plan)) || existsSync(journalTransitionPath(plan)))
      fail('BOOTSTRAP_JOURNAL_REVIEW_REQUIRED');
    if (existsSync(plan.paths.trust)) fail('BOOTSTRAP_TRUST_REVIEW_REQUIRED');
  } else trust = reviewedTrust(plan);
  recoverProvisionJournalTransition(plan);
  let state = readProvisionJournal(plan);
  const resuming = Boolean(state);
  if (state) {
    for (const target of state.ownedTargets) {
      if (!existsSync(target.proof)) fail('PROVISION_RECOVERY_UNCERTAIN');
      if (!descriptorMatches(target.proof, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
      if (!existsSync(target.path)) {
        cleanupOwned(plan, state.ownedTargets);
        removeProvisionJournal(plan, state);
        fail('PROVISION_RECOVERY_ROLLED_BACK');
      }
      if (!descriptorMatches(target.path, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
    }
    if (state.phase === 'COMPLETE') {
      for (const target of state.ownedTargets) {
        if (
          !descriptorMatches(target.proof, target) ||
          !existsSync(target.path) ||
          !descriptorMatches(target.path, target)
        )
          fail('PROVISION_RECOVERY_UNCERTAIN');
        if (
          process.env.CLAUDE_COORDINATION_TESTING === '1' &&
          process.env.CLAUDE_COORDINATION_TEST_SIGKILL_PROOF === target.proof
        )
          process.kill(process.pid, 'SIGKILL');
        fsyncDirectory(dirname(target.proof));
      }
      preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
      publishCompletionReceipt(plan, trust);
      removeProvisionJournal(plan, state);
      return { ok: true, digest: supplied, configPath: plan.paths.config };
    }
  }
  // A resumed transaction intentionally still has authenticated proof
  // hardlinks, which generic topology validation rejects by link count. The
  // loop above has already matched every proof and final path to its journaled
  // inode and digest; fresh transactions take the full topology snapshot here.
  if (!resuming) validateTopology(plan.paths, plan.paths.quarantine);
  if (realpathSync(plan.manifestSource) !== resolve(plan.manifestSource)) fail('MANIFEST_SOURCE_INVALID');
  validateExistingTarget(plan.manifestSource, 'file');
  const manifestBytes = secureReadSource(plan.manifestSource, 'MANIFEST_SOURCE_INVALID');
  if (assertManifestInventory(manifestBytes, plan.accounts) !== plan.manifestDigest) fail('MANIFEST_SOURCE_CHANGED');
  validateExistingTarget(plan.inventorySource, 'file');
  const inventoryBytes = secureReadSource(plan.inventorySource, 'INVALID_INVENTORY');
  if (rawDigest(inventoryBytes) !== plan.inventoryDigest) fail('INVENTORY_SOURCE_CHANGED');
  if (canonicalJson(accountsFromInventoryBytes(inventoryBytes)) !== canonicalJson(plan.accounts))
    fail('INVENTORY_IDENTITY_MISMATCH');
  validateExistingTarget(plan.consumerInventorySource, 'file');
  const consumerInventoryBytes = secureReadSource(plan.consumerInventorySource, 'INVALID_CONSUMER_INVENTORY');
  if (rawDigest(consumerInventoryBytes) !== plan.consumerInventoryDigest) fail('CONSUMER_INVENTORY_SOURCE_CHANGED');
  consumersFromInventoryBytes(consumerInventoryBytes);
  const expectedArtifactDigests = Object.fromEntries(
    Object.entries(artifactBytes(plan)).map(([path, bytes]) => [path, rawDigest(bytes)]),
  );
  if (canonicalJson(expectedArtifactDigests) !== canonicalJson(plan.artifactDigests)) fail('ARTIFACT_DIGEST_MISMATCH');
  const written = [];
  const generated = rendered(plan);
  const configBytes = Buffer.from(`${JSON.stringify(configFor(plan), null, 2)}\n`);
  let newKeyBytes;
  if (!state) {
    newKeyBytes = randomBytes(32);
    state = {
      version: 1,
      operationId: randomBytes(16).toString('hex'),
      planDigest: plan.digest,
      phase: 'APPLYING',
      ownedTargets: [],
    };
    writeProvisionJournal(plan, state);
  }
  try {
    for (const dir of [
      plan.paths.active,
      plan.paths.staging,
      plan.paths.usage,
      plan.paths.rollback,
      ...plan.paths.quarantine,
      dirname(plan.paths.lock),
      dirname(plan.paths.trust),
    ])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    const publish = (path, bytes) => {
      const owned = state.ownedTargets.find((target) => target.path === path);
      if (owned && owned.digest !== rawDigest(bytes)) fail('INVALID_PROVISION_JOURNAL');
      atomicWrite(path, bytes, written, (descriptor) => {
        state.ownedTargets.push({ path, digest: rawDigest(bytes), ...descriptor });
        writeProvisionJournal(plan, state);
      });
      if (
        process.env.CLAUDE_COORDINATION_TESTING === '1' &&
        process.env.CLAUDE_COORDINATION_TEST_FAIL_AFTER === String(written.length)
      )
        fail('INJECTED_FAILURE');
      if (
        process.env.CLAUDE_COORDINATION_TESTING === '1' &&
        process.env.CLAUDE_COORDINATION_TEST_SIGKILL_AFTER === String(written.length)
      )
        process.kill(process.pid, 'SIGKILL');
    };
    publish(plan.paths.manifest, manifestBytes);
    if (existsSync(plan.paths.trust)) {
      const owned = state.ownedTargets.find((target) => target.path === plan.paths.trust);
      const trust = secureReadDescriptor(plan.paths.trust, 'EXISTING_FILE_MISMATCH', false);
      if (mode(plan.paths.trust) !== 0o600 || trust.length !== 32 || (owned && trust.digest !== owned.digest))
        fail('EXISTING_FILE_MISMATCH');
    } else if (newKeyBytes) publish(plan.paths.trust, newKeyBytes);
    else fail('PROVISION_KEY_RECOVERY_REQUIRED');
    publish(plan.paths.config, configBytes);
    publish(plan.paths['runtime-inventory'], inventoryBytes);
    publish(plan.paths['authoritative-consumer-inventory'], consumerInventoryBytes);
    for (const [path, data] of Object.entries(generated)) publish(path, Buffer.from(data));
    const priorJournalDescriptor = state.journalDescriptor;
    state = { ...state, phase: 'COMPLETE' };
    Object.defineProperty(state, 'journalDescriptor', {
      value: priorJournalDescriptor,
      writable: true,
      configurable: true,
    });
    writeProvisionJournal(plan, state);
    for (const target of state.ownedTargets) {
      if (!descriptorMatches(target.proof, target) || !descriptorMatches(target.path, target))
        fail('PROVISION_RECOVERY_UNCERTAIN');
    }
    let cleanedProofs = 0;
    for (const target of state.ownedTargets) {
      cleanedProofs += 1;
      if (
        process.env.CLAUDE_COORDINATION_TESTING === '1' &&
        process.env.CLAUDE_COORDINATION_TEST_SIGKILL_COMPLETE_PROOF_AFTER === String(cleanedProofs)
      )
        process.kill(process.pid, 'SIGKILL');
    }
    for (const dir of new Set(state.ownedTargets.map((target) => dirname(target.proof)))) fsyncDirectory(dir);
    preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
    publishCompletionReceipt(plan, trust);
    removeProvisionJournal(plan, state);
    return { ok: true, digest: supplied, configPath: plan.paths.config };
  } catch (error) {
    if (state.phase === 'COMPLETE') throw error;
    cleanupOwned(plan, state.ownedTargets);
    removeProvisionJournal(plan, state);
    throw error;
  }
}
function apply(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  if (plan.trustSnapshot?.state === 'absent') {
    if (existsSync(journalPath(plan)) || existsSync(journalTransitionPath(plan)))
      fail('BOOTSTRAP_JOURNAL_REVIEW_REQUIRED');
    if (existsSync(plan.paths.trust)) fail('BOOTSTRAP_TRUST_REVIEW_REQUIRED');
    beginAbsentTrustBootstrap(plan);
  }
  return withProvisionLock(plan, () => applyReviewed(plan));
}
function rollbackReviewed(plan) {
  recoverProvisionJournalTransition(plan);
  const state = readProvisionJournal(plan);
  if (!state) return { ok: true, rolledBack: false };
  if (state.phase === 'COMPLETE') return applyReviewed(plan);
  cleanupOwned(plan, state.ownedTargets);
  removeProvisionJournal(plan, state);
  return { ok: true, rolledBack: true, digest: plan.digest };
}
function rollback(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  if (plan.trustSnapshot?.state === 'absent') {
    if (existsSync(bootstrapAttemptPath(plan))) fail('BOOTSTRAP_ATTEMPT_REVIEW_REQUIRED');
    if (existsSync(journalPath(plan)) || existsSync(journalTransitionPath(plan)))
      fail('BOOTSTRAP_JOURNAL_REVIEW_REQUIRED');
    if (existsSync(plan.paths.trust)) fail('BOOTSTRAP_TRUST_REVIEW_REQUIRED');
  }
  return withProvisionLock(plan, () => {
    if (plan.trustSnapshot?.state === 'present') reviewedTrust(plan);
    return rollbackReviewed(plan);
  });
}
function activateLinux(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  if (plan.trustSnapshot?.state !== 'present') fail('BOOTSTRAP_TRUST_REVIEW_REQUIRED');
  return withProvisionLock(plan, () => {
    const trust = reviewedTrust(plan);
    validateCompletionReceipt(plan, trust);
    preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
    const unitPath = plan.paths['linux-unit'];
    const pinned = lstatSync(unitPath);
    const expectedDigest = plan.artifactDigests[unitPath];
    const assertPinned = () => {
      const current = lstatSync(unitPath);
      if (
        current.dev !== pinned.dev ||
        current.ino !== pinned.ino ||
        rawDigest(secureReadSource(unitPath, 'GENERATED_ARTIFACT_CHANGED')) !== expectedDigest
      )
        fail('GENERATED_ARTIFACT_CHANGED');
    };
    const systemctl = (...args) => {
      if (!descriptorMatches(plan.paths.trust, trust, 'TRUST_SNAPSHOT_CHANGED')) fail('TRUST_SNAPSHOT_CHANGED');
      assertPinned();
      const result = spawnSync('systemctl', ['--user', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assertPinned();
      if (result.status !== 0) fail('SYSTEMD_ACTIVATION_FAILED');
      return String(result.stdout || '').trim();
    };
    systemctl('daemon-reload');
    systemctl('enable', 'claude-account-rotator');
    systemctl('restart', 'claude-account-rotator');
    const status = systemctl('is-active', 'claude-account-rotator');
    if (status !== 'active') fail('SYSTEMD_ACTIVATION_FAILED');
    return { ok: true, activated: 'claude-account-rotator', planDigest: plan.digest };
  });
}
function preflight(configPath, accounts, expectedPaths, expectedInventoryDigest, reviewedPlan) {
  const config = readDeploymentConfig(configPath);
  if (
    mode(configPath) !== 0o600 ||
    mode(config.approvalKeyPath) !== 0o600 ||
    statSync(config.approvalKeyPath).size !== 32
  )
    fail('INVALID_TRUST_MODE');
  const cfgAccounts =
    accounts || accountsFromInventory(process.env.CLAUDE_ROTATOR_INVENTORY || fail('INVENTORY_REQUIRED'));
  if (!cfgAccounts.length) fail('ACCOUNT_IDENTITY_REQUIRED');
  assertManifestInventory(readFileSync(config.manifestPath), cfgAccounts);
  const authoritativeConsumers = secureReadSource(
    config.authoritativeConsumerInventoryPath,
    'INVALID_CONSUMER_INVENTORY',
  );
  consumersFromInventoryBytes(authoritativeConsumers);
  if (rawDigest(authoritativeConsumers) !== config.authoritativeConsumerInventoryDigest)
    fail('AUTHORITATIVE_CONSUMER_INVENTORY_MISMATCH');
  const runtimeInventoryBytes = expectedPaths
    ? secureReadSource(expectedPaths['runtime-inventory'], 'RUNTIME_INVENTORY_MISMATCH')
    : null;
  if (expectedPaths && (!runtimeInventoryBytes || rawDigest(runtimeInventoryBytes) !== expectedInventoryDigest))
    fail('RUNTIME_INVENTORY_MISMATCH');
  if (expectedPaths && canonicalJson(accountsFromInventoryBytes(runtimeInventoryBytes)) !== canonicalJson(cfgAccounts))
    fail('RUNTIME_INVENTORY_IDENTITY_MISMATCH');
  if (reviewedPlan) {
    const expectedConfig = Buffer.from(`${JSON.stringify(configFor(reviewedPlan), null, 2)}\n`);
    if (
      rawDigest(secureReadSource(configPath, 'CONFIG_ARTIFACT_MISMATCH')) !==
        reviewedPlan.artifactDigests[configPath] ||
      !readFileSync(configPath).equals(expectedConfig) ||
      config.deploymentPlanDigest !== configFor(reviewedPlan).deploymentPlanDigest
    )
      fail('CONFIG_ARTIFACT_MISMATCH');
    for (const [path, expectedDigest] of Object.entries(reviewedPlan.artifactDigests))
      if (rawDigest(secureReadSource(path, 'GENERATED_ARTIFACT_MISMATCH')) !== expectedDigest)
        fail('GENERATED_ARTIFACT_MISMATCH');
  }
  const paths = expectedPaths || {
    config: configPath,
    trust: config.approvalKeyPath,
    manifest: config.manifestPath,
    active: config.activeDir,
    staging: config.stagingDir,
    usage: config.usageDir,
    rollback: config.rollbackDir,
    lock: config.operationLockPath,
    quarantine: config.quarantineDirs,
  };
  validateTopology(
    { ...paths, ...Object.fromEntries(PATH_FLAGS.filter((k) => !paths[k]).map((k) => [k, `/dev/null/${k}`])) },
    paths.quarantine,
  );
  if (expectedPaths)
    for (const path of [expectedPaths['linux-env'], expectedPaths['macos-env']])
      if (
        readFileSync(path, 'utf8') !==
        `CLAUDE_AUTH_COORDINATION_CONFIG=${configPath}\nCLAUDE_ROTATOR_CONFIG=${expectedPaths['runtime-inventory']}\n`
      )
        fail('ENV_CONFIG_MISMATCH');
  return {
    ok: true,
    configPath,
    runtimeInventoryPath: expectedPaths?.['runtime-inventory'],
    linuxUnitPath: expectedPaths?.['linux-unit'],
  };
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  let result;
  if (command === 'plan') result = buildPlan(args);
  else if (command === 'apply') result = apply(args.plan, args['expected-digest']);
  else if (command === 'rollback') result = rollback(args.plan, args['expected-digest']);
  else if (command === 'activate-linux') result = activateLinux(args.plan, args['expected-digest']);
  else if (command === 'preflight') {
    if (args.plan || args['expected-digest']) {
      const plan = readReviewedPlan(args.plan, args['expected-digest']);
      result = preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
      for (const [path, expected] of Object.entries(rendered(plan)))
        if (readFileSync(path, 'utf8') !== expected || /\$\{HOME\}|__HOME__/.test(expected))
          fail('GENERATED_ARTIFACT_MISMATCH');
    } else result = preflight(args.config, args.inventory ? accountsFromInventory(args.inventory) : undefined);
  } else fail('INVALID_ARGUMENTS');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url))
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
