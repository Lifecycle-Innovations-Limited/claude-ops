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

function fileEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const paths = [
    join(homedir(), '.mcp-secrets.env'),
    join(homedir(), '.agent-secrets.env'),
    join(homedir(), '.config', 'credentials.env'),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
        if (!m || m[1] !== name) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v;
      }
    } catch {}
  }
  return '';
}

function firstEnvValue(names) {
  for (const name of names) {
    const value = fileEnvValue(name);
    if (value) return value;
  }
  return '';
}

function accountKey(account) {
  return account?.label || account?.email || String(account || '');
}

function safeSessionSuffix(key) {
  return (
    String(key || 'account')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || 'account'
  );
}

function withBrightDataSession(username, key) {
  const session = safeSessionSuffix(key);
  if (username.includes('-session-')) return username.replace(/-session-[^-]+/, `-session-${session}`);
  return `${username}-session-${session}`;
}

function brightDataUsername(rawUser, bright = {}) {
  const zone = bright.zone || firstEnvValue(['BRIGHT_DATA_ZONE']) || 'isp1';
  if (String(rawUser).startsWith('brd-customer-')) return rawUser;
  return `brd-customer-${rawUser}-zone-${zone}`;
}

function brightDataIps(bright = {}) {
  const raw = Array.isArray(bright.ips)
    ? bright.ips.join(',')
    : String(bright.ips || firstEnvValue(['BRIGHT_DATA_IPS', 'BRIGHT_DATA_PROXY_IPS']) || '');
  return raw
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function brightDataAliasConfig(bright = {}) {
  const alias = String(bright.alias || firstEnvValue(['BRIGHT_DATA_ACTIVE_PROXY_ALIAS']) || 'isp-proxy')
    .trim()
    .toLowerCase();
  if (alias === 'residential-proxy' || alias === 'residential' || alias === 'isp1') {
    return {
      ...bright,
      zone: bright.residentialZone || firstEnvValue(['BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE']) || 'isp1',
      password:
        bright.residentialPassword ||
        firstEnvValue(['BRIGHT_DATA_RESIDENTIAL_PROXY_PASSWORD', 'BRIGHT_DATA_RESIDENTIAL_PASSWORD']) ||
        bright.password,
      ips: [],
    };
  }
  return {
    ...bright,
    zone: bright.ispZone || firstEnvValue(['BRIGHT_DATA_ISP_PROXY_ZONE']) || bright.zone,
    password:
      bright.ispPassword ||
      firstEnvValue(['BRIGHT_DATA_ISP_PROXY_PASSWORD', 'BRIGHT_DATA_PROXY_PASSWORD']) ||
      bright.password,
    ips: bright.ispIps || bright.ips || firstEnvValue(['BRIGHT_DATA_ISP_PROXY_IPS', 'BRIGHT_DATA_IPS']),
  };
}

function brightDataUsernameForAccount(rawUser, bright = {}, key, accountIndex = 0) {
  const base = brightDataUsername(rawUser, bright);
  const ips = brightDataIps(bright);
  if (ips.length) {
    const ip = ips[Math.abs(accountIndex) % ips.length];
    return `${base}-ip-${ip}`;
  }
  const country = bright.country || firstEnvValue(['BRIGHT_DATA_COUNTRY']) || 'us';
  const scoped = `${base}-country-${country}`;
  return bright.sessionPerAccount === false ? scoped : withBrightDataSession(scoped, key);
}

function proxyRoutingEnabled(config) {
  const raw = String(
    process.env.CLAUDE_ROTATION_PROXY_ENABLED ||
      process.env.CRS_ACCOUNT_PROXY_ENABLED ||
      firstEnvValue(['CLAUDE_ROTATION_PROXY_ENABLED', 'CRS_ACCOUNT_PROXY_ENABLED']) ||
      config.crs?.proxyEnabled ||
      config.crs?.proxy?.enabled ||
      '',
  )
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function proxyProviderOrder(config) {
  const raw = String(
    process.env.CLAUDE_ROTATION_PROXY_PROVIDER ||
      process.env.CRS_ACCOUNT_PROXY_PROVIDER ||
      firstEnvValue(['CLAUDE_ROTATION_PROXY_PROVIDER', 'CRS_ACCOUNT_PROXY_PROVIDER']) ||
      config.crs?.proxyProvider ||
      config.crs?.proxy?.provider ||
      '2captcha,brightdata',
  );
  return raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function parseProxyUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      type: u.protocol.replace(':', '') || 'http',
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch {
    return null;
  }
}

function twoCaptchaSessionUsername(username, account) {
  const key = accountKey(account);
  const session = safeSessionSuffix(key);
  return username ? String(username).replace(/-session-[^-]+/, `-session-${session}`) : username;
}

function twoCaptchaProxyConfig(twoCaptcha = {}) {
  const preferred = firstEnvValue(['TWOCAPTCHA_PROXY_PREFERRED_TRANSPORT', 'TWO_CAPTCHA_PROXY_PREFERRED_TRANSPORT']);
  const url =
    twoCaptcha.url ||
    firstEnvValue(
      preferred === 'socks5'
        ? [
            'TWOCAPTCHA_PROXY_SOCKS5_URL',
            'TWO_CAPTCHA_PROXY_SOCKS5_URL',
            'TWOCAPTCHA_PROXY_URL',
            'TWO_CAPTCHA_PROXY_URL',
            'CAPTCHA_PROXY_URL',
            'TWO_CAPTCHA_HTTP_PROXY',
            'TWOCAPTCHA_HTTP_PROXY',
          ]
        : [
            'TWOCAPTCHA_PROXY_URL',
            'TWO_CAPTCHA_PROXY_URL',
            'CAPTCHA_PROXY_URL',
            'TWO_CAPTCHA_HTTP_PROXY',
            'TWOCAPTCHA_HTTP_PROXY',
            'TWOCAPTCHA_PROXY_SOCKS5_URL',
            'TWO_CAPTCHA_PROXY_SOCKS5_URL',
          ],
    );
  const parsed = parseProxyUrl(url);
  if (parsed?.host && parsed?.port) {
    return {
      ...parsed,
      username: twoCaptchaSessionUsername(parsed.username, twoCaptcha.account),
    };
  }

  const host =
    twoCaptcha.host ||
    firstEnvValue([
      'TWOCAPTCHA_PROXY_HOST',
      'TWO_CAPTCHA_PROXY_HOST',
      'CAPTCHA_PROXY_HOST',
      'TWO_CAPTCHA_HOST',
      'TWOCAPTCHA_HOST',
    ]);
  const port =
    twoCaptcha.port ||
    firstEnvValue([
      'TWOCAPTCHA_PROXY_PORT',
      'TWO_CAPTCHA_PROXY_PORT',
      'CAPTCHA_PROXY_PORT',
      'TWO_CAPTCHA_PORT',
      'TWOCAPTCHA_PORT',
    ]);
  const username =
    twoCaptcha.username ||
    firstEnvValue([
      'TWOCAPTCHA_PROXY_USERNAME',
      'TWO_CAPTCHA_PROXY_USERNAME',
      'CAPTCHA_PROXY_USERNAME',
      'TWOCAPTCHA_PROXY_USER',
      'TWO_CAPTCHA_PROXY_USER',
      'CAPTCHA_PROXY_USER',
    ]);
  const password =
    twoCaptcha.password ||
    firstEnvValue([
      'TWOCAPTCHA_PROXY_PASSWORD',
      'TWO_CAPTCHA_PROXY_PASSWORD',
      'CAPTCHA_PROXY_PASSWORD',
      'TWOCAPTCHA_PROXY_PASS',
      'TWO_CAPTCHA_PROXY_PASS',
      'CAPTCHA_PROXY_PASS',
    ]);
  if (!host || !port) return null;
  const scopedUsername = twoCaptchaSessionUsername(username, twoCaptcha.account);
  return {
    type:
      twoCaptcha.type ||
      firstEnvValue(['TWOCAPTCHA_PROXY_TYPE', 'TWO_CAPTCHA_PROXY_TYPE', 'CAPTCHA_PROXY_TYPE']) ||
      'http',
    host,
    port: Number(port),
    username: scopedUsername,
    password,
  };
}

function efgProxyConfig(config = {}) {
  const url = config.url || firstEnvValue(['EFG_PROXY_URL', 'CRS_EFG_PROXY_URL']) || 'http://100.90.98.93:18088';
  const parsed = parseProxyUrl(url);
  if (parsed?.host && parsed?.port) return parsed;

  const host = config.host || firstEnvValue(['EFG_PROXY_HOST', 'CRS_EFG_PROXY_HOST']) || '100.90.98.93';
  const port = config.port || firstEnvValue(['EFG_PROXY_PORT', 'CRS_EFG_PROXY_PORT']) || '18088';
  return {
    type: config.type || firstEnvValue(['EFG_PROXY_TYPE', 'CRS_EFG_PROXY_TYPE']) || 'http',
    host,
    port: Number(port),
    username: config.username || firstEnvValue(['EFG_PROXY_USERNAME', 'CRS_EFG_PROXY_USERNAME']),
    password: config.password || firstEnvValue(['EFG_PROXY_PASSWORD', 'CRS_EFG_PROXY_PASSWORD']),
  };
}

function brightDataProxyConfig(bright = {}, key, accountIndex = 0) {
  bright = brightDataAliasConfig(bright);
  const user = bright.username || fileEnvValue('BRIGHT_DATA_USERID');
  const password =
    bright.password || firstEnvValue(['BRIGHT_DATA_PROXY_PASSWORD', 'BRIGHT_DATA_PASSWORD', 'BRIGHT_DATA_TOKEN']);
  if (!user || !password) return null;
  if (process.env.CLAUDE_ROTATION_USE_BRIGHTDATA_PROXY === '0' || bright.enabled === false) return null;
  return {
    type: bright.type || process.env.BRIGHT_DATA_PROXY_TYPE || 'http',
    host: bright.host || process.env.BRIGHT_DATA_HOST || 'brd.superproxy.io',
    port: Number(bright.port || process.env.BRIGHT_DATA_PORT || 33335),
    username: brightDataUsernameForAccount(user, bright, key, accountIndex),
    password,
  };
}

/**
 * Resolve a per-account rotation-proxy descriptor.
 *
 * Public contract (tests + simple installs):
 *   accountProxyConfig(config, account, env?)
 *   Requires env.CLAUDE_ROTATION_PROXY_ENABLED === '1' and a provider URL
 *   (EFG_PROXY_URL or BRIGHTDATA_PROXY_URL). Returns { type, host, port }.
 *
 * Ops fallback (when public env URL path is not used): config-driven Bright
 * Data / 2captcha / EFG with per-account sessions, reading secrets from env
 * files only — never hardcodes credentials.
 */
export function accountProxyConfig(config = {}, account, env = process.env) {
  // ── public contract ────────────────────────────────────────────────────
  if (env && typeof env === 'object' && env.CLAUDE_ROTATION_PROXY_ENABLED === '1') {
    const provider = String(env.CLAUDE_ROTATION_PROXY_PROVIDER || 'brightdata')
      .trim()
      .toLowerCase();
    const urlKey =
      provider === 'efg' || provider === 'unifi' || provider === 'home' || provider === 'gateway'
        ? 'EFG_PROXY_URL'
        : 'BRIGHTDATA_PROXY_URL';
    const raw = env[urlKey];
    if (raw && typeof raw === 'string' && raw.trim()) {
      const parsed = parseProxyUrlSimple(raw.trim());
      if (parsed) return parsed;
    }
    // Enabled but URL missing/invalid → null (do not fall through to rich path
    // when the public switch is explicitly on; keeps test contract strict).
    return null;
  }

  // ── ops-rich path (no public enable flag) ──────────────────────────────
  const cfg =
    config && typeof config === 'object' && Object.keys(config).length
      ? config
      : typeof loadRotationConfig === 'function'
        ? loadRotationConfig()
        : {};
  const key = accountKey(account);
  const direct = account?.proxy || account?.proxyConfig;
  if (direct) return direct;

  const byKey = cfg.crs?.proxyByVaultKey || cfg.crs?.proxies;
  if (byKey && typeof byKey === 'object' && byKey[key]) return byKey[key];

  if (!proxyRoutingEnabled(cfg)) return null;

  const bright = cfg.crs?.brightData || {};
  const twoCaptcha = cfg.crs?.twoCaptchaProxy || cfg.crs?.captchaProxy || {};
  const efg = cfg.crs?.efgProxy || cfg.crs?.efg || {};
  const accountIndex = Math.max(
    0,
    (cfg.accounts || []).findIndex((a) => accountKey(a) === key),
  );
  for (const provider of proxyProviderOrder(cfg)) {
    if (provider === 'efg' || provider === 'unifi' || provider === 'home' || provider === 'gateway') {
      const proxy = efgProxyConfig(efg);
      if (proxy) return proxy;
    }
    if (provider === '2captcha' || provider === 'twocaptcha' || provider === 'captcha') {
      const proxy = twoCaptchaProxyConfig({ ...twoCaptcha, account });
      if (proxy) return proxy;
    }
    if (provider === 'bright' || provider === 'brightdata' || provider === 'bright-data') {
      const proxy = brightDataProxyConfig(bright, key, accountIndex);
      if (proxy) return proxy;
    }
  }
  return null;
}

/** Simple URL parser for the public contract (type/host/port only). */
function parseProxyUrlSimple(raw) {
  if (!raw) return null;
  let s = raw.replace(/\/+$/, '');
  let type = 'http';
  if (s.startsWith('socks5://')) {
    type = 'socks5';
    s = s.slice('socks5://'.length);
  } else if (s.startsWith('socks5h://')) {
    type = 'socks5';
    s = s.slice('socks5h://'.length);
  } else if (s.startsWith('https://')) {
    type = 'http';
    s = s.slice('https://'.length);
  } else if (s.startsWith('http://')) {
    type = 'http';
    s = s.slice('http://'.length);
  } else {
    if (/[/?#]/.test(s)) return null;
  }
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.lastIndexOf(':');
  if (colon < 0) return null;
  const host = s.slice(0, colon).trim();
  const portStr = s.slice(colon + 1).trim();
  if (!host || /[\s/?#]/.test(host) || !/^\d+$/.test(portStr)) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { type, host, port };
}
