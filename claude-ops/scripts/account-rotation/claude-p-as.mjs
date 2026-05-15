#!/usr/bin/env node
/**
 * claude-p-as — run `claude -p` as the highest-credit-remaining Max-OAuth account.
 *
 * Usage: claude-p-as [--pin <email>] [--ledger <path>] [--config <path>]
 *                    [--max-budget-usd <N>] -- <claude -p args>
 *
 * Behavior (per Wave 0 plan, activation 2026-06-15):
 *   1. Read ~/.claude/credits-ledger.json (v2 schema). Refuse if missing.
 *   2. Filter accounts with remaining_usd > 0. Pinned account honored if set.
 *   3. Verify selected account is not flagged extra_usage: true (post-2026-04-21 guard).
 *   4. flock on ~/.claude/keychain.lock (O_EXCL atomic).
 *   5. Swap active Claude keychain to that account's stored OAuth token.
 *   6. Probe `--max-budget-usd` availability AFTER swap (P1b fix).
 *   7. Run `claude -p <args> --max-budget-usd <cap>` (cap = min(200, user-supplied, account remaining_usd)).
 *   8. On exit (any signal), restore prior keychain & release lock.
 *   9. Scan BOTH stdout and stderr for cost (P1a fix). Refuse to decrement if parse fails.
 *
 * Refusal cases (exit code 2):
 *   - Ledger file missing
 *   - Unknown ledger schema_version
 *   - All accounts at $0  ("credit exhausted, resets day 1 of next month")
 *   - Pinned account at $0
 *   - Selected account has extra_usage: true
 *   - `claude --max-budget-usd` flag unavailable in target account's CLI (checked post-swap)
 *   - Cost parse failed after invocation
 *
 * No network calls from this script (only the `claude -p` subprocess).
 * No user prompts.
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { spawnSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, constants } from 'os';

import { swapToEmail, restoreToken } from './keychain-swap.mjs';
import { readLedger, writeLedger, findAccount, upsertAccount } from './ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER = join(homedir(), '.claude', 'credits-ledger.json');
const DEFAULT_CONFIG = join(__dirname, 'config.json');
const DEFAULT_LOCK = join(homedir(), '.claude', 'keychain.lock');
const HARD_CAP_USD = 200;

function die(code, msg) {
  process.stderr.write(`[claude-p-as] ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { pin: null, ledger: DEFAULT_LEDGER, config: DEFAULT_CONFIG, lock: DEFAULT_LOCK, budget: null, rest: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a === '--pin' && argv[i + 1]) {
      out.pin = argv[++i + 0];
      i++;
      continue;
    }
    if (a === '--ledger' && argv[i + 1]) {
      out.ledger = argv[++i + 0];
      i++;
      continue;
    }
    if (a === '--config' && argv[i + 1]) {
      out.config = argv[++i + 0];
      i++;
      continue;
    }
    if (a === '--lock' && argv[i + 1]) {
      out.lock = argv[++i + 0];
      i++;
      continue;
    }
    if (a === '--max-budget-usd' && argv[i + 1]) {
      out.budget = Number(argv[++i + 0]);
      i++;
      continue;
    }
    // Unknown leading flag — treat remainder as claude args
    out.rest = argv.slice(i);
    break;
  }
  return out;
}

function pickAccount(ledger, pin) {
  const accts = (ledger.accounts || []).filter((a) => a && a.email);
  if (!accts.length) die(2, 'ledger has no accounts');
  if (pin) {
    const found = accts.find((a) => a.email.toLowerCase() === pin.toLowerCase());
    if (!found) die(2, `pinned account not in ledger: ${pin}`);
    if (!(Number(found.remaining_usd) > 0))
      die(2, `pinned account ${pin} credit exhausted, resets day 1 of next month`);
    return found;
  }
  const live = accts.filter((a) => Number(a.remaining_usd) > 0);
  if (!live.length) die(2, 'all accounts $0 — credit exhausted, resets day 1 of next month');
  live.sort((x, y) => Number(y.remaining_usd) - Number(x.remaining_usd));
  return live[0];
}

function assertNotExtraUsage(account, configPath) {
  // Ledger may carry its own flag; if not, consult account-rotation config.json
  if (account.extra_usage === true || account.extraUsageEnabled === true)
    die(2, `account ${account.email} has extra_usage=true — refusing to bill against paid overage`);
  if (!existsSync(configPath)) return;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const match = (cfg.accounts || []).find((a) => a.email && a.email.toLowerCase() === account.email.toLowerCase());
    if (match && (match.extraUsageEnabled === true || match.extra_usage === true))
      die(2, `account ${account.email} has extraUsageEnabled=true in config — refusing to bill against paid overage`);
  } catch (e) {
    process.stderr.write(`[claude-p-as] warning: could not read config ${configPath}: ${e.message}\n`);
  }
}

/**
 * P1b fix: probe must run AFTER keychain swap so it tests the target account's CLI install.
 * Call this AFTER swapToEmail() succeeds, BEFORE spawning claude -p.
 */
