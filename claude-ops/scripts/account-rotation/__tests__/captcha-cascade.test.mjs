/**
 * captcha-cascade unit tests (no network, no real browser).
 */
import {
  resolveCaptchaHandoffDir,
  detectPostVerifyVisualChallenge,
  captchaHardFailed,
  tryClearCaptchaWall,
  maybeSolvePageCaptcha,
} from '../captcha-cascade.mjs';
import { trySolveCaptchaWall, detectCaptchaWall, maybeClearCaptchaWall } from '../rotate-captcha-soft.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// handoff dir prefers env, then plugin data, never host-only path hardcode
const d1 = resolveCaptchaHandoffDir({ CLAUDE_ROT_CAPTCHA_HANDOFF_DIR: '/tmp/captcha-handoff-test' });
assert(d1 === '/tmp/captcha-handoff-test', 'explicit handoff dir');
const d2 = resolveCaptchaHandoffDir({
  CLAUDE_PLUGIN_DATA_DIR: '/tmp/plugin-data',
  HOME: '/tmp/home',
});
assert(d2.includes('account-rotation'), 'plugin data handoff under account-rotation');
assert(d2.startsWith('/tmp/plugin-data'), 'uses CLAUDE_PLUGIN_DATA_DIR');

// empty page → no wall
const empty = await detectPostVerifyVisualChallenge(null);
assert(empty.blocking === false && empty.present === false, 'null page not blocking');

// mock page: body text only
const mockNoWall = {
  evaluate: async () => 'Enter the verification code we sent',
};
const soft = await detectPostVerifyVisualChallenge(mockNoWall);
assert(soft.blocking === false, 'otp prompt text alone is not a blocking wall');

// mock page with pick/drag prompt
const mockDrag = {
  evaluate: async () => 'Please drag the icon to the place where it fits to continue',
};
const drag = await detectPostVerifyVisualChallenge(mockDrag);
assert(drag.blocking === true, 'drag-fit is blocking');
assert(drag.kind === 'drag-fit', 'kind drag-fit');

// soft helpers
const pageObj = {};
assert(captchaHardFailed(pageObj) === false, 'fresh page not hard-failed');
assert(captchaHardFailed(null) === false, 'null not hard-failed');
assert((await trySolveCaptchaWall(null, 'unit', () => {})) === false, 'null trySolve');
assert((await tryClearCaptchaWall(null, 'unit', () => {})) === false, 'null tryClear');
assert((await maybeClearCaptchaWall(null, 'unit', () => {})) === false, 'null maybeClear alias');
assert((await maybeSolvePageCaptcha(null, 'unit')) === false, 'null maybeSolvePage');

const softDetect = await detectCaptchaWall(null);
assert(softDetect.blocking === false, 'soft detect null');

console.log('captcha-cascade.test.mjs: ok');
