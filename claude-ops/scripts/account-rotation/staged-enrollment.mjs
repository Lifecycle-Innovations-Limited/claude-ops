#!/usr/bin/env node
/** Fail-closed, offline staging and activation for Claude CLIProxyAPI auth files. */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { parseStrictJson } from './strict-json.mjs';

export const APPROVAL_VERSION = 1;
export const DEFAULT_MAX_TTL_MS = 15 * 60 * 1000;
const PROVIDER_COUNTS = { claude: 9, antigravity: 1, codex: 2, xai: 3 };
const CONFIG_KEYS = [
  'manifestPath',
  'approvalKeyPath',
  'usageDir',
  'stagingDir',
  'activeDir',
  'quarantineDirs',
  'rollbackDir',
  'operationLockPath',
  'environment',
  'authorizedOperator',
  'maxApprovalTtlMs',
  'runtimeInventoryPath',
  'runtimeInventoryDigest',
  'authoritativeConsumerInventoryPath',
  'authoritativeConsumerInventoryDigest',
  'deploymentPlanDigest',
];
const APPROVAL_KEYS = [
  'version',
  'id',
  'nonce',
  'action',
  'manifestDigest',
  'manifestEntryId',
  'provider',
  'email',
  'organizationUuid',
  'organizationName',
  'accountOwner',
  'authorizedOperator',
  'environment',
  'issuedAt',
  'expiresAt',
  'candidateDigest',
  'oldTargetDigest',
  'inventoryDigest',
  'canaryDigest',
  'destination',
];
const INVENTORY_KEYS = ['version', 'credential', 'consumers'];
const INVENTORY_CREDENTIAL_KEYS = [
  'id',
  'provider',
  'email',
  'organizationUuid',
  'organizationName',
  'accountOwner',
  'destination',
];
const INVENTORY_CONSUMER_KEYS = ['id', 'type', 'path'];
const CANARY_KEYS = ['version', 'results'];
const CANARY_RESULT_KEYS = [
  'consumerId',
  'consumerPath',
  'credentialId',
  'candidateDigest',
  'destination',
  'noFallback',
  'pass',
];
const AUTHORITATIVE_CONSUMER_KEYS = ['version', 'consumers'];
const AUTHORITATIVE_CONSUMER_ENTRY_KEYS = ['id', 'type', 'path', 'credentialId', 'destination'];
const CLAUDE_ENTRY_KEYS = [
  'id',
  'authFilename',
  'provider',
  'email',
  'organizationUuid',
  'organizationName',
  'accountOwner',
];
const CANDIDATE_KEYS = [
  'access_token',
  'account_uuid',
  'claude_device_ids',
  'disabled',
  'email',
  'expired',
  'expires_in',
  'id_token',
  'last_refresh',
  'organization_name',
  'organization_uuid',
  'refresh_token',
  'type',
];

export function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new Error('UNSAFE_CANONICAL_JSON');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length)
      throw new Error('UNSAFE_CANONICAL_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Object.keys(descriptors);
    const expected = [...Array(value.length).keys()].map(String).concat('length');
    if (own.length !== expected.length || own.some((key, index) => key !== expected[index]))
      throw new Error('UNSAFE_CANONICAL_JSON');
    if (
      expected.some((key) =>
        key === 'length'
          ? 'get' in descriptors[key] || 'set' in descriptors[key] || descriptors[key].enumerable
          : 'get' in descriptors[key] || 'set' in descriptors[key] || !descriptors[key].enumerable,
      )
    )
      throw new Error('UNSAFE_CANONICAL_JSON');
    return `[${expected
      .slice(0, -1)
      .map((key) => canonicalJson(descriptors[key].value, depth + 1))
      .join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new Error('UNSAFE_CANONICAL_JSON');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('UNSAFE_CANONICAL_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.some((key) => 'get' in descriptors[key] || 'set' in descriptors[key] || !descriptors[key].enumerable))
      throw new Error('UNSAFE_CANONICAL_JSON');
    if (keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)))
      throw new Error('UNSAFE_CANONICAL_JSON');
    return `{${keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value, depth + 1)}`)
      .join(',')}}`;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' &&
      (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    throw new Error('UNSAFE_CANONICAL_JSON');
  return JSON.stringify(value);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SCHEMA');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('INVALID_SCHEMA');
  }
}

function nonempty(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error('INVALID_VALUE');
  }
  return value;
}

export function normalizeEmail(value) {
  const email = nonempty(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('INVALID_EMAIL');
  return email;
}

function safeFilename(value) {
  nonempty(value);
  if (basename(value) !== value || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value))
    throw new Error('INVALID_FILENAME');
  return value;
}

function identityKey(value) {
  return `${normalizeEmail(value.email)}\0${nonempty(value.organizationUuid || value.organization_uuid)}\0${nonempty(value.organizationName || value.organization_name)}`;
}

export function parseManifestBytes(bytes) {
  let manifest;
  try {
    manifest = parseStrictJson(bytes, 'INVALID_MANIFEST');
  } catch {
    throw new Error('INVALID_MANIFEST');
  }
  exactKeys(manifest, ['version', 'entries']);
  const expectedCount = Object.values(PROVIDER_COUNTS).reduce((sum, count) => sum + count, 0);
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length !== expectedCount) {
    throw new Error('INVALID_MANIFEST');
  }
  const ids = new Set();
  const files = new Set();
  const identities = new Set();
  const counts = { claude: 0, antigravity: 0, codex: 0, xai: 0 };
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_MANIFEST');
    nonempty(entry.id);
    safeFilename(entry.authFilename);
    if (!Object.hasOwn(counts, entry.provider)) throw new Error('INVALID_PROVIDER');
    if (!entry.authFilename.startsWith(`${entry.provider}-`)) throw new Error('PROVIDER_FILENAME_MISMATCH');
    if (ids.has(entry.id) || files.has(entry.authFilename)) throw new Error('DUPLICATE_MANIFEST_BINDING');
    ids.add(entry.id);
    files.add(entry.authFilename);
    counts[entry.provider] += 1;
    if (entry.provider === 'claude') {
      exactKeys(entry, CLAUDE_ENTRY_KEYS);
      if (entry.email !== normalizeEmail(entry.email)) throw new Error('INVALID_EMAIL');
      nonempty(entry.organizationUuid);
      nonempty(entry.organizationName);
      nonempty(entry.accountOwner);
      const identity = identityKey(entry);
      if (identities.has(identity)) throw new Error('DUPLICATE_CLAUDE_IDENTITY');
      identities.add(identity);
    }
  }
  if (Object.keys(counts).some((provider) => counts[provider] !== PROVIDER_COUNTS[provider])) {
    throw new Error('INVALID_PROVIDER_COUNTS');
  }
  return { manifest, digest: sha256(bytes) };
}

export function readManifest(path) {
  assertCanonicalExisting(path);
  assertOwnerOnly(path, 'file');
  return parseManifestBytes(secureRead(path));
}

function structurallySafe(value, depth = 0) {
  if (depth > 4 || value === null) return false;
  if (typeof value === 'string') return value.length <= 4096 && !/[\0\r\n]/.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => structurallySafe(item, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      entries.length <= 64 &&
      entries.every(([key, item]) => /^[A-Za-z0-9_.-]{1,128}$/.test(key) && structurallySafe(item, depth + 1))
    );
  }
  return false;
}

export function validateCandidateBytes(bytes, entry, now = Date.now()) {
  let candidate;
  try {
    candidate = parseStrictJson(bytes, 'INVALID_CANDIDATE');
  } catch {
    throw new Error('INVALID_CANDIDATE');
  }
  exactKeys(candidate, CANDIDATE_KEYS);
  if (candidate.type !== 'claude' || candidate.disabled !== false) throw new Error('INVALID_CANDIDATE');
  if (candidate.email !== normalizeEmail(candidate.email) || candidate.email !== entry.email)
    throw new Error('IDENTITY_MISMATCH');
  if (nonempty(candidate.organization_uuid) !== entry.organizationUuid) throw new Error('IDENTITY_MISMATCH');
  if (nonempty(candidate.organization_name) !== entry.organizationName) throw new Error('IDENTITY_MISMATCH');
  for (const key of ['account_uuid', 'access_token', 'refresh_token']) nonempty(candidate[key]);
  if (typeof candidate.id_token !== 'string' || /[\0\r\n]/.test(candidate.id_token))
    throw new Error('INVALID_CANDIDATE');
  if (!Number.isSafeInteger(candidate.expires_in) || candidate.expires_in <= 0) throw new Error('INVALID_EXPIRY');
  const expired = parseRfc3339(candidate.expired);
  const lastRefresh = parseRfc3339(candidate.last_refresh);
  if (expired === null || expired <= now) {
    throw new Error('INVALID_EXPIRY');
  }
  if (
    lastRefresh === null ||
    !Array.isArray(candidate.claude_device_ids) ||
    candidate.claude_device_ids.length !== 1 ||
    !/^[a-f0-9]{64}$/.test(candidate.claude_device_ids[0])
  ) {
    throw new Error('INVALID_CANDIDATE');
  }
  return { candidate, digest: sha256(bytes) };
}

function parseRfc3339(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = '',
    zone,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(
    Number,
  );
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  }
  const milliseconds = Number(`0.${fraction || '0'}`) * 1000;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  const timestamp = date.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function assertOwnerOnly(path, kind, allowLinks = false) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error('MISSING_TRUST_ROOT');
  }
  const rightKind = kind === 'file' ? st.isFile() : st.isDirectory();
  if (
    !rightKind ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    (kind === 'file' && !allowLinks && st.nlink !== 1 && !hasBoundedPreparationAlias(path, st))
  ) {
    throw new Error('INSECURE_TRUST_ROOT');
  }
}

function hasBoundedPreparationAlias(path, stat, bytes) {
  if (!stat.isFile() || stat.nlink !== 2) return false;
  try {
    const digest = sha256(bytes ?? readFileSync(path));
    const proof = `${path}.preparation-${digest}`;
    const proofStat = lstatSync(proof);
    return proofStat.isFile() && proofStat.dev === stat.dev && proofStat.ino === stat.ino && proofStat.nlink === 2;
  } catch {
    return false;
  }
}

function assertCanonicalExisting(path) {
  const normalized = resolve(path);
  let physical;
  try {
    physical = realpathSync(path);
  } catch {
    throw new Error('MISSING_TRUST_ROOT');
  }
  if (physical !== normalized) throw new Error('INSECURE_TRUST_ROOT');
  let ancestor = normalized;
  let immediateParent = true;
  while (ancestor !== dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (st.isSymbolicLink()) throw new Error('INSECURE_TRUST_ROOT');
    ancestor = dirname(ancestor);
    const parent = lstatSync(ancestor);
    if (parent.isSymbolicLink() || (parent.uid !== process.getuid() && parent.uid !== 0))
      throw new Error('INSECURE_TRUST_ROOT');
    if (immediateParent && (parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0))
      throw new Error('INSECURE_TRUST_ROOT');
    if ((parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0))
      throw new Error('INSECURE_TRUST_ROOT');
    immediateParent = false;
  }
  return physical;
}

function secureReadDescriptor(path, requireSingleLink = true) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const st = fstatSync(fd);
    const big = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const post = fstatSync(fd);
    const fst = lstatSync(path);
    if (
      !st.isFile() ||
      !fst.isFile() ||
      st.dev !== fst.dev ||
      st.ino !== fst.ino ||
      st.dev !== post.dev ||
      st.ino !== post.ino ||
      (requireSingleLink && st.nlink !== 1 && !hasBoundedPreparationAlias(path, st, bytes))
    )
      throw new Error();
    return {
      bytes,
      digest: sha256(bytes),
      dev: st.dev,
      ino: st.ino,
      birthtimeNs: big.birthtimeNs.toString(),
      nlink: st.nlink,
    };
  } catch {
    throw new Error('INSECURE_TRUST_ROOT');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function secureRead(path) {
  return secureReadDescriptor(path).bytes;
}

function descriptorStillCurrent(path, descriptor) {
  try {
    const current = secureReadDescriptor(path, false);
    return (
      current.dev === descriptor.dev &&
      current.ino === descriptor.ino &&
      current.digest === descriptor.digest &&
      current.nlink <= 2 &&
      (!descriptor.birthtimeNs || current.birthtimeNs === descriptor.birthtimeNs)
    );
  } catch {
    return false;
  }
}

function candidateTopologyCurrent(path, proof, descriptor) {
  return (
    existsSync(path) &&
    existsSync(proof) &&
    descriptorStillCurrent(path, descriptor) &&
    descriptorStillCurrent(proof, descriptor) &&
    lstatSync(path).nlink === 2 &&
    lstatSync(proof).nlink === 2
  );
}

function activeTargetTopologyCurrent(path, stagingDir, descriptor) {
  const proof = `${join(stagingDir, basename(path))}.preparation-${descriptor.digest}`;
  if (descriptor.nlink === 2) return candidateTopologyCurrent(path, proof, descriptor);
  return (
    descriptor.nlink === 1 &&
    !existsSync(proof) &&
    descriptorStillCurrent(path, descriptor) &&
    lstatSync(path).nlink === 1
  );
}

// Detach a name atomically before deciding whether its inode is ours. This is
// deliberately rename-first: a pathname swap between a CAS and unlink(2)
// otherwise lets an attacker make us delete an inode we never authenticated.
// A foreign inode is retained under the private recovery name and never
// unlinked; fail closed so an operator can inspect/reconcile it.
function removeDescriptorSafely(path, descriptor, code = 'RECOVERY_UNCERTAIN') {
  const evidenceDir = basename(path).length > 120 ? dirname(dirname(path)) : dirname(path);
  const detached = join(evidenceDir, `.evidence-${sha256(path).slice(0, 16)}-${process.pid}-${randomUUID()}`);
  try {
    renameSync(path, detached);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fsyncDirectory(dirname(path));
      return false;
    }
    throw error;
  }
  if (!descriptorStillCurrent(detached, descriptor)) {
    // The detached inode is evidence. Restoring the canonical name would
    // reintroduce the pathname race that detach was intended to close.
    fsyncDirectory(dirname(path));
    throw new Error(code);
  }
  // Retain even authenticated cleanup as auditable evidence. A separate,
  // operator-reviewed garbage collection pass may remove evidence later.
  fsyncDirectory(dirname(path));
  return true;
}
function matchesDigest(path, digest, allowLinks = false) {
  try {
    return secureReadDescriptor(path, !allowLinks).digest === digest;
  } catch {
    return false;
  }
}

