#!/usr/bin/env node
/* eslint-disable no-console */

// ──────────────────────────────────────────────────────────────────────────────
//  kapture-claim-credits.mjs
//  Monthly Anthropic $200 Agent SDK credit redemption sweep across all Max 20x
//  accounts registered in scripts/account-rotation/config.json.
//
//  Activation: 2026-06-15. Run once on that date, then re-run on day 1 of each
//  subsequent month.
//
//  Authoring date: 2026-05-14. The exact Anthropic console URL, button label,
//  and DOM markup for the credit-claim flow are unknown until the feature ships
//  on 2026-06-15. The selectors below are defensive guesses with multiple
//  fallbacks; verify them by hand on June 15 before flipping `--dry-run` off.
//
//  MANDATORY MANUAL VERIFICATION ON 2026-06-15 BEFORE LIVE RUN:
//    1. Log into one Anthropic console account in Sam's Chrome.
//    2. Navigate to the credit-claim page (see CANDIDATE_BILLING_URLS below).
//    3. Inspect the actual DOM for:
//         - the "Claim $200 credit" button label/aria-label/data-attr
//         - the post-claim success state text
//         - the user-menu element that shows the logged-in email
//         - the "Switch account" / logout affordance
//    4. Update CLAIM_SELECTORS / EMAIL_SELECTORS / SUCCESS_SELECTORS below.
//    5. Run with `--dry-run` first against one account to confirm the plan.
//    6. Then drop --dry-run.
//
//  Design notes:
//    - This script is `node`-invoked from cron. Kapture tools live behind the
//      Claude Code MCP layer. To actually drive a browser we shell out to
//      `claude -p` with a tightly-scoped per-account prompt and the MCP server
//      enabled (which is the documented automation pattern for Kapture).
//    - Per ~/.claude/CLAUDE.md: Kapture-first; always `new_tab`; never reuse
//      tabs; never fall back to Playwright; close the tab on exit.
//    - Per Rule 0: never read or write real account emails into this repo.
//      We read them from the local config.json at runtime; they are not part
//      of the committed payload.
//    - Per CLAUDE.md outbound-comms guardrail: this script does NOT send any
//      message. It clicks an internal billing button. The outbound-comms
//      block-list does not cover Anthropic console actions.
//
//  CLI:
//    --dry-run    (default ON)      Print the plan; do not touch the browser.
//    --live                          Disable dry-run. Required to actually claim.
//    --only EMAIL                    Restrict the sweep to a single account.
//    --skip EMAIL[,EMAIL,...]        Skip listed accounts.
//    --max-concurrency N             (Default 1.) Number of parallel claude -p
//                                    sessions; >1 means multiple Kapture tabs
//                                    in flight simultaneously. Keep at 1 unless
//                                    you have verified Sam's Chrome can survive
//                                    parallel automation.
//    --help                          Print this header.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const LEDGER_PATH = join(homedir(), '.claude', 'credits-ledger.json');
const RECEIPTS_DIR = join(homedir(), '.claude', 'credits-ledger-receipts');

// Candidate billing URLs — Anthropic may ship the credit-claim affordance on
// any of these. The Kapture prompt below tries them in order.
const CANDIDATE_BILLING_URLS = [
  'https://console.anthropic.com/settings/billing',
  'https://console.anthropic.com/settings/plans',
  'https://console.anthropic.com/settings/usage',
];

// Selectors for the "Claim $200 credit" button. Tried in order.
const CLAIM_SELECTORS = [
  'button:has-text("Claim $200")',
  'button:has-text("Claim Agent SDK credit")',
  'button[data-testid="claim-agent-sdk-credit"]',
  'button[aria-label*="Claim"][aria-label*="credit"]',
  'a:has-text("Claim Agent SDK credit")',
];

// Selectors for "credit already claimed this month".
const ALREADY_CLAIMED_SELECTORS = [
  ':text("Credit claimed")',
  ':text("Claimed for this billing cycle")',
  'button:disabled:has-text("Claim")',
  '[data-testid="agent-sdk-credit-claimed"]',
];

// Selectors that reveal the logged-in account email.
const EMAIL_SELECTORS = [
  '[data-testid="user-menu-email"]',
  '[aria-label*="user menu"] :text-matches("@")',
  'button[aria-label="Account menu"]',
  'header :text-matches("@")',
];

