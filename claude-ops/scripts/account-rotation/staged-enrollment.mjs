#!/usr/bin/env node
/** Fail-closed, offline staging and activation for Claude CLIProxyAPI auth files. */
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
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
  rmSync,
  statSync,
  unlinkSync,
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
  'writersQuiesced',
];
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

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
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

function assertOwnerOnly(path, kind) {
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
    (kind === 'file' && st.nlink !== 1)
  ) {
    throw new Error('INSECURE_TRUST_ROOT');
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
  while (ancestor !== dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (st.isSymbolicLink()) throw new Error('INSECURE_TRUST_ROOT');
    ancestor = dirname(ancestor);
  }
  return physical;
}

function secureReadDescriptor(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const st = fstatSync(fd);
    const fst = lstatSync(path);
    if (!st.isFile() || !fst.isFile() || st.dev !== fst.dev || st.ino !== fst.ino || st.nlink !== 1) throw new Error();
    const bytes = readFileSync(fd);
    return { bytes, digest: sha256(bytes), dev: st.dev, ino: st.ino };
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
    const current = secureReadDescriptor(path);
    return current.dev === descriptor.dev && current.ino === descriptor.ino && current.digest === descriptor.digest;
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
export function validatePathTopology({ configPath, config, approvalPath, candidatePath, entry, approvalId }) {
  const roots = [config.usageDir, config.stagingDir, config.activeDir, config.rollbackDir, ...config.quarantineDirs];
  const fileRoles = [
    ['config', configPath, true],
    ['manifest', config.manifestPath, true],
    ['key', config.approvalKeyPath, true],
    ['approval', approvalPath, Boolean(approvalPath)],
    ['candidate', candidatePath, Boolean(candidatePath)],
  ].filter(([, path]) => path);
  const leafRoles = [
    ['lock', config.operationLockPath, dirname(config.operationLockPath)],
    ['recovery claim', `${config.operationLockPath}.recovery-claim`, dirname(config.operationLockPath)],
    ['journal', `${config.operationLockPath}.journal`, dirname(config.operationLockPath)],
    ...(entry
      ? [
          ['staged target', join(config.stagingDir, entry.authFilename), config.stagingDir],
          ['active target', join(config.activeDir, entry.authFilename), config.activeDir],
          ...(approvalId
            ? [['usage marker', join(config.usageDir, `${approvalId.id}.${approvalId.nonce}.used`), config.usageDir]]
            : []),
          ...(approvalId
            ? [
                [
                  'backup target',
                  join(config.rollbackDir, `${entry.authFilename}.${approvalId.id}.bak`),
                  config.rollbackDir,
                ],
              ]
            : []),
        ]
      : []),
  ];
  for (const [role, path] of [...fileRoles, ...leafRoles]) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('INVALID_CONFIG');
  }
  for (const [, path] of fileRoles) {
    assertCanonicalExisting(path);
    assertOwnerOnly(path, 'file');
  }
  for (const [role, path, parent] of leafRoles) {
    if (!containsPath(parent, path) || dirname(path) !== parent) throw new Error('INVALID_CONFIG');
    assertCanonicalLeaf(path);
    if (existsSync(path)) assertOwnerOnly(path, 'file');
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
  const existing = [...trustPaths, lockRoot, ...physicalRoots, ...leafRoles.map(([, path]) => path).filter(existsSync)];
  const inodes = existing.map((path) => {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  });
  if (new Set(inodes).size !== inodes.length) throw new Error('INVALID_CONFIG');
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
    action: fields.action,
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
    candidateDigest: fields.action === 'activate' ? fields.candidateDigest : null,
    writersQuiesced: fields.action === 'activate' ? fields.writersQuiesced : null,
  };
}