function assertCanonicalLeaf(path) {
  const normalized = resolve(path);
  const parent = dirname(normalized);
  if (realpathSync(parent) !== parent || join(parent, basename(normalized)) !== normalized)
    throw new Error('INSECURE_TRUST_ROOT');
  return normalized;
}

function containsPath(root, path) {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

/** Canonical role-aware path contract used by every staged-enrollment operation. */
export function validatePathTopology({
  configPath,
  config,
  approvalPath,
  candidatePath,
  entry,
  approvalId,
  computedPaths = [],
}) {
  const roots = [config.usageDir, config.stagingDir, config.activeDir, config.rollbackDir, ...config.quarantineDirs];
  const fileRoles = [
    ['config', configPath, true],
    ['manifest', config.manifestPath, true],
    ['key', config.approvalKeyPath, true],
    ['authoritative consumer inventory', config.authoritativeConsumerInventoryPath, true],
    ['approval', approvalPath, Boolean(approvalPath)],
    ['candidate', candidatePath, Boolean(candidatePath)],
  ].filter(([, path]) => path);
  const leafRoles = [
    ['lock', config.operationLockPath, dirname(config.operationLockPath)],
    ['recovery claim', `${config.operationLockPath}.recovery-claim`, dirname(config.operationLockPath)],
    ['journal', `${config.operationLockPath}.journal`, dirname(config.operationLockPath)],
    ['publication', `${config.operationLockPath}.publication`, dirname(config.operationLockPath)],
    ...(entry
      ? [
          ['staged target', join(config.stagingDir, entry.authFilename), config.stagingDir],
          ['active target', join(config.activeDir, entry.authFilename), config.activeDir, true],
          ...(approvalId
            ? [['usage marker', join(config.usageDir, `${approvalId.id}.${approvalId.nonce}.used`), config.usageDir]]
            : []),
        ]
      : []),
    ...computedPaths,
  ];
  for (const [role, path] of [...fileRoles, ...leafRoles]) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('INVALID_CONFIG');
  }
  for (const [, path] of fileRoles) {
    assertCanonicalExisting(path);
    assertOwnerOnly(path, 'file');
  }
  for (const [role, path, parent, allowLinks] of leafRoles) {
    if (!containsPath(parent, path) || dirname(path) !== parent) throw new Error('INVALID_CONFIG');
    assertCanonicalLeaf(path);
    if (existsSync(path)) assertOwnerOnly(path, 'file', allowLinks);
  }
  for (const root of roots) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error('INVALID_CONFIG');
    assertCanonicalExisting(root);
    assertOwnerOnly(root, 'directory');
  }
  const physicalRoots = roots.map((path) => realpathSync(path));
  for (let i = 0; i < physicalRoots.length; i += 1)
    for (let j = i + 1; j < physicalRoots.length; j += 1)
      if (containsPath(physicalRoots[i], physicalRoots[j]) || containsPath(physicalRoots[j], physicalRoots[i]))
        throw new Error('INVALID_CONFIG');
  const lockRoot = realpathSync(dirname(config.operationLockPath));
  const trustPaths = fileRoles.map(([, path]) => realpathSync(path));
  if (
    trustPaths.some((path) => physicalRoots.some((root) => containsPath(root, path))) ||
    physicalRoots.some((root) => containsPath(root, lockRoot) || containsPath(lockRoot, root))
  )
    throw new Error('INVALID_CONFIG');
  const existing = [
    ...trustPaths.map((path) => ({ path, allowLinks: false })),
    { path: lockRoot, allowLinks: false },
    ...physicalRoots.map((path) => ({ path, allowLinks: false })),
    ...leafRoles
      .filter(([, path]) => existsSync(path))
      .map(([, path, , allowLinks]) => ({ path, allowLinks: Boolean(allowLinks) })),
  ];
  const inodeGroups = new Map();
  for (const item of existing) {
    const st = statSync(item.path);
    const key = `${st.dev}:${st.ino}`;
    inodeGroups.set(key, [...(inodeGroups.get(key) || []), item]);
  }
  if ([...inodeGroups.values()].some((items) => items.length > 1 && items.some((item) => !item.allowLinks)))
    throw new Error('INVALID_CONFIG');
  const mutationDevices = [lockRoot, ...physicalRoots].map((path) => statSync(path).dev);
  if (new Set(mutationDevices).size !== 1) throw new Error('CROSS_FILESYSTEM');
  return true;
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function signApproval(payload, key) {
  return { payload, signature: createHmac('sha256', key).update(canonicalJson(payload)).digest('hex') };
}

export function createApprovalPayload(fields, { now = Date.now(), ttlMs = DEFAULT_MAX_TTL_MS } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_MAX_TTL_MS) throw new Error('INVALID_TTL');
  return {
    version: APPROVAL_VERSION,
    id: fields.id || randomUUID(),
    nonce: fields.nonce || randomUUID(),
    action:
      fields.action === 'stage'
        ? 'additive-publish'
        : fields.action === 'activate'
          ? 'canonical-switch'
          : fields.action,
    manifestDigest: fields.manifestDigest,
    manifestEntryId: fields.manifestEntryId,
    provider: 'claude',
    email: normalizeEmail(fields.email),
    organizationUuid: fields.organizationUuid,
    organizationName: fields.organizationName,
    accountOwner: fields.accountOwner,
    authorizedOperator: fields.authorizedOperator,
    environment: fields.environment,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    candidateDigest: fields.candidateDigest,
    oldTargetDigest: fields.oldTargetDigest ?? null,
    inventoryDigest: fields.inventoryDigest ?? null,
    canaryDigest: fields.canaryDigest ?? null,
    destination: fields.destination,
  };
}

export function verifyApproval({ artifact, keyPath, expected, now = Date.now(), maxTtlMs = DEFAULT_MAX_TTL_MS }) {
  if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0 || maxTtlMs > DEFAULT_MAX_TTL_MS) throw new Error('INVALID_TTL');
  exactKeys(artifact, ['payload', 'signature']);
  exactKeys(artifact.payload, APPROVAL_KEYS);
  const p = artifact.payload;
  if (p.version !== APPROVAL_VERSION || !['additive-publish', 'canonical-switch'].includes(p.action))
    throw new Error('INVALID_APPROVAL');
  for (const key of [
    'id',
    'nonce',
    'manifestDigest',
    'manifestEntryId',
    'organizationUuid',
    'organizationName',
    'accountOwner',
    'authorizedOperator',
    'environment',
  ])
    nonempty(p[key]);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(p.id) || !/^[A-Za-z0-9_-]{8,128}$/.test(p.nonce))
    throw new Error('INVALID_APPROVAL');
  if (p.provider !== 'claude' || p.email !== normalizeEmail(p.email)) throw new Error('INVALID_APPROVAL');
  if (!/^[a-f0-9]{64}$/.test(p.manifestDigest)) throw new Error('INVALID_APPROVAL');
  if (!/^[a-f0-9]{64}$/.test(p.candidateDigest) || !nonempty(p.destination)) throw new Error('INVALID_APPROVAL');
  if (
    p.action === 'additive-publish' &&
    (p.oldTargetDigest !== null || p.inventoryDigest !== null || p.canaryDigest !== null)
  )
    throw new Error('INVALID_APPROVAL');
  if (
    p.action === 'canonical-switch' &&
    ((p.oldTargetDigest !== null && !/^[a-f0-9]{64}$/.test(p.oldTargetDigest)) ||
      !/^[a-f0-9]{64}$/.test(p.inventoryDigest) ||
      !/^[a-f0-9]{64}$/.test(p.canaryDigest))
  )
    throw new Error('INVALID_APPROVAL');
  const issued = parseRfc3339(p.issuedAt);
  const expires = parseRfc3339(p.expiresAt);
  if (
    issued === null ||
    expires === null ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > maxTtlMs
  )
    throw new Error('INVALID_APPROVAL_CLOCK');
  for (const [key, value] of Object.entries(expected))
    if (p[key] !== value) throw new Error('APPROVAL_BINDING_MISMATCH');
  assertOwnerOnly(keyPath, 'file');
  const key = secureRead(keyPath);
  if (key.length < 32) throw new Error('APPROVAL_KEY_TOO_SHORT');
  if (typeof artifact.signature !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.signature))
    throw new Error('INVALID_SIGNATURE');
  const supplied = Buffer.from(artifact.signature, 'hex');
  const calculated = createHmac('sha256', key).update(canonicalJson(p)).digest();
  if (!timingSafeEqual(supplied, calculated)) throw new Error('INVALID_SIGNATURE');
  return p;
}

function validateUseMarker(path, keyPath, expected) {
  const marker = verifySignedRecord(secureRead(path), secureRead(keyPath), 'INVALID_USE_MARKER');
  exactKeys(marker, ['version', 'approvalId', 'nonce', 'action']);
  if (
    marker.version !== 1 ||
    marker.approvalId !== expected.approvalId ||
    marker.nonce !== expected.nonce ||
    marker.action !== expected.action
  )
    throw new Error('INVALID_USE_MARKER');
  return marker;
}

export function consumeApproval(payload, usageDir, keyPath) {
  assertOwnerOnly(usageDir, 'directory');
  const marker = join(usageDir, `${payload.id}.${payload.nonce}.used`);
  assertCanonicalLeaf(marker);
  if (existsSync(marker)) {
    if (keyPath)
      validateUseMarker(marker, keyPath, { approvalId: payload.id, nonce: payload.nonce, action: payload.action });
    throw new Error('APPROVAL_REPLAY');
  }
  const markerPayload = { version: 1, approvalId: payload.id, nonce: payload.nonce, action: payload.action };
  const markerBytes = keyPath
    ? `${canonicalJson(signedRecord(markerPayload, secureRead(keyPath)))}\n`
    : `${payload.action}\n`;
  try {
    durableExclusive(marker, markerBytes);
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:MARKER_LINK'
    )
      process.kill(process.pid, 'SIGKILL');
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      ['THROW:MARKER_AFTER_LINK', 'THROW:MARKER_CLEANUP_UNCERTAIN'].includes(
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT,
      )
    )
      throw new Error('INJECTED_FAILURE');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('APPROVAL_REPLAY');
    // Once the signed canonical marker may have been published it is
    // authoritative. Never attempt deletion on a downstream failure.
    if (existsSync(marker)) throw new Error('APPROVAL_CONSUME_RECOVERY_REQUIRED');
    throw new Error('APPROVAL_CONSUME_FAILED');
  }
}

function publicationPath(options) {
  return `${options.operationLockPath}.publication`;
}

function removeDurably(path, expectedDescriptor) {
  if (
    path.endsWith('.publication') &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:PUBLICATION_CLEANUP_FSYNC'
  )
    throw new Error('PUBLICATION_RECOVERY_REQUIRED');
  if (!expectedDescriptor) throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
  removeDescriptorSafely(path, expectedDescriptor, 'PUBLICATION_RECOVERY_UNCERTAIN');
}

function recoverPublication(options) {
  const path = publicationPath(options);
  if (!existsSync(path)) {
    // An unanchored filename pattern cannot authenticate a preparation inode.
    // Leave orphan temps untouched unless an authenticated publication record
    // names the exact expected proof.
    return false;
  }
  const publicationDescriptor = secureReadDescriptor(path);
  const record = verifySignedRecord(
    publicationDescriptor.bytes,
    secureRead(options.keyPath),
    'INVALID_PUBLICATION_RECORD',
  );
  exactKeys(record, [
    'version',
    'kind',
    'stagedPath',
    'stagingDigest',
    'stagedDescriptor',
    'stagedProof',
    'markerPath',
    'approvalId',
    'approvalNonce',
  ]);
  if (record.version !== 1 || record.kind !== 'stage') throw new Error('INVALID_PUBLICATION_RECORD');
  for (const key of ['stagedPath', 'stagingDigest', 'markerPath', 'approvalId', 'approvalNonce']) nonempty(record[key]);
  exactKeys(record.stagedDescriptor, ['dev', 'ino', 'birthtimeNs', 'digest']);
  if (record.stagedDescriptor.digest !== record.stagingDigest) throw new Error('INVALID_PUBLICATION_RECORD');
  assertCanonicalLeaf(record.stagedPath);
  assertCanonicalLeaf(record.markerPath);
  if (!containsPath(options.stagingDir, record.stagedPath) || !containsPath(options.usageDir, record.markerPath))
    throw new Error('INVALID_PUBLICATION_RECORD');
  if (record.stagedProof !== `${record.stagedPath}.preparation-${record.stagingDigest}`)
    throw new Error('INVALID_PUBLICATION_RECORD');
  if (!existsSync(record.stagedProof) || !descriptorStillCurrent(record.stagedProof, record.stagedDescriptor))
    throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
  const markerExists = existsSync(record.markerPath);
  if (markerExists) {
    validateUseMarker(record.markerPath, options.keyPath, {
      approvalId: record.approvalId,
      nonce: record.approvalNonce,
      action: 'additive-publish',
    });
    // The durable use marker is authoritative evidence. Keep any successfully
    // published staged bytes; absence means the operation rolled back consumed.
    if (
      existsSync(record.stagedPath) &&
      !candidateTopologyCurrent(record.stagedPath, record.stagedProof, record.stagedDescriptor)
    )
      throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    fsyncDirectory(options.usageDir);
    if (existsSync(record.stagedPath)) fsyncDirectory(options.stagingDir);
  } else if (existsSync(record.stagedPath)) {
    if (!descriptorStillCurrent(record.stagedPath, record.stagedDescriptor))
      throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    removeDescriptorSafely(record.stagedPath, record.stagedDescriptor, 'PUBLICATION_RECOVERY_UNCERTAIN');
  }
  if (!markerExists && existsSync(record.stagedProof)) {
    if (!descriptorStillCurrent(record.stagedProof, record.stagedDescriptor))
      throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    removeDescriptorSafely(record.stagedProof, record.stagedDescriptor, 'PUBLICATION_RECOVERY_UNCERTAIN');
  }
  if (!markerExists) fsyncDirectory(options.usageDir);
  removeDurably(path, publicationDescriptor);
  return true;
}

