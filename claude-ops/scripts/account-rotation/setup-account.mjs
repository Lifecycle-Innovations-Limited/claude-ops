#!/usr/bin/env node
// setup-account.mjs — Standalone OAuth init for a single Claude account.
//
// Walks a magic-link login flow against claude.ai using Playwright, extracts
// the session token from cookies, verifies the token against api.anthropic.com,
// and writes it to the OS keychain via lib/credential-store.sh as
// `Claude-Rotation-<account_id>`. Does NOT touch the active rotation state.
//
// Usage:
//   node setup-account.mjs --email user@example.com [--display "Personal"] \
//                          [--plan max] [--account-id <slug>] [--no-headless]
//
// TODO(account-rotation-fold): when the parallel account-rotation source lands,
// fold this file into rotate.mjs as a `--setup-account <email>` mode and call
// the shared keychain/verification helpers from there. Until then this file is
// callable standalone.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CRED_STORE = resolve(REPO_ROOT, 'lib', 'credential-store.sh');
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
  const out = { headless: true, plan: 'max' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--display') out.display = argv[++i];
    else if (a === '--plan') out.plan = argv[++i];
    else if (a === '--account-id') out.accountId = argv[++i];
    else if (a === '--no-headless') out.headless = false;
    else if (a === '--gmail-poll') out.gmailPoll = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: setup-account.mjs --email <addr> [--display <name>] [--plan pro|max] [--account-id <slug>] [--no-headless] [--gmail-poll]',
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
  const path = CONFIG_USER;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function upsertAccount(args) {
  const cfg = loadConfig();
  cfg.accounts = cfg.accounts || [];
  const existing = cfg.accounts.find((a) => a.id === args.accountId);
  if (existing) {
    existing.email = args.email;
    existing.display = args.display;
    existing.plan = args.plan;
  } else {
    cfg.accounts.push({
      id: args.accountId,
      email: args.email,
      display: args.display,
      plan: args.plan,
      added: new Date().toISOString(),
    });
  }
  saveConfig(cfg);
  log(`config upserted: ${args.accountId} -> ${CONFIG_USER}`);
}

function credSet(service, account, secret) {
  const r = spawnSync('bash', [CRED_STORE, 'set', service, account, secret], {
    input: '',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    log(`credential-store set failed: ${r.stderr}`);
    return false;
  }
  return true;
}

function credGet(service, account) {
  const r = spawnSync('bash', [CRED_STORE, 'get', service, account], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

async function ensurePlaywright() {
  try {
    await import('playwright');
    return true;
  } catch {
    log('installing playwright (one-time)...');
    const r = spawnSync('npm', ['install', '--no-save', 'playwright'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      log('playwright install failed');
      return false;
    }
    spawnSync('npx', ['playwright', 'install', 'chromium'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    return true;
  }
}

async function pollGmailForMagicLink(toEmail, sinceTs) {
  // Best-effort: use `gog` if available. Returns the link URL or null.
  const probe = spawnSync('which', ['gog'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    log('gog CLI not installed — falling back to manual confirmation');
    return null;
  }
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min
  while (Date.now() < deadline) {
    const r = spawnSync(
      'gog',
      [
        'gmail',
        'search',
        `to:${toEmail} from:noreply@anthropic.com after:${Math.floor(sinceTs / 1000)} subject:"sign in"`,
        '--max',
        '3',
        '-j',
        '--results-only',
        '--no-input',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    if (r.status === 0 && r.stdout.trim()) {
      try {
        const threads = JSON.parse(r.stdout);
        const first = Array.isArray(threads) ? threads[0] : null;
        if (first?.id) {
          const t = spawnSync('gog', ['gmail', 'thread', 'get', first.id, '-j'], { encoding: 'utf8', timeout: 15000 });
          if (t.status === 0) {
            const m = t.stdout.match(/https:\/\/claude\.ai\/(?:magic-link|verify|login)[^\s"'<>]+/);
            if (m) return m[0];
          }
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function runOAuth(args) {
  const ok = await ensurePlaywright();
  if (!ok) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: args.headless });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  log('navigating to claude.ai/login');
  await page.goto('https://claude.ai/login', { waitUntil: 'domcontentloaded' });

  log(`filling email: ${args.email}`);
  // Selector is best-effort — Anthropic's login form may change.
  try {
    await page.fill('input[type="email"], input[name="email"]', args.email, {
      timeout: 15000,
    });
    await page.click('button[type="submit"], button:has-text("Continue")', {
      timeout: 5000,
    });
  } catch (e) {
    log(`email entry failed: ${e.message}`);
  }

  const sinceTs = Date.now();
  log('magic-link sent — waiting for completion...');
  if (args.gmailPoll) {
    const link = await pollGmailForMagicLink(args.email, sinceTs);
    if (link) {
      log(`got magic link from gmail — navigating`);
      await page.goto(link, { waitUntil: 'domcontentloaded' });
    } else {
      log('gmail poll timed out — waiting for manual click');
    }
  }

  // Wait for the post-login app shell. 10 min ceiling for 2FA / manual click.
  try {
    await page.waitForURL(/claude\.ai\/(?:chats?|new|projects)/, {
      timeout: 10 * 60 * 1000,
    });
  } catch (e) {
    log(`login did not complete in time: ${e.message}`);
    await browser.close();
    return null;
  }

  const cookies = await ctx.cookies('https://claude.ai');
  const session = cookies.find((c) => c.name === 'sessionKey' || c.name === '__Secure-next-auth.session-token');
  await browser.close();
  if (!session) {
    log('no session cookie found after login');
    return null;
  }
  return session.value;
}

async function verifyToken(token) {
  // Minimal probe — the rotation system uses this token to mint API requests
  // via the Claude Code OAuth bridge. We just check that claude.ai accepts it.
  try {
    const res = await fetch('https://claude.ai/api/organizations', {
      headers: { Cookie: `sessionKey=${token}` },
    });
    return res.ok;
  } catch (e) {
    log(`verify error: ${e.message}`);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  ensureLogDir();
  log(`starting setup for ${args.email} (id=${args.accountId}, plan=${args.plan})`);

  const existingToken = credGet('Claude-Rotation', args.accountId);
  if (existingToken) {
    log(`keychain entry already present for ${args.accountId} — skipping OAuth`);
    upsertAccount(args);
    console.log(JSON.stringify({ ok: true, accountId: args.accountId, skipped: true }));
    return;
  }

  const token = await runOAuth(args);
  if (!token) {
    console.log(JSON.stringify({ ok: false, accountId: args.accountId, error: 'oauth_failed' }));
    process.exit(1);
  }

  const verified = await verifyToken(token);
  if (!verified) {
    console.log(JSON.stringify({ ok: false, accountId: args.accountId, error: 'verify_failed' }));
    process.exit(1);
  }

  const stored = credSet('Claude-Rotation', args.accountId, token);
  if (!stored) {
    console.log(JSON.stringify({ ok: false, accountId: args.accountId, error: 'keychain_write_failed' }));
    process.exit(1);
  }

  upsertAccount(args);
  log(`✓ ${args.accountId} initialized`);
  console.log(JSON.stringify({ ok: true, accountId: args.accountId, email: args.email }));
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
