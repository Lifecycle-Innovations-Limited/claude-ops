#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { readRotationToken } from './rotation-vault.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CRS_CONFIG || join(__dirname, 'config.json');
// Legacy fallback only — the canonical mapping is config.json's `crs.nameByVaultKey`
// (or per-account `crsAccountName`; see config.example.json). Real account keys are
// host-local and never belong in source. Populate config.json for your own accounts.
const CRS_NAME_BY_KEY = {};

function accountKey(account) {
  return account.label || account.email;
}

function normalizeOauth(oauth) {
  const scopes = Array.isArray(oauth.scopes) && oauth.scopes.length ? oauth.scopes : ['user:inference'];
  return {
    ...oauth,
    scopes,
    subscriptionInfo: {
      ...(oauth.subscriptionInfo || {}),
      accountType: oauth.subscriptionInfo?.accountType || oauth.subscriptionType || 'claude_max',
      hasClaudeMax: oauth.subscriptionInfo?.hasClaudeMax ?? true,
    },
  };
}

function assertFreshOauth(accountKey, oauth) {
  const expiresAt = Number(oauth.expiresAt || 0);
  const minFreshMs = Number(process.env.CLAUDE_ROTATION_CRS_MIN_FRESH_MS || 5 * 60_000);
  if (process.env.CLAUDE_ROTATION_ALLOW_STALE_CRS_SYNC === '1') return;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + minFreshMs) {
    const suffix = expiresAt ? ` (expired ${new Date(expiresAt).toISOString()})` : '';
    throw new Error(`Vault token for ${accountKey} is stale; refusing CRS sync${suffix}`);
  }
}

function containerImporter() {
  return String.raw`
const fs = require('fs');
const { randomUUID } = require('crypto');
const uuidv4 = () => randomUUID();

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.chdir('/app');
  const redis = require('/app/src/models/redis');
  const claudeAccountService = require('/app/src/services/account/claudeAccountService');

  await redis.connect();
  const rawAccounts = await redis.getAllClaudeAccounts();
  const name = payload.crsName || ('local:' + payload.key);
  const parseExtInfo = (account) => {
    try { return typeof account.extInfo === 'string' ? JSON.parse(account.extInfo) : (account.extInfo || {}); }
    catch { return {}; }
  };
  const matches = rawAccounts.filter((account) =>
    account.name === name || parseExtInfo(account).localKey === payload.key
  );
  const existing = matches.find((account) => parseExtInfo(account).localKey === payload.key)
    || matches.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
  const id = existing?.id || uuidv4();
  const now = new Date().toISOString();
  const requestedMaxConcurrency = Number(payload.maxConcurrency);
  const existingMaxConcurrency = Number(existing?.maxConcurrency);
  const maxConcurrency = Number.isFinite(requestedMaxConcurrency) && requestedMaxConcurrency > 0
    ? requestedMaxConcurrency
    : Number.isFinite(existingMaxConcurrency) && existingMaxConcurrency > 0
      ? existingMaxConcurrency
      : 5;
  const futureIso = (value) => {
    if (!value) return false;
    const ts = Date.parse(value);
    return Number.isFinite(ts) && ts > Date.now();
  };
  const hardHeld = Boolean(existing) && (
    ['blocked', 'auth_repair', 'error'].includes(String(existing.status || '')) ||
    futureIso(existing.rateLimitEndAt) ||
    futureIso(existing.weeklyRateLimitEndAt)
  );
  const data = {
    ...(existing || {}),
    id,
    name,
    description: 'Synced from local Claude Code account rotation vault',
    email: claudeAccountService._encryptSensitiveData(payload.email),
    password: existing?.password || '',
    claudeAiOauth: claudeAccountService._encryptSensitiveData(JSON.stringify(payload.claudeAiOauth)),
    accessToken: claudeAccountService._encryptSensitiveData(payload.claudeAiOauth.accessToken),
    refreshToken: claudeAccountService._encryptSensitiveData(payload.claudeAiOauth.refreshToken),
    expiresAt: String(payload.claudeAiOauth.expiresAt || Date.now() + 8 * 3600000),
    scopes: Array.isArray(payload.claudeAiOauth.scopes) ? payload.claudeAiOauth.scopes.join(' ') : 'user:inference',
    proxy: '',
    isActive: 'true',
    status: hardHeld ? existing.status : 'active',
    errorMessage: hardHeld ? (existing.errorMessage || '') : '',
    accountType: 'shared',
    platform: 'claude',
    priority: String(payload.priority || existing?.priority || 50),
    schedulable: hardHeld ? 'false' : 'true',
    subscriptionInfo: JSON.stringify(payload.claudeAiOauth.subscriptionInfo || {}),
    extInfo: JSON.stringify({
      source: 'local-account-rotation',
      localKey: payload.key,
      syncedAt: now
    }),
    useUnifiedUserAgent: 'true',
    useUnifiedClientId: 'false',
    unifiedClientId: existing?.unifiedClientId || '',
    disableAutoProtection: 'false',
    maxConcurrency: String(maxConcurrency),
    interceptWarmup: 'false',
    disableTempUnavailable: 'false',
    tempUnavailable503TtlSeconds: '',
    tempUnavailable5xxTtlSeconds: '',
    autoStopOnWarning: 'false',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRefreshAt: now,
    lastUsedAt: existing?.lastUsedAt || '',
    subscriptionExpiresAt: existing?.subscriptionExpiresAt || ''
  };

  await redis.setClaudeAccount(id, data);
  if (!hardHeld && typeof claudeAccountService.resetAccountStatus === 'function') {
    await claudeAccountService.resetAccountStatus(id);
  }

  const duplicatesRemoved = [];
  for (const duplicate of matches) {
    if (duplicate.id === id) continue;
    await claudeAccountService.deleteAccount(duplicate.id);
    duplicatesRemoved.push(duplicate.name || duplicate.id);
  }

  let orphanRemoved = null;
  if (payload.crsName) {
    const orphanName = 'local:' + payload.key;
    if (orphanName !== name) {
      const orphan = rawAccounts.find((account) => account.name === orphanName && account.id !== id);
      if (orphan) {
        await claudeAccountService.deleteAccount(orphan.id);
        orphanRemoved = orphanName;
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: existing ? 'updated' : 'created',
    id,
    name,
    orphanRemoved,
    duplicatesRemoved,
  }));

  await redis.client.quit();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
`;
}