function beginPublication(options, payload, stagedPath, digest, descriptor) {
  const markerPath = join(options.usageDir, `${payload.id}.${payload.nonce}.used`);
  const record = {
    version: 1,
    kind: 'stage',
    stagedPath,
    stagingDigest: digest,
    stagedDescriptor: {
      dev: descriptor.dev,
      ino: descriptor.ino,
      birthtimeNs: descriptor.birthtimeNs,
      digest: descriptor.digest,
    },
    stagedProof: descriptor.proof,
    markerPath,
    approvalId: payload.id,
    approvalNonce: payload.nonce,
  };
  durableExclusive(publicationPath(options), `${canonicalJson(signedRecord(record, secureRead(options.keyPath)))}\n`);
  const publicationDescriptor = secureReadDescriptor(publicationPath(options));
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:PUBLICATION_FIRST_DIR_FSYNC'
  )
    throw new Error('PUBLICATION_RECOVERY_REQUIRED');
  return { record, publicationDescriptor };
}

function recursiveJsonFiles(root) {
  assertOwnerOnly(root, 'directory');
  const files = [];
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error('UNSAFE_INVENTORY');
      if (st.isDirectory()) visit(path);
      else if (item.name.endsWith('.json')) {
        if (!st.isFile()) throw new Error('UNSAFE_INVENTORY');
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function claudeIdentityFromInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const indicators = [value.type, value.provider].filter((item) => item !== undefined);
  if (indicators.length === 2 && indicators[0] !== indicators[1]) throw new Error('AMBIGUOUS_INVENTORY');
  const claudeShaped =
    indicators.includes('claude') ||
    ['organization_uuid', 'organization_name', 'claude_device_ids'].some((key) => Object.hasOwn(value, key));
  if (!claudeShaped) return null;
  if (indicators.some((item) => item !== 'claude')) throw new Error('AMBIGUOUS_INVENTORY');
  try {
    return identityKey(value);
  } catch {
    throw new Error('AMBIGUOUS_INVENTORY');
  }
}

export function assertNoIdentityConflicts({ entry, activeDir, quarantineDirs, stagingDir, candidatePath }) {
  const wanted = identityKey(entry);
  let approvedQuarantine = 0;
  for (const [kind, roots] of [
    ['active', [activeDir]],
    ['quarantine', quarantineDirs],
    ['staging', [stagingDir]],
  ]) {
    for (const root of roots) {
      for (const path of recursiveJsonFiles(root)) {
        if (candidatePath && resolve(path) === resolve(candidatePath)) continue;
        let value;
        try {
          if (kind === 'active') {
            const descriptor = secureReadDescriptor(path, false);
            if (descriptor.nlink === 2) {
              const proof = `${join(stagingDir, basename(path))}.preparation-${descriptor.digest}`;
              if (!candidateTopologyCurrent(path, proof, descriptor)) throw new Error();
            } else if (descriptor.nlink !== 1) throw new Error();
            value = parseStrictJson(descriptor.bytes, 'MALFORMED_INVENTORY');
          } else value = parseStrictJson(secureRead(path), 'MALFORMED_INVENTORY');
        } catch {
          throw new Error('MALFORMED_INVENTORY');
        }
        const identity = claudeIdentityFromInventory(value);
        if (identity !== wanted) continue;
        const exactActive = kind === 'active' && resolve(path) === resolve(join(activeDir, entry.authFilename));
        const exactQuarantine = kind === 'quarantine' && resolve(path) === resolve(join(root, entry.authFilename));
        if (exactQuarantine) approvedQuarantine += 1;
        if (!exactActive && !exactQuarantine) throw new Error('DUPLICATE_IDENTITY');
      }
    }
  }
  if (approvedQuarantine > 1) throw new Error('DUPLICATE_IDENTITY');
}

function normalizedConsumers(consumers, keys, code) {
  if (!Array.isArray(consumers) || consumers.length === 0) throw new Error(code);
  const ids = new Set();
  const paths = new Set();
  return consumers.map((consumer) => {
    exactKeys(consumer, keys);
    nonempty(consumer.id);
    nonempty(consumer.type);
    if (!isAbsolute(nonempty(consumer.path)) || resolve(consumer.path) !== consumer.path) throw new Error(code);
    if (ids.has(consumer.id) || paths.has(consumer.path)) throw new Error(code);
    ids.add(consumer.id);
    paths.add(consumer.path);
    return consumer;
  });
}

function readAuthoritativeConsumers(options, entry) {
  assertCanonicalExisting(options.authoritativeConsumerInventoryPath);
  assertOwnerOnly(options.authoritativeConsumerInventoryPath, 'file');
  const bytes = secureRead(options.authoritativeConsumerInventoryPath);
  if (sha256(bytes) !== options.authoritativeConsumerInventoryDigest)
    throw new Error('AUTHORITATIVE_INVENTORY_MISMATCH');
  try {
    const value = parseStrictJson(bytes, 'INVALID_AUTHORITATIVE_INVENTORY');
    exactKeys(value, AUTHORITATIVE_CONSUMER_KEYS);
    if (value.version !== 1) throw new Error();
    const all = normalizedConsumers(
      value.consumers,
      AUTHORITATIVE_CONSUMER_ENTRY_KEYS,
      'INVALID_AUTHORITATIVE_INVENTORY',
    );
    const selected = all.filter((consumer) => consumer.credentialId === entry.id);
    if (!selected.length || selected.some((consumer) => consumer.destination !== entry.authFilename)) throw new Error();
    return selected.map(({ id, type, path }) => ({ id, type, path }));
  } catch {
    throw new Error('INVALID_AUTHORITATIVE_INVENTORY');
  }
}

function readSwitchEvidence(path, kind, entry, candidateDigest, authoritativeConsumers) {
  if (!isAbsolute(path)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  assertCanonicalExisting(path);
  assertOwnerOnly(path, 'file');
  const descriptor = secureReadDescriptor(path);
  const bytes = descriptor.bytes;
  let value;
  try {
    value = parseStrictJson(bytes, `INVALID_${kind.toUpperCase()}`);
    if (kind === 'inventory') {
      exactKeys(value, INVENTORY_KEYS);
      exactKeys(value.credential, INVENTORY_CREDENTIAL_KEYS);
      if (value.version !== 1 || !Array.isArray(value.consumers) || value.consumers.length === 0) throw new Error();
      const consumers = normalizedConsumers(value.consumers, INVENTORY_CONSUMER_KEYS, 'INVALID_INVENTORY');
      const expected = {
        id: entry.id,
        provider: entry.provider,
        email: entry.email,
        organizationUuid: entry.organizationUuid,
        organizationName: entry.organizationName,
        accountOwner: entry.accountOwner,
        destination: entry.authFilename,
      };
      if (canonicalJson(value.credential) !== canonicalJson(expected)) throw new Error();
      if (canonicalJson(consumers) !== canonicalJson(authoritativeConsumers)) throw new Error();
    } else {
      exactKeys(value, CANARY_KEYS);
      if (value.version !== 1 || !Array.isArray(value.results)) throw new Error();
      const expected = new Map(authoritativeConsumers.map((consumer) => [consumer.id, consumer]));
      const seen = new Set();
      for (const result of value.results) {
        exactKeys(result, CANARY_RESULT_KEYS);
        const consumer = expected.get(result.consumerId);
        if (
          !consumer ||
          seen.has(result.consumerId) ||
          result.consumerPath !== consumer.path ||
          result.credentialId !== entry.id ||
          result.candidateDigest !== candidateDigest ||
          result.destination !== entry.authFilename ||
          result.noFallback !== true ||
          result.pass !== true
        )
          throw new Error();
        seen.add(result.consumerId);
      }
      if (seen.size !== expected.size) throw new Error();
    }
  } catch {
    throw new Error(`INVALID_${kind.toUpperCase()}`);
  }
  return { value, digest: sha256(bytes), descriptor, path };
}

function binding(entry, manifestDigest, action, candidateDigest, environment, operator, switchEvidence = {}) {
  return {
    action: action === 'stage' ? 'additive-publish' : 'canonical-switch',
    manifestDigest,
    manifestEntryId: entry.id,
    provider: 'claude',
    email: entry.email,
    organizationUuid: entry.organizationUuid,
    organizationName: entry.organizationName,
    accountOwner: entry.accountOwner,
    authorizedOperator: operator,
    environment,
    candidateDigest,
    oldTargetDigest: action === 'activate' ? switchEvidence.oldTargetDigest : null,
    inventoryDigest: action === 'activate' ? switchEvidence.inventoryDigest : null,
    canaryDigest: action === 'activate' ? switchEvidence.canaryDigest : null,
    destination: entry.authFilename,
  };
}

function signedRecord(payload, key) {
  return { payload, signature: createHmac('sha256', key).update(canonicalJson(payload)).digest('hex') };
}

function verifySignedRecord(bytes, key, kind) {
  const record = parseStrictJson(bytes, kind);
  exactKeys(record, ['payload', 'signature']);
  if (typeof record.signature !== 'string' || !/^[a-f0-9]{64}$/.test(record.signature)) throw new Error(kind);
  const expected = createHmac('sha256', key).update(canonicalJson(record.payload)).digest();
  if (!timingSafeEqual(Buffer.from(record.signature, 'hex'), expected)) throw new Error(kind);
  return record.payload;
}

function durableExclusive(path, bytes) {
  bytes = Buffer.from(bytes);
  const temp = `${path}.preparation-${sha256(bytes)}`;
  let descriptor;
  if (existsSync(temp)) {
    descriptor = secureReadDescriptor(temp, false);
    if (!descriptor.bytes.equals(bytes)) throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
  } else {
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const st = fstatSync(fd);
      const big = fstatSync(fd, { bigint: true });
      descriptor = { bytes, digest: sha256(bytes), dev: st.dev, ino: st.ino, birthtimeNs: big.birthtimeNs.toString() };
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(path));
    if (!descriptorStillCurrent(temp, descriptor)) throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
  }
  if (
    path.endsWith('.publication') &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:PUBLICATION_BEFORE_LINK'
  )
    process.kill(process.pid, 'SIGKILL');
  try {
    if (existsSync(path)) {
      if (!descriptorStillCurrent(path, descriptor)) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
    } else linkSync(temp, path);
    if (
      path.endsWith('.publication') &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:PUBLICATION_LINK'
    )
      process.kill(process.pid, 'SIGKILL');
    fsyncDirectory(dirname(path));
    if (!descriptorStillCurrent(path, descriptor)) throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    if (
      path.endsWith('.publication') &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:PUBLICATION_DIR_FSYNC'
    )
      process.kill(process.pid, 'SIGKILL');
    if (
      path.endsWith('.publication') &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:PUBLICATION_CLEANUP'
    )
      process.kill(process.pid, 'SIGKILL');
  } catch (error) {
    throw error;
  }
  return descriptor;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function validateProcessRecord(record, kind, { lockNonce } = {}) {
  if (
    record.version !== 1 ||
    typeof record.host !== 'string' ||
    !record.host ||
    record.host.length > 255 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.pid > 2_147_483_647 ||
    typeof record.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.nonce) ||
    parseRfc3339(record.createdAt) === null ||
    (lockNonce !== undefined && record.lockNonce !== lockNonce)
  )
    throw new Error(kind);
  return record;
}

function acquireRecoveryClaim(claim, holder, key) {
  const claimPayload = () => ({
    version: 1,
    host: hostname(),
    pid: process.pid,
    nonce: randomUUID(),
    lockNonce: holder.nonce,
    createdAt: new Date().toISOString(),
  });
  let mine = claimPayload();
  try {
    const descriptor = durableExclusive(claim, `${canonicalJson(signedRecord(mine, key))}\n`);
    return { payload: mine, descriptor };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('OPERATION_LOCKED');
  }
  let stale;
  try {
    assertOwnerOnly(claim, 'file');
    const staleDescriptor = secureReadDescriptor(claim);
    stale = verifySignedRecord(staleDescriptor.bytes, key, 'RECOVERY_CLAIM_MALFORMED');
    exactKeys(stale, ['version', 'host', 'pid', 'nonce', 'lockNonce', 'createdAt']);
    // Authenticate and validate the claimant independently from the lock it
    // originally observed. A dead same-host claimant can outlive that lock;
    // its older nonce must not permanently wedge a later dead-holder reclaim.
    validateProcessRecord(stale, 'RECOVERY_CLAIM_MALFORMED');
    if (typeof stale.lockNonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(stale.lockNonce))
      throw new Error('RECOVERY_CLAIM_MALFORMED');
    if (stale.host !== hostname() || pidAlive(stale.pid)) throw new Error('OPERATION_LOCKED');
    if (!descriptorStillCurrent(claim, staleDescriptor)) throw new Error('OPERATION_LOCKED');
    removeDescriptorSafely(claim, staleDescriptor, 'OPERATION_LOCKED');
    mine = claimPayload();
    const descriptor = durableExclusive(claim, `${canonicalJson(signedRecord(mine, key))}\n`);
    return { payload: mine, descriptor };
  } catch (claimError) {
    if (claimError?.message === 'RECOVERY_CLAIM_MALFORMED') throw claimError;
    throw new Error('OPERATION_LOCKED');
  }
}

function removeOwnedRecoveryClaim(claim, ownedClaim, key) {
  const current = verifySignedRecord(ownedClaim.descriptor.bytes, key, 'RECOVERY_CLAIM_MALFORMED');
  if (canonicalJson(current) !== canonicalJson(ownedClaim.payload)) throw new Error('OPERATION_LOCKED');
  removeDescriptorSafely(claim, ownedClaim.descriptor, 'OPERATION_LOCKED');
}

export function withOperationLock(path, keyPath, callback, { allowJournal = false, allowPublication = false } = {}) {
  assertOwnerOnly(dirname(path), 'directory');
  assertCanonicalLeaf(path);
  const key = secureRead(keyPath);
  const journal = `${path}.journal`;
  const journalTransition = `${journal}.transition`;
  const publication = `${path}.publication`;
  if (!allowJournal && (existsSync(journal) || existsSync(journalTransition)))
    throw new Error('PENDING_ACTIVATION_JOURNAL');
  if (!allowPublication && existsSync(publication)) throw new Error('PENDING_APPROVAL_PUBLICATION');
  const metadata = {
    version: 1,
    host: hostname(),
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let ownedLockDescriptor;
  try {
    ownedLockDescriptor = durableExclusive(path, `${canonicalJson(signedRecord(metadata, key))}\n`);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('OPERATION_LOCKED');
    let holder;
    let holderDescriptor;
    try {
      assertOwnerOnly(path, 'file');
      holderDescriptor = secureReadDescriptor(path);
      holder = verifySignedRecord(holderDescriptor.bytes, key, 'OPERATION_LOCKED_MALFORMED');
      exactKeys(holder, ['version', 'host', 'pid', 'nonce', 'createdAt']);
      validateProcessRecord(holder, 'OPERATION_LOCKED_MALFORMED');
    } catch (verifyError) {
      throw new Error(
        verifyError?.message === 'OPERATION_LOCKED_MALFORMED' ? verifyError.message : 'OPERATION_LOCKED_MALFORMED',
      );
    }
    if (holder.host !== hostname() || pidAlive(holder.pid)) throw new Error('OPERATION_LOCKED');
    const claim = `${path}.recovery-claim`;
    const ownedClaim = acquireRecoveryClaim(claim, holder, key);
    let claimRemoved = false;
    try {
      if (!descriptorStillCurrent(path, holderDescriptor)) throw new Error('OPERATION_LOCKED');
      removeDescriptorSafely(path, holderDescriptor, 'OPERATION_LOCKED');
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:OLD_LOCK_UNLINKED'
      )
        process.kill(process.pid, 'SIGKILL');
      // Clear our claim durably before publishing. If we crash here, another
      // process can arbitrate the now-absent lock with O_EXCL instead of being
      // permanently wedged behind our dead claim.
      removeOwnedRecoveryClaim(claim, ownedClaim, key);
      claimRemoved = true;
      try {
        ownedLockDescriptor = durableExclusive(path, `${canonicalJson(signedRecord(metadata, key))}\n`);
      } catch (publishError) {
        if (publishError?.code === 'EEXIST') throw new Error('OPERATION_LOCKED');
        throw publishError;
      }
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:LOCK_REPLACEMENT_PUBLISHED'
      )
        process.kill(process.pid, 'SIGKILL');
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGSTOP:LOCK_REPLACEMENT_PUBLISHED'
      )
        process.kill(process.pid, 'SIGSTOP');
    } finally {
      if (!claimRemoved) {
        try {
          removeOwnedRecoveryClaim(claim, ownedClaim, key);
        } catch {
          // Never remove a claim whose ownership can no longer be demonstrated.
        }
      }
    }
  }
  const release = () => {
    const current = verifySignedRecord(ownedLockDescriptor.bytes, key, 'OPERATION_LOCKED_MALFORMED');
    if (current.nonce !== metadata.nonce) throw new Error('OPERATION_LOCKED');
    if (!removeDescriptorSafely(path, ownedLockDescriptor, 'OPERATION_LOCKED')) throw new Error('OPERATION_LOCKED');
  };
  // The preflight check is only an optimization. Ownership is the
  // synchronization point: crash state may be published while this process is
  // waiting or reclaiming a stale lock.
  if (!allowJournal && (existsSync(journal) || existsSync(journalTransition))) {
    release();
    throw new Error('PENDING_ACTIVATION_JOURNAL');
  }
  if (!allowPublication && existsSync(publication)) {
    release();
    throw new Error('PENDING_APPROVAL_PUBLICATION');
  }
  let result;
  try {
    result = callback({ version: 1, nonce: metadata.nonce, path });
  } catch (error) {
    release();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(release);
  release();
  return result;
}

