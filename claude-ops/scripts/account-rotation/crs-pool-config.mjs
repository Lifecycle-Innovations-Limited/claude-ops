#!/usr/bin/env node
/**
 * crs-pool-config.mjs — shared CRS + rotation config resolution for public installs.
 *
 * Vault key ↔ CRS account name mapping is NEVER hardcoded in repo scripts.
 * Configure per account via `crsAccountName` and/or optional `crs.nameByVaultKey`.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..');
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');

export const CONFIG_CANDIDATES = [
  process.env.CRS_CONFIG,
  join(DATA_DIR, 'account-rotation', 'config.json'),
  join(homedir(), '.claude', 'plugins', 'data', 'ops', 'account-rotation', 'config.json'),
  join(PLUGIN_ROOT, 'scripts', 'account-rotation', 'config.json'),
  join(__dirname, 'config.json'),
].filter(Boolean);

export function resolveConfigPath() {
  for (const p of CONFIG_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadRotationConfig() {
  const path = resolveConfigPath();
  if (!path) return { crs: {}, accounts: [] };
  try {
    return { crs: {}, accounts: [], ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { crs: {}, accounts: [] };
  }
}

/**
 * @returns {{ nameByVaultKey: Record<string,string>, vaultKeyByCrsName: Record<string,string> }}
 */
export function buildCrsNameMaps(config = loadRotationConfig()) {
  const nameByVaultKey = {};
  const vaultKeyByCrsName = {};

  const overrides = config.crs?.nameByVaultKey;
  if (overrides && typeof overrides === 'object') {
    for (const [vaultKey, crsName] of Object.entries(overrides)) {
      if (!vaultKey || !crsName) continue;
      nameByVaultKey[vaultKey] = crsName;
      if (!vaultKeyByCrsName[crsName]) vaultKeyByCrsName[crsName] = vaultKey;
    }
  }

  for (const a of config.accounts || []) {
    const crsName = a.crsAccountName || a.crsName;
    if (!crsName) continue;
    const keys = [];
    if (a.email) keys.push(a.email);
    if (a.label) keys.push(a.label);
    for (const k of keys) {
      if (!k) continue;
      nameByVaultKey[k] = crsName;
    }
    if (!vaultKeyByCrsName[crsName]) {
      vaultKeyByCrsName[crsName] = a.email || a.label || null;
    }
  }

  for (const [vaultKey, crsName] of Object.entries(nameByVaultKey)) {
    if (crsName && !vaultKeyByCrsName[crsName]) vaultKeyByCrsName[crsName] = vaultKey;
  }

  return { nameByVaultKey, vaultKeyByCrsName };
}

export function crsBaseUrl(config = loadRotationConfig()) {
  return process.env.CRS_BASE || config.crs?.baseUrl || 'http://127.0.0.1:3005';
}

/**
 * CRS reachability healthcheck, shared by rotate.mjs --status and daemon.mjs
 * startup. Two probes:
 *   - GET  /health              — plain liveness check
 *   - POST /api/v1/messages {}  — deliberately malformed body; CRS validating
 *     and rejecting it (400) or rejecting our probe auth (401) both prove the
 *     relay process is up and routing requests. Anything else (timeout,
 *     connection refused, 5xx) means it isn't.
 *
 * Never throws. Callers should treat `reachable: false` as "skip refresh/sync
 * actions for CRS-pool accounts this cycle" — not a reason to stop rotating
 * keychain-only accounts.
 */
