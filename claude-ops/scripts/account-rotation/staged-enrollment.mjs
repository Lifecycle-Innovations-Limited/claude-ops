#!/usr/bin/env node
/** Fail-closed, offline staging and activation for Claude CLIProxyAPI auth files. */
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
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
    manifest = JSON.parse(bytes);
  } catch {
    throw new Error('INVALID_MANIFEST');
  }
  exactKeys(manifest, ['version', 'entries']);
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length !== 15) {
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
  return parseManifestBytes(readFileSync(path));
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
    candidate = JSON.parse(bytes);
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
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60_000;
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
  if (!rightKind || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
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
  return physical;
}

function assertCanonicalLeaf(path) {
  const normalized = resolve(path);
  const parent = dirname(normalized);
  if (realpathSync(parent) !== parent || join(parent, basename(normalized)) !== normalized)
    throw new Error('INSECURE_TRUST_ROOT');
  return normalized;
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
  const key = readFileSync(keyPath);
  if (key.length < 32) throw new Error('APPROVAL_KEY_TOO_SHORT');
  if (typeof artifact.signature !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.signature))
    throw new Error('INVALID_SIGNATURE');
  const supplied = Buffer.from(artifact.signature, 'hex');
  const calculated = createHmac('sha256', key).update(canonicalJson(p)).digest();
  if (!timingSafeEqual(supplied, calculated)) throw new Error('INVALID_SIGNATURE');
  return p;
}

export function consumeApproval(payload, usageDir) {
  assertOwnerOnly(usageDir, 'directory');
  const marker = join(usageDir, `${payload.id}.${payload.nonce}.used`);
  let fd;
  try {
    fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${payload.action}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(usageDir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code === 'EEXIST') throw new Error('APPROVAL_REPLAY');
    throw new Error('APPROVAL_CONSUME_FAILED');
  }
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
          value = JSON.parse(readFileSync(path));
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

function withOperationLock(path, callback) {
  assertOwnerOnly(dirname(path), 'directory');
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    throw new Error('OPERATION_LOCKED');
  }
  try {
    return callback();
  } finally {
    closeSync(fd);
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  }
}

function loadCommon(options) {
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
  return { initial, entry };
}

function readArtifact(path) {
  assertOwnerOnly(path, 'file');
  try {
    return JSON.parse(readFileSync(path));
  } catch {
    throw new Error('INVALID_APPROVAL');
  }
}

function publishNoReplace(path, bytes) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, path);
    unlinkSync(temp);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    if (error?.code === 'EEXIST') throw new Error('STAGE_TARGET_EXISTS');
    throw error;
  }
}

