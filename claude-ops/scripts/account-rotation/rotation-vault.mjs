import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createVerifiedCredentialWriter, requireVerifiedCredentialCapability } from './verified-credential-write.mjs';
import { publishCredentialFileCas, snapshotCredentialFile } from './credential-file-publication.mjs';

const FILE_PATH = process.env.CLAUDE_ROTATION_FILE_VAULT || join(homedir(), '.claude', '.credentials.json');
const KEYCHAIN_ACCOUNT = process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || 'claude-ops';
const LOGIN_KEYCHAIN_PATH = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');

export function rotationService(key) {
  return `Claude-Rotation-${key}`;
}

function parseToken(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function expiry(value) {
  return Number(parseToken(value)?.claudeAiOauth?.expiresAt || 0);
}

function readFileStore() {
  try {
    return JSON.parse(readFileSync(FILE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeFileToken(service, token) {
  const snapshot = snapshotCredentialFile(FILE_PATH);
  let store = {};
  try {
    store = snapshot.absent ? {} : JSON.parse(snapshot.bytes.toString('utf8'));
  } catch {
    throw new Error('ROTATION_VAULT_MALFORMED');
  }
  store[service] = token;
  publishCredentialFileCas(FILE_PATH, Buffer.from(JSON.stringify(store, null, 2)), snapshot);
}

function readKeychainToken(service) {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT, '-g', LOGIN_KEYCHAIN_PATH],
    { timeout: 5000, encoding: 'utf8' },
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/^password: "?(.*?)"?$/m);
  return match ? parseToken(match[1].replace(/\\"/g, '"')) : null;
}

function writeKeychainToken(service, token) {
  if (process.platform !== 'darwin') return;
  const result = spawnSync(
    'security',
    ['add-generic-password', '-U', '-s', service, '-a', KEYCHAIN_ACCOUNT, '-w', token],
    { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || 'security exited non-zero')
      .split('\n')[0]
      .slice(0, 160);
    throw new Error(`Keychain update failed for ${service}: ${detail}`);
  }
}

export function readRotationToken(key, { heal = true } = {}) {
  // Reads are deliberately side-effect free. Identity verification is async,
  // so a synchronous read must never "heal" a higher-expiry unbound value.
  void heal;
  return readRotationTokenInternal(key, false);
}

function readRotationTokenInternal(key, heal) {
  const service = rotationService(key);
  const fileToken = parseToken(readFileStore()[service]);
  const keychainToken = readKeychainToken(service);
  const selected = expiry(fileToken) > expiry(keychainToken) ? fileToken : keychainToken || fileToken;
  if (!selected) return null;
  const serialized = JSON.stringify(selected);

  if (heal) {
    if (JSON.stringify(fileToken) !== serialized) writeFileToken(service, selected);
    if (process.platform === 'darwin' && JSON.stringify(keychainToken) !== serialized) {
      writeKeychainToken(service, selected);
    }
  }
  return serialized;
}

function writeRotationTokenVerified(account, token, verifiedCapability) {
  const key = account.label || account.email;
  const parsed = parseToken(token);
  if (!parsed?.claudeAiOauth?.accessToken) throw new Error(`Invalid rotation token for ${key}`);
  const service = rotationService(key);
  requireVerifiedCredentialCapability(verifiedCapability, {
    account,
    credential: token,
    destination: service,
  });
  if (process.platform === 'darwin') throw new Error('KEYCHAIN_CREDENTIAL_PUBLICATION_DISABLED');
  writeFileToken(service, token);
  return token;
}

const verifiedRotationWrite = createVerifiedCredentialWriter({
  write: writeRotationTokenVerified,
  destination: (account) => rotationService(account.label || account.email),
});

export function writeRotationToken(account, token) {
  void account;
  void token;
  throw new Error('ROTATION_TOKEN_MUTATION_APPROVAL_REQUIRED');
}

export function writeRotationTokenCoordinated(account, token, capability) {
  void account;
  void token;
  void capability;
  throw new Error('ROTATION_TOKEN_MUTATION_APPROVAL_REQUIRED');
}

export function reconcileRemoteRotationVault({ host = process.env.CLAUDE_ROTATION_SSH_HOST || 'dev-us' } = {}) {
  // A local lock cannot serialize or identity-verify a writer on another host.
  // Distributed reconciliation remains operationally fenced until the remote
  // endpoint exposes the same canonical lock + exact profile-verification API.
  void host;
  return { skipped: true, pulled: 0, pushed: 0, reason: 'REMOTE_WRITER_FENCED' };
}
