#!/usr/bin/env node
/* eslint-disable no-console */

// ──────────────────────────────────────────────────────────────────────────────
//  daily-credit-digest.mjs
//  Daily 09:00 cron entrypoint (HEA-4047).
//
//  Posts a Slack digest of Anthropic credit-pool health:
//    1. Per-account remaining balance (read from credits-ledger.json — same
//       file HEA-4049's monthly reclaimer writes).
//    2. 7-day burn rate per account + total (computed from a rolling JSONL
//       snapshot ledger at ~/.claude/credit-snapshots.jsonl that this script
//       appends to on every run).
//    3. Month-end projection: remaining_now − (days_left_in_month × daily_burn),
//       expressed as "$X consumed of $1400 pool (Y%)".
//    4. Anthropic→Bedrock fallback ratio over the last 24h, read from
//       CloudWatch (namespace Healify/LLM, metrics bedrock_fallback_count +
//       anthropic_credit_hit established by HEA-4045). Graceful skip with a
//       warning line if CloudWatch read fails or metrics are absent.
//    5. Severity escalation via scripts/ops-notify.sh:
//         HIGH  → projected_consumption_pct >= 90  OR  fallback_ratio >= 0.30
//         LOW   → otherwise
//
//  CLI:
//    --dry-run        Print the planned Slack body + severity; do NOT post or
//                     fan-out, and do NOT append today's snapshot to the JSONL.
//    --skip-snapshot  Compute + post but do not append today's snapshot
//                     (useful for re-posting after a manual rerun).
//    --help           Print this header.
//
//  Exit codes:
//    0  success (digest posted, or dry-run plan printed)
//    1  partial — digest computed but Slack post failed (logged)
//    2  hard failure (missing config, ledger schema mismatch, snapshot append crash)
// ──────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { MAX_PLAN_MONTHLY_USD, readLedger, findAccount, ymKey } from './ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const LEDGER_PATH = join(homedir(), '.claude', 'credits-ledger.json');
const SNAPSHOTS_PATH = join(homedir(), '.claude', 'credit-snapshots.jsonl');
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const LOG_DIR = join(DATA_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'daily-credit-digest.log');
const NOTIFY_SCRIPT = join(__dirname, '..', 'ops-notify.sh');

const CLOUDWATCH_NAMESPACE = 'Healify/LLM';
const CLOUDWATCH_FALLBACK_METRIC = 'bedrock_fallback_count';
const CLOUDWATCH_HIT_METRIC = 'anthropic_credit_hit';

// Thresholds.
export const SEVERITY_HIGH_PROJECTED_PCT = 90;
export const SEVERITY_HIGH_FALLBACK_RATIO = 0.3;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const DRY_RUN = flag('--dry-run');
const SKIP_SNAPSHOT = flag('--skip-snapshot');

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
  console.log(line);
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

/**
 * Read all historical snapshots from the JSONL file.
 * Returns an array of { ts: ISO, email: string, remaining_usd: number, cycle: string }
 * Missing file → empty array.
 */
