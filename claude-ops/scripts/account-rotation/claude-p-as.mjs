#!/usr/bin/env node
/**
 * claude-p-as — run `claude -p` as the highest-credit-remaining Max-OAuth account.
 *
 * Usage: claude-p-as [--pin <email>] [--ledger <path>] [--config <path>]
 *                    [--max-budget-usd <N>] -- <claude -p args>
 *
 * Behavior (per Wave 0 plan, activation 2026-06-15):
 *   1. Read ~/.claude/credits-ledger.json. Refuse if missing.
 *   2. Filter accounts with remaining_usd > 0. Pinned account honored if set.
 *   3. Verify selected account is not flagged extra_usage: true (post-2026-04-21 guard).
 *   4. flock on ~/.claude/keychain.lock (O_EXCL atomic).
 *   5. Swap active Claude keychain to that account's stored OAuth token.
 *   6. Run `claude -p <args> --max-budget-usd <cap>` (cap = min(200, user-supplied)).
 *   7. On exit (any signal), restore prior keychain & release lock.
 *   8. Best-effort parse usage from claude output → decrement remaining_usd atomically.
 *
 * Refusal cases (exit code 2):
 *   - Ledger file missing
 *   - All accounts at $0  ("credit exhausted, resets day 1 of next month")
 *   - Pinned account at $0
 *   - Selected account has extra_usage: true
 *   - `claude --max-budget-usd` flag unavailable in installed CLI
 *
 * No network calls from this script (only the `claude -p` subprocess).
 * No user prompts.
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from 'fs';
import { spawnSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, constants } from 'os';

import { swapToEmail, restoreToken } from './keychain-swap.mjs';

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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
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
    const cfg = readJson(configPath);
    const match = (cfg.accounts || []).find((a) => a.email && a.email.toLowerCase() === account.email.toLowerCase());
    if (match && (match.extraUsageEnabled === true || match.extra_usage === true))
      die(2, `account ${account.email} has extraUsageEnabled=true in config — refusing to bill against paid overage`);
  } catch (e) {
    process.stderr.write(`[claude-p-as] warning: could not read config ${configPath}: ${e.message}\n`);
  }
}

function assertBudgetFlagAvailable() {
  const r = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 8000 });
  const helpText = (r.stdout || '') + (r.stderr || '');
  if (!helpText.match(/--max-budget-usd/))
    die(2, '`claude --max-budget-usd` not available in installed CLI — refusing to run without hard cap');
}

function acquireLock(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(lockPath, String(process.pid));
    return fd;
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

function effectiveBudget(userBudget) {
  if (userBudget == null || Number.isNaN(userBudget)) return HARD_CAP_USD;
  return Math.min(HARD_CAP_USD, Math.max(0, userBudget));
}

function parseUsageCost(stdout, stderr) {
  // Best-effort parse — claude prints things like "Cost: $0.0123" on completion.
  const text = (stdout || '') + '\n' + (stderr || '');
  const m = text.match(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:total|cost|spend)/i) || text.match(/cost[^$]*\$([0-9.]+)/i);
  if (m) {
    const v = Number(m[1]);
    if (!Number.isNaN(v) && v >= 0) return v;
  }
  return null;
}

function decrementLedger(ledgerPath, email, amount) {
  let ledger;
  try {
    ledger = readJson(ledgerPath);
  } catch (e) {
    process.stderr.write(`[claude-p-as] warning: post-call ledger read failed: ${e.message}\n`);
    return;
  }
  const a = (ledger.accounts || []).find((x) => x.email && x.email.toLowerCase() === email.toLowerCase());
  if (!a) return;
  a.remaining_usd = Math.max(0, Number(a.remaining_usd || 0) - Number(amount));
  a.last_call_at = new Date().toISOString();
  try {
    atomicWriteJson(ledgerPath, ledger);
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
    ledger = readJson(opts.ledger);
  } catch (e) {
    die(2, `ledger unreadable: ${e.message}`);
  }

  const account = pickAccount(ledger, opts.pin);
  assertNotExtraUsage(account, opts.config);
  assertBudgetFlagAvailable();

  const budget = effectiveBudget(opts.budget);

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

  // Build claude args. Strip user-supplied --max-budget-usd if present, then append our floor.
  const userArgs = [];
  for (let i = 0; i < opts.rest.length; i++) {
    const a = opts.rest[i];
    if (a === '--max-budget-usd' && opts.rest[i + 1] != null) {
      i++; // skip the value too
      continue;
    }
    userArgs.push(a);
  }
  const finalArgs = ['-p', ...userArgs, '--max-budget-usd', String(budget)];

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
    child.on('exit', (code, signal) => {
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

  // Best-effort cost parse + ledger decrement.
  const out = Buffer.concat(stdoutChunks).toString('utf8');
  const err = Buffer.concat(stderrChunks).toString('utf8');
  let cost = parseUsageCost(out, err);
  if (cost == null) {
    cost = 0.01; // conservative floor when parse fails — avoids zero-decrement drift
    process.stderr.write('[claude-p-as] warning: usage cost not parsed from output; decrementing $0.01 floor\n');
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