function sshHosts() {
  // Aliases are managed by crs-resolve-ips.sh in ~/.ssh/config; keep this in sync
  // with its Host block (currently: devus / llm-dev-us). The old dev-us /
  // llm-dev-us-public / dev-us-direct names were dropped from ssh config and
  // caused every --all sync to fail the "remote" leg with a DNS lookup error.
  return (process.env.CLAUDE_ROTATION_CRS_SSH_HOSTS || 'devus,llm-dev-us')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

function preferSshTransport() {
  if (process.env.CLAUDE_ROTATION_CRS_PREFER_SSH === '1') return true;
  if (process.env.CLAUDE_ROTATION_CRS_PREFER_SSH === '0') return false;
  return false; // Docker first on all platforms; SSH fallback in pushPayloadToCrs
}

function detectLocalCrsContainer() {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const candidates = ['crs-claude-relay-1', 'crs-local-fallback-claude-relay-1', 'claude-relay-service-1'];
    for (const name of candidates) {
      if (out.split('\n').includes(name)) return name;
    }
    for (const line of out.split('\n')) {
      if (/claude-relay-1$/.test(line)) return line;
    }
  } catch {}
  return 'crs-claude-relay-1';
}

function resolveCrsContainer() {
  if (process.env.CLAUDE_ROTATION_CRS_CONTAINER) return process.env.CLAUDE_ROTATION_CRS_CONTAINER;
  return detectLocalCrsContainer();
}