export function readSnapshotHistory(path = SNAPSHOTS_PATH) {
  if (!existsSync(path)) return [];
  try {
    const txt = readFileSync(path, 'utf8');
    const lines = txt.split('\n').filter((l) => l.trim());
    const rows = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row.email === 'string' && typeof row.ts === 'string') {
          rows.push(row);
        }
      } catch {
        /* skip malformed line */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Append today's per-account snapshot to the JSONL log.
 */
function appendSnapshot(ledger, accountsConfig, path = SNAPSHOTS_PATH) {
  const ts = new Date().toISOString();
  const accounts = accountsConfig.length ? accountsConfig : (ledger.accounts || []).map((a) => ({ email: a.email }));
  const rows = [];
  for (const cfg of accounts) {
    const entry = findAccount(ledger, cfg.email);
    const remaining = typeof entry?.remaining_usd === 'number' ? entry.remaining_usd : null;
    if (remaining == null) continue;
    rows.push({ ts, email: cfg.email, remaining_usd: remaining, cycle: entry?.cycle ?? null });
  }
  if (!rows.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * Compute 7-day burn rate per account ($/day) from snapshot history.
 *
 * For each account: find the oldest snapshot >= (now - 7d) within the SAME cycle
 * as the current snapshot, and the latest snapshot. burn = (older.remaining -
 * latest.remaining) / days_elapsed. If older == latest (same day, only one
 * snapshot), burn = 0. If no historical snapshot in window, burn = null.
 *
 * Returns { perAccount: [{ email, dailyBurnUsd, windowDays }], totalDailyBurnUsd }.
 *
 * @param {Array} history          rows from readSnapshotHistory
 * @param {Array} accountsConfig   account configs (provides email list)
 * @param {Object} currentLedger   current ledger (provides "now" balance + cycle)
 * @param {Date}   now             current time
 */
export function computeBurnRate(history, accountsConfig, currentLedger, now = new Date()) {
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const perAccount = [];
  let totalDailyBurnUsd = 0;

  const accounts = accountsConfig.length
    ? accountsConfig
    : (currentLedger.accounts || []).map((a) => ({ email: a.email }));

  for (const cfg of accounts) {
    const current = findAccount(currentLedger, cfg.email);
    const currentRemaining = typeof current?.remaining_usd === 'number' ? current.remaining_usd : null;
    const currentCycle = current?.cycle ?? null;

    if (currentRemaining == null) {
      perAccount.push({ email: cfg.email, dailyBurnUsd: null, windowDays: 0 });
      continue;
    }

    // Filter history to this account + same cycle (avoid burn-rate spike from
    // monthly reset where remaining jumps from ~0 back to 200).
    const rows = history
      .filter((r) => r.email.toLowerCase() === cfg.email.toLowerCase())
      .filter((r) => (currentCycle == null ? true : r.cycle === currentCycle))
      .filter((r) => new Date(r.ts).getTime() >= sevenDaysAgoMs)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    if (rows.length === 0) {
      perAccount.push({ email: cfg.email, dailyBurnUsd: null, windowDays: 0 });
      continue;
    }

    const oldest = rows[0];
    const oldestMs = new Date(oldest.ts).getTime();
    const elapsedMs = now.getTime() - oldestMs;
    const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);

    if (elapsedDays <= 0) {
      perAccount.push({ email: cfg.email, dailyBurnUsd: 0, windowDays: 0 });
      continue;
    }

    const consumed = oldest.remaining_usd - currentRemaining;
    // Negative burn (e.g. mid-cycle re-claim or a glitch) → clamp to 0.
    const dailyBurn = consumed > 0 ? consumed / elapsedDays : 0;
    totalDailyBurnUsd += dailyBurn;
    perAccount.push({ email: cfg.email, dailyBurnUsd: dailyBurn, windowDays: elapsedDays });
  }

  return { perAccount, totalDailyBurnUsd };
}

/**
 * Days remaining in the current calendar month (UTC), inclusive of today.
 * E.g. on 2026-05-19, May has 31 days → 31 - 19 + 1 = 13 days remaining.
 */
export function daysRemainingInMonth(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return lastDay - now.getUTCDate() + 1;
}

/**
 * Compute month-end projection.
 *
 * Returns {
 *   currentRemainingUsd,      // sum across accounts right now
 *   poolUsd,                  // accountCount * MAX_PLAN_MONTHLY_USD
 *   currentConsumedUsd,       // poolUsd - currentRemainingUsd
 *   currentConsumedPct,
 *   projectedConsumedUsd,     // poolUsd - (currentRemainingUsd - daysLeft*burn), clamped [0, poolUsd]
 *   projectedConsumedPct,
 *   daysRemaining,
 * }
 */
export function projectMonthEnd(currentLedger, accountsConfig, totalDailyBurnUsd, now = new Date()) {
  const accounts = accountsConfig.length
    ? accountsConfig
    : (currentLedger.accounts || []).map((a) => ({ email: a.email }));
  const accountCount = accounts.length;
  const poolUsd = MAX_PLAN_MONTHLY_USD * accountCount;
  let currentRemainingUsd = 0;
  for (const cfg of accounts) {
    const e = findAccount(currentLedger, cfg.email);
    if (typeof e?.remaining_usd === 'number') currentRemainingUsd += e.remaining_usd;
  }
  const daysLeft = daysRemainingInMonth(now);
  const projectedRemainingUsd = Math.max(0, currentRemainingUsd - daysLeft * totalDailyBurnUsd);
  const projectedConsumedUsd = poolUsd - projectedRemainingUsd;
  const currentConsumedUsd = poolUsd - currentRemainingUsd;
  const pct = (n) => (poolUsd > 0 ? Math.round((n / poolUsd) * 100) : 0);

  return {
    accountCount,
    poolUsd,
    currentRemainingUsd,
    currentConsumedUsd,
    currentConsumedPct: pct(currentConsumedUsd),
    projectedRemainingUsd,
    projectedConsumedUsd: Math.min(poolUsd, Math.max(0, projectedConsumedUsd)),
    projectedConsumedPct: Math.min(100, Math.max(0, pct(projectedConsumedUsd))),
    daysRemaining: daysLeft,
  };
}

/**
 * Fetch the Anthropic→Bedrock fallback ratio for the last 24h from CloudWatch.
 *
 * Uses AWS CLI (`aws cloudwatch get-metric-data`) to avoid adding an npm
 * dependency to this public plugin. Returns:
 *   {
 *     available: true,
 *     fallbackCount, hitCount, ratio
 *   }
 * or { available: false, reason: string } on any failure (missing CLI, missing
 * metric, no creds, non-zero exit, JSON parse error). The caller should render
 * a graceful warning when available=false rather than failing the digest.
 *
 * `_now` (default `new Date()`) is exposed for testability.
 */
export async function fetchFallbackRatio({ now = new Date(), region = process.env.AWS_REGION || 'eu-west-1' } = {}) {
  const endTime = now.toISOString();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const query = {
    MetricDataQueries: [
      {
        Id: 'fallback',
        MetricStat: {
          Metric: { Namespace: CLOUDWATCH_NAMESPACE, MetricName: CLOUDWATCH_FALLBACK_METRIC },
          Period: 86400,
          Stat: 'Sum',
        },
        ReturnData: true,
      },
      {
        Id: 'hits',
        MetricStat: {
          Metric: { Namespace: CLOUDWATCH_NAMESPACE, MetricName: CLOUDWATCH_HIT_METRIC },
          Period: 86400,
          Stat: 'Sum',
        },
        ReturnData: true,
      },
    ],
    StartTime: startTime,
    EndTime: endTime,
  };

  const res = spawnSync(
    'aws',
    [
      'cloudwatch',
      'get-metric-data',
      '--region',
      region,
      '--cli-input-json',
      JSON.stringify(query),
      '--output',
      'json',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );

  if (res.error) {
    return { available: false, reason: `aws cli not invokable: ${res.error.code || res.error.message}` };
  }
  if (res.status !== 0) {
    return { available: false, reason: `aws cli exited ${res.status}: ${(res.stderr || '').slice(0, 200).trim()}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { available: false, reason: `cloudwatch JSON parse error: ${e.message}` };
  }

  const results = Array.isArray(parsed?.MetricDataResults) ? parsed.MetricDataResults : [];
  const sumOf = (id) => {
    const r = results.find((x) => x.Id === id);
    if (!r || !Array.isArray(r.Values)) return 0;
    return r.Values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  };
  const fallbackCount = sumOf('fallback');
  const hitCount = sumOf('hits');
  const denom = fallbackCount + hitCount;

  if (denom === 0) {
    return { available: false, reason: 'no datapoints in last 24h (metrics may not exist yet)' };
  }

  return {
    available: true,
    fallbackCount,
    hitCount,
    ratio: fallbackCount / denom,
  };
}

/**
 * Pure version that drives off a pre-fetched result. Lets us unit-test the
 * formatter + severity logic without invoking AWS CLI.
 */
export function computeSeverity(projection, fallback) {
  const projectedHigh = projection.projectedConsumedPct >= SEVERITY_HIGH_PROJECTED_PCT;
  const fallbackHigh = fallback.available && fallback.ratio >= SEVERITY_HIGH_FALLBACK_RATIO;
  return projectedHigh || fallbackHigh ? 'HIGH' : 'LOW';
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '?';
  return `$${n.toFixed(2)}`;
}

function fmtRatio(r) {
  if (!Number.isFinite(r)) return '?';
  return `${(r * 100).toFixed(1)}%`;
}

export function formatSlackBody({
  cycle,
  perAccountBalances,
  burn,
  projection,
  fallback,
  severity,
  dryRun = false,
} = {}) {
  const lines = [];
  lines.push(`Anthropic credit-pool daily digest — ${cycle} (severity ${severity})`);
  lines.push('');
  lines.push(
    `Pool: $${projection.poolUsd} (${projection.accountCount} × $${MAX_PLAN_MONTHLY_USD}) — ${projection.daysRemaining} day(s) left in month`,
  );
  lines.push(`Remaining now: ${fmtUsd(projection.currentRemainingUsd)} (${projection.currentConsumedPct}% consumed)`);
  lines.push(
    `7d burn rate: ${fmtUsd(burn.totalDailyBurnUsd)}/day — month-end projection ${fmtUsd(projection.projectedConsumedUsd)} consumed (${projection.projectedConsumedPct}% of pool)`,
  );
  if (fallback.available) {
    lines.push(
      `Fallback 24h: ${fmtRatio(fallback.ratio)} (${fallback.fallbackCount} bedrock fallbacks / ${fallback.hitCount} anthropic hits)`,
    );
  } else {
    lines.push(`Fallback 24h: unavailable (${fallback.reason}) — section skipped`);
  }
  lines.push('');
  lines.push('Per-account:');
  for (const row of perAccountBalances) {
    const burnRow = burn.perAccount.find((b) => b.email === row.email);
    const burnTxt =
      burnRow == null || burnRow.dailyBurnUsd == null ? 'burn: n/a' : `burn: ${fmtUsd(burnRow.dailyBurnUsd)}/d`;
    const remainTxt = row.remaining_usd == null ? 'remaining: n/a' : `remaining: ${fmtUsd(row.remaining_usd)}`;
    lines.push(`  • ${row.email} — ${remainTxt} — ${burnTxt}`);
  }
  if (dryRun) {
    lines.push('');
    lines.push('(dry-run — no Slack post / no snapshot append)');
  }
  return lines.join('\n');
}

function gatherPerAccountBalances(ledger, accountsConfig) {
  const accounts = accountsConfig.length ? accountsConfig : (ledger.accounts || []).map((a) => ({ email: a.email }));
  return accounts.map((cfg) => {
    const e = findAccount(ledger, cfg.email);
    return {
      email: cfg.email,
      remaining_usd: typeof e?.remaining_usd === 'number' ? e.remaining_usd : null,
    };
  });
}

async function postSlack(body) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    log('[daily-digest] SLACK_WEBHOOK_URL not set — skipping Slack post');
    return { ok: true, skipped: true };
  }
  if (DRY_RUN) {
    log('[daily-digest] DRY RUN — Slack payload below:');
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
      log(`[daily-digest] Slack post failed: ${res.status} ${txt.slice(0, 200)}`);
      return { ok: false };
    }
    log('[daily-digest] Slack post OK');
    return { ok: true };
  } catch (e) {
    log(`[daily-digest] Slack post threw: ${e.message}`);
    return { ok: false };
  }
}

function fanOutNotify(severity, title, body) {
  if (DRY_RUN) {
    log(`[daily-digest] DRY RUN — would fan-out via ops-notify (${severity}): ${title}`);
    return;
  }
  if (!existsSync(NOTIFY_SCRIPT)) return;
  try {
    spawnSync(NOTIFY_SCRIPT, [severity, title, body], { stdio: 'ignore', env: process.env });
  } catch (e) {
    log(`[daily-digest] ops-notify fan-out failed: ${e.message}`);
  }
}

async function main() {
  log(`[daily-digest] start cycle=${ymKey()} dry-run=${DRY_RUN} skip-snapshot=${SKIP_SNAPSHOT}`);

  const accountsConfig = loadAccountsConfig();

  let ledger;
  try {
    ledger = readLedger(LEDGER_PATH);
  } catch (e) {
    log(`[fatal] ledger read failed: ${e.message}`);
    process.exit(2);
  }

  // Append today's snapshot BEFORE computing burn so the rolling window stays
  // populated even on first run (a single-row history will yield burn=null,
  // which the formatter handles gracefully).
  if (!DRY_RUN && !SKIP_SNAPSHOT) {
    try {
      appendSnapshot(ledger, accountsConfig, SNAPSHOTS_PATH);
    } catch (e) {
      log(`[fatal] snapshot append failed: ${e.message}`);
      process.exit(2);
    }
  }

  const history = readSnapshotHistory(SNAPSHOTS_PATH);
  const burn = computeBurnRate(history, accountsConfig, ledger);
  const projection = projectMonthEnd(ledger, accountsConfig, burn.totalDailyBurnUsd);
  const fallback = await fetchFallbackRatio();
  const perAccountBalances = gatherPerAccountBalances(ledger, accountsConfig);
  const severity = computeSeverity(projection, fallback);

  const cycle = ymKey();
  const body = formatSlackBody({ cycle, perAccountBalances, burn, projection, fallback, severity, dryRun: DRY_RUN });

  const slack = await postSlack(body);
  const title = `Credit pool daily — ${projection.currentConsumedPct}% consumed, projected ${projection.projectedConsumedPct}%`;
  fanOutNotify(severity, title, body);

  if (!slack.ok && !slack.skipped) process.exit(1);
  log('[daily-digest] done');
}

// Only run main() when executed directly (not when imported by tests).
const _entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === _entryPath) {
  if (flag('--help') || flag('-h')) {
    console.log(readFileSync(_entryPath, 'utf8').split('\n').slice(0, 40).join('\n'));
    process.exit(0);
  }
  main().catch((e) => {
    log(`[fatal] ${e.stack || e.message}`);
    process.exit(2);
  });
}
