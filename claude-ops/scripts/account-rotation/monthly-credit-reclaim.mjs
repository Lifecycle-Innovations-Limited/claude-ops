#!/usr/bin/env node
/* eslint-disable no-console */

// ──────────────────────────────────────────────────────────────────────────────
//  monthly-credit-reclaim.mjs
//  Day-1 09:00 monthly cron entrypoint.
//
//  Sequence:
//    1. Snapshot pre-run ledger so we can compute prior-month consumption.
//    2. Invoke kapture-claim-credits.mjs --live to re-claim the $200 Agent SDK
//       credit on each of the ~7 Max accounts registered in config.json.
//    3. Re-read the ledger and compute the prior-month delta:
//         claimed_usd  = sum of accounts that successfully claimed last cycle
//         consumed_usd = sum of (granted − remaining) just before re-claim
//         waste_pct    = unclaimed_pool / total_pool      (× 100, rounded)
//       Pool size = MAX_PLAN_MONTHLY_USD × account_count.
//    4. Post a Slack summary (env: SLACK_WEBHOOK_URL) AND fan-out via
//       scripts/ops-notify.sh (Discord / ntfy / Telegram / Pushover are picked
//       up automatically when their env vars are present).
//
//  CLI:
//    --dry-run     Print the planned Slack payload + skip the live claim.
//                  (Forwards --dry-run intent to kapture-claim-credits.mjs by
//                  NOT passing --live.)
//    --skip-claim  Compute + post the summary only; do not invoke the claimer
//                  (useful for re-posting after a manual claim).
//    --help        Print this header.
//
//  Exit codes:
//    0  success (claim ran AND summary posted, or dry-run plan printed)
//    1  partial — claim ran but Slack post failed (logged, do not retry inside
//                 the same window; cron will catch the next month)
//    2  hard failure (missing config, ledger schema mismatch, claimer crashed)
// ──────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { MAX_PLAN_MONTHLY_USD, readLedger, findAccount, ymKey } from './ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIMER = join(__dirname, 'kapture-claim-credits.mjs');
const CONFIG_PATH = join(__dirname, 'config.json');
const LEDGER_PATH = join(homedir(), '.claude', 'credits-ledger.json');
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const LOG_DIR = join(DATA_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'monthly-credit-reclaim.log');
const NOTIFY_SCRIPT = join(__dirname, '..', 'ops-notify.sh');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const DRY_RUN = flag('--dry-run');
const SKIP_CLAIM = flag('--skip-claim');

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
  console.log(line);
}

function priorMonthKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return ymKey(d);
}

function loadAccountsConfig() {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return (cfg.accounts ?? []).filter((a) => a?.email);
  } catch {
    return [];
  }
}

function snapshotLedger() {
  // readLedger handles missing file (returns empty v2 ledger) and v1→v2 migration.
  // Safe to call even when the claimer has never run.
  try {
    return readLedger(LEDGER_PATH);
  } catch (e) {
    log(`[fatal] ledger read failed: ${e.message}`);
    process.exit(2);
  }
}

function runClaimer() {
  if (SKIP_CLAIM) {
    log('[monthly-reclaim] --skip-claim set; not invoking kapture-claim-credits.mjs');
    return { code: 0, signal: null };
  }
  if (DRY_RUN) {
    log('[monthly-reclaim] DRY RUN — would invoke:');
    log(`  node ${CLAIMER} --live`);
    return { code: 0, signal: null, dryRun: true };
  }
  log(`[monthly-reclaim] invoking ${CLAIMER} --live`);
  const res = spawnSync(process.execPath, [CLAIMER, '--live'], {
    stdio: 'inherit',
    env: process.env,
  });
  return { code: res.status, signal: res.signal };
}

/**
 * Build the consumption summary for the prior month from the pre-run ledger.
 * Pre-run ledger holds last cycle's `claimed` + `remaining_usd` BEFORE the
 * new month's claim overwrites them.
 */
function buildPriorMonthSummary(preLedger, accountsConfig) {
  // "Prior cycle" = whatever cycle the pre-run ledger holds, UNLESS that cycle
  // is the current month or later (e.g. ledger was just provisioned, not yet
  // claimed against), in which case we fall back to "last calendar month".
  const ledgerCycle = preLedger.month;
  const currentCycle = ymKey();
  const priorCycle = ledgerCycle && ledgerCycle < currentCycle ? ledgerCycle : priorMonthKey();
  const accounts = accountsConfig.length ? accountsConfig : (preLedger.accounts || []).map((a) => ({ email: a.email }));
  const poolUsd = MAX_PLAN_MONTHLY_USD * accounts.length;

  let claimedUsd = 0;
  let consumedUsd = 0;
  let unclaimedCount = 0;
  const perAccount = [];

  for (const cfg of accounts) {
    const entry = findAccount(preLedger, cfg.email);
    const claimed = !!entry?.claimed;
    const remaining = typeof entry?.remaining_usd === 'number' ? entry.remaining_usd : null;
    const granted = claimed ? MAX_PLAN_MONTHLY_USD : 0;
    const consumed = claimed && remaining != null ? Math.max(0, granted - remaining) : null;
    if (claimed) claimedUsd += granted;
    else unclaimedCount += 1;
    if (consumed != null) consumedUsd += consumed;
    perAccount.push({ email: cfg.email, claimed, remaining_usd: remaining, consumed_usd: consumed });
  }

  const unclaimedPoolUsd = poolUsd - claimedUsd;
  const wastePct = poolUsd > 0 ? Math.round((unclaimedPoolUsd / poolUsd) * 100) : 0;

  return {
    priorCycle,
    accountCount: accounts.length,
    poolUsd,
    claimedUsd,
    unclaimedPoolUsd,
    unclaimedCount,
    consumedUsd,
    wastePct,
    perAccount,
  };
}