function pushViaDocker(payload) {
  const dockerArgs = ['exec', '-i', resolveCrsContainer(), 'node', '-e', containerImporter()];
  return execFileSync('docker', dockerArgs, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function pushViaSsh(payload) {
  const hosts = sshHosts();
  if (!hosts.length) throw new Error('No CLAUDE_ROTATION_CRS_SSH_HOSTS configured');
  const importerB64 = Buffer.from(containerImporter(), 'utf8').toString('base64');
  const vaultMirror = String.raw`
const fs = require('fs');
const os = require('os');
const path = require('path');
const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const target = path.join(os.homedir(), '.claude', '.credentials.json');
let store = {};
try { store = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
const service = 'Claude-Rotation-' + payload.key;
const previous = store[service] || {};
store[service] = {
  claudeAiOauth: payload.claudeAiOauth,
  mcpOAuth: previous.mcpOAuth || {}
};
const temp = target + '.tmp.' + process.pid;
fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
fs.renameSync(temp, target);
`;
  const vaultMirrorB64 = Buffer.from(vaultMirror, 'utf8').toString('base64');
  const remoteCommand = [
    'set -e',
    'payload=$(mktemp)',
    'trap \'rm -f "$payload"\' EXIT',
    'cat > "$payload"',
    `env CRS_VAULT_MIRROR_B64=${vaultMirrorB64} node -e 'eval(Buffer.from(process.env.CRS_VAULT_MIRROR_B64, "base64").toString())' "$payload"`,
    `docker exec -i ${process.env.CLAUDE_ROTATION_CRS_CONTAINER || 'crs-claude-relay-1'} env CRS_IMPORTER_B64=${importerB64} node -e 'eval(Buffer.from(process.env.CRS_IMPORTER_B64, "base64").toString())' < "$payload"`,
  ].join('; ');
  let lastError;
  for (const host of hosts) {
    try {
      return execFileSync('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, remoteCommand], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch (sshError) {
      lastError = sshError;
    }
  }
  throw lastError || new Error('SSH CRS sync failed for all hosts');
}

function pushPayloadToCrs(payload) {
  const requested = (process.env.CLAUDE_ROTATION_CRS_TARGETS || 'local,remote')
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  const results = [];
  const failures = [];
  for (const target of requested) {
    try {
      const output = target === 'local' ? pushViaDocker(payload) : pushViaSsh(payload);
      results.push({ target, output });
    } catch (error) {
      failures.push(`${target}: ${String(error.message || error).split('\n')[0]}`);
    }
  }
  if (failures.length) throw new Error(`CRS reconciliation incomplete (${failures.join('; ')})`);
  return results;
}

function loadAccountPayload(requested) {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const account = config.accounts.find((candidate) => {
    const key = accountKey(candidate);
    return key === requested || candidate.email === requested;
  });
  if (!account) throw new Error(`Unknown account: ${requested}`);

  const key = accountKey(account);
  const tokenJson = readRotationToken(key);
  const parsed = JSON.parse(tokenJson);
  if (!parsed?.claudeAiOauth?.accessToken || !parsed?.claudeAiOauth?.refreshToken) {
    throw new Error(`Vault token for ${key} is missing Claude OAuth fields`);
  }
  assertFreshOauth(key, parsed.claudeAiOauth);

  return {
    key,
    email: account.email,
    priority: account.priority || 50,
    crsName: config.crs?.nameByVaultKey?.[key] || CRS_NAME_BY_KEY[key],
    claudeAiOauth: normalizeOauth(parsed.claudeAiOauth),
  };
}

function syncOneAccount(requested) {
  const payload = loadAccountPayload(requested);
  const outputs = pushPayloadToCrs(payload);
  const summaries = outputs.map(({ target, output }) => {
    const result = JSON.parse(output.split('\n').at(-1));
    if (!result.ok) throw new Error(result.error || `CRS ${target} sync failed`);
    const deduped = result.duplicatesRemoved?.length ? `, deduped=${result.duplicatesRemoved.length}` : '';
    return `${target}:${result.action}${deduped}`;
  });
  console.log(`[crs-sync] ${payload.key}: ${summaries.join(' ')} ${payload.crsName}`);
  return payload.key;
}

function syncAllAccounts() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  console.log('\n=== CRS vault sync → relay (all accounts) ===\n');
  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const account of config.accounts) {
    const key = accountKey(account);
    if (account.disabled === true) {
      console.log(`  ⏭  ${key}: disabled`);
      skip++;
      continue;
    }
    try {
      readRotationToken(key, { heal: false });
    } catch {
      console.log(`  ⏭  ${key}: no vault token`);
      skip++;
      continue;
    }
    try {
      syncOneAccount(key);
      ok++;
    } catch (error) {
      console.log(`  ✗  ${key}: ${String(error.message || error).slice(0, 160)}`);
      fail++;
    }
  }
  console.log(`\nCRS sync summary: ${ok} ok, ${fail} failed, ${skip} skipped\n`);
  if (fail > 0) process.exitCode = 1;
}

function main() {
  const requested = process.argv[2];
  if (!requested) {
    console.error('Usage: sync-crs-account.mjs <account-key-or-email|--all>');
    process.exit(2);
  }
  if (requested === '--all') {
    syncAllAccounts();
    return;
  }
  syncOneAccount(requested);
}

main();
