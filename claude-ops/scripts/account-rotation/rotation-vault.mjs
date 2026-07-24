import { readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

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
  const store = readFileStore();
  store[service] = parseToken(token);
  const temp = `${FILE_PATH}.tmp.${process.pid}`;
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(temp, FILE_PATH);
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
    ['add-generic-password', '-U', '-s', service, '-a', KEYCHAIN_ACCOUNT, '-w', JSON.stringify(parseToken(token))],
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

export function writeRotationToken(key, token) {
  const parsed = parseToken(token);
  if (!parsed?.claudeAiOauth?.accessToken) throw new Error(`Invalid rotation token for ${key}`);
  const service = rotationService(key);
  writeFileToken(service, parsed);
  writeKeychainToken(service, parsed);
  return JSON.stringify(parsed);
}

export function reconcileRemoteRotationVault({ host = process.env.CRS_SSH_HOST || 'dev-us' } = {}) {
  if (process.platform !== 'darwin' || process.env.CLAUDE_ROTATION_REMOTE_VAULT_SYNC === '0') {
    return { skipped: true, pulled: 0, pushed: 0 };
  }
  const read = spawnSync('ssh', [host, 'cat "$HOME/.claude/.credentials.json"'], {
    timeout: 15_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (read.status !== 0) {
    const detail = String(read.stderr || 'ssh read failed')
      .split('\n')[0]
      .slice(0, 160);
    throw new Error(`Remote rotation vault read failed from ${host}: ${detail}`);
  }

  let remote;
  try {
    remote = JSON.parse(read.stdout);
  } catch {
    throw new Error(`Remote rotation vault from ${host} was not valid JSON`);
  }

  const local = readFileStore();
  const services = new Set(
    [...Object.keys(local), ...Object.keys(remote)].filter((key) => key.startsWith('Claude-Rotation-')),
  );
  let pulled = 0;
  let pushed = 0;
  for (const service of services) {
    const key = service.slice('Claude-Rotation-'.length);
    const localToken = parseToken(readRotationToken(key, { heal: false }));
    const remoteToken = parseToken(remote[service]);
    if (expiry(remoteToken) > expiry(localToken)) {
      writeRotationToken(key, remoteToken);
      pulled++;
    } else if (expiry(localToken) > expiry(remoteToken)) {
      remote[service] = localToken;
      pushed++;
    }
  }

  if (pushed > 0) {
    const write = spawnSync(
      'ssh',
      [
        host,
        'umask 077; tmp="$HOME/.claude/.credentials.json.tmp.$$"; cat >"$tmp"; mv "$tmp" "$HOME/.claude/.credentials.json"',
      ],
      {
        timeout: 15_000,
        encoding: 'utf8',
        input: `${JSON.stringify(remote, null, 2)}\n`,
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    if (write.status !== 0) {
      const detail = String(write.stderr || 'ssh write failed')
        .split('\n')[0]
        .slice(0, 160);
      throw new Error(`Remote rotation vault write failed to ${host}: ${detail}`);
    }
  }
  return { skipped: false, pulled, pushed };
}