export async function checkCrsHealth(config = loadRotationConfig(), { timeoutMs = 4000 } = {}) {
  const base = crsBaseUrl(config);
  const result = { base, reachable: false, healthStatus: null, messagesProbeStatus: null };
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    result.healthStatus = res.status;
    result.reachable = res.ok;
  } catch (error) {
    result.error = String(error.message || error);
    return result;
  }
  try {
    const res = await fetch(`${base}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.messagesProbeStatus = res.status;
    if (!result.reachable && (res.status === 400 || res.status === 401)) result.reachable = true;
  } catch (error) {
    result.messagesProbeError = String(error.message || error);
  }
  return result;
}

export function crsFileVaultPath(config = loadRotationConfig()) {
  const fromEnv = process.env.CRS_FILE_VAULT;
  if (fromEnv) return fromEnv.replace(/^~(?=$|\/)/, homedir());
  const fromCfg = config.crs?.fileVaultPath;
  if (fromCfg) return fromCfg.replace(/^~(?=$|\/)/, homedir());
  return join(homedir(), '.claude', '.credentials.json');
}

export function crsPolicy(config = loadRotationConfig()) {
  const raw = String(process.env.CRS_POLICY || config.crs?.policy || 'conservative')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (raw === 'maxout' || raw === 'max-out') return 'max-out';
  return 'conservative';
}

export function vaultLookupKeysForEmail(email, accounts = []) {
  const keys = new Set();
  if (email) keys.add(email);
  for (const a of accounts) {
    const label = a.label || a.email;
    const addr = a.email || a.label;
    if (addr === email || label === email) {
      if (label) keys.add(label);
      if (addr) keys.add(addr);
    }
  }
  return [...keys];
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Parse a proxy URL (full scheme://[user:pass@]host:port, or a bare host:port)
 * into { type, host, port, username?, password? }. Returns null on anything
 * unparseable or missing host/port — never throws.
 */
function parseProxyUrl(raw, defaultType = 'http') {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = SCHEME_RE.test(trimmed);
  const toParse = hasScheme ? trimmed : `http://${trimmed}`;
  let url;
  try {
    url = new URL(toParse);
  } catch {
    return null;
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : null;
  if (!host || !port) return null;
  const type = hasScheme ? trimmed.split('://')[0].toLowerCase() : defaultType;
  const result = { type, host, port };
  if (url.username) result.username = decodeURIComponent(url.username);
  if (url.password) result.password = decodeURIComponent(url.password);
  return result;
}

/**
 * Load KEY=VALUE pairs from a dotenv-style file. Missing/unreadable file
 * yields {} silently — this is a soft fallback layer, never authoritative.
 */
function loadEnvFile(path) {
  if (!path) return {};
  try {
    if (!existsSync(path)) return {};
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed
        .slice(0, idx)
        .replace(/^export\s+/, '')
        .trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function proxyRoutingEnabled(env) {
  const raw = String(env.CLAUDE_ROTATION_PROXY_ENABLED ?? env.CRS_ACCOUNT_PROXY_ENABLED ?? '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/**
 * Resolve the outbound proxy (if any) for a given account.
 *
 * Precedence: an explicit `account.proxy`/`account.proxyConfig` short-circuits
 * everything. Next, a `config.crs.proxyByVaultKey`/`proxies` map keyed by the
 * account's email/label. Otherwise, env-driven: disabled unless
 * CLAUDE_ROTATION_PROXY_ENABLED is truthy; provider defaults to 'brightdata'
 * (BRIGHTDATA_PROXY_URL) unless CLAUDE_ROTATION_PROXY_PROVIDER selects
 * 'efg'/'unifi'/'home'/'gateway' (EFG_PROXY_URL — a generic local-SOCKS slot,
 * no hardcoded default host; must be explicitly configured). Never throws.
 *
 * @param {object} config - loadRotationConfig() shape
 * @param {object} account - { email, label, proxy?, proxyConfig? }
 * @param {object} env - defaults to process.env; pass an object for tests
 */
export function accountProxyConfig(config = loadRotationConfig(), account, env = process.env) {
  const direct = account?.proxy || account?.proxyConfig;
  if (direct) return direct;

  const key = account?.email || account?.label;
  const byKey = config?.crs?.proxyByVaultKey || config?.crs?.proxies;
  if (key && byKey && typeof byKey === 'object' && byKey[key]) return byKey[key];

  const fileEnv = loadEnvFile(env.CLAUDE_ROTATION_ENV_FILE);
  const merged = { ...fileEnv, ...env };

  if (!proxyRoutingEnabled(merged)) return null;

  const providerRaw = String(merged.CLAUDE_ROTATION_PROXY_PROVIDER ?? 'brightdata')
    .trim()
    .toLowerCase();

  if (['efg', 'unifi', 'home', 'gateway'].includes(providerRaw)) {
    return parseProxyUrl(merged.EFG_PROXY_URL, 'socks5');
  }

  return parseProxyUrl(merged.BRIGHTDATA_PROXY_URL, 'http');
}
