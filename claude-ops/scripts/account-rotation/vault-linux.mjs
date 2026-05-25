#!/usr/bin/env node
/**
 * vault-linux.mjs — Linux file-based credential vault
 *
 * Drop-in replacement for the macOS `security` keychain CLI.
 * No native dependencies — uses the filesystem only.
 *
 * Active credentials:  ~/.claude/.credentials.json  (Claude Code's own file)
 * Per-account vault:   ~/.local/share/claude-rotation/<sha256(service)[0:16]>.json (chmod 600)
 *
 * Exports (same interface consumed by rotate.mjs + daemon.mjs + keychain-swap.mjs):
 *   readEntry(service)          → raw JSON string or null
 *   writeEntry(service, json)   → void
 *   deleteEntry(service)        → void
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
export const ACTIVE_SERVICE = 'Claude Code-credentials';
const ACTIVE_CREDS_PATH = join(HOME, '.claude', '.credentials.json');
const VAULT_DIR = join(HOME, '.local', 'share', 'claude-rotation');

function ensureVaultDir() {
  mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
}

function vaultPath(service) {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 24);
  return join(VAULT_DIR, `${hash}.json`);
}

/**
 * Read a stored credential entry.
 * Returns raw JSON string on success, null if not found.
 */
export function readEntry(service) {
  if (service === ACTIVE_SERVICE) {
    if (!existsSync(ACTIVE_CREDS_PATH)) return null;
    try {
      return readFileSync(ACTIVE_CREDS_PATH, 'utf8').trim();
    } catch {
      return null;
    }
  }
  const p = vaultPath(service);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Write a credential entry.
 * Active-service writes go directly to ~/.claude/.credentials.json.
 * All others land in the vault dir as chmod-600 files.
 */
export function writeEntry(service, json) {
  if (service === ACTIVE_SERVICE) {
    writeFileSync(ACTIVE_CREDS_PATH, json, { mode: 0o600 });
    return;
  }
  ensureVaultDir();
  writeFileSync(vaultPath(service), json, { mode: 0o600 });
}

/**
 * Delete a vault entry (no-op for the active-service entry — never delete live creds).
 */
export function deleteEntry(service) {
  if (service === ACTIVE_SERVICE) return;
  const p = vaultPath(service);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}