export function stageEnrollment(options) {
  return withOperationLock(options.operationLockPath, () => {
    const { initial, entry } = loadCommon(options);
    assertCanonicalExisting(options.candidatePath);
    assertOwnerOnly(options.candidatePath, 'file');
    const candidateBytes = readFileSync(options.candidatePath);
    const { digest: candidateDigest } = validateCandidateBytes(candidateBytes, entry, options.now);
    const artifact = readArtifact(options.approvalPath);
    const payload = verifyApproval({
      artifact,
      keyPath: options.keyPath,
      expected: binding(entry, initial.digest, 'stage', null, options.environment, options.operator),
      now: options.now,
      maxTtlMs: options.maxTtlMs,
    });
    assertNoIdentityConflicts({
      entry,
      activeDir: options.activeDir,
      quarantineDirs: options.quarantineDirs,
      stagingDir: options.stagingDir,
    });
    const stagedPath = join(options.stagingDir, entry.authFilename);
    consumeApproval(payload, options.usageDir);
    publishNoReplace(stagedPath, candidateBytes);
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

export function activateEnrollment(options) {
  return withOperationLock(options.operationLockPath, () => {
    const { initial, entry } = loadCommon(options);
    const stagedPath = join(options.stagingDir, entry.authFilename);
    assertOwnerOnly(stagedPath, 'file');
    const candidateBytes = readFileSync(stagedPath);
    const { digest: candidateDigest } = validateCandidateBytes(candidateBytes, entry, options.now);
    const artifact = readArtifact(options.approvalPath);
    const payload = verifyApproval({
      artifact,
      keyPath: options.keyPath,
      expected: binding(entry, initial.digest, 'activate', candidateDigest, options.environment, options.operator),
      now: options.now,
      maxTtlMs: options.maxTtlMs,
    });
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
    const target = join(options.activeDir, entry.authFilename);
    const hadTarget = existsSync(target);
    if (hadTarget) assertOwnerOnly(target, 'file');
    if (options.injectFailure === 'before-rename') throw new Error('INJECTED_FAILURE');
    if (readManifest(options.manifestPath).digest !== initial.digest) throw new Error('MANIFEST_CAS_FAILED');
    consumeApproval(payload, options.usageDir);
    const backup = join(options.rollbackDir, `${entry.authFilename}.${payload.id}.bak`);
    if (hadTarget) {
      copyFileSync(target, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      const fd = openSync(backup, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(options.rollbackDir);
    }
    let renameCompleted = false;
    try {
      replaceAndFsync(stagedPath, target, options.stagingDir, options.activeDir, options.injectFailure, () => {
        renameCompleted = true;
      });
      if (sha256(readFileSync(target)) !== candidateDigest) throw new Error('DIGEST_MISMATCH');
      if (options.injectFailure === 'after-digest-verification') throw new Error('INJECTED_FAILURE');
      return {
        ok: true,
        action: 'activate',
        provider: 'claude',
        manifestEntryId: entry.id,
        authFilename: entry.authFilename,
        candidateDigest,
        backupCreated: hadTarget,
      };
    } catch {
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
      throw new Error(recoveryFailed ? 'ACTIVATION_ROLLBACK_FAILED' : 'ACTIVATION_ROLLED_BACK');
    }
  });
}

export function readDeploymentConfig(path) {
  assertCanonicalExisting(path);
  assertOwnerOnly(path, 'file');
  let config;
  try {
    config = JSON.parse(readFileSync(path));
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
  for (const item of [
    config.manifestPath,
    config.approvalKeyPath,
    config.usageDir,
    config.stagingDir,
    config.activeDir,
    config.rollbackDir,
    ...config.quarantineDirs,
  ])
    assertCanonicalExisting(item);
  assertCanonicalLeaf(config.operationLockPath);
  const roots = [
    config.usageDir,
    config.stagingDir,
    config.activeDir,
    config.rollbackDir,
    ...config.quarantineDirs,
  ].map((item) => realpathSync(item));
  const overlaps = (a, b) => {
    const rel = relative(a, b);
    return (
      rel === '' ||
      (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
    );
  };
  for (let i = 0; i < roots.length; i += 1)
    for (let j = i + 1; j < roots.length; j += 1)
      if (overlaps(roots[i], roots[j]) || overlaps(roots[j], roots[i])) throw new Error('INVALID_CONFIG');
  const lockDir = resolve(dirname(config.operationLockPath));
  if (roots.some((root) => overlaps(root, lockDir) || overlaps(lockDir, root))) throw new Error('INVALID_CONFIG');
  return config;
}

function cliOptions(argv, command) {
  const allowed = new Set(['config', 'entry', 'approval', ...(command === 'stage' ? ['candidate'] : [])]);
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
  if (!out.config || !out.entry || !out.approval || (command === 'stage' && !out.candidate))
    throw new Error('INVALID_ARGUMENTS');
  return out;
}

function runCli() {
  const [command, ...argv] = process.argv.slice(2);
  if (!['stage', 'activate'].includes(command)) throw new Error('INVALID_ARGUMENTS');
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
    command === 'stage' ? stageEnrollment({ ...common, candidatePath: args.candidate }) : activateEnrollment(common);
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
    ]);
    const code = allowed.has(error?.message) ? error.message : 'OPERATION_REFUSED';
    process.stderr.write(`staged enrollment refused: ${code}\n`);
    process.exitCode = 1;
  }
}
