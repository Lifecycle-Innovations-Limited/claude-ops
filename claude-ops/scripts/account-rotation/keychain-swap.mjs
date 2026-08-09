/**
 * keychain-swap.mjs — minimal account-keychain swap helpers for claude-p-as.
 *
 * Reuses the same `security` CLI approach as rotate.mjs but is self-contained
 * so importing it has no side effects (rotate.mjs has top-level CLI execution).
 *
 * Platform:
 *   macOS  — macOS security(1) Keychain
 *   Linux  — file-based vault via vault-linux.mjs
 *
 * Exports:
 *   - readCurrentToken()           → raw JSON string of active Claude credentials
 *   - writeCurrentToken(json)      → overwrite active Claude credentials
 *   - readStoredToken(email)       → per-account vault token (or null)
 *   - swapToEmail(email)           → save current to previous, install email's token,
 *                                    return previous token JSON for restoration
 *   - restoreToken(prevJson)       → write previous token back as active
 */

import { execFileSync, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireWriterCapability } from './auth-writer-coordination.mjs';
import { createVerifiedCredentialWriter, requireVerifiedCredentialCapability } from './verified-credential-write.mjs';

const IS_LINUX = process.platform === 'linux';
// Top-level await: pre-load vault on Linux so all exports stay synchronous.
const _vault = IS_LINUX ? await import('./vault-linux.mjs') : null;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || process.env.LOGNAME || 'claude-ops';
const TOKEN_PREFIX = 'Claude-Rotation';
const restorations = new WeakMap();

function accountKey(email, label) {
  return label ? `${email}|${label}` : email;
}

function tokenService(email, label) {
  return `${TOKEN_PREFIX}-${accountKey(email, label)}`;
}

// ── Low-level read/write — platform-aware ────────────────────────────────────

function readEntry(svc) {
  if (IS_LINUX) {
    return _vault.readEntry(svc);
  }
  const result = spawnSync('security', ['find-generic-password', '-s', svc, '-a', KEYCHAIN_ACCOUNT, '-g'], {
    timeout: 5000,
    encoding: 'utf8',
  });
  const out = (result.stdout || '') + (result.stderr || '');
  const m = out.match(/^password: "?(.*?)"?$/m);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"');
}

function writeEntryUnlocked(svc, json, capability) {
  if (IS_LINUX) {
    _vault.writeEntryCoordinated(svc, json, capability);
    return;
  }
  try {
    execFileSync('security', ['delete-generic-password', '-s', svc, '-a', KEYCHAIN_ACCOUNT], { stdio: 'ignore' });
  } catch {
    /* not present, ignore */
  }
  execFileSync('security', ['add-generic-password', '-s', svc, '-a', KEYCHAIN_ACCOUNT, '-w', json], {
    timeout: 5000,
  });
}

function writeVerifiedEntry(account, json, verifiedCapability, svc) {
  if (IS_LINUX) {
    // The Linux vault validates the exact account/bytes/destination binding and
    // obtains the still-live outer writer capability from the authorization.
    _vault.writeEntryIdentityPreserving(account, svc, json, undefined, verifiedCapability);
    return;
  }
  const writerCapability = requireVerifiedCredentialCapability(verifiedCapability, {
    account,
    credential: json,
    destination: svc,
  });
  writeEntryUnlocked(svc, json, writerCapability);
}

const verifiedEntryWrite = createVerifiedCredentialWriter({ write: writeVerifiedEntry });
const verifiedReadOnly = createVerifiedCredentialWriter({
  write: () => undefined,
  destination: (_account, _credential, destination) => destination,
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

// ── Public exports ───────────────────────────────────────────────────────────

export function readCurrentToken() {
  const json = readEntry(KEYCHAIN_SERVICE);
  if (!json) throw new Error(`No active Claude credential entry (${KEYCHAIN_SERVICE})`);
  return json;
}

export function writeCurrentToken() {
  throw new Error('LEGACY_CREDENTIAL_WRITE_FORBIDDEN');
}

export function readStoredToken(email, label) {
  return readEntry(tokenService(email, label));
}

/**
 * Swap the active token to the given email's stored token.
 * Returns the previous (now-replaced) token JSON so the caller can restore it.
 * Throws if the target email has no stored token or it's malformed.
 */
export function swapToEmail() {
  throw new Error('LEGACY_CREDENTIAL_WRITE_FORBIDDEN');
}

export async function swapToAccountCoordinated(account, previousAccount, capability) {
  throw new Error('SIGNED_CREDENTIAL_MUTATION_APPROVAL_REQUIRED');
}

export function restoreToken() {
  throw new Error('LEGACY_CREDENTIAL_WRITE_FORBIDDEN');
}

export async function restoreTokenCoordinated(authorization, prevJson, capability) {
  throw new Error('SIGNED_CREDENTIAL_MUTATION_APPROVAL_REQUIRED');
}
