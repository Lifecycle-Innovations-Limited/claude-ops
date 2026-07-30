/**
 * Runs captcha unit suite and applies rotate captcha hooks once.
 * Usage: node __tests__/run-captcha-unit-tests.mjs
 */
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureRotateCaptchaHooks } from '../ensure-rotate-captcha-hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const applied = ensureRotateCaptchaHooks();
console.log('[run] ensure hooks:', JSON.stringify(applied));

const tests = [
  join(__dirname, 'captcha-cascade.test.mjs'),
  join(__dirname, 'ensure-rotate-captcha-hooks.test.mjs'),
  join(__dirname, 'reauth-env.test.mjs'),
];

let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    failed++;
    console.error(`[run] FAIL ${t} status=${r.status}`);
  } else {
    console.error(`[run] ok ${t}`);
  }
}
process.exit(failed ? 1 : 0);