export function verifyApproval({ artifact, keyPath, expected, now = Date.now(), maxTtlMs = DEFAULT_MAX_TTL_MS }) {
  if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0 || maxTtlMs > DEFAULT_MAX_TTL_MS) throw new Error('INVALID_TTL');
  exactKeys(artifact, ['payload', 'signature']);
  exactKeys(artifact.payload, APPROVAL_KEYS);
  const p = artifact.payload;
  if (p.version !== APPROVAL_VERSION || !['stage', 'activate'].includes(p.action)) throw new Error('INVALID_APPROVAL');
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
  if (p.action === 'stage' && (p.candidateDigest !== null || p.writersQuiesced !== null))
    throw new Error('INVALID_APPROVAL');
  if (p.action === 'activate' && (!/^[a-f0-9]{64}$/.test(p.candidateDigest) || p.writersQuiesced !== true))
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
  const temp = join(usageDir, `.${basename(marker)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let linked = false;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const markerPayload = { version: 1, approvalId: payload.id, nonce: payload.nonce, action: payload.action };
    const markerBytes = keyPath
      ? `${canonicalJson(signedRecord(markerPayload, secureRead(keyPath)))}\n`
      : `${payload.action}\n`;
    writeFileSync(fd, markerBytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, marker);
    linked = true;
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
    unlinkSync(temp);
    fsyncDirectory(usageDir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    if (linked) {
      try {
        if (
          process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
          process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:MARKER_CLEANUP_UNCERTAIN'
        )
          throw new Error('INJECTED_MARKER_CLEANUP_FAILURE');
        unlinkSync(marker);
        fsyncDirectory(usageDir);
      } catch {
        // The authenticated marker may be durable. Fail closed as consumed.
        throw new Error('APPROVAL_CONSUME_RECOVERY_REQUIRED');
      }
    }
    if (error?.code === 'EEXIST') throw new Error('APPROVAL_REPLAY');
    throw new Error('APPROVAL_CONSUME_FAILED');
  }
}

function publicationPath(options) {
  return `${options.operationLockPath}.publication`;
}

function removeDurably(path) {
  if (
    path.endsWith('.publication') &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:PUBLICATION_CLEANUP_FSYNC'
  )
    throw new Error('PUBLICATION_RECOVERY_REQUIRED');
  if (existsSync(path)) unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function removePublicationTempLink(path) {
  if (!existsSync(path)) return;
  const targetStat = lstatSync(path);
  if (!targetStat.isFile() || targetStat.nlink === 1) return;
  const prefix = `.${basename(path)}.`;
  const aliases = readdirSync(dirname(path)).filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
    const stat = lstatSync(join(dirname(path), name));
    return stat.isFile() && stat.dev === targetStat.dev && stat.ino === targetStat.ino;
  });
  if (targetStat.nlink !== 2 || aliases.length !== 1) throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
  unlinkSync(join(dirname(path), aliases[0]));
  fsyncDirectory(dirname(path));
}

function recoverPublication(options) {
  const path = publicationPath(options);
  if (!existsSync(path)) return false;
  const record = verifySignedRecord(secureRead(path), secureRead(options.keyPath), 'INVALID_PUBLICATION_RECORD');
  exactKeys(record, ['version', 'kind', 'stagedPath', 'stagingDigest', 'markerPath', 'approvalId', 'approvalNonce']);
  if (record.version !== 1 || record.kind !== 'stage') throw new Error('INVALID_PUBLICATION_RECORD');
  for (const key of ['stagedPath', 'stagingDigest', 'markerPath', 'approvalId', 'approvalNonce']) nonempty(record[key]);
  assertCanonicalLeaf(record.stagedPath);
  assertCanonicalLeaf(record.markerPath);
  if (!containsPath(options.stagingDir, record.stagedPath) || !containsPath(options.usageDir, record.markerPath))
    throw new Error('INVALID_PUBLICATION_RECORD');
  removePublicationTempLink(record.stagedPath);
  removePublicationTempLink(record.markerPath);
  const markerExists = existsSync(record.markerPath);
  if (markerExists) {
    validateUseMarker(record.markerPath, options.keyPath, {
      approvalId: record.approvalId,
      nonce: record.approvalNonce,
      action: 'stage',
    });
    // The durable use marker is authoritative evidence. Keep any successfully
    // published staged bytes; absence means the operation rolled back consumed.
    if (existsSync(record.stagedPath) && sha256(secureRead(record.stagedPath)) !== record.stagingDigest)
      throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    fsyncDirectory(options.usageDir);
    if (existsSync(record.stagedPath)) fsyncDirectory(options.stagingDir);
  } else if (existsSync(record.stagedPath)) {
    if (sha256(secureRead(record.stagedPath)) !== record.stagingDigest)
      throw new Error('PUBLICATION_RECOVERY_UNCERTAIN');
    unlinkSync(record.stagedPath);
    fsyncDirectory(options.stagingDir);
  }
  if (!markerExists) fsyncDirectory(options.usageDir);
  removeDurably(path);
  return true;
}

function beginPublication(options, payload, stagedPath, digest) {
  const markerPath = join(options.usageDir, `${payload.id}.${payload.nonce}.used`);
  const record = {
    version: 1,
    kind: 'stage',
    stagedPath,
    stagingDigest: digest,
    markerPath,
    approvalId: payload.id,
    approvalNonce: payload.nonce,
  };
  durableExclusive(publicationPath(options), `${canonicalJson(signedRecord(record, secureRead(options.keyPath)))}\n`);
  if (
    process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
    process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'THROW:PUBLICATION_FIRST_DIR_FSYNC'
  )
    throw new Error('PUBLICATION_RECOVERY_REQUIRED');
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
          value = parseStrictJson(secureRead(path), 'MALFORMED_INVENTORY');
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

function binding(entry, manifestDigest, action, candidateDigest, environment, operator) {
  return {
    action,
    manifestDigest,
    manifestEntryId: entry.id,
    provider: 'claude',
    email: entry.email,
    organizationUuid: entry.organizationUuid,
    organizationName: entry.organizationName,
    accountOwner: entry.accountOwner,
    authorizedOperator: operator,
    environment,
    candidateDigest: action === 'activate' ? candidateDigest : null,
    writersQuiesced: action === 'activate' ? true : null,
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
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
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
    durableExclusive(claim, `${canonicalJson(signedRecord(mine, key))}\n`);
    return mine;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('OPERATION_LOCKED');
  }
  let stale;
  try {
    assertOwnerOnly(claim, 'file');
    stale = verifySignedRecord(secureRead(claim), key, 'RECOVERY_CLAIM_MALFORMED');
    exactKeys(stale, ['version', 'host', 'pid', 'nonce', 'lockNonce', 'createdAt']);
    // Authenticate and validate the claimant independently from the lock it
    // originally observed. A dead same-host claimant can outlive that lock;
    // its older nonce must not permanently wedge a later dead-holder reclaim.
    validateProcessRecord(stale, 'RECOVERY_CLAIM_MALFORMED');
    if (typeof stale.lockNonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(stale.lockNonce))
      throw new Error('RECOVERY_CLAIM_MALFORMED');
    if (stale.host !== hostname() || pidAlive(stale.pid)) throw new Error('OPERATION_LOCKED');
    const current = verifySignedRecord(secureRead(claim), key, 'RECOVERY_CLAIM_MALFORMED');
    if (canonicalJson(current) !== canonicalJson(stale)) throw new Error('OPERATION_LOCKED');
    unlinkSync(claim);
    fsyncDirectory(dirname(claim));
    mine = claimPayload();
    durableExclusive(claim, `${canonicalJson(signedRecord(mine, key))}\n`);
    return mine;
  } catch (claimError) {
    if (claimError?.message === 'RECOVERY_CLAIM_MALFORMED') throw claimError;
    throw new Error('OPERATION_LOCKED');
  }
}

function removeOwnedRecoveryClaim(claim, ownedClaim, key) {
  const current = verifySignedRecord(secureRead(claim), key, 'RECOVERY_CLAIM_MALFORMED');
  if (canonicalJson(current) !== canonicalJson(ownedClaim)) throw new Error('OPERATION_LOCKED');
  unlinkSync(claim);
  fsyncDirectory(dirname(claim));
}

export function withOperationLock(path, keyPath, callback, { allowJournal = false } = {}) {
  assertOwnerOnly(dirname(path), 'directory');
  assertCanonicalLeaf(path);
  const key = secureRead(keyPath);
  const journal = `${path}.journal`;
  if (!allowJournal && existsSync(journal)) throw new Error('PENDING_ACTIVATION_JOURNAL');
  const metadata = {
    version: 1,
    host: hostname(),
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    durableExclusive(path, `${canonicalJson(signedRecord(metadata, key))}\n`);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('OPERATION_LOCKED');
    let holder;
    try {
      assertOwnerOnly(path, 'file');
      holder = verifySignedRecord(secureRead(path), key, 'OPERATION_LOCKED_MALFORMED');
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
      const current = verifySignedRecord(secureRead(path), key, 'OPERATION_LOCKED_MALFORMED');
      if (canonicalJson(current) !== canonicalJson(holder)) throw new Error('OPERATION_LOCKED');
      unlinkSync(path);
      fsyncDirectory(dirname(path));
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
        durableExclusive(path, `${canonicalJson(signedRecord(metadata, key))}\n`);
      } catch (publishError) {
        if (publishError?.code === 'EEXIST') throw new Error('OPERATION_LOCKED');
        throw publishError;
      }
      if (
        process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
        process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:LOCK_REPLACEMENT_PUBLISHED'
      )
        process.kill(process.pid, 'SIGKILL');
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
    try {
      const current = verifySignedRecord(secureRead(path), key, 'OPERATION_LOCKED_MALFORMED');
      if (current.nonce === metadata.nonce) {
        unlinkSync(path);
        fsyncDirectory(dirname(path));
      }
    } catch {
      // Never remove a lock whose ownership can no longer be demonstrated.
    }
  };
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

function publishNoReplace(path, bytes) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let linked = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
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
    unlinkSync(temp);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    if (linked) {
      try {
        unlinkSync(path);
        fsyncDirectory(dirname(path));
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
  return withOperationLock(options.operationLockPath, options.keyPath, () => {
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
      expected: binding(entry, initial.digest, 'stage', null, options.environment, options.operator),
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
    beginPublication(options, payload, stagedPath, candidateDigest);
    publishNoReplace(stagedPath, candidateBytes);
    try {
      consumeApproval(payload, options.usageDir, options.keyPath);
    } catch (error) {
      // A marker is evidence that publication succeeded. If marker publication
      // fails, remove the staged bytes durably rather than leaving false replay
      // evidence or an unauthorised staged candidate behind.
      try {
        unlinkSync(stagedPath);
        fsyncDirectory(options.stagingDir);
      } catch {
        throw new Error('PUBLICATION_RECOVERY_REQUIRED');
      }
      throw error;
    }
    removeDurably(publicationPath(options));
    return {
      ok: true,
      action: 'stage',
      provider: 'claude',
      manifestEntryId: entry.id,
      authFilename: entry.authFilename,
      candidateDigest,
    };
  });
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

function restoreBackup(backup, target, activeDir) {
  const temp = join(activeDir, `.${basename(target)}.${process.pid}.${randomUUID()}.restore`);
  copyFileSync(backup, temp, constants.COPYFILE_EXCL);
  chmodSync(temp, 0o600);
  const fd = openSync(temp, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncDirectory(activeDir);
}

function validateExistingTarget(path, entry) {
  const descriptor = secureReadDescriptor(path);
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

function writeJournal(options, state, phase) {
  const path = journalPath(options);
  const key = secureRead(options.keyPath);
  const next = { ...state, phase };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = `${canonicalJson(signedRecord(next, key))}\n`;
  let fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let published = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    published = true;
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
    rmSync(temp, { force: true });
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
  return next;
}

function removeJournal(options) {
  unlinkSync(journalPath(options));
  fsyncDirectory(dirname(journalPath(options)));
}

function removeCommittedBackup(state) {
  if (existsSync(state.backup)) {
    assertCanonicalExisting(state.backup);
    assertOwnerOnly(state.backup, 'file');
    if (state.hadTarget && sha256(secureRead(state.backup)) !== state.oldDigest)
      throw new Error('INVALID_ACTIVATION_BACKUP');
    unlinkSync(state.backup);
  }
  // Always prove cleanup durable, including the already-absent case.
  fsyncDirectory(dirname(state.backup));
}

function removePreparingBackup(state) {
  if (existsSync(state.backup)) {
    assertCanonicalExisting(state.backup);
    assertOwnerOnly(state.backup, 'file');
    unlinkSync(state.backup);
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
  if (!isAbsolute(options.configPath) || !isAbsolute(options.approvalPath)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  options = optionsFromConfig(options);
  return withOperationLock(options.operationLockPath, options.keyPath, () => {
    if (
      process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
      process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGSTOP:LOCK_ACQUIRED'
    )
      process.kill(process.pid, 'SIGSTOP');
    const { initial, entry } = loadCommon(options);
    const stagedPath = join(options.stagingDir, entry.authFilename);
    assertOwnerOnly(stagedPath, 'file');
    const candidateBytes = secureRead(stagedPath);
    const { digest: candidateDigest } = validateCandidateBytes(candidateBytes, entry, options.now);
    const artifact = readArtifact(options.approvalPath);
    const payload = verifyApproval({
      artifact,
      keyPath: options.keyPath,
      expected: binding(entry, initial.digest, 'activate', candidateDigest, options.environment, options.operator),
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
    const target = join(options.activeDir, entry.authFilename);
    assertCanonicalLeaf(target);
    const hadTarget = existsSync(target);
    let oldDigest = null;
    let oldTarget = null;
    if (hadTarget) {
      assertOwnerOnly(target, 'file');
      oldTarget = validateExistingTarget(target, entry);
      oldDigest = oldTarget.digest;
    }
    assertNoIdentityConflicts({
      entry,
      activeDir: options.activeDir,
      quarantineDirs: options.quarantineDirs,
      stagingDir: options.stagingDir,
      candidatePath: stagedPath,
    });
    if (statSync(options.stagingDir).dev !== statSync(options.activeDir).dev) throw new Error('CROSS_FILESYSTEM');
    if (options.beforeCas) options.beforeCas();
    if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
    if (options.injectFailure === 'before-rename') throw new Error('INJECTED_FAILURE');
    if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
    if (sha256(secureRead(stagedPath)) !== candidateDigest) throw new Error('CANDIDATE_CAS_FAILED');
    if (existsSync(target) !== hadTarget || (hadTarget && !descriptorStillCurrent(target, oldTarget)))
      throw new Error('ACTIVE_TARGET_CAS_FAILED');
    const backup = join(options.rollbackDir, `${entry.authFilename}.${payload.id}.bak`);
    assertCanonicalLeaf(backup);
    let journal = {
      version: 1,
      entryId: entry.id,
      authFilename: entry.authFilename,
      candidateDigest,
      oldDigest,
      hadTarget,
      stagedPath,
      target,
      backup,
      approvalId: payload.id,
      approvalNonce: payload.nonce,
    };
    journal = writeJournal(options, journal, 'PREPARING');
    if (hadTarget) {
      // Back up the bytes pinned and schema-validated from one descriptor read,
      // never a later pathname resolution.
      const fd = openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const split =
          options.injectFailure === 'partial-backup'
            ? Math.max(1, Math.floor(oldTarget.bytes.length / 2))
            : oldTarget.bytes.length;
        writeFileSync(fd, oldTarget.bytes.subarray(0, split));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (options.injectFailure === 'partial-backup') throw new Error('INJECTED_FAILURE');
      fsyncDirectory(options.rollbackDir);
    }
    journal = writeJournal(options, journal, 'PREPARED');
    // Final CAS is immediately before backup authorization and approval use.
    if (sha256(secureRead(stagedPath)) !== candidateDigest) throw new Error('CANDIDATE_CAS_FAILED');
    if (existsSync(target) !== hadTarget || (hadTarget && !descriptorStillCurrent(target, oldTarget)))
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
      replaceAndFsync(stagedPath, target, options.stagingDir, options.activeDir, options.injectFailure, () => {
        renameCompleted = true;
      });
      journal = writeJournal(options, journal, 'INSTALLED');
      if (sha256(readFileSync(target)) !== candidateDigest) throw new Error('DIGEST_MISMATCH');
      if (options.injectFailure === 'after-digest-verification') throw new Error('INJECTED_FAILURE');
      journal = writeJournal(options, journal, 'COMMITTED');
      removeCommittedBackup(journal);
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
          if (existsSync(target) && sha256(readFileSync(target)) === candidateDigest) renameSync(target, stagedPath);
          else recoveryFailed = true;
        } catch {
          recoveryFailed = true;
        }
      }
      if (hadTarget && renameCompleted) {
        try {
          restoreBackup(backup, target, options.activeDir);
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
        if (!existsSync(stagedPath) || sha256(readFileSync(stagedPath)) !== candidateDigest) recoveryFailed = true;
        if (hadTarget) {
          if (!existsSync(target) || sha256(readFileSync(target)) !== sha256(readFileSync(backup)))
            recoveryFailed = true;
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
      const path = journalPath(options);
      if (!existsSync(path)) return { ok: true, action: 'recover', recovered: false };
      const state = verifySignedRecord(secureRead(path), secureRead(options.keyPath), 'INVALID_ACTIVATION_JOURNAL');
      exactKeys(state, [
        'version',
        'entryId',
        'authFilename',
        'candidateDigest',
        'oldDigest',
        'hadTarget',
        'stagedPath',
        'target',
        'backup',
        'approvalId',
        'approvalNonce',
        'phase',
      ]);
      const allowed = [
        'PREPARING',
        'PREPARED',
        'APPROVAL_INTENT',
        'APPROVAL_CONSUMED',
        'INSTALL_INTENT',
        'INSTALLED',
        'COMMITTED',
      ];
      if (state.version !== 1 || !allowed.includes(state.phase)) throw new Error('INVALID_ACTIVATION_JOURNAL');
      const manifest = readManifest(options.manifestPath).manifest;
      const entry = manifest.entries.find((item) => item.id === state.entryId && item.provider === 'claude');
      const expectedStaged = entry && join(options.stagingDir, entry.authFilename);
      const expectedTarget = entry && join(options.activeDir, entry.authFilename);
      const expectedBackup = entry && join(options.rollbackDir, `${entry.authFilename}.${state.approvalId}.bak`);
      if (
        !entry ||
        state.authFilename !== entry.authFilename ||
        state.stagedPath !== expectedStaged ||
        state.target !== expectedTarget ||
        state.backup !== expectedBackup
      )
        throw new Error('INVALID_ACTIVATION_JOURNAL');
      const targetHasNew = existsSync(state.target) && sha256(secureRead(state.target)) === state.candidateDigest;
      const marker = join(options.usageDir, `${state.approvalId}.${state.approvalNonce}.used`);
      // consumeApproval publishes through one expected temp hardlink. A crash
      // after link(2) may leave nlink=2; remove only the uniquely inode-matched
      // expected temp after the signed journal has authenticated every path.
      removePublicationTempLink(marker);
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
      });
      const markerRequired = allowed.indexOf(state.phase) >= allowed.indexOf('APPROVAL_CONSUMED');
      if (markerRequired || (state.phase === 'APPROVAL_INTENT' && existsSync(marker))) {
        try {
          if (!existsSync(marker)) throw new Error('MISSING_USE_MARKER');
          validateUseMarker(marker, options.keyPath, {
            approvalId: state.approvalId,
            nonce: state.approvalNonce,
            action: 'activate',
          });
        } catch {
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        }
        fsyncDirectory(options.usageDir);
      } else if (state.phase === 'APPROVAL_INTENT') {
        fsyncDirectory(options.usageDir);
      }
      if (state.phase === 'COMMITTED') {
        if (!targetHasNew) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removeCommittedBackup(state);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'committed' };
      }
      if (state.phase === 'PREPARING' && state.hadTarget && !existsSync(state.backup)) {
        if (!existsSync(state.target) || sha256(secureRead(state.target)) !== state.oldDigest || targetHasNew)
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || sha256(secureRead(state.stagedPath)) !== state.candidateDigest)
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
          if (!existsSync(state.target) || sha256(secureRead(state.target)) !== state.oldDigest || targetHasNew)
            throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        } else if (existsSync(state.target)) throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        if (!existsSync(state.stagedPath) || sha256(secureRead(state.stagedPath)) !== state.candidateDigest)
          throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
        removePreparingBackup(state);
        fsyncDirectory(options.activeDir);
        fsyncDirectory(options.stagingDir);
        removeJournal(options);
        return { ok: true, action: 'recover', recovered: true, outcome: 'rolled-back' };
      }
      if (targetHasNew) {
        renameSync(state.target, state.stagedPath);
        if (
          process.env.CLAUDE_STAGED_ENROLLMENT_TESTING === '1' &&
          process.env.CLAUDE_STAGED_ENROLLMENT_TEST_FAULT === 'SIGKILL:RECOVERY_ROLLBACK_RENAMED'
        )
          process.kill(process.pid, 'SIGKILL');
      }
      if (state.hadTarget) {
        const targetHasOld = existsSync(state.target) && sha256(secureRead(state.target)) === state.oldDigest;
        if (!targetHasOld) {
          if (!existsSync(state.backup) || sha256(secureRead(state.backup)) !== state.oldDigest)
            throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
          restoreBackup(state.backup, state.target, dirname(state.target));
        }
        removeCommittedBackup(state);
      } else if (existsSync(state.target)) {
        throw new Error('ACTIVATION_RECOVERY_UNCERTAIN');
      }
      if (!existsSync(state.stagedPath) || sha256(secureRead(state.stagedPath)) !== state.candidateDigest)
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
  ];
  if ([...pathKeys.map((key) => config[key]), ...config.quarantineDirs].some((item) => !isAbsolute(item)))
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
  };
}

function cliOptions(argv, command) {
  const allowed = new Set([
    'config',
    ...(command === 'recover' ? [] : ['entry', 'approval']),
    ...(command === 'stage' ? ['candidate'] : []),
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
    (command !== 'recover' && (!out.entry || !out.approval)) ||
    (command === 'stage' && !out.candidate)
  )
    throw new Error('INVALID_ARGUMENTS');
  return out;
}

function runCli() {
  const [command, ...argv] = process.argv.slice(2);
  if (!['stage', 'activate', 'recover'].includes(command)) throw new Error('INVALID_ARGUMENTS');
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
        ? activateEnrollment({ configPath: args.config, ...common })
        : recoverEnrollment({ configPath: args.config, ...common });
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
    ]);
    const code = allowed.has(error?.message) ? error.message : 'OPERATION_REFUSED';
    process.stderr.write(`staged enrollment refused: ${code}\n`);
    process.exitCode = 1;
  }
}
