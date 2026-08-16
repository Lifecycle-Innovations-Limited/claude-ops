// secrets-bootstrap.mjs
// Lazily hydrates captcha + proxy secrets into process.env from Doppler
// (project/config via CLAUDE_ROTATOR_SECRETS_PROJECT / CLAUDE_ROTATOR_SECRETS_CONFIG)
// when they are not already present.
//
// Never throws. Never prints secret values. Runs the Doppler CLI at most once
// per process, and only if at least one required key is missing.
import { execFileSync } from 'child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DOPPLER_PROJECT = process.env.CLAUDE_ROTATOR_SECRETS_PROJECT || 'claude-ops';
const DOPPLER_CONFIG = process.env.CLAUDE_ROTATOR_SECRETS_CONFIG || 'prd';

const CAPTCHA_KEYS = [
  'TWOCAPTCHA_API_KEY',
  'TWOCAPTCHA_PROXY_URL',
  'TWOCAPTCHA_PROXY_HOST',
  'TWOCAPTCHA_PROXY_PORT',
  'TWOCAPTCHA_PROXY_USER_BASE',
  'TWOCAPTCHA_PROXY_PASS',
  'TWOCAPTCHA_PROXY_HTTP_URL',
  'TWOCAPTCHA_PROXY_SOCKS5_URL',
  'TWOCAPTCHA_PROXY_SOCKS5_HOST',
  'TWOCAPTCHA_PROXY_SOCKS5_PORT',
  'TWOCAPTCHA_PROXY_SOCKS5_TYPE',
  'TWOCAPTCHA_PROXY_USERNAME',
  'TWOCAPTCHA_PROXY_PASSWORD',
  'TWOCAPTCHA_PROXY_TYPE',
  'TWOCAPTCHA_PROXY_PREFERRED_TRANSPORT',
  'TWOCAPTCHA_PROXY_API_KEY',
  'CAPSOLVER_API_KEY',
  'CAPMONSTER_API_KEY',
  'CAPMONSTER_CLIENT_KEY',
  'ANTICAPTCHA_API_KEY',
  'YESCAPTCHA_CLIENT_KEY',
  'YESCAPTCHA_API_KEY',
];

const BRIGHTDATA_KEYS = [
  'BRIGHT_DATA_USERID',
  'BRIGHT_DATA_TOKEN',
  'BRIGHT_DATA_API_TOKEN',
  'BRIGHTDATA_API_TOKEN',
  'BRIGHTDATA_API_KEY',
  'BRIGHTDATA_PROXY_URL',
  'BRIGHT_DATA_PROXY_HOST',
  'BRIGHT_DATA_PROXY_PORT',
  'BRIGHT_DATA_PROXY_USER',
  'BRIGHT_DATA_PROXY_PASS',
  'BRIGHT_DATA_PROXY_PASSWORD',
  'BRIGHT_DATA_CUSTOMER',
  'BRIGHT_DATA_USER',
  'BRIGHT_DATA_ZONE',
  'BRIGHT_DATA_PASS',
  'BRIGHT_DATA_BROWSER_WSS',
  'BRIGHT_DATA_SCRAPING_ZONE',
  'BRIGHT_DATA_SCRAPING_PASS',
  'BRIGHT_DATA_ISP_PROXY_ZONE',
  'BRIGHT_DATA_ISP_PROXY_PASSWORD',
  'BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE',
  'BRIGHT_DATA_RESIDENTIAL_PROXY_PASSWORD',
  'BRIGHT_DATA_RESIDENTIAL_ZONE',
  'BRIGHT_DATA_ISP_ZONE',
  'BRIGHT_DATA_MOBILE_PROXY_ZONE',
  'BRIGHT_DATA_MOBILE_ZONE',
  'BRIGHT_DATA_MOBILE_PROXY_PASSWORD',
  'BRIGHT_DATA_MOBILE_PASSWORD',
  'BRIGHT_DATA_WEB_UNLOCKER_ZONE',
  'BRIGHTDATA_WEB_UNLOCKER_ZONE',
  'BRIGHT_DATA_UNLOCKER_ZONE',
  'BRIGHT_DATA_ACTIVE_PROXY_ALIAS',
];

const BROWSERLESS_KEYS = ['BROWSERLESS_TOKEN', 'BROWSERLESS_WSS', 'BROWSERLESS_REGION'];

let _done = false;

const SECRET_FILES = [
  process.env.CLAUDE_ROTATOR_SECRETS_FILE,
  join(homedir(), '.config', 'claude-rotation', 'rotator-secrets.env'),
  join(homedir(), '.mcp-secrets.env'),
].filter(Boolean);

function hydrateFromSecretFiles(keys, log) {
  const loaded = [];
  for (const path of SECRET_FILES) {
    let fd = null;
    try {
      // Open first, then fstat and read *the same descriptor*. Checking
      // existence/mode by path and re-resolving the path to read it leaves a
      // TOCTOU window in which the file we vetted can be swapped for a
      // world-readable one (or a symlink to another file) before we read it.
      try {
        fd = openSync(path, 'r');
      } catch {
        continue; // missing or unreadable — nothing to hydrate from
      }
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0) {
        if (log) log(`secrets-bootstrap: refusing permissive secret file ${path}`);
        continue;
      }
      const allowed = new Set(keys);
      for (const line of readFileSync(fd, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)\s*$/);
        if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!value) continue;
        process.env[match[1]] = value;
        loaded.push(match[1]);
      }
    } catch {
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }
  return loaded;
}

function hydrateKeys(keys, log) {
  const fileLoaded = hydrateFromSecretFiles(keys, log);
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length === 0) return { loaded: fileLoaded, source: fileLoaded.length ? 'partial' : 'env' };

  let json;
  try {
    const raw = execFileSync(
      'doppler',
      ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
    );
    json = JSON.parse(raw);
  } catch (e) {
    if (log)
      log(
        `secrets-bootstrap: Doppler unavailable (${String(e.message || e).slice(0, 80)}) — ${missing.length} key(s) stay unset`,
      );
    return { loaded: fileLoaded, source: fileLoaded.length ? 'partial' : 'env' };
  }

  const loaded = [...fileLoaded];
  let dopplerLoaded = 0;
  for (const k of missing) {
    const v = json?.[k]?.computed ?? json?.[k]?.raw;
    if (typeof v === 'string' && v.length > 0) {
      process.env[k] = v;
      loaded.push(k);
      dopplerLoaded++;
    }
  }
  if (log && loaded.length) {
    log(`secrets-bootstrap: hydrated ${loaded.length} key(s) from Doppler ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}`);
  }
  return { loaded, source: !fileLoaded.length && dopplerLoaded === missing.length ? 'doppler' : 'partial' };
}

export function bootstrapRotatorSecrets(log) {
  if (_done) return;
  _done = true;
  try {
    hydrateKeys([...CAPTCHA_KEYS, ...BRIGHTDATA_KEYS, ...BROWSERLESS_KEYS], log);
  } catch {}
}

export function captchaKeyPresent() {
  return !!(
    process.env.TWOCAPTCHA_API_KEY ||
    process.env.CAPSOLVER_API_KEY ||
    process.env.CAPMONSTER_API_KEY ||
    process.env.CAPMONSTER_CLIENT_KEY ||
    process.env.ANTICAPTCHA_API_KEY ||
    process.env.YESCAPTCHA_CLIENT_KEY ||
    process.env.YESCAPTCHA_API_KEY
  );
}

export function captchaKeyNames() {
  return [...CAPTCHA_KEYS];
}
