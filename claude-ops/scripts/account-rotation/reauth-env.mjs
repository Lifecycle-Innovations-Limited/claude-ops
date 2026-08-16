/**
 * Portable env builder for unattended re-auth (magic-link-autoloop → rotate.mjs).
 *
 * No host paths, no account emails, no operator names. Everything is driven by
 * process.env (and optional rotation config keys). Callers merge the returned
 * object into child_process.spawn env.
 *
 * See CAPTCHA-CASCADE.md for the captcha stack contract.
 */
import { join } from 'path';
import { homedir } from 'os';

/**
 * Resolve the X display used for headed reauth Chrome + desktop-act.
 * Prefer explicit reauth seat vars over the ambient DISPLAY of a headless unit.
 */
export function resolveReauthDisplay(env = process.env) {
  return env.CLAUDE_DESKTOP_DISPLAY || env.DESKTOP_ACT_DISPLAY || env.CLAUDE_REAUTH_DISPLAY || env.DISPLAY || ':1';
}

/**
 * Build PATH with optional user-local bin. No OS package-manager roots.
 * Prefer process PATH; fall back to a minimal POSIX list only when PATH is
 * unset (common in stripped service units).
 */
export function resolveReauthPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const isWin = process.platform === 'win32' || /^(msys|cygwin)/i.test(String(env.OSTYPE || ''));
  const sep = isWin || String(env.PATH || '').includes(';') ? ';' : ':';
  const localBin = home ? join(home, '.local', 'bin') : '';
  const base = env.PATH || (isWin ? '' : ['/usr/local/bin', '/usr/bin', '/bin'].join(sep));
  const parts = [localBin, base].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const chunk of parts.join(sep).split(sep)) {
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    out.push(chunk);
  }
  return out.join(sep);
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Record<string, unknown>} [opts.rotation]  optional rotationSection(loadRotationConfig())
 * @returns {NodeJS.ProcessEnv} env fragment to merge into spawn
 */
export function buildReauthChildEnv(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.rotation || opts.crs || {};
  const display = resolveReauthDisplay(env);

  // Dispatch mode: public plugin default is rotate --setup; forks may set magic-link.
  const dispatch = env.CLAUDE_REAUTH_DISPATCH || env.CRS_MAGIC_LINK_DISPATCH || cfg.magicLinkDispatch || 'setup';

  const headed = env.CLAUDE_ROT_HEADED || (String(cfg.magicLinkHeaded ?? '1') === '0' ? '0' : '1');

  const fragment = {
    CLAUDE_ROTATION_MAGIC_LINK_AUTO: '1',
    CLAUDE_ROT_STEAL_LOCK: '0',
    CLAUDE_REAUTH_DISPATCH: String(dispatch),

    // Seat for headed Chrome + desktop-act (must match reauth browser DISPLAY)
    DISPLAY: display,
    CLAUDE_DESKTOP_DISPLAY: display,
    DESKTOP_ACT_DISPLAY: display,

    // Headed browser is required for interactive captcha walls on most seats
    CLAUDE_ROT_HEADED: headed,
    CLAUDE_ROT_FORCE_HEADED: env.CLAUDE_ROT_FORCE_HEADED || (headed === '1' ? '1' : '0'),

    // Captcha cascade (no-op if rotate.mjs lacks captcha helpers)
    CLAUDE_ROT_VISUAL_CAPTCHA: env.CLAUDE_ROT_VISUAL_CAPTCHA || '1',
    CLAUDE_ROT_DESKTOP_ACT: env.CLAUDE_ROT_DESKTOP_ACT || '1',
    CLAUDE_ROT_VNC_AGENT: env.CLAUDE_ROT_VNC_AGENT || '1',
    CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS: env.CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS || '4',
    CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS: env.CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS || '8000',
    // Never leave a one-shot "skip solvers" flag sticky in the reconciler env
    CLAUDE_ROT_SKIP_TOKEN_SOLVERS: env.CLAUDE_ROT_SKIP_TOKEN_SOLVERS || '0',

    PATH: resolveReauthPath(env),
  };

  // Optional desktop-act install roots (portable; only set when provided)
  for (const key of [
    'DESKTOP_ACT_CLI',
    'DESKTOP_ACT_HOME',
    'DESKTOP_ACT_VENV',
    'DESKTOP_ACT_COMMAND',
    'DESKTOP_ACT_CAPTCHA_TIMEOUT',
    'DESKTOP_ACT_MAX_ITERATIONS',
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA_DIR',
    'CLAUDE_REAUTH_CDP_PORT',
  ]) {
    if (env[key]) fragment[key] = env[key];
  }

  return fragment;
}

/**
 * Wall-clock budget for one unattended reauth child.
 * Longer than a pure token refresh: visual + desktop-act layers need room.
 */
export function resolveReauthTimeoutMs(env = process.env, cfg = {}) {
  return Number(
    env.CLAUDE_REAUTH_TIMEOUT_MS ??
      env.CRS_MAGIC_LINK_ROTATE_TIMEOUT_MS ??
      cfg.magicLinkRotateTimeoutMs ??
      20 * 60_000,
  );
}

/**
 * Success markers for unattended reauth stdout (setup JSON or magic-link logs).
 * Keep provider-agnostic; no account emails.
 */
export function reauthOutputLooksSuccessful(out = '') {
  const text = String(out || '');
  if (
    /FATAL:|Authorize button still not clickable|Cloudflare challenge|security verification|Timed out waiting for login email/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /"ok"\s*:\s*true/i.test(text) ||
    /authorized|propagat|VERIFIED|OAuth complete|token refreshed|refresh.?ok|Saved token to vault|needsReauth cleared/i.test(
      text,
    )
  );
}
