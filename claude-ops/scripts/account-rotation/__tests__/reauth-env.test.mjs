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

// path includes home .local/bin when HOME set; never injects OS package roots
const p = resolveReauthPath({ HOME: '/tmp/fakehome', PATH: '/usr/bin' });
assert(p.includes('/tmp/fakehome/.local/bin'), 'local bin first');
assert(p.includes('/usr/bin'), 'keeps system path');
assert(!p.includes('homebrew'), 'no homebrew hardcode');
assert(!p.includes('/Users/'), 'no mac home hardcode');
const pEmpty = resolveReauthPath({ HOME: '/tmp/fakehome', PATH: '' });
// empty PATH falls back to minimal POSIX bins only
assert(!pEmpty.includes('homebrew'), 'fallback has no homebrew');
assert(pEmpty.includes('/usr/bin') || pEmpty.includes('.local'), 'fallback usable');

// child env
const env = buildReauthChildEnv({
  env: {
    HOME: '/tmp/fakehome',
    PATH: '/usr/bin',
    CLAUDE_DESKTOP_DISPLAY: ':5',
  },
  crs: {},
});
assert(env.CLAUDE_ROT_HEADED === '1', 'headed default');
assert(env.CLAUDE_DESKTOP_DISPLAY === ':5', 'seat');
assert(env.DESKTOP_ACT_DISPLAY === ':5', 'desktop-act seat');
assert(env.CLAUDE_ROT_STEAL_LOCK === '0', 'no steal');
assert(env.CLAUDE_ROT_SKIP_TOKEN_SOLVERS === '0', 'solvers on');
assert(env.CRS_MAGIC_LINK_DISPATCH === 'setup', 'default dispatch');

const magic = buildReauthChildEnv({
  env: { CRS_MAGIC_LINK_DISPATCH: 'magic-link', HOME: '/tmp/x', PATH: '/bin' },
});
assert(magic.CRS_MAGIC_LINK_DISPATCH === 'magic-link', 'dispatch override');

// timeout
assert(resolveReauthTimeoutMs({}) === 20 * 60_000, 'default 20m');
assert(resolveReauthTimeoutMs({ CRS_MAGIC_LINK_ROTATE_TIMEOUT_MS: '90000' }) === 90000, 'env timeout');

// success markers
assert(reauthOutputLooksSuccessful('{"ok": true}'), 'json ok');
assert(reauthOutputLooksSuccessful('Saved token to vault: Claude-Rotation-user@example.com'), 'vault save');
assert(!reauthOutputLooksSuccessful('FATAL: boom'), 'fatal');
assert(!reauthOutputLooksSuccessful('Timed out waiting for login email'), 'timeout fail');

console.log('reauth-env.test.mjs: ok');
