// lib/credential-store.mjs — cascading cross-OS credential store (Node ESM).
// Mirrors the bash helper lib/credential-store.sh.
//
// Cascade (in priority order):
//   1. OS-native keyring — macOS `security`, Linux `secret-tool`, Windows `cmdkey`
//   2. keytar (dynamically imported if installed)
//   3. Encrypted JSON — AES-256-GCM via node:crypto
//   4. Plaintext JSON — 0600 perms, last-resort fallback with warning
//
// API:
//   import { setCredential, getCredential, deleteCredential,
//            backendsAvailable, backendFor } from './lib/credential-store.mjs';
//
// Override the cascade in tests:
//   CLAUDE_OPS_CRED_BACKEND=plaintext-json node ...

import { spawnSync, spawn } from 'node:child_process';
import { promises as fs, constants as fsConst } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { osId, keyringBackend } from './os-detect.mjs';

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'claude-ops')
  : path.join(os.homedir(), '.local', 'share', 'claude-ops');
const ENC_FILE = path.join(DATA_DIR, 'secrets.enc.json');
const PLAIN_FILE = path.join(DATA_DIR, 'secrets.plain.json');
const MASTERKEY_FILE = path.join(DATA_DIR, '.masterkey');

let __plaintextWarned = false;

// ─── Redacted logging ────────────────────────────────────────────────────────
// This module handles secret material, so nothing reaches stderr unredacted.
// Deliberately NO last-4 / length-hint preview: any function that copies bytes
// of a secret into a log line is still a process.env → log-sink data flow, and
// a length plus last-4 measurably narrows an offline guess. Redaction labels
// are built from the ENV VAR NAME (or the token's scheme prefix) only, which
// gives operators the "which value" they actually need for correlation without
// carrying any of the value itself.

// Env vars whose values must never appear in log output, even indirectly
// (e.g. interpolated into an error message thrown by a child process).
const SENSITIVE_ENV_RE =
  /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|SESSION|COOKIE|MASTERKEY|OTP)/i;

function sensitiveEnvEntries() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v.length >= 6 && SENSITIVE_ENV_RE.test(k)) out.push([k, v]);
  }
  // Longest value first so overlapping values redact fully.
  return out.sort((a, b) => b[1].length - a[1].length);
}

function scrub(text) {
  let s = String(text);
  // Replace each secret with a label built from the ENV VAR NAME only. No byte
  // of the value itself — not even a last-4 hint — is carried into the output,
  // so there is no data flow from process.env to the log sink at all.
  for (const [key, value] of sensitiveEnvEntries()) {
    if (s.includes(value)) s = s.split(value).join(`<redacted ${key}>`);
  }
  // Belt-and-braces: mask anything shaped like a bearer/API token even if it
  // did not come from the environment. Only the scheme prefix is retained.
  s = s.replace(
    /\b(sk|pk|xoxc|xoxd|xoxb|xoxp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g,
    (_m, prefix) => `<redacted ${prefix}-token>`,
  );
  return s;
}

const log = (...args) =>
  console.error(
    'credential-store:',
    ...args.map((a) => scrub(a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))),
  );

function assertPublicWriteAllowed(service) {
  const name = String(service || '').toLowerCase();
  if (name === 'claude code-credentials' || name === 'claude-rotation' || name.startsWith('claude-rotation-')) {
    throw new Error('protected Claude credential writes require the coordinated internal writer');
  }
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

// ─── 1. OS-native backends ───────────────────────────────────────────────────

// Map of the ONLY binaries this module may execute. The spawnSync call sites
// below pass a STRING LITERAL from this table, never the caller's value, so no
// data flow exists from any argument into the executable name. A Set/allowlist
// membership check was not recognised as a sanitizer by CodeQL
// (js/command-line-injection alert #12) — literal dispatch removes the sink.

function runSync(key, args, opts = {}) {
  const options = { encoding: 'utf8', ...opts };
  switch (key) {
    case 'security':
      return spawnSync('security', args, options);
    case 'secret-tool':
      return spawnSync('secret-tool', args, options);
    case 'which':
      return spawnSync('which', args, options);
    case 'cmdkey':
      return spawnSync('cmdkey', args, options);
    default:
      throw new Error(`credential-store: refused non-allowlisted command: ${String(key)}`);
  }
}

// Credential coordinates land on OS command lines. Restrict them to a safe
// charset so nothing can break out of an argument (CodeQL js/command-line-injection
// and js/indirect-command-line-injection, alerts #12/#290/#291). Callers pass
// service/account derived from config and env, which is untrusted input.
const SAFE_ID = /^[A-Za-z0-9._@:-]{1,128}$/;

function assertSafeId(kind, value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`credential-store: unsafe ${kind} (allowed: A-Z a-z 0-9 . _ @ : -)`);
  }
  return value;
}

