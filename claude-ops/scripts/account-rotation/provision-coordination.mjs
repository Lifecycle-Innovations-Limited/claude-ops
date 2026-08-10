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
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  constants,
  fstatSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  'linux-token-feed-unit',
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
function assertSafeAncestors(path) {
  let cursor = existsSync(path) ? dirname(path) : dirname(canonicalProspective(path));
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
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return fields[19];
  } catch {
    return null;
  }
}
function withProvisionLock(plan, callback) {
  const path = plan.paths['provision-lock'];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let owned;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const nonce = randomBytes(16).toString('hex');
      try {
        writeFileSync(
          fd,
          `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: process.pid, start: processStart(process.pid), nonce })}\n`,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(dirname(path));
      owned = lstatSync(path);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw error;
      validateExistingTarget(path, 'file');
      const descriptor = lstatSync(path);
      const stale = json(path, 'INVALID_PROVISION_LOCK');
      if (
        Object.keys(stale).sort().join(',') !== 'nonce,pid,planDigest,start,version' ||
        stale.version !== 1 ||
        stale.planDigest !== plan.digest ||
        !Number.isSafeInteger(stale.pid) ||
        typeof stale.start !== 'string' ||
        !/^[a-f0-9]{32}$/.test(stale.nonce)
      )
        fail('INVALID_PROVISION_LOCK');
      if (processStart(stale.pid) === stale.start) fail('PROVISION_LOCK_HELD');
      const current = lstatSync(path);
      if (current.dev !== descriptor.dev || current.ino !== descriptor.ino) fail('PROVISION_LOCK_OWNERSHIP_LOST');
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
  }
  if (!owned) fail('PROVISION_LOCK_HELD');
  try {
    return callback();
  } finally {
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.dev !== owned.dev || current.ino !== owned.ino) fail('PROVISION_LOCK_OWNERSHIP_LOST');
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
  }
}
function descriptorIdentity(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
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
    if (
      !pre.isFile() ||
      !named.isFile() ||
      canonicalJson(identity) !== canonicalJson(descriptorIdentity(post)) ||
      canonicalJson(identity) !== canonicalJson(descriptorIdentity(named)) ||
      pre.uid !== BigInt(process.getuid()) ||
      (requireSingleLink && pre.nlink !== 1n) ||
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
function secureReadSource(path, code) {
  return secureReadDescriptor(path, code).bytes;
}
function descriptorMatches(path, expected, code = 'PROVISION_RECOVERY_UNCERTAIN') {
  const actual = secureReadDescriptor(path, code, false);
  return ['dev', 'ino', 'birthtimeNs', 'digest', 'length'].every((key) => actual[key] === expected[key]);
}
function validateExistingTarget(path, kind) {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== process.getuid()) fail('UNSAFE_EXISTING_TARGET');
  if (kind === 'file' && (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0)) fail('UNSAFE_EXISTING_TARGET');
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
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(temp, 'wx', modeBits);
  let descriptor;
  let journaled = false;
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
    if (process.env.CLAUDE_COORDINATION_TESTING === '1' && process.env.CLAUDE_COORDINATION_TEST_RACE_TARGET === path)
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
      process.env.CLAUDE_COORDINATION_TEST_POST_LINK_REPLACE === path
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
    if (!journaled) {
      rmSync(temp, { force: true });
      fsyncDirectory(dirname(temp));
    }
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
    [p['linux-token-feed-unit']]:
      `[Service]\nType=oneshot\nEnvironmentFile=${p['linux-env']}\nExecStart=/bin/bash ${resolve(dirname(fileURLToPath(import.meta.url)), 'crs-token-feed.sh')}\n`,
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
    deploymentPlanDigest: plan.intentDigest,
  };
}
function journalPath(plan) {
  return `${plan.paths.config}.provision-journal`;
}
function writeProvisionJournal(plan, state) {
  const path = journalPath(plan);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}
