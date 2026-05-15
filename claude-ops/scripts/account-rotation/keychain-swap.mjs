/**
 * keychain-swap.mjs — minimal account-keychain swap helpers for claude-p-as.
 *
 * Reuses the same `security` CLI approach as rotate.mjs but is self-contained
 * so importing it has no side effects (rotate.mjs has top-level CLI execution).
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

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT =
  process.env.CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT || process.env.USER || process.env.LOGNAME || 'claude-ops';
const TOKEN_PREFIX = 'Claude-Rotation';

function accountKey(email, label) {
  return label ? `${email}|${label}` : email;
}

function tokenService(email, label) {
  return `${TOKEN_PREFIX}-${accountKey(email, label)}`;
}

function readSecurityEntry(svc, acct = KEYCHAIN_ACCOUNT) {
  const result = spawnSync('security', ['find-generic-password', '-s', svc, '-a', acct, '-g'], {
    timeout: 5000,
    encoding: 'utf8',
  });
  const out = (result.stdout || '') + (result.stderr || '');
  const m = out.match(/^password: "?(.*?)"?$/m);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"');
}

function writeSecurityEntry(json, svc, acct = KEYCHAIN_ACCOUNT) {
  try {
    execFileSync('security', ['delete-generic-password', '-s', svc, '-a', acct], { stdio: 'ignore' });
  } catch {
    /* not present, ignore */
  }
  execFileSync('security', ['add-generic-password', '-s', svc, '-a', acct, '-w', json], { timeout: 5000 });
}

export function readCurrentToken() {
  const json = readSecurityEntry(KEYCHAIN_SERVICE);
  if (!json) throw new Error(`No active Claude keychain entry (${KEYCHAIN_SERVICE})`);
  return json;
}

export function writeCurrentToken(json) {
  writeSecurityEntry(json, KEYCHAIN_SERVICE);
}

export function readStoredToken(email, label) {
  return readSecurityEntry(tokenService(email, label));
}

/**
 * Swap the active keychain to the given email's stored token.
 * Returns the previous (now-replaced) token JSON so the caller can restore it.
 * Throws if the target email has no stored token or it's malformed.
 */
export function swapToEmail(email, label) {
  const target = readStoredToken(email, label);
  if (!target) throw new Error(`No stored token for ${accountKey(email, label)} — run rotate.mjs --setup first`);
  // Validate target token is well-formed before clobbering current
  try {
    const parsed = JSON.parse(target);
    if (!parsed.claudeAiOauth) throw new Error('missing claudeAiOauth');
  } catch (e) {
    throw new Error(`Target token for ${email} is malformed: ${e.message}`);
  }
  const previous = readCurrentToken();
  // Preserve any current mcpOAuth (Figma, Shake, etc.) across the swap.
  try {
    const cur = JSON.parse(previous);
    const tgt = JSON.parse(target);
    if (cur.mcpOAuth && Object.keys(cur.mcpOAuth).length > 0) {
      tgt.mcpOAuth = { ...tgt.mcpOAuth, ...cur.mcpOAuth };
      writeCurrentToken(JSON.stringify(tgt));
      return previous;
    }
  } catch {
    /* fallthrough to plain swap */
  }
  writeCurrentToken(target);
  return previous;
}

export function restoreToken(prevJson) {
  if (!prevJson) return;
  writeCurrentToken(prevJson);
}
