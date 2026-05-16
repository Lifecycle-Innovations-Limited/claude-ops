#!/usr/bin/env node
/* eslint-disable no-console */

// ──────────────────────────────────────────────────────────────────────────────
//  bulk-setup-token.mjs
//
//  Loops `claude setup-token` over every account in credits-ledger.json that
//  is missing an OAuth bearer token, drives the Anthropic web login via
//  Kapture (delegated to a one-shot `claude -p` subprocess with the kapture
//  MCP server enabled), then stores the resulting sk-ant-oat01-* token in AWS
//  Secrets Manager at my-project/claude-oauth-token/account-{1..7}.
//
//  Idempotent: skips accounts whose Secrets Manager entry already contains a
//  validated sk-ant-oat01-* token AND ledger entry says claimed=true.
//
//  Reuses the proven flow from PR #225 (claude-p-as wrapper + ledger.mjs)
//  and the kapture-via-claude-p pattern from kapture-claim-credits.mjs.
//
//  Usage:
//     node bulk-setup-token.mjs [--dry-run] [--only <email>] [--region <r>]
//                               [--ledger <path>] [--secret-prefix <s>]
//                               [--gmail-account <addr>]
//
//  Defaults:
//     --region          eu-west-1
//     --ledger          ~/.claude/credits-ledger.json
//     --secret-prefix   my-project/claude-oauth-token/account-
//     --gmail-account   $BULK_SETUP_GMAIL_ACCOUNT (env) or unset
//
//  Required tools on PATH: claude, aws, gog, expect.
//
//  HARD RULES
//    - Never log plaintext tokens.
//    - Never write tokens to disk except via `aws secretsmanager update-secret`
//      stdin. Local /tmp files are shred-deleted on exit.
//    - Per-account run is atomic: errors don't corrupt ledger or
//      Secrets Manager state for other accounts.
//
// ──────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { findAccount, readLedger, upsertAccount, writeLedger } from './ledger.mjs';

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function value(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const DRY_RUN = flag('--dry-run');
const ONLY = value('--only', null);
const REGION = value('--region', 'eu-west-1');
const HOME = process.env.HOME || process.env.USERPROFILE;
const LEDGER_PATH = value('--ledger', join(HOME, '.claude', 'credits-ledger.json'));
const SECRET_PREFIX = value('--secret-prefix', 'my-project/claude-oauth-token/account-');
const GMAIL_ACCOUNT = value('--gmail-account', process.env.BULK_SETUP_GMAIL_ACCOUNT || null);
const SUBPROCESS_TIMEOUT_MS = 8 * 60 * 1000; // 8 min per Kapture step

// ─── logging ────────────────────────────────────────────────────────────────

const TAG = '[bulk-setup-token]';
function log(...a) {
  console.error(TAG, ...a);
}
function logRedacted(label, secret) {
  const s = typeof secret === 'string' ? secret : String(secret);
  if (s.length < 12) {
    log(label, '(redacted, len=' + s.length + ')');
  } else {
    log(label, s.slice(0, 18) + '…' + s.slice(-6) + ' (len=' + s.length + ')');
  }
}

// ─── tmp dir scrubbed on exit ───────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'bulk-setup-token-'));
function scrubTmp() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.on('exit', scrubTmp);
process.on('SIGINT', () => {
  scrubTmp();
  process.exit(130);
});
process.on('SIGTERM', () => {
  scrubTmp();
  process.exit(143);
});

// ─── Kapture-via-claude-p delegate ─────────────────────────────────────────

function buildLoginPrompt(email) {
  return [
    `You are driving Kapture to log into the Anthropic Claude Console.`,
    ``,
    `Steps:`,
    `1. mcp__kapture__new_tab — open a fresh Chrome tab. Stash the tabId.`,
    `2. mcp__kapture__navigate to https://platform.claude.com/login`,
    `3. mcp__kapture__fill the #email input with: ${email}`,
    `4. mcp__kapture__click the button with data-testid="continue".`,
    `5. mcp__kapture__show the tab (brings to front so subsequent click can work).`,
    `6. Wait ~3 seconds for the "Enter the verification code sent to ${email}" screen to render.`,
    `7. Emit ONE LINE of JSON on stdout: {"ok":true,"tabId":"<tabId>"}`,
    ``,
    `If anything fails before step 7, emit instead: {"ok":false,"error":"<short reason>"}`,
    `Do not retry. Do not Authorize anything in this session.`,
  ].join('\n');
}

function buildAuthorizePrompt(tabId, authUrl) {
  return [
    `You are driving Kapture to complete an Anthropic Claude Code OAuth consent.`,
    ``,
    `Steps:`,
    `1. mcp__kapture__navigate tab ${tabId} to: ${authUrl}`,
    `2. mcp__kapture__show the tab.`,
    `3. Wait ~3 seconds for the consent page to render (button data-testid is not set; use #kapture-1 or the primary button with text "Authorize").`,
    `4. mcp__kapture__click the Authorize button. After click the page redirects to platform.claude.com/oauth/code/callback?code=…&state=…`,
    `5. Read the final URL via mcp__kapture__elements selector="body" or by inspecting the navigation state.`,
    `6. Extract the "code" query parameter from the final URL.`,
    `7. Emit ONE LINE of JSON on stdout: {"ok":true,"code":"<the code>","state":"<the state>"}`,
    ``,
    `If anything fails, emit: {"ok":false,"error":"<short reason>"}`,
    `Do not Decline. Do not navigate elsewhere.`,
  ].join('\n');
}

function buildMagicLinkPrompt(tabId, magicLinkUrl) {
  return [
    `You are driving Kapture to complete an Anthropic magic-link sign-in.`,
    ``,
    `Steps:`,
    `1. mcp__kapture__navigate tab ${tabId} to: ${magicLinkUrl}`,
    `2. Wait ~3 seconds for the redirect to platform.claude.com/settings/billing (= logged in).`,
    `3. Read the resulting URL. If it contains "/login" or "/error", login failed.`,
    `4. Emit ONE LINE of JSON: {"ok":true,"url":"<final-url>"} or {"ok":false,"error":"<reason>"}`,
  ].join('\n');
}

function invokeClaude(prompt, label) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    log(`${label}: invoking claude -p…`);
    const child = spawn('claude', ['-p', prompt]);
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      done({ ok: false, error: `${label}: claude -p timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s` });
    }, SUBPROCESS_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c) => {
      stdout += c;
    });
    child.stderr?.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => done({ ok: false, error: `${label}: spawn failed: ${err.message}` }));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const hint = signal ? ` (signal ${signal})` : '';
        done({ ok: false, error: `${label}: exit ${code}${hint}: ${stderr.slice(0, 400)}` });
        return;
      }
      const lines = stdout.trim().split('\n').reverse();
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          try {
            const parsed = JSON.parse(t);
            done({ ok: true, result: parsed });
            return;
          } catch {
            /* try next line */
          }
        }
      }
      done({ ok: false, error: `${label}: no JSON result line in claude -p stdout: ${stdout.slice(-400)}` });
    });
  });
}

