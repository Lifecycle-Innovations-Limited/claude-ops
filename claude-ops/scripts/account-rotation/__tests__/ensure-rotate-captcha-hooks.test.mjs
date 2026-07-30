/**
 * ensure-rotate-captcha-hooks unit tests (no browser).
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// Live plugin rotate should either already have hooks or be patchable.
const live = await import('../ensure-rotate-captcha-hooks.mjs');
const status = live.rotateCaptchaHooksPresent();
assert(typeof status === 'boolean', 'present returns boolean');

// Dry-run ensure should not throw
const dry = live.ensureRotateCaptchaHooks({ dryRun: true });
assert(dry.ok === true, 'dry-run ok');
assert(typeof dry.changed === 'boolean', 'changed boolean');

// Apply for real (idempotent on this tree)
const applied = live.ensureRotateCaptchaHooks({ dryRun: false });
assert(applied.ok === true, 'apply ok');
assert(live.rotateCaptchaHooksPresent() === true, 'hooks present after ensure');

// Second apply is no-op
const again = live.ensureRotateCaptchaHooks({ dryRun: false });
assert(again.ok === true && again.changed === false, 'second ensure no-op');

console.log('ensure-rotate-captcha-hooks.test.mjs: ok');
