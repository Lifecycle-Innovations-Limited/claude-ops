// secrets-bootstrap.mjs
// Lazily hydrates captcha + proxy secrets into process.env from Doppler
// (project claude-ops / config prd) when they are not already present.
//
// Keys hydrated (only the missing ones are set):
//   TWOCAPTCHA_API_KEY, TWOCAPTCHA_PROXY_URL, TWOCAPTCHA_PROXY_HOST,
//   TWOCAPTCHA_PROXY_PORT, TWOCAPTCHA_PROXY_USER_BASE, TWOCAPTCHA_PROXY_PASS,
//   BRIGHT_DATA_USERID, BRIGHT_DATA_TOKEN, BRIGHTDATA_PROXY_URL,
//   BRIGHT_DATA_PROXY_HOST, BRIGHT_DATA_PROXY_PORT, BRIGHT_DATA_PROXY_USER,
//   BRIGHT_DATA_PROXY_PASS, BRIGHT_DATA_CUSTOMER, BRIGHT_DATA_ZONE,
//   BRIGHT_DATA_PASS, BRIGHT_DATA_BROWSER_WSS, BRIGHT_DATA_SCRAPING_ZONE,
//   BRIGHT_DATA_SCRAPING_PASS
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
];

const BRIGHTDATA_KEYS = [
  'BRIGHT_DATA_USERID',
  'BRIGHT_DATA_TOKEN',
  'BRIGHTDATA_PROXY_URL',
  'BRIGHT_DATA_PROXY_HOST',
  'BRIGHT_DATA_PROXY_PORT',
  'BRIGHT_DATA_PROXY_USER',
  'BRIGHT_DATA_PROXY_PASS',
  'BRIGHT_DATA_CUSTOMER',
  'BRIGHT_DATA_ZONE',
  'BRIGHT_DATA_PASS',
  // Scraping Browser (remote headless Chrome over WSS CDP). Either provide the
  // full connection string in BRIGHT_DATA_BROWSER_WSS, or the zone + password
  // so the endpoint can be constructed.
  'BRIGHT_DATA_BROWSER_WSS',
  'BRIGHT_DATA_SCRAPING_ZONE',
  'BRIGHT_DATA_SCRAPING_PASS',
];

// Browserless — remote headless Chrome over WSS CDP (works today, no GUI).
// Used as the default remote-browser endpoint when Bright Data's Scraping
// Browser zone is not provisioned.
const BROWSERLESS_KEYS = ['BROWSERLESS_TOKEN', 'BROWSERLESS_WSS', 'BROWSERLESS_REGION'];

let _done = false;

const SECRET_FILES = [
  process.env.CLAUDE_ROTATOR_SECRETS_FILE,
  join(homedir(), '.config', 'crs-sync', 'rotator-secrets.env'),
].filter(Boolean);

function hydrateFromSecretFiles(keys, log) {
  const loaded = [];
  for (const path of SECRET_FILES) {
    // Open once and check/read via the same fd, with no existsSync pre-check —
    // any check-then-open on a path is a race the path could be swapped
    // (e.g. to a symlink) in between. A missing file just throws ENOENT here,
    // same as any other open failure.
    let fd;
    try {
      fd = openSync(path, 'r');
      if ((fstatSync(fd).mode & 0o077) !== 0) {
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
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }
  return loaded;
}

/**
 * Ensure the given keys exist in process.env, pulling any missing ones from
 * Doppler. Returns { loaded: string[], source: 'env'|'doppler'|'partial' }.
 * @param {string[]} keys
 * @param {(m:string)=>void} [log]
 */
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

/**
 * Hydrate captcha + Bright Data secrets once per process. Safe to call eagerly.
 * @param {(m:string)=>void} [log]
 */
export function bootstrapRotatorSecrets(log) {
  if (_done) return;
  _done = true;
  try {
    hydrateKeys([...CAPTCHA_KEYS, ...BRIGHTDATA_KEYS, ...BROWSERLESS_KEYS], log);
  } catch {}
}

export function captchaKeyPresent() {
  return !!process.env.TWOCAPTCHA_API_KEY;
}