// ─── gog Gmail poller for the magic-link email ─────────────────────────────

async function pollMagicLink(email, sinceMs, deadlineMs) {
  // Anthropic magic-link emails arrive within ~30s; we poll Gmail every 5s
  // for newer-than-5m emails matching the secure-link subject. The body is
  // base64-encoded HTML containing a https://platform.claude.com/magic-link#…
  // anchor — we extract that URL.
  while (Date.now() < deadlineMs) {
    const q = `from:no-reply@mail.anthropic.com OR from:noreply@anthropic.com newer_than:10m`;
    const args2 = ['gmail', 'search', q, '--max', '5', '-j', '--results-only', '--no-input'];
    if (GMAIL_ACCOUNT) args2.unshift('-a', GMAIL_ACCOUNT);
    const r = spawnSync('gog', args2, { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim().startsWith('[')) {
      const threads = JSON.parse(r.stdout);
      for (const t of threads) {
        const ts = Number(t.internalDate || 0);
        // gog gives "date":"YYYY-MM-DD HH:MM" only, no ms; fall back to id-based.
        if (
          (t.subject || '').toLowerCase().includes('secure link') ||
          (t.subject || '').toLowerCase().includes('claude console')
        ) {
          // Fetch full thread to extract the magic-link URL from the HTML body.
          const tid = t.id || t.threadId;
          if (!tid) continue;
          const r2 = spawnSync(
            'gog',
            [...(GMAIL_ACCOUNT ? ['-a', GMAIL_ACCOUNT] : []), 'gmail', 'thread', 'get', tid, '-j', '--no-input'],
            { encoding: 'utf8' },
          );
          if (r2.status !== 0) continue;
          const thread = JSON.parse(r2.stdout);
          const msg = thread?.thread?.messages?.[0];
          const bodyB64 = msg?.payload?.body?.data;
          if (!bodyB64) continue;
          // gog returns base64url
          const html = Buffer.from(bodyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
          const m = html.match(/https:\/\/platform\.claude\.com\/magic-link#[A-Za-z0-9+/=:.-]+/);
          if (m) {
            // Decode the trailing base64 email part and confirm it matches.
            const frag = m[0].split('#')[1];
            const parts = frag.split(':');
            if (parts.length === 2) {
              const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
              if (decoded.toLowerCase() === email.toLowerCase()) {
                return m[0];
              }
            }
          }
        }
        // ignore non-matching emails
        void ts;
        void sinceMs;
      }
    }
    await sleep(5000);
  }
  throw new Error(`magic-link email never arrived for ${email} within deadline`);
}

// ─── expect-driven `claude setup-token` ────────────────────────────────────

const EXPECT_SCRIPT = `#!/usr/bin/env expect -f
log_user 0
set timeout 3600
set logfile [lindex $argv 0]
set codefile [lindex $argv 1]
set tokenfile [lindex $argv 2]
log_file -a $logfile
spawn -noecho claude setup-token
set sent 0
while 1 {
  expect {
    -re {prompted} {
      if {$sent == 0} {
        set sent 1
        while {![file exists $codefile]} { exec sleep 1 }
        set fh [open $codefile r]
        set code [string trim [read $fh]]
        close $fh
        send -- "$code"
        after 200
        send -- "\\r"
      }
    }
    -re {sk-ant-oat01-[A-Za-z0-9_-]+} {
      set token $expect_out(0,string)
      # trim trailing alphanumeric run that may include the "S" of "Store this token securely…"
      regsub {Store?$} $token "" token
      set fh [open $tokenfile w]
      puts -nonewline $fh $token
      close $fh
      puts stderr "TOKEN_CAPTURED"
    }
    timeout { puts stderr "TIMEOUT"; exit 2 }
    eof { puts stderr "EOF"; exit 0 }
  }
}
`;

function startSetupTokenExpect(accountDir) {
  const expectScript = join(accountDir, 'driver.exp');
  const log = join(accountDir, 'setup.log');
  const codeFile = join(accountDir, 'oauth-code.txt');
  const tokenFile = join(accountDir, 'token.txt');
  writeFileSync(expectScript, EXPECT_SCRIPT, { mode: 0o700 });
  const child = spawn('expect', ['-f', expectScript, log, codeFile, tokenFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { child, expectScript, log, codeFile, tokenFile };
}

function readOauthAuthorizeUrl(logPath, deadlineMs) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!existsSync(logPath)) return;
      const raw = readFileSync(logPath);
      // strip OSC hyperlinks then CSI
      const stripped = raw
        .toString('binary')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, '')
        .replace(/\r/g, '');
      const m = stripped.match(
        /https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=[a-z0-9-]+&response_type=code&redirect_uri=https%3A%2F%2Fplatform\.claude\.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=[A-Za-z0-9_-]+&code_challenge_method=S256&state=[A-Za-z0-9_-]+/,
      );
      if (m) {
        clearInterval(interval);
        resolve(m[0]);
      } else if (Date.now() > deadlineMs) {
        clearInterval(interval);
        reject(new Error('OAuth URL never appeared in setup-token log'));
      }
    }, 500);
  });
}