function assertBudgetFlagAvailable() {
  const r = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 8000 });
  const helpText = (r.stdout || '') + (r.stderr || '');
  if (!helpText.match(/--max-budget-usd/))
    die(2, '`claude --max-budget-usd` not available in installed CLI — refusing to run without hard cap');
}

function acquireLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      let owner = '';
      try {
        owner = readFileSync(lockPath, 'utf8').trim();
      } catch {
        /* ignore */
      }
      die(2, `keychain lock held (${lockPath}, pid=${owner || 'unknown'}) — another rotation/claude-p-as in flight`);
    }
    die(2, `failed to acquire lock ${lockPath}: ${e.message}`);
  }
  writeFileSync(lockPath, String(process.pid));
  return fd;
}

function releaseLock(fd, lockPath) {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

function effectiveBudget(userBudget, remainingUsd) {
  const cap =
    userBudget == null || Number.isNaN(userBudget) ? HARD_CAP_USD : Math.min(HARD_CAP_USD, Math.max(0, userBudget));
  const rem = Number(remainingUsd);
  if (Number.isFinite(rem) && rem >= 0) return Math.min(cap, rem);
  return cap;
}

/**
 * P1a fix: scan BOTH stdout and stderr for cost markers.
 * Match the LAST dollar amount in either stream (stderr overrides stdout since
 * it carries the real usage summary; stdout is model text that may contain
 * dollar amounts as false positives).
 *
 * Returns null if no match; caller must refuse to decrement on null.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {number|null}
 */
function parseUsageCost(stdout, stderr) {
  // Two-pass: collect ALL matches from stdout first, then stderr.
  // Last match wins (stderr results shadow stdout false-positives).
  const PATTERN =
    /(?:\$([0-9]+(?:\.[0-9]+)?)[ \t]*(?:used|total|cost|spend))|(?:(?:total|cost|spend)[^$\n]*\$([0-9]+(?:\.[0-9]+)?))/gi;

  let lastValue = null;

  for (const text of [stdout || '', stderr || '']) {
    let m;
    while ((m = PATTERN.exec(text)) !== null) {
      const raw = m[1] ?? m[2];
      const v = Number(raw);
      if (!Number.isNaN(v) && v >= 0) lastValue = v;
    }
    PATTERN.lastIndex = 0;
  }

  return lastValue;
}

function decrementLedger(ledgerPath, email, amount) {
  let ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch (e) {
    process.stderr.write(`[claude-p-as] warning: post-call ledger read failed: ${e.message}\n`);
    return;
  }
  const a = findAccount(ledger, email);
  if (!a) return;
  upsertAccount(ledger, email, {
    remaining_usd: Math.max(0, Number(a.remaining_usd || 0) - Number(amount)),
    last_call_at: new Date().toISOString(),
  });
  try {
    writeLedger(ledgerPath, ledger);
  } catch (e) {
    process.stderr.write(`[claude-p-as] warning: ledger write failed: ${e.message}\n`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);

  if (!existsSync(opts.ledger))
    die(
      2,
      `ledger missing: ${opts.ledger} — run kapture redemption sweep first (Wave 1 day-1) or pass --ledger <path>`,
    );

  let ledger;
  try {
    ledger = readLedger(opts.ledger);
  } catch (e) {
    die(2, `ledger unreadable: ${e.message}`);
  }

  const account = pickAccount(ledger, opts.pin);
  assertNotExtraUsage(account, opts.config);

  // P1b fix: do NOT call assertBudgetFlagAvailable() here — it runs post-swap below.

  const budget = effectiveBudget(opts.budget, account.remaining_usd);

  // Acquire lock BEFORE any keychain mutation.
  const lockFd = acquireLock(opts.lock);

  // Swap keychain.
  let previousToken = null;
  try {
    previousToken = swapToEmail(account.email, account.label);
  } catch (e) {
    releaseLock(lockFd, opts.lock);
    die(2, `keychain swap failed: ${e.message}`);
  }

  // Wire restoration on every exit path BEFORE spawning child.
  let restored = false;
  const restoreOnce = () => {
    if (restored) return;
    restored = true;
    try {
      if (previousToken) restoreToken(previousToken);
    } catch (e) {
      process.stderr.write(`[claude-p-as] warning: failed to restore previous keychain: ${e.message}\n`);
    }
    releaseLock(lockFd, opts.lock);
  };
  process.on('exit', restoreOnce);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      restoreOnce();
      const n = constants.signals[sig];
      process.exit(n == null ? 130 : 128 + n);
    });
  }

  // P1b fix: probe --max-budget-usd AFTER swap — now tests target account's CLI env.
  assertBudgetFlagAvailable();

  // Build claude args. Strip user-supplied --max-budget-usd if present, then prefix our floor.
  const userArgs = [];
  for (let i = 0; i < opts.rest.length; i++) {
    const a = opts.rest[i];
    if (a.startsWith('--max-budget-usd=')) {
      continue;
    }
    if (a === '--max-budget-usd' && opts.rest[i + 1] != null) {
      i++; // skip the value too
      continue;
    }
    userArgs.push(a);
  }
  const finalArgs = ['-p', '--max-budget-usd', String(budget), ...userArgs];

  // Spawn claude. Stream output through; collect for cost parsing.
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn('claude', finalArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => {
    stdoutChunks.push(b);
    process.stdout.write(b);
  });
  child.stderr.on('data', (b) => {
    stderrChunks.push(b);
    process.stderr.write(b);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code, signal) => {
      if (signal) {
        const n = constants.signals[signal];
        resolve(n == null ? 128 : 128 + n);
      } else {
        resolve(code ?? 1);
      }
    });
    child.on('error', (e) => {
      process.stderr.write(`[claude-p-as] spawn failed: ${e.message}\n`);
      resolve(127);
    });
  });

  // P1a fix: scan both streams; refuse (exit 2) if parse fails — never silently floor at $0.01.
  const out = Buffer.concat(stdoutChunks).toString('utf8');
  const err = Buffer.concat(stderrChunks).toString('utf8');
  const cost = parseUsageCost(out, err);
  if (cost == null) {
    process.stderr.write('[claude-p-as] cost parse failed; refusing to decrement; check claude CLI output format\n');
    restoreOnce();
    process.exit(2);
  }
  decrementLedger(opts.ledger, account.email, cost);

  restoreOnce();
  process.exit(exitCode);
}

// Pure-import guard so tests can require helpers without triggering CLI.
const invokedAsCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsCli) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`[claude-p-as] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

export { parseArgs, pickAccount, assertNotExtraUsage, effectiveBudget, parseUsageCost, decrementLedger };