function loadCommon(options) {
  validatePathTopology({
    configPath: options.configPath,
    config: {
      manifestPath: options.manifestPath,
      approvalKeyPath: options.keyPath,
      usageDir: options.usageDir,
      stagingDir: options.stagingDir,
      activeDir: options.activeDir,
      quarantineDirs: options.quarantineDirs,
      rollbackDir: options.rollbackDir,
      operationLockPath: options.operationLockPath,
    },
    approvalPath: options.approvalPath,
    candidatePath: options.candidatePath,
  });
  for (const path of [options.manifestPath, options.keyPath, options.approvalPath]) {
    assertCanonicalExisting(path);
    assertOwnerOnly(path, 'file');
  }
  for (const path of [
    options.usageDir,
    options.stagingDir,
    options.activeDir,
    ...options.quarantineDirs,
    options.rollbackDir,
  ])
    (assertCanonicalExisting(path), assertOwnerOnly(path, 'directory'));
  assertCanonicalLeaf(options.operationLockPath);
  const initial = readManifest(options.manifestPath);
  const entry = initial.manifest.entries.find((item) => item.id === options.entryId);
  if (!entry || entry.provider !== 'claude') throw new Error('ENTRY_NOT_CLAUDE');
  validatePathTopology({
    configPath: options.configPath,
    config: {
      manifestPath: options.manifestPath,
      approvalKeyPath: options.keyPath,
      usageDir: options.usageDir,
      stagingDir: options.stagingDir,
      activeDir: options.activeDir,
      quarantineDirs: options.quarantineDirs,
      rollbackDir: options.rollbackDir,
      operationLockPath: options.operationLockPath,
    },
    approvalPath: options.approvalPath,
    candidatePath: options.candidatePath,
    entry,
  });
  return { initial, entry };
}

function readArtifact(path) {
  assertOwnerOnly(path, 'file');
  try {
    return parseStrictJson(secureRead(path), 'INVALID_APPROVAL');
  } catch {
    throw new Error('INVALID_APPROVAL');
  }
}

function publishNoReplace(path, bytes, onPrepared) {
  const temp = `${path}.preparation-${sha256(bytes)}`;
  let fd = existsSync(temp)
    ? undefined
    : openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let linked = false;
  let prepared;
  try {
    if (fd !== undefined) {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const st = fstatSync(fd);
      const big = fstatSync(fd, { bigint: true });
      prepared = {
        bytes: Buffer.from(bytes),
        digest: sha256(bytes),
        dev: st.dev,
        ino: st.ino,
        birthtimeNs: big.birthtimeNs.toString(),
      };
      closeSync(fd);
      fd = undefined;
    }
    fsyncDirectory(dirname(path));
    prepared ??= secureReadDescriptor(temp, false);
    if (!descriptorStillCurrent(temp, prepared)) throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
    if (!prepared.bytes.equals(Buffer.from(bytes))) throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
    onPrepared({ ...prepared, proof: temp });
    linkSync(temp, path);
    linked = true;
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:STAGED_LINK'
    )
      process.kill(process.pid, 'SIGKILL');
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:STAGE_AFTER_LINK'
    )
      throw new Error('INJECTED_FAILURE');
    if (!descriptorStillCurrent(temp, prepared) || !descriptorStillCurrent(path, prepared))
      throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
  } catch (error) {
    if (linked && (!prepared || !descriptorStillCurrent(temp, prepared) || !descriptorStillCurrent(path, prepared)))
      throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
    if (existsSync(temp) && prepared && !descriptorStillCurrent(temp, prepared))
      throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
    if (fd !== undefined) closeSync(fd);
    if (linked) {
      try {
        removeDescriptorSafely(path, prepared, 'STAGE_PUBLICATION_RECOVERY_REQUIRED');
      } catch {
        throw new Error('STAGE_PUBLICATION_RECOVERY_REQUIRED');
      }
    }
    if (error?.code === 'EEXIST') throw new Error('STAGE_TARGET_EXISTS');
    throw error;
  }
}

export function stageEnrollment(options) {
  if (!options?.configPath) throw new Error('CONFIG_PATH_REQUIRED');
  if (!isAbsolute(options.configPath) || !isAbsolute(options.candidatePath) || !isAbsolute(options.approvalPath))
    throw new Error('ABSOLUTE_PATH_REQUIRED');
  options = optionsFromConfig(options);
  return withOperationLock(
    options.operationLockPath,
    options.keyPath,
    () => {
      recoverPublication(options);
      const { initial, entry } = loadCommon(options);
      assertCanonicalExisting(options.candidatePath);
      assertOwnerOnly(options.candidatePath, 'file');
      const candidateBytes = secureRead(options.candidatePath);
      const { digest: candidateDigest } = validateCandidateBytes(candidateBytes, entry, options.now);
      const artifact = readArtifact(options.approvalPath);
      const payload = verifyApproval({
        artifact,
        keyPath: options.keyPath,
        expected: binding(entry, initial.digest, 'stage', candidateDigest, options.environment, options.operator),
        now: options.now,
        maxTtlMs: options.maxTtlMs,
      });
      validatePathTopology({
        configPath: options.configPath,
        config: {
          manifestPath: options.manifestPath,
          approvalKeyPath: options.keyPath,
          usageDir: options.usageDir,
          stagingDir: options.stagingDir,
          activeDir: options.activeDir,
          quarantineDirs: options.quarantineDirs,
          rollbackDir: options.rollbackDir,
          operationLockPath: options.operationLockPath,
        },
        approvalPath: options.approvalPath,
        entry,
        approvalId: payload,
      });
      assertNoIdentityConflicts({
        entry,
        activeDir: options.activeDir,
        quarantineDirs: options.quarantineDirs,
        stagingDir: options.stagingDir,
      });
      const stagedPath = join(options.stagingDir, entry.authFilename);
      assertCanonicalLeaf(stagedPath);
      let stagedDescriptor;
      let publicationDescriptor;
      publishNoReplace(stagedPath, candidateBytes, (descriptor) => {
        stagedDescriptor = descriptor;
        ({ publicationDescriptor } = beginPublication(options, payload, stagedPath, candidateDigest, descriptor));
      });
      try {
        consumeApproval(payload, options.usageDir, options.keyPath);
      } catch (error) {
        // A marker is evidence that publication succeeded. If marker publication
        // fails, remove the staged bytes durably rather than leaving false replay
        // evidence or an unauthorised staged candidate behind.
        try {
          if (!stagedDescriptor || !descriptorStillCurrent(stagedPath, stagedDescriptor)) throw new Error();
          removeDescriptorSafely(stagedPath, stagedDescriptor, 'PUBLICATION_RECOVERY_REQUIRED');
        } catch {
          throw new Error('PUBLICATION_RECOVERY_REQUIRED');
        }
        throw error;
      }
      removeDurably(publicationPath(options), publicationDescriptor);
      return {
        ok: true,
        action: 'stage',
        provider: 'claude',
        manifestEntryId: entry.id,
        authFilename: entry.authFilename,
        candidateDigest,
      };
    },
    { allowPublication: true },
  );
}

function replaceAndFsync(stagedPath, target, stagingDir, activeDir, injectFailure, markRenamed) {
  if (injectFailure === 'initial-rename-failure') throw new Error('INJECTED_FAILURE');
  renameSync(stagedPath, target);
  markRenamed();
  if (['after-rename-before-dir-fsync', 'rollback-fsync-failure'].includes(injectFailure))
    throw new Error('INJECTED_FAILURE');
  fsyncDirectory(stagingDir);
  if (injectFailure === 'after-source-dir-fsync') throw new Error('INJECTED_FAILURE');
  fsyncDirectory(activeDir);
}

