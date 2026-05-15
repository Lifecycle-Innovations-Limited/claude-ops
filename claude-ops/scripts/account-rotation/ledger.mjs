/**
 * ledger.mjs — shared ledger schema, migration, and I/O helpers for
 * account-rotation scripts (kapture-claim-credits, claude-p-as).
 *
 * Schema v2 (canonical):
 * {
 *   "schema_version": 2,
 *   "month": "2026-06",
 *   "accounts": [
 *     {
 *       "email": "...",
 *       "cycle": "2026-06",
 *       "claimed": true,
 *       "remaining_usd": 200,
 *       "last_claim_at": "...",
 *       "last_call_at": "..."
 *     }
 *   ]
 * }
 *
 * v1 (legacy, auto-migrated on read):
 * {
 *   "version": 1,
 *   "accounts": { "<email>": { "<cycle>": { claimed, remaining_usd, ... } } }
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** Monthly Max plan credit grant in USD. */
export const MAX_PLAN_MONTHLY_USD = 200;

/** Current ledger schema version produced by this module. */
export const SCHEMA_VERSION = 2;

/**
 * Migrate a v1 (nested-object) ledger to v2 (flat array) in memory.
 * Returns a fresh v2 ledger object; does NOT write to disk.
 *
 * @param {object} v1
 * @returns {object}
 */
function migrateV1(v1) {
  const month = v1.month || _ymKey();
  const accounts = [];
  const raw = v1.accounts || {};
  for (const [email, cycles] of Object.entries(raw)) {
    if (typeof cycles !== 'object' || cycles === null) continue;
    // Find the most recent cycle entry
    const cycleKeys = Object.keys(cycles).sort();
    const latestCycle = cycleKeys[cycleKeys.length - 1] ?? month;
    const entry = cycles[latestCycle] ?? {};
    accounts.push({
      email,
      cycle: latestCycle,
      claimed: Boolean(entry.claimed),
      remaining_usd: entry.remaining_usd != null ? entry.remaining_usd : entry.claimed ? MAX_PLAN_MONTHLY_USD : null,
      last_claim_at: entry.claimed_at ?? null,
      last_call_at: entry.last_call_at ?? null,
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    month,
    accounts,
    _migrated_from_v1: true,
  };
}

/**
 * Returns "YYYY-MM" for the current UTC month.
 */
function _ymKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Read and validate (and migrate if needed) a ledger from disk.
 *
 * - Missing file → returns a fresh empty v2 ledger (no error).
 * - v1 shape detected → migrates in memory; caller should writeLedger to persist.
 * - Unknown schema_version → throws with exit-2-suitable message.
 *
 * @param {string} path  Absolute path to credits-ledger.json
 * @returns {object}     Validated v2 ledger object
 */
export function readLedger(path) {
  if (!existsSync(path)) {
    return { schema_version: SCHEMA_VERSION, month: _ymKey(), accounts: [] };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`ledger parse error at ${path}: ${e.message}`);
  }

  // v1 detection: no schema_version field AND accounts is a plain object (not array)
  if (!raw.schema_version && !Array.isArray(raw.accounts)) {
    return migrateV1(raw);
  }

  const ver = Number(raw.schema_version);
  if (ver !== SCHEMA_VERSION) {
    const err = new Error(
      `ledger schema_version ${raw.schema_version} is unknown (expected ${SCHEMA_VERSION}). ` +
        `Upgrade this script or manually migrate the ledger file at ${path}.`,
    );
    err.code = 'LEDGER_VERSION_MISMATCH';
    throw err;
  }

  if (!Array.isArray(raw.accounts)) {
    throw new Error(`ledger at ${path} has schema_version=${SCHEMA_VERSION} but accounts is not an array`);
  }

  return raw;
}

/**
 * Atomically write a ledger to disk (tmp + rename).
 *
 * @param {string} path
 * @param {object} ledger
 */
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Find an account entry by email (case-insensitive).
 *
 * @param {object} ledger
 * @param {string} email
 * @returns {object|undefined}
 */
export function findAccount(ledger, email) {
  if (!Array.isArray(ledger.accounts)) return undefined;
  return ledger.accounts.find((a) => a && typeof a.email === 'string' && a.email.toLowerCase() === email.toLowerCase());
}

/**
 * Upsert (insert or shallow-merge) an account entry in the ledger.
 * Mutates ledger.accounts in place; returns the updated account object.
 *
 * @param {object} ledger
 * @param {string} email
 * @param {object} patch   Partial account fields to set/overwrite
 * @returns {object}       The resulting account entry
 */
export function upsertAccount(ledger, email, patch) {
  if (!Array.isArray(ledger.accounts)) ledger.accounts = [];
  let a = findAccount(ledger, email);
  if (!a) {
    a = { email };
    ledger.accounts.push(a);
  }
  Object.assign(a, patch);
  return a;
}
