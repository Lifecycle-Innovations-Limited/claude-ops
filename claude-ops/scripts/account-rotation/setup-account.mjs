#!/usr/bin/env node
// setup-account.mjs — OAuth init for a single Claude account in the rotator.
//
// Thin wrapper around the proven rotate.mjs setup flow. It:
//   1. Upserts the account into the user config (gitignored override).
//   2. Delegates the OAuth capture to `rotate.mjs --setup --only=<email>
//      --auto --skip-valid`, which drives the browser-driver cascade
//      (CDP-attach to a real Chrome → spawn Chrome with a real profile →
//      bundled Chromium), polls Gmail for the magic link via `gog`, verifies
//      the token, and writes it to the keychain under the SAME schema the
//      daemon/rotator consume: service `Claude-Rotation-<key>`, account
//      `$USER` (or $CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT), value
//      `{ "claudeAiOauth": { "accessToken": ... } }`.
//
// Why delegate instead of re-implementing the browser flow here: a freshly
// launched Playwright Chromium is blocked by claude.ai's Cloudflare Turnstile
// (the magic link is never sent), and a hand-rolled web-cookie capture writes a
// credential shape (sessionKey cookie) that NO consumer in this repo reads.
// rotate.mjs already solves both correctly — this wrapper just feeds it one
// account and reports a machine-readable result.
//
// Usage:
//   node setup-account.mjs --email user@example.com [--display "Personal"] \
//                          [--plan max] [--account-id <slug>] [--no-headless]
//
// --gmail-poll / --no-headless are accepted for backward compatibility but are
// no-ops: rotate.mjs --auto always polls Gmail and manages its own browser.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROTATE_SCRIPT = resolve(__dirname, 'rotate.mjs');
const CONFIG_USER = join(
  homedir(),
  '.claude',
  'plugins',
  'data',
  'ops-ops-marketplace',
  'account-rotation-config.json',
);
const CONFIG_REPO = resolve(__dirname, 'config.json');
const LOG_DIR = join(homedir(), '.claude', 'logs', 'account-rotation');

function parseArgs(argv) {
  const out = { plan: 'max' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--display') out.display = argv[++i];
    else if (a === '--plan') out.plan = argv[++i];
    else if (a === '--account-id') out.accountId = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--no-headless' || a === '--gmail-poll') {
      /* accepted for backward compat — no-op (rotate.mjs --auto handles both) */
    } else if (a === '--help' || a === '-h') {
      console.log(
        'usage: setup-account.mjs --email <addr> [--display <name>] [--plan pro|max] [--account-id <slug>] [--label <key>]',
      );
      process.exit(0);
    }
  }
  if (!out.email) {
    console.error('error: --email is required');
    process.exit(2);
  }
  if (!out.accountId) out.accountId = slugify(out.email);
  if (!out.display) out.display = out.email;
  return out;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[setup-account ${ts}] ${msg}\n`);
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function loadConfig() {
  const path = existsSync(CONFIG_USER) ? CONFIG_USER : CONFIG_REPO;
  if (!existsSync(path)) return { accounts: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_USER), { recursive: true });
  writeFileSync(CONFIG_USER, JSON.stringify(cfg, null, 2));
}

// Write the account into the user-override config (never the committed repo
// default — Rule 0). rotate.mjs reads this same file via its USER_CONFIG_PATH
// preference, so the --only=<email> filter below will find it.
function upsertAccount(args) {
  const cfg = loadConfig();
  cfg.accounts = cfg.accounts || [];
  const existing = cfg.accounts.find((a) => a.id === args.accountId || a.email === args.email);
  if (existing) {
    existing.email = args.email;
    existing.display = args.display;
    existing.plan = args.plan;
    if (args.label) existing.label = args.label;
  } else {
    const acct = {
      id: args.accountId,
      email: args.email,
      display: args.display,
      plan: args.plan,
      added: new Date().toISOString(),
    };
    if (args.label) acct.label = args.label;
    cfg.accounts.push(acct);
  }
  saveConfig(cfg);
  log(`config upserted: ${args.accountId} (${args.email}) -> ${CONFIG_USER}`);
}

// Delegate the actual OAuth capture to rotate.mjs's proven setup flow.
// --skip-valid: no-op if a valid token already exists for this account.
// --auto: fully automated (browser cascade + Gmail magic-link polling).
function runRotateSetup(email) {
  return new Promise((resolveExit) => {
    log(`delegating OAuth to rotate.mjs --setup --only=${email} --auto --skip-valid`);
    const child = spawn(
      process.execPath,
      [ROTATE_SCRIPT, '--setup', `--only=${email}`, '--auto', '--skip-valid'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('exit', (code) => resolveExit(code ?? 1));
    child.on('error', (e) => {
      log(`failed to spawn rotate.mjs: ${e.message}`);
      resolveExit(1);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  ensureLogDir();
  log(`starting setup for ${args.email} (id=${args.accountId}, plan=${args.plan})`);

  // Persist the account first so rotate.mjs's config read picks it up.
  upsertAccount(args);

  const code = await runRotateSetup(args.email);
  if (code !== 0) {
    console.log(
      JSON.stringify({ ok: false, accountId: args.accountId, email: args.email, error: 'oauth_failed' }),
    );
    process.exit(1);
  }

  log(`✓ ${args.accountId} initialized (token written to Claude-Rotation-<key> by rotate.mjs)`);
  console.log(JSON.stringify({ ok: true, accountId: args.accountId, email: args.email }));
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