function restoreBackup(backup, target, activeDir, restorePath, expectedDescriptor, expectedDigest) {
  const source = secureReadDescriptor(backup, false);
  if (
    !expectedDescriptor ||
    source.dev !== expectedDescriptor.dev ||
    source.ino !== expectedDescriptor.ino ||
    source.birthtimeNs !== expectedDescriptor.birthtimeNs ||
    source.digest !== expectedDigest
  )
    throw new Error('INVALID_ACTIVATION_BACKUP');
  if (!existsSync(target)) {
    if (restorePath) {
      if (existsSync(restorePath)) throw new Error('INVALID_ACTIVATION_RESTORE');
      renameSync(backup, restorePath);
      fsyncDirectory(dirname(backup));
      fsyncDirectory(dirname(restorePath));
      linkSync(restorePath, target);
    } else linkSync(backup, target);
    fsyncDirectory(activeDir);
  }
  const restore = secureReadDescriptor(target, false);
  if (
    restore.dev !== expectedDescriptor.dev ||
    restore.ino !== expectedDescriptor.ino ||
    restore.birthtimeNs !== expectedDescriptor.birthtimeNs ||
    restore.digest !== expectedDigest
  )
    throw new Error('INVALID_ACTIVATION_RESTORE');
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:RESTORE_TEMP_FSYNCED'
  )
    process.kill(process.pid, 'SIGKILL');
  if (!restorePath && existsSync(backup)) {
    if (!descriptorStillCurrent(backup, expectedDescriptor) || !descriptorStillCurrent(target, expectedDescriptor))
      throw new Error('INVALID_ACTIVATION_BACKUP');
    removeDescriptorSafely(backup, expectedDescriptor, 'INVALID_ACTIVATION_BACKUP');
  }
  if (!descriptorStillCurrent(target, expectedDescriptor)) throw new Error('INVALID_ACTIVATION_BACKUP');
}

function validateExistingTarget(path, entry, stagingDir) {
  const descriptor = secureReadDescriptor(path, false);
  if (!activeTargetTopologyCurrent(path, stagingDir, descriptor)) throw new Error('INVALID_ACTIVE_TARGET');
  try {
    // Existing active credentials may be expired, but otherwise must satisfy
    // the same exact schema and structural checks as a staging candidate.
    validateCandidateBytes(descriptor.bytes, entry, Number.NEGATIVE_INFINITY);
  } catch (error) {
    if (error?.message === 'IDENTITY_MISMATCH') throw new Error('ACTIVE_TARGET_IDENTITY_MISMATCH');
    throw new Error('INVALID_ACTIVE_TARGET');
  }
  return descriptor;
}

function journalPath(options) {
  return `${options.operationLockPath}.journal`;
}

function journalTransitionPath(options) {
  return `${journalPath(options)}.transition`;
}

function rollbackRecordPath(options, entry) {
  return join(options.rollbackDir, `${entry.authFilename}.committed-rollback.json`);
}

function retainCommittedRollback(options, state) {
  if (!state.hadTarget || !state.backupDescriptor) return;
  if (!descriptorStillCurrent(state.backup, state.backupDescriptor)) throw new Error('INVALID_ACTIVATION_BACKUP');
  if (!descriptorStillCurrent(state.target, state.candidateDescriptor)) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
  const path = rollbackRecordPath(options, state.entrySnapshot);
  const retained = { ...state, phase: 'RETAINED' };
  const key = secureRead(options.keyPath);
  if (existsSync(path)) {
    const existing = verifySignedRecord(secureRead(path), key, 'INVALID_ROLLBACK_RECORD');
    if (canonicalJson(existing) !== canonicalJson(retained)) throw new Error('ROLLBACK_RECORD_EXISTS');
    return;
  }
  durableExclusive(path, `${canonicalJson(signedRecord(retained, key))}\n`);
}

function writeJournal(options, state, phase) {
  const path = journalPath(options);
  const key = secureRead(options.keyPath);
  const next = { ...state, phase };
  const bytes = `${canonicalJson(signedRecord(next, key))}\n`;
  const temp = `${path}.preparation-${sha256(Buffer.from(bytes))}`;
  let fd = existsSync(temp)
    ? undefined
    : openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let published = false;
  let prepared;
  try {
    if (fd !== undefined) {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const st = fstatSync(fd);
      const big = fstatSync(fd, { bigint: true });
      prepared = {
        bytes: Buffer.from(bytes),
        digest: sha256(bytes),
        dev: st.dev,
        ino: st.ino,
        birthtimeNs: big.birthtimeNs.toString(),
      };
      closeSync(fd);
      fd = undefined;
    }
    prepared ??= secureReadDescriptor(temp, false);
    if (!descriptorStillCurrent(temp, prepared)) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
    if (!prepared.bytes.equals(Buffer.from(bytes))) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
    let prior = null;
    if (existsSync(path)) {
      prior = secureReadDescriptor(path, false);
      if (!state.journalDescriptor || !descriptorStillCurrent(path, state.journalDescriptor))
        throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      if (descriptorStillCurrent(path, prepared)) {
        if (lstatSync(temp).nlink !== 2) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
        published = true;
      } else {
        if (lstatSync(temp).nlink !== 1) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      }
    } else if (lstatSync(temp).nlink !== 1) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
    if (!published) {
      const clean = (value) =>
        value && Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'digest'].map((field) => [field, value[field]]));
      const transition = { version: 1, path, prior: clean(prior), next: clean(prepared), nextProof: temp };
      const transitionPath = journalTransitionPath(options);
      const transitionDescriptor = durableExclusive(
        transitionPath,
        `${canonicalJson(signedRecord(transition, key))}\n`,
      );
      if (prior) removeDescriptorSafely(path, prior, 'ACTIVATION_RECOVERY_REQUIRED');
      linkSync(temp, path);
      published = true;
      fsyncDirectory(dirname(path));
      if (!descriptorStillCurrent(path, prepared)) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      removeDescriptorSafely(transitionPath, transitionDescriptor, 'ACTIVATION_RECOVERY_REQUIRED');
    }
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === `THROW:JOURNAL_FSYNC:${phase}`
    )
      throw new Error('INJECTED_JOURNAL_FSYNC_FAILURE');
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (published) error.publishedJournalPhase = phase;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === `SIGKILL:${phase}`
  )
    process.kill(process.pid, 'SIGKILL');
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === `SIGSTOP:${phase}`
  )
    process.kill(process.pid, 'SIGSTOP');
  Object.defineProperty(next, 'journalDescriptor', { value: prepared, writable: true, configurable: true });
  return next;
}

function recoverJournalTransition(options) {
  const transitionPath = journalTransitionPath(options);
  if (!existsSync(transitionPath)) return;
  const key = secureRead(options.keyPath);
  const transitionDescriptor = secureReadDescriptor(transitionPath);
  const transition = verifySignedRecord(transitionDescriptor.bytes, key, 'INVALID_ACTIVATION_JOURNAL_TRANSITION');
  exactKeys(transition, ['version', 'path', 'prior', 'next', 'nextProof']);
  const path = journalPath(options);
  if (
    transition.version !== 1 ||
    transition.path !== path ||
    transition.nextProof !== `${path}.preparation-${transition.next?.digest}` ||
    !descriptorStillCurrent(transition.nextProof, transition.next)
  )
    throw new Error('INVALID_ACTIVATION_JOURNAL_TRANSITION');
  if (existsSync(path)) {
    if (descriptorStillCurrent(path, transition.next)) {
      // already published
    } else if (transition.prior && descriptorStillCurrent(path, transition.prior))
      removeDescriptorSafely(path, transition.prior, 'ACTIVATION_RECOVERY_REQUIRED');
    else throw new Error('ACTIVATION_RECOVERY_REQUIRED');
  }
  if (!existsSync(path)) linkSync(transition.nextProof, path);
  fsyncDirectory(dirname(path));
  if (!descriptorStillCurrent(path, transition.next)) throw new Error('ACTIVATION_RECOVERY_REQUIRED');
  removeDescriptorSafely(transitionPath, transitionDescriptor, 'ACTIVATION_RECOVERY_REQUIRED');
}

function removeJournal(options) {
  const path = journalPath(options);
  const descriptor = secureReadDescriptor(path, false);
  removeDescriptorSafely(path, descriptor, 'ACTIVATION_RECOVERY_REQUIRED');
  fsyncDirectory(dirname(journalPath(options)));
}

function removeCommittedBackup(state) {
  if (existsSync(state.backup)) {
    assertCanonicalExisting(state.backup);
    assertOwnerOnly(state.backup, 'file', true);
    // No backup is ever created for a previously absent target. Refuse an
    // unexpected file instead of deleting a pathname solely because it was
    // recorded in the journal.
    if (!state.hadTarget || !state.backupDescriptor || !descriptorStillCurrent(state.backup, state.backupDescriptor))
      throw new Error('INVALID_ACTIVATION_BACKUP');
    removeDescriptorSafely(state.backup, state.backupDescriptor, 'INVALID_ACTIVATION_BACKUP');
  }
  // Always prove cleanup durable, including the already-absent case.
  fsyncDirectory(dirname(state.backup));
}

function removePreparingBackup(state) {
  if (state.restorePath) {
    if (existsSync(state.backup)) {
      if (existsSync(state.restorePath) || !descriptorStillCurrent(state.backup, state.backupDescriptor))
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
      renameSync(state.backup, state.restorePath);
      fsyncDirectory(dirname(state.backup));
      fsyncDirectory(dirname(state.restorePath));
    }
    if (!descriptorStillCurrent(state.restorePath, state.backupDescriptor))
      throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
    return;
  }
  if (existsSync(state.backup)) {
    if (!state.hadTarget) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
    assertCanonicalExisting(state.backup);
    assertOwnerOnly(state.backup, 'file', true);
    if (state.backupDescriptor) {
      if (!descriptorStillCurrent(state.backup, state.backupDescriptor))
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
    } else throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
    removeDescriptorSafely(state.backup, state.backupDescriptor, 'ACTIVATION_RECOVERY_UNCERTAIN');
  }
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:BACKUP_UNLINK_BEFORE_FSYNC'
  )
    throw new Error('INJECTED_BACKUP_CLEANUP_FSYNC_FAILURE');
  fsyncDirectory(dirname(state.backup));
}

