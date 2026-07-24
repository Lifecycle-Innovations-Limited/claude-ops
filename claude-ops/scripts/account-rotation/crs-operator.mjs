#!/usr/bin/env node
/** CRS-backed Claude Code background operator for account-rotation stalls. */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import os from 'os';

const DEFAULT_CRS_BASE_URL = 'http://127.0.0.1:8091/api';
const DEFAULT_CRS_KEY_PATH = join(os.homedir(), '.claude', 'crs-api-key');
const LOG_DIR = join(os.homedir(), '.claude', 'scripts', 'account-rotation', 'operator-logs');

function safeName(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80);
}

function claudeBin() {
  const candidates = [
    join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ];
  return candidates.find((p) => p === 'claude' || existsSync(p)) || 'claude';
}

function crsSettingsPath() {
  const p = join(os.homedir(), '.claude', 'crs-session-settings.json');
  return existsSync(p) ? p : null;
}

export async function launchCrsOperator({ account, stallReason, url, screenshotPath, logger }) {
  const log = logger || (() => {});
  if (process.env.CLAUDE_ROTATOR_DISABLE_CRS_OPERATOR === '1') {
    log('[crs-operator] disabled by CLAUDE_ROTATOR_DISABLE_CRS_OPERATOR=1');
    return { ok: false, reason: 'disabled' };
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const email = account?.email || 'unknown';
  const missionPath = join(LOG_DIR, `${ts}-${safeName(email)}.mission.md`);
  const outPath = join(LOG_DIR, `${ts}-${safeName(email)}.out.log`);
  const errPath = join(LOG_DIR, `${ts}-${safeName(email)}.err.log`);

  const prompt = `# Mission: complete Claude account re-auth

You are a bounded browser operator for the Claude account rotation script.

Target account: ${email}
Current URL: ${url || 'unknown'}
Stall reason: ${stallReason || 'unknown'}
Chrome CDP: http://127.0.0.1:9222
Workspace: ${process.cwd()}
Screenshot: ${screenshotPath || 'not captured'}

Rules:
- Use the existing Chrome Beta remote debugging session on port 9222; do not launch a separate browser unless CDP is unreachable.
- Complete the login/OAuth flow for the target account only.
- Magic-link emails for all used Claude.ai accounts are polled from shared-inbox@example.com; target-specific forwarded emails may arrive through user@example.com.
- If the page asks for an email verification code or magic link, inspect Gmail via gog using account shared-inbox@example.com and use the newest Claude/Anthropic message whose embedded magic-link target matches ${email}.
- Preserve user work and active tmux panes. Do not kill Chrome, CRS, tmux, or unrelated agents.
- Prefer clicking/typing in the existing page over config edits. Only edit files if that is required to fix the reauth automation root cause.
- Stop when the OAuth localhost callback is captured or when you can state the exact external challenge preventing completion.

Return concise progress in your agent log. This mission is urgent but bounded.`;

  writeFileSync(missionPath, prompt);

  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || DEFAULT_CRS_BASE_URL;
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY && existsSync(DEFAULT_CRS_KEY_PATH)) {
    env.ANTHROPIC_AUTH_TOKEN = `Bearer ${DEFAULT_CRS_KEY_PATH}`;
  }

  const args = [
    '--bg',
    '--name',
    `crs-reauth-${safeName(email)}`,
    '--model',
    process.env.CLAUDE_ROTATOR_OPERATOR_MODEL || 'claude-sonnet-5',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    os.homedir(),
  ];
  const settings = crsSettingsPath();
  if (settings) args.push('--settings', settings);
  args.push(prompt);

  const child = spawn(claudeBin(), args, {
    cwd: join(os.homedir(), '.claude', 'scripts', 'account-rotation'),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => writeFileSync(outPath, d, { flag: 'a' }));
  child.stderr.on('data', (d) => writeFileSync(errPath, d, { flag: 'a' }));
  child.unref();

  log(`[crs-operator] launched Claude bg operator pid=${child.pid} mission=${missionPath}`);
  return { ok: true, pid: child.pid, missionPath, outPath, errPath };
}