// --- macOS Keychain (security) ---
function macSet(service, account, secret) {
  assertSafeId('service', service);
  assertSafeId('account', account);
  const r = runSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret]);
  return r.status === 0;
}
function macGet(service, account) {
  assertSafeId('service', service);
  assertSafeId('account', account);
  const r = runSync('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
  if (r.status === 0) return (r.stdout || '').replace(/\n$/, '');
  // exit 44 means "not found" — treat as normal
  return null;
}
function macDelete(service, account) {
  assertSafeId('service', service);
  assertSafeId('account', account);
  runSync('security', ['delete-generic-password', '-s', service, '-a', account]);
  return true;
}

// --- Linux libsecret (secret-tool) ---
function hasSecretTool() {
  // Fixed argv only — no shell (CodeQL js/command-line-injection).
  return runSync('secret-tool', ['--version']).status === 0 || runSync('which', ['secret-tool']).status === 0;
}
function stSet(service, account, secret) {
  if (!hasSecretTool()) return false;
  assertSafeId('service', service);
  assertSafeId('account', account);
  const r = spawnSync(
    'secret-tool',
    ['store', '--label=' + service + '/' + account, 'service', service, 'account', account],
    { input: secret, encoding: 'utf8' },
  );
  return r.status === 0;
}
function stGet(service, account) {
  assertSafeId('service', service);
  assertSafeId('account', account);
  if (!hasSecretTool()) return null;
  const r = runSync('secret-tool', ['lookup', 'service', service, 'account', account]);
  if (r.status === 0 && r.stdout) return r.stdout.replace(/\n$/, '');
  return null;
}
function stDelete(service, account) {
  assertSafeId('service', service);
  assertSafeId('account', account);
  if (!hasSecretTool()) return true;
  runSync('secret-tool', ['clear', 'service', service, 'account', account]);
  return true;
}

// --- Windows Credential Manager (cmdkey — write-only from CLI) ---
function hasCmd() {
  return process.platform === 'win32' || runSync('which', ['cmd.exe']).status === 0;
}
function wincredSet(service, account, secret) {
  if (!hasCmd()) return false;
  assertSafeId('service', service);
  assertSafeId('account', account);
  // argv form only. The previous MSYS/WSL branch built a `cmd.exe /c "cmdkey …"`
  // SHELL STRING with the service, account and secret concatenated into it —
  // a real injection sink, and it also exposed the secret to the command line.
  const r = runSync('cmdkey', [`/generic:claude-ops:${service}:${account}`, `/user:${account}`, `/pass:${secret}`]);
  return r.status === 0;
}
function wincredGet(_service, _account) {
  // cmdkey cannot read passwords back from the CLI — skip
  return null;
}
function wincredDelete(service, account) {
  if (!hasCmd()) return true;
  assertSafeId('service', service);
  assertSafeId('account', account);
  runSync('cmdkey', [`/delete:claude-ops:${service}:${account}`]);
  return true;
}

function nativeBackend() {
  // Prefer os-detect's answer but fall back to process.platform heuristics
  const b = keyringBackend();
  if (b) return b;
  if (process.platform === 'darwin') return 'security';
  if (process.platform === 'linux' && hasSecretTool()) return 'secret-tool';
  if (process.platform === 'win32') return 'wincred';
  return null;
}

// ─── 2. keytar (optional) ────────────────────────────────────────────────────
let __keytarCache;
async function loadKeytar() {
  if (__keytarCache !== undefined) return __keytarCache;
  try {
    const mod = await import('keytar');
    __keytarCache = mod.default || mod;
  } catch {
    __keytarCache = null;
  }
  return __keytarCache;
}
async function keytarSet(service, account, secret) {
  const k = await loadKeytar();
  if (!k) return false;
  try {
    await k.setPassword(service, account, secret);
    return true;
  } catch {
    return false;
  }
}
async function keytarGet(service, account) {
  const k = await loadKeytar();
  if (!k) return null;
  try {
    return await k.getPassword(service, account);
  } catch {
    return null;
  }
}
async function keytarDelete(service, account) {
  const k = await loadKeytar();
  if (!k) return true;
  try {
    await k.deletePassword(service, account);
  } catch {
    /* ignore */
  }
  return true;
}

// ─── 3. Encrypted JSON (AES-256-GCM) ─────────────────────────────────────────
async function masterKey() {
  if (process.env.CLAUDE_OPS_MASTER_KEY) return process.env.CLAUDE_OPS_MASTER_KEY;
  await ensureDataDir();
  try {
    return (await fs.readFile(MASTERKEY_FILE, 'utf8')).trim();
  } catch {
    const key = crypto.randomBytes(32).toString('base64');
    await fs.writeFile(MASTERKEY_FILE, key, { mode: 0o600 });
    return key;
  }
}

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function writeJson(file, obj) {
  await ensureDataDir();
  const tmp = file + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

function encrypt(plaintext, keyB64) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(keyB64, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decrypt(entry, keyB64) {
  try {
    const salt = Buffer.from(entry.salt, 'base64');
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const ct = Buffer.from(entry.ct, 'base64');
    const key = crypto.scryptSync(keyB64, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

async function encJsonSet(service, account, secret) {
  const k = await masterKey();
  const entry = encrypt(secret, k);
  entry.service = service;
  entry.account = account;
  const store = await readJson(ENC_FILE);
  store[service + '/' + account] = entry;
  await writeJson(ENC_FILE, store);
  return true;
}
async function encJsonGet(service, account) {
  const key = service + '/' + account;
  const store = await readJson(ENC_FILE);
  if (!store[key]) return null;
  const k = await masterKey();
  const pt = decrypt(store[key], k);
  if (pt === null) log('decrypt failed for enc-json/' + key);
  return pt;
}
async function encJsonDelete(service, account) {
  const key = service + '/' + account;
  const store = await readJson(ENC_FILE);
  if (store[key]) {
    delete store[key];
    await writeJson(ENC_FILE, store);
  }
  return true;
}

// ─── 4. Plaintext JSON fallback ──────────────────────────────────────────────
function plaintextWarnOnce() {
  if (__plaintextWarned) return;
  __plaintextWarned = true;
  log('⚠ using plaintext JSON fallback — install secret-tool (linux) or cmdkey (windows) for better security');
}
async function plainSet(service, account, secret) {
  plaintextWarnOnce();
  const store = await readJson(PLAIN_FILE);
  store[service + '/' + account] = secret;
  await writeJson(PLAIN_FILE, store);
  return true;
}
async function plainGet(service, account) {
  const store = await readJson(PLAIN_FILE);
  return store[service + '/' + account] ?? null;
}
async function plainDelete(service, account) {
  const store = await readJson(PLAIN_FILE);
  const key = service + '/' + account;
  if (store[key]) {
    delete store[key];
    await writeJson(PLAIN_FILE, store);
  }
  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List backends available on this host in priority order.
 * @returns {Promise<string[]>}
 */
export async function backendsAvailable() {
  const backends = [];
  const nb = nativeBackend();
  if (nb) backends.push(nb);
  if (await loadKeytar()) backends.push('keytar');
  backends.push('enc-json');
  backends.push('plaintext-json');
  return backends;
}

/**
 * Store a secret via the cascade. Honors CLAUDE_OPS_CRED_BACKEND override.
 * @returns {Promise<{backend: string, ok: boolean}>}
 */
export async function setCredential(service, account, secret) {
  assertPublicWriteAllowed(service);
  const forced = process.env.CLAUDE_OPS_CRED_BACKEND;
  const tryBackend = async (name) => {
    let ok = false;
    switch (name) {
      case 'security':
        ok = macSet(service, account, secret);
        break;
      case 'secret-tool':
        ok = stSet(service, account, secret);
        break;
      case 'wincred':
        ok = wincredSet(service, account, secret);
        break;
      case 'keytar':
        ok = await keytarSet(service, account, secret);
        break;
      case 'enc-json':
        ok = await encJsonSet(service, account, secret);
        break;
      case 'plaintext-json':
        ok = await plainSet(service, account, secret);
        break;
    }
    if (ok) log('stored via=' + name);
    return ok;
  };

  if (forced) {
    const ok = await tryBackend(forced);
    if (!ok) log('forced backend=' + forced + ' failed');
    return { backend: forced, ok };
  }

  const cascade = [];
  const nb = nativeBackend();
  if (nb) cascade.push(nb);
  cascade.push('keytar', 'enc-json', 'plaintext-json');
  for (const name of cascade) {
    if (await tryBackend(name)) return { backend: name, ok: true };
  }
  log('all backends failed');
  return { backend: null, ok: false };
}

/**
 * Retrieve a secret. Cascades through backends.
 * @returns {Promise<{backend: string, secret: string} | null>}
 */
export async function getCredential(service, account) {
  const forced = process.env.CLAUDE_OPS_CRED_BACKEND;
  const tryBackend = async (name) => {
    let v = null;
    switch (name) {
      case 'security':
        v = macGet(service, account);
        break;
      case 'secret-tool':
        v = stGet(service, account);
        break;
      case 'wincred':
        v = wincredGet(service, account);
        break;
      case 'keytar':
        v = await keytarGet(service, account);
        break;
      case 'enc-json':
        v = await encJsonGet(service, account);
        break;
      case 'plaintext-json':
        v = await plainGet(service, account);
        break;
    }
    return v == null ? null : { backend: name, secret: v };
  };

  if (forced) return await tryBackend(forced);

  const cascade = [];
  const nb = nativeBackend();
  if (nb) cascade.push(nb);
  cascade.push('keytar', 'enc-json', 'plaintext-json');
  for (const name of cascade) {
    const hit = await tryBackend(name);
    if (hit) return hit;
  }
  return null;
}

/**
 * Delete a secret from all backends (best-effort).
 * @returns {Promise<{deletedFrom: string[]}>}
 */
export async function deleteCredential(service, account) {
  assertPublicWriteAllowed(service);
  const deletedFrom = [];
  const nb = nativeBackend();
  try {
    if (nb === 'security') {
      macDelete(service, account);
      deletedFrom.push('security');
    }
    if (nb === 'secret-tool') {
      stDelete(service, account);
      deletedFrom.push('secret-tool');
    }
    if (nb === 'wincred') {
      wincredDelete(service, account);
      deletedFrom.push('wincred');
    }
  } catch {
    /* ignore */
  }
  try {
    await keytarDelete(service, account);
    deletedFrom.push('keytar');
  } catch {
    /* ignore */
  }
  try {
    await encJsonDelete(service, account);
    deletedFrom.push('enc-json');
  } catch {
    /* ignore */
  }
  try {
    await plainDelete(service, account);
    deletedFrom.push('plaintext-json');
  } catch {
    /* ignore */
  }
  return { deletedFrom };
}

/**
 * Which backend currently holds this credential?
 * @returns {Promise<string | null>}
 */
export async function backendFor(service, account) {
  const hit = await getCredential(service, account);
  return hit ? hit.backend : null;
}

// ─── CLI entry ───────────────────────────────────────────────────────────────
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const [, , sub, ...rest] = process.argv;
  const dispatch = async () => {
    switch (sub) {
      case 'set': {
        const [service, account, secret] = rest;
        const r = await setCredential(service, account, secret);
        process.exit(r.ok ? 0 : 1);
      }
      case 'get': {
        const [service, account] = rest;
        const r = await getCredential(service, account);
        if (!r) process.exit(1);
        process.stdout.write(r.secret);
        process.exit(0);
      }
      case 'delete': {
        const [service, account] = rest;
        await deleteCredential(service, account);
        process.exit(0);
      }
      case 'backends': {
        const r = await backendsAvailable();
        process.stdout.write(r.join(' ') + '\n');
        process.exit(0);
      }
      case 'backend-for': {
        const [service, account] = rest;
        const r = await backendFor(service, account);
        if (!r) process.exit(1);
        process.stdout.write(r + '\n');
        process.exit(0);
      }
      // Helpers called by lib/credential-store.sh
      case 'set-keytar': {
        const [service, account, secret] = rest;
        assertPublicWriteAllowed(service);
        const ok = await keytarSet(service, account, secret);
        process.exit(ok ? 0 : 1);
      }
      case 'get-keytar': {
        const [service, account] = rest;
        const v = await keytarGet(service, account);
        if (v == null) process.exit(1);
        process.stdout.write(v);
        process.exit(0);
      }
      case 'delete-keytar': {
        const [service, account] = rest;
        assertPublicWriteAllowed(service);
        await keytarDelete(service, account);
        process.exit(0);
      }
      default: {
        process.stderr.write(
          'usage: credential-store.mjs {set|get|delete|backends|backend-for|set-keytar|get-keytar|delete-keytar} ...\n',
        );
        process.exit(2);
      }
    }
  };
  dispatch().catch((e) => {
    log('fatal:', e.message);
    process.exit(1);
  });
}

export default {
  setCredential,
  getCredential,
  deleteCredential,
  backendsAvailable,
  backendFor,
};