// Selectors that confirm the credit balance after claim.
const BALANCE_SELECTORS = [
  '[data-testid="agent-sdk-credit-remaining"]',
  ':text-matches("\\$[0-9]+(\\.[0-9]{2})? remaining")',
  ':text-matches("Agent SDK credit:.*\\$")',
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(0, 60)
      .join('\n'),
  );
  process.exit(0);
}

const DRY_RUN = !flag('--live'); // default ON
const ONLY = valueOf('--only');
const SKIP = (valueOf('--skip') ?? '').split(',').filter(Boolean);
const rawMaxConcurrency = Number(valueOf('--max-concurrency') ?? '1');
const MAX_CONCURRENCY =
  Number.isFinite(rawMaxConcurrency) && rawMaxConcurrency >= 1 ? Math.floor(rawMaxConcurrency) : 1;

function loadAccounts() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[fatal] missing ${CONFIG_PATH}`);
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const accounts = (cfg.accounts ?? []).filter((a) => a?.email);
  if (accounts.length === 0) {
    console.error(`[fatal] no accounts in ${CONFIG_PATH}. The committed config is empty by Rule 0;`);
    console.error(
      '        real accounts live at ~/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json',
    );
    console.error('        or are user-supplied. Point this script at the populated config.');
    process.exit(2);
  }
  return accounts.filter((a) => {
    if (ONLY && a.email !== ONLY) return false;
    if (SKIP.includes(a.email)) return false;
    return true;
  });
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, updated_at: null, accounts: {} };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return { version: 1, updated_at: null, accounts: {} };
  }
}

function saveLedger(ledger) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

function ymKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function receiptPath(email) {
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  const safe = email.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(RECEIPTS_DIR, `${safe}-${ymKey()}.png`);
}

function buildPrompt(email, screenshotTo) {
  // The prompt instructs a Claude Code session to drive Kapture. The session
  // must have the Kapture MCP server enabled (it does, by default, in Sam's
  // setup). The session opens its OWN tab, never reuses, closes on exit.
  return [
    `You are a Kapture automation worker. Do not chat, narrate, or ask questions.`,
    `Execute the following plan against Sam's daily Chrome via the Kapture MCP.`,
    ``,
    `TARGET ACCOUNT: ${email}`,
    `OUTPUT (must be the final line of your response, JSON, no other prose):`,
    `{"email": "${email}", "claimed": <bool>, "remaining_usd": <number|null>, "already_claimed": <bool>, "screenshot": "${screenshotTo}", "error": <string|null>}`,
    ``,
    `STEPS:`,
    `1. mcp__kapture__new_tab — open YOUR own tab. Store tabId. NEVER reuse.`,
    `2. mcp__kapture__navigate to the first candidate URL: ${CANDIDATE_BILLING_URLS.join(', ')}.`,
    `   If 404 or redirect to login, try the next.`,
    `3. Read the page (mcp__kapture__dom or elements) and find the user-menu email.`,
    `   Try EMAIL_SELECTORS: ${JSON.stringify(EMAIL_SELECTORS)}.`,
    `   Match against "${email}". If wrong account is logged in, locate the account switcher`,
    `   (look for a "Switch account" menu item or sign-out link) and either switch in-app`,
    `   or sign out + sign in via Google OAuth (the Google session is already present in`,
    `   Sam's Chrome, so the Google OAuth step is usually one click).`,
    `4. On the billing page, look for "$200 Agent SDK credit" or similar copy.`,
    `   Try CLAIM_SELECTORS: ${JSON.stringify(CLAIM_SELECTORS)}.`,
    `   If none match, check ALREADY_CLAIMED_SELECTORS: ${JSON.stringify(ALREADY_CLAIMED_SELECTORS)}.`,
    `   If neither matches, ABORT — the DOM has shifted; do not click anything.`,
    `5. If claimable: click the button, wait 2s, verify success by reading the page state.`,
    `   If success markers are present, set claimed=true.`,
    `6. Read the remaining balance via BALANCE_SELECTORS: ${JSON.stringify(BALANCE_SELECTORS)}.`,
    `   Parse the dollar amount as remaining_usd. If unparseable, leave null.`,
    `7. mcp__kapture__screenshot the page → save to "${screenshotTo}".`,
    `8. mcp__kapture__close your tab.`,
    `9. Emit the JSON result line.`,
    ``,
    `HARD STOPS (return error, do not retry):`,
    `- 2FA prompt or unexpected modal.`,
    `- DOM unrecognized after step 3 or 4.`,
    `- Cannot match a candidate URL.`,
    `- Wrong account is logged in AND no switcher is visible.`,
  ].join('\n');
}