function formatSlackBody(summary, postClaimSummary, { dryRun = false, skipClaim = false } = {}) {
  const lines = [];
  lines.push(`Monthly Anthropic credit reclaim — ${ymKey()} (prior cycle ${summary.priorCycle})`);
  lines.push('');
  lines.push(`Pool: $${summary.poolUsd} (${summary.accountCount} × $${MAX_PLAN_MONTHLY_USD})`);
  lines.push(`Claimed last month: $${summary.claimedUsd}`);
  lines.push(
    `Unclaimed pool: $${summary.unclaimedPoolUsd} (${summary.wastePct}% waste, ${summary.unclaimedCount} accounts skipped)`,
  );
  lines.push(`Consumed last month: $${summary.consumedUsd}`);
  lines.push('');
  if (postClaimSummary) {
    lines.push(`This cycle: ${postClaimSummary.claimedCount}/${summary.accountCount} accounts re-claimed`);
    if (postClaimSummary.failed.length) {
      lines.push(`Failed: ${postClaimSummary.failed.join(', ')}`);
    }
  } else if (dryRun) {
    lines.push('(dry-run — no claim attempted)');
  } else if (skipClaim) {
    lines.push('(--skip-claim — ledger unchanged this run)');
  }
  return lines.join('\n');
}

function summarizePostClaim(postLedger, accountsConfig) {
  const cycle = ymKey();
  const accounts = accountsConfig.length
    ? accountsConfig
    : (postLedger.accounts || []).map((a) => ({ email: a.email }));
  let claimedCount = 0;
  const failed = [];
  for (const cfg of accounts) {
    const e = findAccount(postLedger, cfg.email);
    if (e?.claimed && e.cycle === cycle) claimedCount += 1;
    else failed.push(cfg.email);
  }
  return { claimedCount, failed };
}

async function postSlack(body) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    log('[monthly-reclaim] SLACK_WEBHOOK_URL not set — skipping Slack post');
    return { ok: true, skipped: true };
  }
  if (DRY_RUN) {
    log('[monthly-reclaim] DRY RUN — Slack payload below:');
    log(body);
    return { ok: true, dryRun: true };
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log(`[monthly-reclaim] Slack post failed: ${res.status} ${txt.slice(0, 200)}`);
      return { ok: false };
    }
    log('[monthly-reclaim] Slack post OK');
    return { ok: true };
  } catch (e) {
    log(`[monthly-reclaim] Slack post threw: ${e.message}`);
    return { ok: false };
  }
}

function fanOutNotify(severity, title, body) {
  if (DRY_RUN) {
    log(`[monthly-reclaim] DRY RUN — would fan-out via ops-notify (${severity}): ${title}`);
    return;
  }
  if (!existsSync(NOTIFY_SCRIPT)) return;
  try {
    spawnSync(NOTIFY_SCRIPT, [severity, title, body], {
      stdio: 'ignore',
      env: process.env,
    });
  } catch (e) {
    log(`[monthly-reclaim] ops-notify fan-out failed: ${e.message}`);
  }
}

async function main() {
  log(`[monthly-reclaim] start cycle=${ymKey()} dry-run=${DRY_RUN} skip-claim=${SKIP_CLAIM}`);

  const accountsConfig = loadAccountsConfig();
  const preLedger = snapshotLedger();
  const priorSummary = buildPriorMonthSummary(preLedger, accountsConfig);

  const claim = runClaimer();
  if (claim.code !== 0 && !claim.dryRun) {
    log(`[monthly-reclaim] claimer exited code=${claim.code} signal=${claim.signal}`);
    fanOutNotify(
      'HIGH',
      'Monthly credit reclaim FAILED',
      `kapture-claim-credits.mjs exited ${claim.code}. Cycle ${ymKey()} claim incomplete.`,
    );
    // Continue to post the prior-month summary anyway — operator still needs visibility.
  }

  const postLedger = snapshotLedger();
  const postClaim = SKIP_CLAIM || DRY_RUN ? null : summarizePostClaim(postLedger, accountsConfig);

  const body = formatSlackBody(priorSummary, postClaim, { dryRun: DRY_RUN, skipClaim: SKIP_CLAIM });
  const slack = await postSlack(body);

  const title = `Monthly credit reclaim — ${priorSummary.wastePct}% waste last month`;
  const severity = priorSummary.wastePct >= 30 ? 'HIGH' : 'LOW';
  fanOutNotify(severity, title, body);

  if (claim.code !== 0 && !claim.dryRun) process.exit(2);
  if (!slack.ok && !slack.skipped) process.exit(1);
  log('[monthly-reclaim] done');
}

// Only run main() when executed directly (not when imported by tests).
const _entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === _entryPath) {
  if (flag('--help') || flag('-h')) {
    console.log(readFileSync(_entryPath, 'utf8').split('\n').slice(0, 44).join('\n'));
    process.exit(0);
  }
  main().catch((e) => {
    log(`[fatal] ${e.stack || e.message}`);
    process.exit(2);
  });
}

// Test exports
export { buildPriorMonthSummary, summarizePostClaim, formatSlackBody, ymKey, priorMonthKey };
