#!/usr/bin/env node
/**
 * rotate-magic — thin entry for unattended magic-link re-auth.
 *
 * SSOT implementation: rotate.mjs --magic-link (plus setup --auto for multi-account).
 * Ensures captcha wall hooks exist in rotate.mjs, then loads captcha cascade modules
 * when present (captcha-cascade.mjs / rotate-captcha-soft.mjs).
 * Does NOT require CRS. Optional CRS reconcilers call this via magic-link-autoloop.
 *
 * Usage:
 *   node rotate-magic.mjs --to <email>
 *   node rotate-magic.mjs --to <email> --force
 *   node rotate-magic.mjs --setup --only=<email> --auto --skip-valid
 *
 * Env: see CAPTCHA-CASCADE.md and reauth-env.mjs (CLAUDE_DESKTOP_DISPLAY, headed, cascade flags).
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureRotateCaptchaHooks } from './ensure-rotate-captcha-hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rotate = join(__dirname, 'rotate.mjs');
const argv = process.argv.slice(2);

// Ensure trySolveCaptchaWall call sites exist in public rotate.mjs (idempotent).
try {
  const r = ensureRotateCaptchaHooks();
  if (r.changed) {
    console.error(`[rotate-magic] applied captcha wall hooks to rotate.mjs (${r.reason || 'patched'})`);
  }
} catch (e) {
  console.error(`[rotate-magic] captcha hook ensure failed: ${String(e.message || e).slice(0, 120)}`);
}

// Default to magic-link mode unless caller already chose --setup / --status / etc.
const hasMode = argv.some(
  (a) =>
    a === '--magic-link' ||
    a === '--setup' ||
    a === '--status' ||
    a === '--utilization' ||
    a === '--capture' ||
    a === '--audit-billing' ||
    a.startsWith('--setup'),
);
const finalArgv = hasMode ? argv : ['--magic-link', ...argv];

const child = spawn(process.execPath, [rotate, ...finalArgv], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