function readProvisionJournal(plan) {
  const path = journalPath(plan);
  if (!existsSync(path)) return null;
  validateExistingTarget(path, 'file');
  const state = json(path, 'INVALID_PROVISION_JOURNAL');
  const keys = Object.keys(state).sort();
  if (
    keys.join(',') !== 'ownedTargets,phase,planDigest,version' ||
    state.version !== 1 ||
    state.planDigest !== plan.digest ||
    !['APPLYING', 'COMPLETE'].includes(state.phase) ||
    !Array.isArray(state.ownedTargets) ||
    state.ownedTargets.some(
      (target) =>
        !target ||
        Object.keys(target).sort().join(',') !== 'birthtimeNs,dev,digest,ino,length,path,proof' ||
        typeof target.path !== 'string' ||
        typeof target.proof !== 'string' ||
        !/^[a-f0-9]{64}$/.test(target.digest) ||
        !['birthtimeNs', 'dev', 'ino'].every((key) => /^\d+$/.test(target[key])) ||
        !Number.isSafeInteger(target.length) ||
        target.length < 0,
    )
  )
    fail('INVALID_PROVISION_JOURNAL');
  return state;
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
      rmSync(target.path);
    }
    rmSync(target.proof);
    if (existsSync(dirname(target.path))) fsyncDirectory(dirname(target.path));
  }
}
function applyReviewed(plan) {
  const supplied = plan.digest;
  let state = readProvisionJournal(plan);
  const resuming = Boolean(state);
  if (state) {
    for (const target of state.ownedTargets) {
      if (!existsSync(target.proof) && state.phase === 'COMPLETE') {
        if (!existsSync(target.path)) fail('PROVISION_RECOVERY_UNCERTAIN');
        if (!descriptorMatches(target.path, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
        continue;
      }
      if (!existsSync(target.proof)) fail('PROVISION_RECOVERY_UNCERTAIN');
      if (!descriptorMatches(target.proof, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
      if (!existsSync(target.path)) {
        cleanupOwned(plan, state.ownedTargets);
        rmSync(journalPath(plan), { force: true });
        fsyncDirectory(dirname(journalPath(plan)));
        fail('PROVISION_RECOVERY_ROLLED_BACK');
      }
      if (!descriptorMatches(target.path, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
    }
    if (state.phase === 'COMPLETE') {
      for (const target of state.ownedTargets) {
        if (existsSync(target.proof)) {
          if (
            !descriptorMatches(target.proof, target) ||
            !existsSync(target.path) ||
            !descriptorMatches(target.path, target)
          )
            fail('PROVISION_RECOVERY_UNCERTAIN');
          unlinkSync(target.proof);
          if (process.env.CLAUDE_COORDINATION_TEST_SIGKILL_PROOF === target.proof) process.kill(process.pid, 'SIGKILL');
        } else {
          if (!existsSync(target.path) || !descriptorMatches(target.path, target)) fail('PROVISION_RECOVERY_UNCERTAIN');
        }
        fsyncDirectory(dirname(target.proof));
      }
      preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
      rmSync(journalPath(plan));
      fsyncDirectory(dirname(journalPath(plan)));
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
      if (process.env.CLAUDE_COORDINATION_TEST_FAIL_AFTER === String(written.length)) fail('INJECTED_FAILURE');
      if (process.env.CLAUDE_COORDINATION_TEST_SIGKILL_AFTER === String(written.length))
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
    state = { ...state, phase: 'COMPLETE' };
    writeProvisionJournal(plan, state);
    for (const target of state.ownedTargets) {
      if (!descriptorMatches(target.proof, target) || !descriptorMatches(target.path, target))
        fail('PROVISION_RECOVERY_UNCERTAIN');
    }
    let cleanedProofs = 0;
    for (const target of state.ownedTargets) {
      unlinkSync(target.proof);
      cleanedProofs += 1;
      if (process.env.CLAUDE_COORDINATION_TEST_SIGKILL_COMPLETE_PROOF_AFTER === String(cleanedProofs))
        process.kill(process.pid, 'SIGKILL');
    }
    for (const dir of new Set(state.ownedTargets.map((target) => dirname(target.proof)))) fsyncDirectory(dir);
    preflight(plan.paths.config, plan.accounts, plan.paths, plan.inventoryDigest, plan);
    rmSync(journalPath(plan));
    fsyncDirectory(dirname(journalPath(plan)));
    return { ok: true, digest: supplied, configPath: plan.paths.config };
  } catch (error) {
    if (state.phase === 'COMPLETE') throw error;
    cleanupOwned(plan, state.ownedTargets);
    rmSync(journalPath(plan), { force: true });
    fsyncDirectory(dirname(journalPath(plan)));
    throw error;
  }
}
function apply(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  return withProvisionLock(plan, () => applyReviewed(plan));
}
function rollbackReviewed(plan) {
  const state = readProvisionJournal(plan);
  if (!state) return { ok: true, rolledBack: false };
  if (state.phase === 'COMPLETE') return applyReviewed(plan);
  cleanupOwned(plan, state.ownedTargets);
  rmSync(journalPath(plan), { force: true });
  fsyncDirectory(dirname(journalPath(plan)));
  return { ok: true, rolledBack: true, digest: plan.digest };
}
function rollback(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  return withProvisionLock(plan, () => rollbackReviewed(plan));
}
function activateLinux(planPath, expected) {
  const plan = readReviewedPlan(planPath, expected);
  return withProvisionLock(plan, () => {
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
      config.deploymentPlanDigest !== reviewedPlan.intentDigest
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