export function activateEnrollment(options) {
  if (!options?.configPath) throw new Error('CONFIG_PATH_REQUIRED');
  if (
    !isAbsolute(options.configPath) ||
    !isAbsolute(options.approvalPath) ||
    typeof options.inventoryPath !== 'string' ||
    !isAbsolute(options.inventoryPath) ||
    typeof options.canaryPath !== 'string' ||
    !isAbsolute(options.canaryPath)
  )
    throw new Error('ABSOLUTE_PATH_REQUIRED');
  options = optionsFromConfig(options);
  return withOperationLock(options.operationLockPath, options.keyPath, () => {
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGSTOP:LOCK_ACQUIRED'
    )
      process.kill(process.pid, 'SIGSTOP');
    const { initial, entry } = loadCommon(options);
    if (existsSync(rollbackRecordPath(options, entry))) throw new Error('ROLLBACK_RECORD_EXISTS');
    const stagedPath = join(options.stagingDir, entry.authFilename);
    assertOwnerOnly(stagedPath, 'file');
    const candidateDescriptor = secureReadDescriptor(stagedPath);
    const candidateBytes = candidateDescriptor.bytes;
    const { digest: candidateDigest } = validateCandidateBytes(candidateBytes, entry, options.now);
    const target = join(options.activeDir, entry.authFilename);
    assertCanonicalLeaf(target);
    const hadTarget = existsSync(target);
    let oldDigest = null;
    let oldTarget = null;
    let restorePath = null;
    if (hadTarget) {
      oldTarget = validateExistingTarget(target, entry, options.stagingDir);
      oldDigest = oldTarget.digest;
      if (oldTarget.nlink === 2)
        restorePath = `${join(options.stagingDir, entry.authFilename)}.preparation-${oldDigest}`;
    }
    const authoritativeConsumers = readAuthoritativeConsumers(options, entry);
    const inventory = readSwitchEvidence(
      options.inventoryPath,
      'inventory',
      entry,
      candidateDigest,
      authoritativeConsumers,
    );
    const canary = readSwitchEvidence(options.canaryPath, 'canary', entry, candidateDigest, authoritativeConsumers);
    const artifact = readArtifact(options.approvalPath);
    const payload = verifyApproval({
      artifact,
      keyPath: options.keyPath,
      expected: binding(entry, initial.digest, 'activate', candidateDigest, options.environment, options.operator, {
        oldTargetDigest: oldDigest,
        inventoryDigest: inventory.digest,
        canaryDigest: canary.digest,
      }),
      now: options.now,
      maxTtlMs: options.maxTtlMs,
    });
    validatePathTopology({
      configPath: options.configPath,
      config: {
        manifestPath: options.manifestPath,
        approvalKeyPath: options.keyPath,
        usageDir: options.usageDir,
        stagingDir: options.stagingDir,
        activeDir: options.activeDir,
        quarantineDirs: options.quarantineDirs,
        rollbackDir: options.rollbackDir,
        operationLockPath: options.operationLockPath,
      },
      approvalPath: options.approvalPath,
      entry,
      approvalId: payload,
    });
    assertNoIdentityConflicts({
      entry,
      activeDir: options.activeDir,
      quarantineDirs: options.quarantineDirs,
      stagingDir: options.stagingDir,
      candidatePath: stagedPath,
    });
    if (statSync(options.stagingDir).dev !== statSync(options.activeDir).dev) throw new Error('CROSS_FILESYSTEM');
    if (statSync(options.rollbackDir).dev !== statSync(options.activeDir).dev) throw new Error('CROSS_FILESYSTEM');
    if (options.beforeCas) options.beforeCas();
    if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
    if (options.injectFailure === 'before-rename') throw new Error('INJECTED_FAILURE');
    if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
    const candidateProof = `${stagedPath}.preparation-${candidateDigest}`;
    if (!candidateTopologyCurrent(stagedPath, candidateProof, candidateDescriptor))
      throw new Error('CANDIDATE_CAS_FAILED');
    if (!descriptorStillCurrent(inventory.path, inventory.descriptor)) throw new Error('INVENTORY_CAS_FAILED');
    if (!descriptorStillCurrent(canary.path, canary.descriptor)) throw new Error('CANARY_CAS_FAILED');
    if (
      existsSync(target) !== hadTarget ||
      (hadTarget && !activeTargetTopologyCurrent(target, options.stagingDir, oldTarget))
    )
      throw new Error('ACTIVE_TARGET_CAS_FAILED');
    const backupName = `${entry.authFilename}.${payload.id}.${payload.nonce}.${candidateDigest}.${oldDigest || 'none'}.bak`;
    const backup = join(options.rollbackDir, backupName);
    validatePathTopology({
      configPath: options.configPath,
      config: {
        manifestPath: options.manifestPath,
        approvalKeyPath: options.keyPath,
        usageDir: options.usageDir,
        stagingDir: options.stagingDir,
        activeDir: options.activeDir,
        quarantineDirs: options.quarantineDirs,
        rollbackDir: options.rollbackDir,
        operationLockPath: options.operationLockPath,
      },
      approvalPath: options.approvalPath,
      entry,
      approvalId: payload,
      computedPaths: [
        ['backup target', backup, options.rollbackDir, true],
        ...(restorePath ? [['restore target', restorePath, options.stagingDir, true]] : []),
      ],
    });
    let journal = {
      version: 3,
      manifestDigest: initial.digest,
      entrySnapshot: { ...entry },
      entryId: entry.id,
      authFilename: entry.authFilename,
      candidateDigest,
      candidateDescriptor: {
        dev: candidateDescriptor.dev,
        ino: candidateDescriptor.ino,
        digest: candidateDescriptor.digest,
        birthtimeNs: candidateDescriptor.birthtimeNs,
      },
      oldDigest,
      hadTarget,
      backupDescriptor: oldTarget
        ? {
            dev: oldTarget.dev,
            ino: oldTarget.ino,
            birthtimeNs: oldTarget.birthtimeNs,
            size: oldTarget.bytes.length,
            digest: oldDigest,
          }
        : null,
      stagedPath,
      target,
      backup,
      restorePath,
      approvalId: payload.id,
      approvalNonce: payload.nonce,
      authorization: artifact,
      authorizationDigest: sha256(Buffer.from(canonicalJson(artifact))),
      inventoryDigest: inventory.digest,
      canaryDigest: canary.digest,
    };
    journal = writeJournal(options, journal, 'PREPARING');
    if (hadTarget) {
      // The intent already binds the validated target inode. Atomic no-replace
      // hardlink publication means recovery never has to infer ownership from
      // a pathname or digest-only partial copy.
      journal = writeJournal(options, journal, 'BACKUP_CREATE_INTENT');
      if (!activeTargetTopologyCurrent(target, options.stagingDir, oldTarget))
        throw new Error('ACTIVE_TARGET_CAS_FAILED');
      if (restorePath) renameSync(restorePath, backup);
      else linkSync(target, backup);
      if (
        !descriptorStillCurrent(target, oldTarget) ||
        !descriptorStillCurrent(backup, oldTarget) ||
        lstatSync(target).nlink !== 2 ||
        lstatSync(backup).nlink !== 2
      )
        throw new Error('ACTIVE_TARGET_CAS_FAILED');
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:BACKUP_OPENED'
      )
        process.kill(process.pid, 'SIGKILL');
      if (options.injectFailure === 'partial-backup') throw new Error('INJECTED_FAILURE');
      fsyncDirectory(options.rollbackDir);
      if (restorePath) fsyncDirectory(options.stagingDir);
      journal = writeJournal(options, journal, 'BACKUP_CREATED');
    }
    journal = writeJournal(options, journal, 'PREPARED');
    // Final CAS is immediately before backup authorization and approval use.
    if (!candidateTopologyCurrent(stagedPath, candidateProof, candidateDescriptor))
      throw new Error('CANDIDATE_CAS_FAILED');
    if (!descriptorStillCurrent(inventory.path, inventory.descriptor)) throw new Error('INVENTORY_CAS_FAILED');
    if (!descriptorStillCurrent(canary.path, canary.descriptor)) throw new Error('CANARY_CAS_FAILED');
    if (
      existsSync(target) !== hadTarget ||
      (hadTarget &&
        (!descriptorStillCurrent(target, oldTarget) ||
          !descriptorStillCurrent(backup, oldTarget) ||
          lstatSync(target).nlink !== 2 ||
          lstatSync(backup).nlink !== 2))
    )
      throw new Error('ACTIVE_TARGET_CAS_FAILED');
    journal = writeJournal(options, journal, 'APPROVAL_INTENT');
    try {
      consumeApproval(payload, options.usageDir, options.keyPath);
    } catch {
      // The journal lets a fresh recovery process durably resolve whether the
      // marker exists. Do not guess or roll back in-process after an ambiguous
      // marker publication.
      throw new Error('ACTIVATION_RECOVERY_REQUIRED');
    }
    journal = writeJournal(options, journal, 'APPROVAL_CONSUMED');
    journal = writeJournal(options, journal, 'INSTALL_INTENT');
    let renameCompleted = false;
    try {
      if (!candidateTopologyCurrent(stagedPath, candidateProof, candidateDescriptor))
        throw new Error('CANDIDATE_CAS_FAILED');
      replaceAndFsync(stagedPath, target, options.stagingDir, options.activeDir, options.injectFailure, () => {
        renameCompleted = true;
      });
      journal = writeJournal(options, journal, 'INSTALLED');
      if (!candidateTopologyCurrent(target, candidateProof, candidateDescriptor)) throw new Error('DIGEST_MISMATCH');
      // External publishers are required to be operationally fenced, while all
      // first-party writers share this lock. This post-install CAS ensures an
      // unfenced M0→M1 replacement observed before commit is rolled back rather
      // than reported as a successful M0 activation.
      if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGSTOP:MANIFEST_CAS_VERIFIED'
      )
        process.kill(process.pid, 'SIGSTOP');
      if (options.injectFailure === 'after-digest-verification') throw new Error('INJECTED_FAILURE');
      if (!candidateTopologyCurrent(target, candidateProof, candidateDescriptor))
        throw new Error('ACTIVE_TARGET_CAS_FAILED');
      journal = writeJournal(options, journal, 'COMMITTED');
      if (!candidateTopologyCurrent(target, candidateProof, candidateDescriptor))
        throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      retainCommittedRollback(options, journal);
      if (!candidateTopologyCurrent(target, candidateProof, candidateDescriptor))
        throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:AFTER_BACKUP_DELETE'
      )
        process.kill(process.pid, 'SIGKILL');
      removeJournal(options);
      return {
        ok: true,
        action: 'activate',
        provider: 'claude',
        manifestEntryId: entry.id,
        authFilename: entry.authFilename,
        candidateDigest,
        backupCreated: hadTarget,
      };
    } catch (activationError) {
      if (journal.phase === 'COMMITTED' || activationError?.publishedJournalPhase === 'COMMITTED')
        throw new Error('ACTIVATION_RECOVERY_REQUIRED');
      let recoveryFailed = false;
      if (renameCompleted) {
        try {
          if (existsSync(target) && !existsSync(stagedPath) && descriptorStillCurrent(target, candidateDescriptor))
            renameSync(target, stagedPath);
          else recoveryFailed = true;
        } catch {
          recoveryFailed = true;
        }
      }
      if (hadTarget && renameCompleted) {
        try {
          if (!existsSync(backup) || !descriptorStillCurrent(backup, journal.backupDescriptor))
            throw new Error('INVALID_ACTIVATION_BACKUP');
          restoreBackup(backup, target, options.activeDir, restorePath, journal.backupDescriptor, oldDigest);
        } catch {
          recoveryFailed = true;
        }
      }
      for (const dir of [options.activeDir, options.stagingDir]) {
        try {
          if (options.injectFailure === 'rollback-fsync-failure' && dir === options.activeDir)
            throw new Error('INJECTED_FAILURE');
          fsyncDirectory(dir);
        } catch {
          recoveryFailed = true;
        }
      }
      try {
        if (!existsSync(stagedPath) || !descriptorStillCurrent(stagedPath, candidateDescriptor)) recoveryFailed = true;
        if (hadTarget) {
          if (!existsSync(target) || !descriptorStillCurrent(target, journal.backupDescriptor)) recoveryFailed = true;
        } else if (existsSync(target)) recoveryFailed = true;
      } catch {
        recoveryFailed = true;
      }
      if (!recoveryFailed) {
        try {
          removeCommittedBackup(journal);
          removeJournal(options);
        } catch {
          recoveryFailed = true;
        }
      }
      if (activationError?.message === 'INJECTED_FAILURE' && !renameCompleted) throw activationError;
      throw new Error(recoveryFailed ? 'ACTIVATION_ROLLBACK_FAILED' : 'ACTIVATION_ROLLED_BACK');
    }
  });
}

