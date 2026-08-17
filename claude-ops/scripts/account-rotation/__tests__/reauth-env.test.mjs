/**
 * Portable reauth-env unit tests (no network, no real accounts).
 */
import {
  resolveReauthDisplay,
  resolveReauthPath,
  buildReauthChildEnv,
  resolveReauthTimeoutMs,
  reauthOutputLooksSuccessful,
} from '../reauth-env.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// display priority
assert(resolveReauthDisplay({}) === ':1', 'default display');
assert(resolveReauthDisplay({ CLAUDE_DESKTOP_DISPLAY: ':3' }) === ':3', 'desktop display wins');
assert(
  resolveReauthDisplay({ DISPLAY: ':9', CLAUDE_DESKTOP_DISPLAY: ':2' }) === ':2',
  'CLAUDE_DESKTOP_DISPLAY over DISPLAY',
);

// path includes home .local/bin when HOME set; never invents vendor package roots
const p = resolveReauthPath({ HOME: '/tmp/fakehome', PATH: '/usr/bin' });
assert(p.includes('/tmp/fakehome/.local/bin'), 'local bin first');
assert(p.includes('/usr/bin'), 'keeps system path');
assert(!/opt\/(homebrew|local\/Homebrew)/i.test(p), 'no vendor package root');
const pEmpty = resolveReauthPath({ HOME: '/tmp/fakehome', PATH: '' });
assert(pEmpty.includes('/usr/bin') || pEmpty.includes('.local'), 'fallback usable');
assert(!/opt\/(homebrew|local\/Homebrew)/i.test(pEmpty), 'fallback has no vendor package root');

// child env
const env = buildReauthChildEnv({
  env: {
    HOME: '/tmp/fakehome',
    PATH: '/usr/bin',
    CLAUDE_DESKTOP_DISPLAY: ':5',
  },
  rotation: {},
});
assert(env.CLAUDE_ROT_HEADED === '1', 'headed default');
assert(env.CLAUDE_DESKTOP_DISPLAY === ':5', 'seat');
assert(env.DESKTOP_ACT_DISPLAY === ':5', 'desktop-act seat');
assert(env.CLAUDE_ROT_STEAL_LOCK === '0', 'no steal');
assert(env.CLAUDE_ROT_SKIP_TOKEN_SOLVERS === '0', 'solvers on');
assert(env.CLAUDE_REAUTH_DISPATCH === 'setup', 'default dispatch');

const magic = buildReauthChildEnv({
  env: { CLAUDE_REAUTH_DISPATCH: 'magic-link', HOME: '/tmp/x', PATH: '/bin' },
});
assert(magic.CLAUDE_REAUTH_DISPATCH === 'magic-link', 'dispatch override');

// timeout
assert(resolveReauthTimeoutMs({}) === 20 * 60_000, 'default 20m');
assert(resolveReauthTimeoutMs({ CLAUDE_REAUTH_TIMEOUT_MS: '90000' }) === 90000, 'env timeout');

// success markers
assert(reauthOutputLooksSuccessful('{"ok": true}'), 'json ok');
assert(reauthOutputLooksSuccessful('Saved token to vault: Claude-Rotation-user@example.com'), 'vault save');
assert(!reauthOutputLooksSuccessful('FATAL: boom'), 'fatal');
assert(!reauthOutputLooksSuccessful('Timed out waiting for login email'), 'timeout fail');

console.log('reauth-env.test.mjs: ok');
