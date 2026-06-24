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