export function recoverEnrollment(options) {
  if (!options?.configPath) throw new Error('CONFIG_PATH_REQUIRED');
  if (!isAbsolute(options.configPath)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  options = optionsFromConfig(options);
  return withOperationLock(
    options.operationLockPath,
    options.keyPath,
    () => {
      recoverJournalTransition(options);
      const path = journalPath(options);
      if (!existsSync(path)) return { ok: true, action: 'recover', recovered: false };
      const state = verifySignedRecord(secureRead(path), secureRead(options.keyPath), 'INVALID_ACTIVATION_JOURNAL');
      exactKeys(state, [
        'version',
        'manifestDigest',
        'entrySnapshot',
        'entryId',
        'authFilename',
        'candidateDigest',
        'candidateDescriptor',
        'oldDigest',
        'hadTarget',
        'backupDescriptor',
        'stagedPath',
        'target',
        'backup',
        'restorePath',
        'approvalId',
        'approvalNonce',
        'authorization',
        'authorizationDigest',
        'inventoryDigest',
        'canaryDigest',
        'phase',
      ]);
      const allowed = [
        'PREPARING',
        'BACKUP_CREATE_INTENT',
        'BACKUP_CREATED',
        'PREPARED',
        'APPROVAL_INTENT',
        'APPROVAL_CONSUMED',
        'INSTALL_INTENT',
        'INSTALLED',
        'COMMITTED',
      ];
      if (state.version !== 3 || !allowed.includes(state.phase)) throw new Error('INVALID_ACTIVATION_JOURNAL');
      if (!/^[a-f0-9]{64}$/.test(state.manifestDigest)) throw new Error('INVALID_ACTIVATION_JOURNAL');
      try {
        exactKeys(state.authorization, ['payload', 'signature']);
        exactKeys(state.authorization.payload, APPROVAL_KEYS);
        if (
          sha256(Buffer.from(canonicalJson(state.authorization))) !== state.authorizationDigest ||
          state.authorization.payload.action !== 'canonical-switch' ||
          state.authorization.payload.id !== state.approvalId ||
          state.authorization.payload.nonce !== state.approvalNonce ||
          state.authorization.payload.manifestDigest !== state.manifestDigest ||
          state.authorization.payload.candidateDigest !== state.candidateDigest ||
          state.authorization.payload.oldTargetDigest !== state.oldDigest ||
          state.authorization.payload.inventoryDigest !== state.inventoryDigest ||
          state.authorization.payload.canaryDigest !== state.canaryDigest ||
          !/^[a-f0-9]{64}$/.test(state.inventoryDigest) ||
          !/^[a-f0-9]{64}$/.test(state.canaryDigest)
        )
          throw new Error();
        const expectedSignature = createHmac('sha256', secureRead(options.keyPath))
          .update(canonicalJson(state.authorization.payload))
          .digest();
        if (
          typeof state.authorization.signature !== 'string' ||
          !/^[a-f0-9]{64}$/.test(state.authorization.signature) ||
          !timingSafeEqual(Buffer.from(state.authorization.signature, 'hex'), expectedSignature)
        )
          throw new Error();
      } catch {
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      }
      try {
        exactKeys(state.candidateDescriptor, ['dev', 'ino', 'digest', 'birthtimeNs']);
        if (
          !Number.isSafeInteger(state.candidateDescriptor.dev) ||
          !Number.isSafeInteger(state.candidateDescriptor.ino) ||
          !/^\d+$/.test(state.candidateDescriptor.birthtimeNs) ||
          state.candidateDescriptor.digest !== state.candidateDigest
        )
          throw new Error();
      } catch {
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      }
      const candidateProof = `${state.stagedPath}.preparation-${state.candidateDigest}`;
      if (
        !existsSync(candidateProof) ||
        !descriptorStillCurrent(candidateProof, state.candidateDescriptor) ||
        lstatSync(candidateProof).nlink !== 2
      )
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
      // Recovery is bound to the signed raw M0 digest and complete M0 entry
      // snapshot below. It must not reinterpret the transaction through a
      // later same-ID M1 manifest or wedge until an operator restores M0.
      const entry = state.entrySnapshot;
      if (state.backupDescriptor !== null) {
        try {
          exactKeys(state.backupDescriptor, ['dev', 'ino', 'birthtimeNs', 'size', 'digest']);
          if (
            !Number.isSafeInteger(state.backupDescriptor.dev) ||
            !Number.isSafeInteger(state.backupDescriptor.ino) ||
            !/^\d+$/.test(state.backupDescriptor.birthtimeNs) ||
            !Number.isSafeInteger(state.backupDescriptor.size) ||
            !/^[a-f0-9]{64}$/.test(state.backupDescriptor.digest)
          )
            throw new Error();
        } catch {
          throw new Error('INVALID_ACTIVATION_JOURNAL');
        }
      }
      if (
        state.hadTarget &&
        allowed.indexOf(state.phase) >= allowed.indexOf('BACKUP_CREATED') &&
        (!state.backupDescriptor ||
          state.backupDescriptor.digest !== state.oldDigest ||
          state.backupDescriptor.size <= 0)
      )
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      try {
        exactKeys(entry, CLAUDE_ENTRY_KEYS);
        if (entry.provider !== 'claude' || entry.id !== state.entryId || entry.authFilename !== state.authFilename)
          throw new Error('INVALID_ACTIVATION_JOURNAL');
        normalizeEmail(entry.email);
        for (const field of ['organizationUuid', 'organizationName', 'accountOwner']) nonempty(entry[field]);
      } catch {
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      }
      const expectedStaged = entry && join(options.stagingDir, entry.authFilename);
      const expectedTarget = entry && join(options.activeDir, entry.authFilename);
      const expectedBackup =
        entry &&
        join(
          options.rollbackDir,
          `${entry.authFilename}.${state.approvalId}.${state.approvalNonce}.${state.candidateDigest}.${state.oldDigest || 'none'}.bak`,
        );
      const expectedRestore = state.restorePath ? `${expectedStaged}.preparation-${state.oldDigest}` : null;
      if (
        !entry ||
        state.authFilename !== entry.authFilename ||
        state.stagedPath !== expectedStaged ||
        state.target !== expectedTarget ||
        state.backup !== expectedBackup ||
        state.restorePath !== expectedRestore
      )
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      const targetDescriptor = existsSync(state.target) ? secureReadDescriptor(state.target, false) : null;
      const targetHasNew =
        targetDescriptor &&
        targetDescriptor.dev === state.candidateDescriptor.dev &&
        targetDescriptor.ino === state.candidateDescriptor.ino &&
        targetDescriptor.birthtimeNs === state.candidateDescriptor.birthtimeNs &&
        targetDescriptor.digest === state.candidateDigest;
      const marker = join(options.usageDir, `${state.approvalId}.${state.approvalNonce}.used`);
      // consumeApproval publishes through one expected temp hardlink. A crash
      // after link(2) may leave nlink=2; remove only the uniquely inode-matched
      // expected temp after the signed journal has authenticated every path.
      fsyncDirectory(options.usageDir);
      validatePathTopology({
        configPath: options.configPath,
        config: {
          manifestPath: options.manifestPath,
          approvalKeyPath: options.keyPath,
          usageDir: options.usageDir,
          stagingDir: options.stagingDir,
          activeDir: options.activeDir,
          quarantineDirs: options.quarantineDirs,
          rollbackDir: options.rollbackDir,
          operationLockPath: options.operationLockPath,
        },
        entry,
        approvalId: { id: state.approvalId, nonce: state.approvalNonce },
        computedPaths: [
          ['backup target', state.backup, options.rollbackDir, true],
          ...(state.restorePath ? [['restore target', state.restorePath, options.stagingDir, true]] : []),
        ],
      });
      const markerRequired = allowed.indexOf(state.phase) >= allowed.indexOf('APPROVAL_CONSUMED');
      if (markerRequired || (state.phase === 'APPROVAL_INTENT' && existsSync(marker))) {
        try {
          if (!existsSync(marker)) throw new Error('MISSING_USE_MARKER');
          validateUseMarker(marker, options.keyPath, {
            approvalId: state.approvalId,
            nonce: state.approvalNonce,
            action: 'canonical-switch',
          });
        } catch {
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        }
        fsyncDirectory(options.usageDir);
      } else if (state.phase === 'APPROVAL_INTENT') {
        fsyncDirectory(options.usageDir);
      }
      if (state.phase === 'COMMITTED') {
        if (!targetHasNew || !descriptorStillCurrent(state.target, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        retainCommittedRollback(options, state);
        if (!descriptorStillCurrent(state.target, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'committed' };
      }
      if (state.phase === 'PREPARING' && state.hadTarget && !existsSync(state.backup)) {
        if (!existsSync(state.target) || !descriptorStillCurrent(state.target, state.backupDescriptor) || targetHasNew)
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || !descriptorStillCurrent(state.stagedPath, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        // PREPARING is always pre-backup. Remove partial/full backup
        // idempotently and prove every mutation directory durable first.
        removePreparingBackup(state);
        fsyncDirectory(options.activeDir);
        fsyncDirectory(options.stagingDir);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
      }
      if (state.phase === 'PREPARING') {
        if (state.hadTarget) {
          if (
            !existsSync(state.target) ||
            !descriptorStillCurrent(state.target, state.backupDescriptor) ||
            targetHasNew
          )
            throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        } else if (existsSync(state.target)) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || !descriptorStillCurrent(state.stagedPath, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removePreparingBackup(state);
        fsyncDirectory(options.activeDir);
        fsyncDirectory(options.stagingDir);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
      }
      if (state.phase === 'BACKUP_CREATE_INTENT') {
        if (
          !state.hadTarget ||
          !existsSync(state.target) ||
          !descriptorStillCurrent(state.target, state.backupDescriptor)
        )
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || !descriptorStillCurrent(state.stagedPath, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removePreparingBackup(state);
        fsyncDirectory(options.activeDir);
        fsyncDirectory(options.stagingDir);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
      }
      if (state.phase === 'BACKUP_CREATED') {
        if (
          !state.hadTarget ||
          !existsSync(state.target) ||
          !descriptorStillCurrent(state.target, state.backupDescriptor)
        )
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || !descriptorStillCurrent(state.stagedPath, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (state.phase === 'BACKUP_CREATED' && !descriptorStillCurrent(state.backup, state.backupDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removePreparingBackup(state);
        fsyncDirectory(options.activeDir);
        fsyncDirectory(options.stagingDir);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
      }
      if (targetHasNew) {
        if (existsSync(state.stagedPath)) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!descriptorStillCurrent(state.target, state.candidateDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        renameSync(state.target, state.stagedPath);
        if (
          process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
          process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:RECOVERY_ROLLBACK_RENAMED'
        )
          process.kill(process.pid, 'SIGKILL');
      }
      if (state.hadTarget) {
        const targetHasOld = existsSync(state.target) && descriptorStillCurrent(state.target, state.backupDescriptor);
        if (!targetHasOld) {
          if (existsSync(state.target)) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
          if (!existsSync(state.backup) || !descriptorStillCurrent(state.backup, state.backupDescriptor))
            throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
          restoreBackup(
            state.backup,
            state.target,
            dirname(state.target),
            state.restorePath,
            state.backupDescriptor,
            state.oldDigest,
          );
        }
        if (!existsSync(state.target) || !descriptorStillCurrent(state.target, state.backupDescriptor))
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removeCommittedBackup(state);
      } else if (existsSync(state.target)) {
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
      }
      if (!existsSync(state.stagedPath) || !descriptorStillCurrent(state.stagedPath, state.candidateDescriptor))
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
      // Prove both mutation directories durable on every non-PREPARING
      // rollback recovery, including an invocation that found no rename to do.
      fsyncDirectory(options.activeDir);
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:RECOVERY_ROLLBACK_FIRST_DIR_FSYNC'
      )
        process.kill(process.pid, 'SIGKILL');
      fsyncDirectory(options.stagingDir);
      removeJournal(options);
      return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
    },
    { allowJournal: true },
  );
}

function rollbackIntentPath(recordPath) {
  return `${recordPath}.intent`;
}

function writeRollbackIntent(path, payload, key) {
  const bytes = `${canonicalJson(signedRecord(payload, key))}\n`;
  if (existsSync(path)) {
    const prior = secureReadDescriptor(path, false);
    removeDescriptorSafely(path, prior, 'ROLLBACK_RECOVERY_UNCERTAIN');
  }
  durableExclusive(path, bytes);
  fsyncDirectory(dirname(path));
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === `SIGKILL:ROLLBACK_${payload.phase}_INTENT`
  )
    process.kill(process.pid, 'SIGKILL');
  return payload;
}

function recoverRollbackIntent(options, entry, recordPath) {
  const intentPath = rollbackIntentPath(recordPath);
  if (!existsSync(intentPath)) return null;
  const key = secureRead(options.keyPath);
  const intent = verifySignedRecord(secureRead(intentPath), key, 'INVALID_ROLLBACK_INTENT');
  exactKeys(intent, [
    'version',
    'phase',
    'operationId',
    'recordPath',
    'recordDigest',
    'retained',
    'approval',
    'approvalDigest',
    'target',
    'backup',
    'candidateDescriptor',
    'backupDescriptor',
    'manifestDigest',
    'entrySnapshot',
    'destination',
    'tempPath',
  ]);
  if (
    intent.version !== 1 ||
    !['PREPARING', 'SWITCHED'].includes(intent.phase) ||
    !/^[0-9a-f-]{36}$/.test(intent.operationId) ||
    intent.recordPath !== recordPath ||
    intent.target !== join(options.activeDir, entry.authFilename) ||
    intent.backup !== intent.retained?.backup ||
    intent.destination !== entry.authFilename ||
    intent.manifestDigest !== intent.retained?.manifestDigest ||
    canonicalJson(intent.entrySnapshot) !== canonicalJson(entry) ||
    canonicalJson(intent.retained?.entrySnapshot) !== canonicalJson(entry) ||
    intent.tempPath !== join(options.activeDir, `.${entry.authFilename}.${intent.operationId}.rollback`) ||
    intent.recordDigest !== sha256(Buffer.from(`${canonicalJson(signedRecord(intent.retained, key))}\n`)) ||
    intent.approvalDigest !== sha256(Buffer.from(canonicalJson(intent.approval)))
  )
    throw new Error('INVALID_ROLLBACK_INTENT');
  const p = intent.approval?.payload;
  try {
    exactKeys(intent.approval, ['payload', 'signature']);
    if (
      p.action !== 'canonical-rollback' ||
      p.manifestDigest !== intent.manifestDigest ||
      p.manifestEntryId !== entry.id ||
      p.candidateDigest !== intent.retained.candidateDigest ||
      p.oldBackupDigest !== intent.retained.oldDigest ||
      p.recordDigest !== intent.recordDigest ||
      p.destination !== intent.destination
    )
      throw new Error();
    const signature = createHmac('sha256', key).update(canonicalJson(p)).digest();
    if (
      !/^[a-f0-9]{64}$/.test(intent.approval.signature) ||
      !timingSafeEqual(Buffer.from(intent.approval.signature, 'hex'), signature)
    )
      throw new Error();
  } catch {
    throw new Error('INVALID_ROLLBACK_INTENT');
  }
  if (existsSync(recordPath) && sha256(secureRead(recordPath)) !== intent.recordDigest)
    throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
  const marker = join(options.usageDir, `${p.id}.${p.nonce}.used`);
  if (existsSync(marker))
    validateUseMarker(marker, options.keyPath, { approvalId: p.id, nonce: p.nonce, action: p.action });
  else consumeApproval(p, options.usageDir, options.keyPath);

  const targetIsCandidate =
    existsSync(intent.target) && descriptorStillCurrent(intent.target, intent.candidateDescriptor);
  const targetIsBackup = existsSync(intent.target) && descriptorStillCurrent(intent.target, intent.backupDescriptor);
  const restorePath = intent.retained?.restorePath;
  if (restorePath && existsSync(intent.backup)) {
    if (existsSync(restorePath) || !descriptorStillCurrent(intent.backup, intent.backupDescriptor))
      throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
    renameSync(intent.backup, restorePath);
    fsyncDirectory(options.rollbackDir);
    fsyncDirectory(options.stagingDir);
  }
  const backupSource = restorePath || intent.backup;
  const backupExact = existsSync(backupSource) && descriptorStillCurrent(backupSource, intent.backupDescriptor);
  const tempExact = existsSync(intent.tempPath) && descriptorStillCurrent(intent.tempPath, intent.backupDescriptor);
  if (intent.phase === 'PREPARING') {
    if (targetIsCandidate && backupExact) {
      if (!tempExact) {
        if (existsSync(intent.tempPath)) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
        linkSync(backupSource, intent.tempPath);
        if (
          process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
          process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:ROLLBACK_TEMP_LINK'
        )
          process.kill(process.pid, 'SIGKILL');
        fsyncDirectory(options.activeDir);
      }
      if (
        !descriptorStillCurrent(intent.target, intent.candidateDescriptor) ||
        !descriptorStillCurrent(intent.tempPath, intent.backupDescriptor)
      )
        throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
      renameSync(intent.tempPath, intent.target);
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:ROLLBACK_SWITCH'
      )
        process.kill(process.pid, 'SIGKILL');
      fsyncDirectory(options.activeDir);
    } else if (!(targetIsBackup && !existsSync(intent.tempPath))) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
    // Keep PREPARING as the durable recovery anchor. Target/temp topology
    // distinguishes a completed switch without replacing the sole intent.
  } else if (!targetIsBackup || existsSync(intent.tempPath)) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
  if (!descriptorStillCurrent(intent.target, intent.backupDescriptor)) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
  fsyncDirectory(options.activeDir);
  if (existsSync(intent.backup)) {
    if (!descriptorStillCurrent(intent.backup, intent.backupDescriptor)) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
    removeDescriptorSafely(intent.backup, intent.backupDescriptor, 'ROLLBACK_RECOVERY_UNCERTAIN');
    fsyncDirectory(options.rollbackDir);
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:ROLLBACK_CLEANUP'
    )
      process.kill(process.pid, 'SIGKILL');
  }
  if (existsSync(recordPath)) {
    if (sha256(secureRead(recordPath)) !== intent.recordDigest) throw new Error('ROLLBACK_RECOVERY_UNCERTAIN');
    const recordDescriptor = secureReadDescriptor(recordPath);
    removeDescriptorSafely(recordPath, recordDescriptor, 'ROLLBACK_RECOVERY_UNCERTAIN');
    fsyncDirectory(options.rollbackDir);
  }
  const intentDescriptor = secureReadDescriptor(intentPath);
  removeDescriptorSafely(intentPath, intentDescriptor, 'ROLLBACK_RECOVERY_UNCERTAIN');
  fsyncDirectory(options.rollbackDir);
  return {
    ok: true,
    action: 'rollback',
    recovered: true,
    manifestEntryId: entry.id,
    restoredDigest: intent.retained.oldDigest,
  };
}

export function rollbackEnrollment(options) {
  if (!options?.configPath || !options?.entryId || !options?.approvalPath) throw new Error('INVALID_ARGUMENTS');
  options = optionsFromConfig(options);
  options.now ??= Date.now();
  return withOperationLock(options.operationLockPath, options.keyPath, () => {
    const manifest = readManifest(options.manifestPath);
    const entry = manifest.manifest.entries.find((candidate) => candidate.id === options.entryId);
    if (!entry || entry.provider !== 'claude') throw new Error('ENTRY_NOT_CLAUDE');
    const path = rollbackRecordPath(options, entry);
    const recovered = recoverRollbackIntent(options, entry, path);
    if (recovered) return recovered;
    if (!existsSync(path)) throw new Error('ROLLBACK_RECORD_NOT_FOUND');
    const state = verifySignedRecord(secureRead(path), secureRead(options.keyPath), 'INVALID_ROLLBACK_RECORD');
    if (
      state.phase !== 'RETAINED' ||
      state.manifestDigest !== manifest.digest ||
      state.entryId !== entry.id ||
      canonicalJson(state.entrySnapshot) !== canonicalJson(entry) ||
      state.target !== join(options.activeDir, entry.authFilename) ||
      state.backup !==
        join(
          options.rollbackDir,
          `${entry.authFilename}.${state.approvalId}.${state.approvalNonce}.${state.candidateDigest}.${state.oldDigest}.bak`,
        ) ||
      !state.hadTarget ||
      state.oldDigest !== state.backupDescriptor?.digest ||
      state.candidateDigest !== state.candidateDescriptor?.digest ||
      !descriptorStillCurrent(state.target, state.candidateDescriptor) ||
      !descriptorStillCurrent(state.backup, state.backupDescriptor)
    )
      throw new Error('INVALID_ROLLBACK_RECORD');
    const recordDigest = sha256(secureRead(path));
    const rollbackApproval = readArtifact(options.approvalPath);
    const rollbackKeys = [
      'version',
      'id',
      'nonce',
      'action',
      'manifestDigest',
      'manifestEntryId',
      'email',
      'organizationUuid',
      'organizationName',
      'accountOwner',
      'authorizedOperator',
      'environment',
      'issuedAt',
      'expiresAt',
      'candidateDigest',
      'oldBackupDigest',
      'recordDigest',
      'destination',
    ];
    exactKeys(rollbackApproval, ['payload', 'signature']);
    exactKeys(rollbackApproval.payload, rollbackKeys);
    const p = rollbackApproval.payload;
    const issued = parseRfc3339(p.issuedAt);
    const expires = parseRfc3339(p.expiresAt);
    const expected = {
      action: 'canonical-rollback',
      manifestDigest: manifest.digest,
      manifestEntryId: entry.id,
      email: entry.email,
      organizationUuid: entry.organizationUuid,
      organizationName: entry.organizationName,
      accountOwner: entry.accountOwner,
      authorizedOperator: options.operator,
      environment: options.environment,
      candidateDigest: state.candidateDigest,
      oldBackupDigest: state.oldDigest,
      recordDigest,
      destination: entry.authFilename,
    };
    if (
      p.version !== 1 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(p.id || '') ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(p.nonce || '') ||
      issued === null ||
      expires === null ||
      issued > options.now ||
      expires <= options.now ||
      expires <= issued ||
      expires - issued > options.maxTtlMs ||
      Object.entries(expected).some(([key, value]) => p[key] !== value)
    )
      throw new Error('INVALID_ROLLBACK_APPROVAL');
    const signature = createHmac('sha256', secureRead(options.keyPath)).update(canonicalJson(p)).digest();
    if (
      !/^[a-f0-9]{64}$/.test(rollbackApproval.signature || '') ||
      !timingSafeEqual(Buffer.from(rollbackApproval.signature, 'hex'), signature)
    )
      throw new Error('INVALID_ROLLBACK_APPROVAL');
    const operationId = randomUUID();
    const intentPath = rollbackIntentPath(path);
    writeRollbackIntent(
      intentPath,
      {
        version: 1,
        phase: 'PREPARING',
        operationId,
        recordPath: path,
        recordDigest,
        retained: state,
        approval: rollbackApproval,
        approvalDigest: sha256(Buffer.from(canonicalJson(rollbackApproval))),
        target: state.target,
        backup: state.backup,
        candidateDescriptor: state.candidateDescriptor,
        backupDescriptor: state.backupDescriptor,
        manifestDigest: manifest.digest,
        entrySnapshot: entry,
        destination: entry.authFilename,
        tempPath: join(options.activeDir, `.${entry.authFilename}.${operationId}.rollback`),
      },
      secureRead(options.keyPath),
    );
    return recoverRollbackIntent(options, entry, path);
  });
}

export function readDeploymentConfig(path) {
  if (!isAbsolute(path)) throw new Error('INVALID_CONFIG');
  assertCanonicalExisting(path);
  assertOwnerOnly(path, 'file');
  let config;
  try {
    config = parseStrictJson(secureRead(path), 'INVALID_CONFIG');
  } catch {
    throw new Error('INVALID_CONFIG');
  }
  exactKeys(config, CONFIG_KEYS);
  if (
    !Number.isFinite(config.maxApprovalTtlMs) ||
    config.maxApprovalTtlMs <= 0 ||
    config.maxApprovalTtlMs > DEFAULT_MAX_TTL_MS
  )
    throw new Error('INVALID_TTL');
  for (const key of [
    'manifestPath',
    'approvalKeyPath',
    'usageDir',
    'stagingDir',
    'activeDir',
    'rollbackDir',
    'operationLockPath',
    'environment',
    'authorizedOperator',
    'runtimeInventoryPath',
    'runtimeInventoryDigest',
    'authoritativeConsumerInventoryPath',
    'authoritativeConsumerInventoryDigest',
    'deploymentPlanDigest',
  ])
    nonempty(config[key]);
  if (!Array.isArray(config.quarantineDirs) || !config.quarantineDirs.length) throw new Error('INVALID_CONFIG');
  config.quarantineDirs.forEach(nonempty);
  const pathKeys = [
    'manifestPath',
    'approvalKeyPath',
    'usageDir',
    'stagingDir',
    'activeDir',
    'rollbackDir',
    'operationLockPath',
    'runtimeInventoryPath',
    'authoritativeConsumerInventoryPath',
  ];
  if ([...pathKeys.map((key) => config[key]), ...config.quarantineDirs].some((item) => !isAbsolute(item)))
    throw new Error('INVALID_CONFIG');
  if (
    !/^[a-f0-9]{64}$/.test(config.runtimeInventoryDigest) ||
    !/^[a-f0-9]{64}$/.test(config.authoritativeConsumerInventoryDigest) ||
    !/^[a-f0-9]{64}$/.test(config.deploymentPlanDigest)
  )
    throw new Error('INVALID_CONFIG');
  validatePathTopology({ configPath: path, config });
  return config;
}

function optionsFromConfig(options) {
  if (!options.configPath) return options;
  const config = readDeploymentConfig(options.configPath);
  return {
    ...options,
    manifestPath: config.manifestPath,
    keyPath: config.approvalKeyPath,
    usageDir: config.usageDir,
    stagingDir: config.stagingDir,
    activeDir: config.activeDir,
    quarantineDirs: config.quarantineDirs,
    rollbackDir: config.rollbackDir,
    operationLockPath: config.operationLockPath,
    environment: config.environment,
    operator: config.authorizedOperator,
    maxTtlMs: config.maxApprovalTtlMs,
    authoritativeConsumerInventoryPath: config.authoritativeConsumerInventoryPath,
    authoritativeConsumerInventoryDigest: config.authoritativeConsumerInventoryDigest,
  };
}

function cliOptions(argv, command) {
  const allowed = new Set([
    'config',
    ...(command === 'recover' ? [] : ['entry']),
    ...(['stage', 'activate', 'rollback'].includes(command) ? ['approval'] : []),
    ...(command === 'stage' ? ['candidate'] : []),
    ...(command === 'activate' ? ['inventory', 'canary'] : []),
  ]);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    if (
      !arg?.startsWith('--') ||
      !allowed.has(arg.slice(2)) ||
      argv[i + 1] === undefined ||
      out[arg.slice(2)] !== undefined
    )
      throw new Error('INVALID_ARGUMENTS');
    out[arg.slice(2)] = argv[i + 1];
  }
  if (
    !out.config ||
    (!['recover', 'rollback'].includes(command) && (!out.entry || !out.approval)) ||
    (command === 'rollback' && (!out.entry || !out.approval)) ||
    (command === 'stage' && !out.candidate) ||
    (command === 'activate' && (!out.inventory || !out.canary))
  )
    throw new Error('INVALID_ARGUMENTS');
  return out;
}

function runCli() {
  const [command, ...argv] = process.argv.slice(2);
  if (!['stage', 'activate', 'recover', 'rollback'].includes(command)) throw new Error('INVALID_ARGUMENTS');
  const args = cliOptions(argv, command);
  const config = readDeploymentConfig(args.config);
  const common = {
    manifestPath: config.manifestPath,
    keyPath: config.approvalKeyPath,
    usageDir: config.usageDir,
    stagingDir: config.stagingDir,
    activeDir: config.activeDir,
    quarantineDirs: config.quarantineDirs,
    rollbackDir: config.rollbackDir,
    operationLockPath: config.operationLockPath,
    environment: config.environment,
    operator: config.authorizedOperator,
    maxTtlMs: config.maxApprovalTtlMs,
    entryId: args.entry,
    approvalPath: args.approval,
  };
  const receipt =
    command === 'stage'
      ? stageEnrollment({ configPath: args.config, ...common, candidatePath: args.candidate })
      : command === 'activate'
        ? activateEnrollment({
            configPath: args.config,
            ...common,
            inventoryPath: args.inventory,
            canaryPath: args.canary,
          })
        : command === 'recover'
          ? recoverEnrollment({ configPath: args.config, ...common })
          : rollbackEnrollment({ configPath: args.config, ...common });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    const allowed = new Set([
      'INVALID_ARGUMENTS',
      'INVALID_CONFIG',
      'INVALID_TTL',
      'MISSING_TRUST_ROOT',
      'INSECURE_TRUST_ROOT',
      'OPERATION_LOCKED',
      'OPERATION_LOCKED_MALFORMED',
      'PENDING_ACTIVATION_JOURNAL',
      'INVALID_MANIFEST',
      'INVALID_SCHEMA',
      'INVALID_PROVIDER',
      'PROVIDER_FILENAME_MISMATCH',
      'DUPLICATE_MANIFEST_BINDING',
      'DUPLICATE_CLAUDE_IDENTITY',
      'INVALID_PROVIDER_COUNTS',
      'ENTRY_NOT_CLAUDE',
      'INVALID_CANDIDATE',
      'INVALID_VALUE',
      'INVALID_EMAIL',
      'INVALID_FILENAME',
      'IDENTITY_MISMATCH',
      'INVALID_EXPIRY',
      'INVALID_APPROVAL',
      'INVALID_APPROVAL_CLOCK',
      'APPROVAL_BINDING_MISMATCH',
      'APPROVAL_KEY_TOO_SHORT',
      'INVALID_SIGNATURE',
      'APPROVAL_REPLAY',
      'APPROVAL_CONSUME_FAILED',
      'UNSAFE_INVENTORY',
      'MALFORMED_INVENTORY',
      'AMBIGUOUS_INVENTORY',
      'DUPLICATE_IDENTITY',
      'STAGE_TARGET_EXISTS',
      'CROSS_FILESYSTEM',
      'MANIFEST_CAS_FAILED',
      'ACTIVATION_ROLLED_BACK',
      'ACTIVATION_ROLLBACK_FAILED',
      'INVALID_ACTIVE_TARGET',
      'ACTIVE_TARGET_IDENTITY_MISMATCH',
      'INVALID_ACTIVATION_JOURNAL',
      'ACTIVATION_RECOVERY_UNCERTAIN',
      'ROLLBACK_RECORD_EXISTS',
      'ROLLBACK_RECORD_NOT_FOUND',
      'INVALID_ROLLBACK_RECORD',
      'ROLLBACK_RECOVERY_UNCERTAIN',
    ]);
    const code = allowed.has(error?.message) ? error.message : 'OPERATION_REFUSED';
    process.stderr.write(`staged enrollment refused: ${code}\n`);
    process.exitCode = 1;
  }
}