function invokeClaude(prompt) {
  // `claude -p` runs a one-shot Claude Code session. The MCP servers configured
  // in ~/.claude/ are inherited, so Kapture is available. We don't pass any
  // model flag — defer to Sam's default profile.
  // Use async spawn (not spawnSync) so parallel batches can run concurrent subprocesses.
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const timeoutMs = 5 * 60 * 1000;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const child = spawn('claude', ['-p', prompt]);
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      done({ ok: false, error: 'claude -p timed out after 5 minutes' });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      done({ ok: false, error: `claude -p spawn failed: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const hint = signal ? ` (signal ${signal})` : '';
        done({ ok: false, error: `claude -p exited ${code}${hint}: ${stderr.slice(0, 500)}` });
        return;
      }
      const lines = stdout.trim().split('\n').reverse();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            done({ ok: true, result: JSON.parse(trimmed) });
            return;
          } catch {
            /* try next line */
          }
        }
      }
      done({ ok: false, error: 'no JSON result line in claude -p stdout' });
    });
  });
}

async function processAccount(email) {
  const shot = receiptPath(email);
  const prompt = buildPrompt(email, shot);

  if (DRY_RUN) {
    console.log(`[dry-run] would invoke claude -p for ${email}`);
    console.log(`[dry-run]   screenshot target: ${shot}`);
    console.log(`[dry-run]   candidate URLs: ${CANDIDATE_BILLING_URLS.join(', ')}`);
    return { email, claimed: null, remaining_usd: null, screenshot: shot, error: null, dry_run: true };
  }

  const t0 = Date.now();
  const { ok, result, error } = await invokeClaude(prompt);
  const ms = Date.now() - t0;
  if (!ok) return { email, claimed: false, remaining_usd: null, screenshot: shot, error, elapsed_ms: ms };
  return { ...result, email, elapsed_ms: ms };
}

async function main() {
  console.log(`[kapture-claim-credits] dry-run=${DRY_RUN} max-concurrency=${MAX_CONCURRENCY}`);
  if (DRY_RUN) console.log('[kapture-claim-credits] DRY RUN — pass --live to actually claim.');

  const accounts = loadAccounts();
  console.log(`[kapture-claim-credits] ${accounts.length} accounts in scope`);

  const ledger = loadLedger();
  const cycle = ymKey();
  const results = [];

  // Serial by default. >1 concurrency means parallel claude -p subprocesses,
  // which means parallel Kapture tabs — each opens its OWN tab per CLAUDE.md.
  for (let i = 0; i < accounts.length; i += MAX_CONCURRENCY) {
    const batch = accounts.slice(i, i + MAX_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((a) => processAccount(a.email)));
    for (const r of batchResults) {
      results.push(r);
      if (!DRY_RUN && r && !r.error) {
        ledger.accounts[r.email] ??= {};
        ledger.accounts[r.email][cycle] = {
          claimed: !!r.claimed,
          already_claimed: !!r.already_claimed,
          remaining_usd: r.remaining_usd ?? null,
          screenshot: r.screenshot,
          claimed_at: new Date().toISOString(),
        };
      }
    }
  }

  if (!DRY_RUN) {
    ledger.updated_at = new Date().toISOString();
    saveLedger(ledger);
    console.log(`[kapture-claim-credits] ledger written: ${LEDGER_PATH}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(
    'account                                  | claimed | remaining | screenshot                              | error',
  );
  console.log(
    '-----------------------------------------|---------|-----------|-----------------------------------------|------',
  );
  for (const r of results) {
    const account = (r.email ?? '?').padEnd(40);
    const claimed = String(r.claimed ?? 'dry').padEnd(7);
    const rem = r.remaining_usd != null ? `$${r.remaining_usd}` : '—';
    const remCol = rem.padEnd(9);
    const shot = (r.screenshot ?? '').slice(-40).padEnd(40);
    const err = r.error ? r.error.slice(0, 80) : '';
    console.log(`${account} | ${claimed} | ${remCol} | ${shot} | ${err}`);
  }

  const failures = results.filter((r) => r.error);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(2);
});