function waitForToken(tokenFile, deadlineMs) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (existsSync(tokenFile)) {
        const tok = readFileSync(tokenFile, 'utf8').trim();
        if (tok.startsWith('sk-ant-oat01-') && tok.length > 60) {
          clearInterval(interval);
          resolve(tok);
        }
      } else if (Date.now() > deadlineMs) {
        clearInterval(interval);
        reject(new Error('token never appeared in tokenFile'));
      }
    }, 500);
  });
}

// ─── Anthropic API validation ──────────────────────────────────────────────

async function validateToken(token) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new Error(`token validation HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ─── AWS Secrets Manager ───────────────────────────────────────────────────

function storeSecret(email, accountSlot, token) {
  const secretId = `${SECRET_PREFIX}${accountSlot}`;
  const payload = JSON.stringify({
    email,
    token,
    minted_at: new Date().toISOString(),
    scope: 'user:inference',
  });
  const r = spawnSync(
    'aws',
    ['secretsmanager', 'update-secret', '--region', REGION, '--secret-id', secretId, '--secret-string', payload],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`aws update-secret failed for ${secretId}: ${r.stderr.slice(0, 300)}`);
  }
  return secretId;
}

function existingSecretEmail(accountSlot) {
  const secretId = `${SECRET_PREFIX}${accountSlot}`;
  const r = spawnSync(
    'aws',
    [
      'secretsmanager',
      'get-secret-value',
      '--region',
      REGION,
      '--secret-id',
      secretId,
      '--query',
      'SecretString',
      '--output',
      'text',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    if (typeof j.token === 'string' && j.token.startsWith('sk-ant-oat01-')) return j.email;
  } catch {
    /* ignore */
  }
  return null;
}

// ─── orchestrator ──────────────────────────────────────────────────────────

async function processOne(ledger, email, slot) {
  log(`\n────────── account-${slot}: ${email} ──────────`);

  // Idempotency: skip if Secrets Manager already has a real token
  // AND ledger entry marks the account as token-claimed.
  const existing = existingSecretEmail(slot);
  const ledgerEntry = findAccount(ledger, email);
  if (existing && existing.toLowerCase() === email.toLowerCase() && ledgerEntry?.oauth_token_claimed) {
    log(`SKIP — token already present at ${SECRET_PREFIX}${slot} and ledger.oauth_token_claimed=true`);
    return { skipped: true };
  }
  if (DRY_RUN) {
    log(`DRY-RUN — would mint + store sk-ant-oat01-* for ${email} at ${SECRET_PREFIX}${slot}`);
    return { dryRun: true };
  }

  const accountDir = mkdtempSync(join(TMP, `acct-${slot}-`));

  // Step 1: drive Kapture to login form + click "Continue with email".
  const login = await invokeClaude(buildLoginPrompt(email), `login(${email})`);
  if (!login.ok || !login.result?.ok) {
    throw new Error(`login step failed: ${login.error || JSON.stringify(login.result)}`);
  }
  const tabId = login.result.tabId;
  log(`login submitted, tabId=${tabId}`);

  // Step 2: poll Gmail for magic-link.
  const since = Date.now();
  const magicLinkUrl = await pollMagicLink(email, since, since + 3 * 60 * 1000);
  log(`magic-link URL received (len=${magicLinkUrl.length})`);

  // Step 3: drive Kapture to magic-link URL → logged in.
  const mlin = await invokeClaude(buildMagicLinkPrompt(tabId, magicLinkUrl), `magic-link(${email})`);
  if (!mlin.ok || !mlin.result?.ok) {
    throw new Error(`magic-link step failed: ${mlin.error || JSON.stringify(mlin.result)}`);
  }
  log(`logged in as ${email}, final url=${mlin.result.url}`);

  // Step 4: spawn `claude setup-token` via expect, await OAuth URL.
  const exp = startSetupTokenExpect(accountDir);
  const oauthUrl = await readOauthAuthorizeUrl(exp.log, Date.now() + 60 * 1000);
  log(`setup-token OAuth URL captured (len=${oauthUrl.length})`);

  // Step 5: drive Kapture to OAuth consent → grab code from callback.
  const auth = await invokeClaude(buildAuthorizePrompt(tabId, oauthUrl), `authorize(${email})`);
  if (!auth.ok || !auth.result?.ok) {
    try {
      process.kill(exp.child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    throw new Error(`authorize step failed: ${auth.error || JSON.stringify(auth.result)}`);
  }
  const { code, state } = auth.result;
  log(`authorize callback parsed (code len=${code.length})`);

  // Step 6: pipe `<code>#<state>` to expect via the codeFile.
  writeFileSync(exp.codeFile, `${code}#${state}`);
  const token = await waitForToken(exp.tokenFile, Date.now() + 60 * 1000);
  logRedacted(`token captured for ${email}`, token);

  // Step 7: validate via Anthropic API.
  await validateToken(token);
  log(`token validated against /v1/messages`);

  // Step 8: store in Secrets Manager.
  const secretId = storeSecret(email, slot, token);
  log(`stored in ${secretId}`);

  // Step 9: mark ledger.
  upsertAccount(ledger, email, {
    cycle: ledger.month,
    oauth_token_claimed: true,
    oauth_token_minted_at: new Date().toISOString(),
    oauth_token_secret_id: secretId,
  });
  writeLedger(LEDGER_PATH, ledger);

  // Step 10: scrub the per-account tmpdir (token + intermediate code).
  try {
    rmSync(accountDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return { ok: true, secretId };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(LEDGER_PATH)) {
    log(`FATAL: ledger not found at ${LEDGER_PATH}`);
    process.exit(2);
  }
  const ledger = readLedger(LEDGER_PATH);
  if (!Array.isArray(ledger.accounts) || ledger.accounts.length === 0) {
    log(`FATAL: ledger has no accounts (after v1→v2 migration). seed the file first.`);
    process.exit(2);
  }

  // Establish a stable slot mapping: account-N == the Nth entry in
  // ledger.accounts as written. This matches the existing Secrets Manager
  // layout (placeholders 1..7) so we don't have to remap.
  const entries = ledger.accounts.map((a, i) => ({ email: a.email, slot: i + 1 }));
  const targets = ONLY ? entries.filter((e) => e.email.toLowerCase() === ONLY.toLowerCase()) : entries;
  if (targets.length === 0) {
    log(`no targets — check --only argument or ledger contents.`);
    process.exit(2);
  }
  log(`processing ${targets.length}/${entries.length} accounts. region=${REGION} ledger=${LEDGER_PATH}`);
  if (DRY_RUN) log(`DRY-RUN mode — no Secrets Manager / ledger writes.`);

  const results = [];
  for (const { email, slot } of targets) {
    try {
      const r = await processOne(ledger, email, slot);
      results.push({ email, slot, ...r });
    } catch (err) {
      log(`FAILED ${email}: ${err.message}`);
      results.push({ email, slot, ok: false, error: err.message });
    }
  }

  // Final summary
  log(`\n────────── summary ──────────`);
  for (const r of results) {
    if (r.skipped) log(`SKIP  account-${r.slot}  ${r.email}`);
    else if (r.dryRun) log(`DRY   account-${r.slot}  ${r.email}`);
    else if (r.ok) log(`OK    account-${r.slot}  ${r.email}  → ${r.secretId}`);
    else log(`FAIL  account-${r.slot}  ${r.email}  — ${r.error}`);
  }
  const failed = results.filter((r) => r.ok === false);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(2);
});
