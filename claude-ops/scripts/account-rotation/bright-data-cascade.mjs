// bright-data-cascade.mjs
// Bright Data FALLBACK helpers for the captcha/oauth path.
//
// Order of intent (callers enforce solver gate separately):
//   1. Local residential browser (EFG SOCKS + PAC) — not this module
//   2. Token solvers (2captcha → capsolver …) — captcha-helper.mjs
//   3. Bright Data proxy tiers (residential → ISP → mobile) for proxy-aligned
//      re-solve, Web Unlocker page fetch, Scraping Browser WSS (rotate.mjs)
//
// Secrets: env / secrets-bootstrap only. Never print passwords or tokens.
// Zone names are read from env — do not hardcode product zone labels.

const REQUEST_TIMEOUT_MS = 60_000;

const TIER_ORDER = ['residential', 'isp', 'mobile'];

/** Env keys per proxy tier. Zone + password stay paired; first non-empty wins. */
const TIER_ENV = {
  residential: {
    zone: ['BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE', 'BRIGHT_DATA_RESIDENTIAL_ZONE'],
    pass: [
      'BRIGHT_DATA_RESIDENTIAL_PROXY_PASSWORD',
      'BRIGHT_DATA_PROXY_PASSWORD',
      'BRIGHT_DATA_PASS',
      'BRIGHT_DATA_PROXY_PASS',
      'BRIGHT_DATA_TOKEN',
    ],
  },
  isp: {
    zone: ['BRIGHT_DATA_ISP_PROXY_ZONE', 'BRIGHT_DATA_ISP_ZONE'],
    pass: ['BRIGHT_DATA_ISP_PROXY_PASSWORD', 'BRIGHT_DATA_TOKEN', 'BRIGHT_DATA_PASS', 'BRIGHT_DATA_PROXY_PASS'],
  },
  mobile: {
    zone: ['BRIGHT_DATA_MOBILE_PROXY_ZONE', 'BRIGHT_DATA_MOBILE_ZONE'],
    pass: ['BRIGHT_DATA_MOBILE_PROXY_PASSWORD', 'BRIGHT_DATA_MOBILE_PASSWORD', 'BRIGHT_DATA_TOKEN', 'BRIGHT_DATA_PASS'],
  },
};

const UNLOCKER_ZONE_ENV = [
  'BRIGHT_DATA_WEB_UNLOCKER_ZONE',
  'BRIGHTDATA_WEB_UNLOCKER_ZONE',
  'BRIGHT_DATA_UNLOCKER_ZONE',
];

const API_TOKEN_ENV = ['BRIGHT_DATA_API_TOKEN', 'BRIGHTDATA_API_TOKEN', 'BRIGHTDATA_API_KEY', 'BRIGHT_DATA_API_KEY'];

function envFirst(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

function customerId() {
  // Prefer explicit customer; USERID is often the bare customer id (e.g. hl_…).
  const c = envFirst(['BRIGHT_DATA_CUSTOMER', 'BRIGHT_DATA_USER', 'BRIGHT_DATA_USERID']) || null;
  if (!c) return null;
  // If someone stored full brd-customer-X-zone-Y as USERID, strip to customer.
  const m = c.match(/^brd-customer-([^-]+(?:-[^-]+)*)-zone-/i);
  if (m) return m[1];
  if (/^brd-customer-/i.test(c)) return c.replace(/^brd-customer-/i, '');
  return c;
}

function superProxyHost() {
  return envFirst(['BRIGHT_DATA_PROXY_HOST', 'BRIGHTDATA_PROXY_HOST']) || 'brd.superproxy.io';
}

function superProxyPort() {
  const p = envFirst(['BRIGHT_DATA_PROXY_PORT', 'BRIGHTDATA_PROXY_PORT']);
  return p || '33335';
}

/**
 * Configured proxy tiers in order residential → ISP → mobile.
 * Only tiers with both zone and password env set are returned.
 * @returns {Array<{tier:string, zone:string, hasPass:boolean}>}
 */
export function listProxyTiers() {
  const out = [];
  for (const tier of TIER_ORDER) {
    const cfg = TIER_ENV[tier];
    const zone = envFirst(cfg.zone);
    const pass = envFirst(cfg.pass);
    if (zone && pass) {
      out.push({ tier, zone, hasPass: true });
    }
  }
  // Fallback single-zone if dedicated residential keys missing but BRIGHT_DATA_ZONE set
  if (!out.some((t) => t.tier === 'residential')) {
    const zone = envFirst(['BRIGHT_DATA_ZONE']);
    const pass = envFirst([
      'BRIGHT_DATA_PROXY_PASSWORD',
      'BRIGHT_DATA_PASS',
      'BRIGHT_DATA_PROXY_PASS',
      'BRIGHT_DATA_TOKEN',
    ]);
    if (zone && pass) out.unshift({ tier: 'residential', zone, hasPass: true });
  }
  return out;
}

/**
 * Build an HTTP proxy URL for a named tier (residential | isp | mobile).
 * Prefer BRIGHTDATA_PROXY_URL only when tier matches active alias or is the
 * sole configured tier and no zone composition is possible.
 * @param {string} tier
 * @returns {string|null} http://user:pass@host:port
 */
export function getProxyUrlForTier(tier) {
  const name = String(tier || '').toLowerCase();
  if (!TIER_ENV[name] && name !== 'residential') return null;

  const cfg = TIER_ENV[name] || TIER_ENV.residential;
  let zone = envFirst(cfg.zone);
  let pass = envFirst(cfg.pass);
  if (name === 'residential' && (!zone || !pass)) {
    zone = zone || envFirst(['BRIGHT_DATA_ZONE']);
    pass =
      pass ||
      envFirst(['BRIGHT_DATA_PROXY_PASSWORD', 'BRIGHT_DATA_PASS', 'BRIGHT_DATA_PROXY_PASS', 'BRIGHT_DATA_TOKEN']);
  }
  if (!zone || !pass) return null;

  const customer = customerId();
  const host = superProxyHost();
  const port = superProxyPort();

  // Username form: brd-customer-<id>-zone-<zone>
  // If USERID already looks like a full proxy user for this zone, use it.
  const userid = envFirst(['BRIGHT_DATA_USERID', 'BRIGHT_DATA_PROXY_USER']);
  let user;
  if (userid && userid.includes(`-zone-${zone}`)) {
    user = userid;
  } else if (customer) {
    const cust = customer.replace(/^brd-customer-/i, '');
    user = `brd-customer-${cust}-zone-${zone}`;
  } else if (userid && !userid.includes('-zone-')) {
    user = `brd-customer-${userid}-zone-${zone}`;
  } else {
    return null;
  }

  const encPass = encodeURIComponent(pass);
  return `http://${user}:${encPass}@${host}:${port}`;
}

/**
 * Solver-shaped proxy fields for 2captcha / CapSolver task payloads.
 * @param {string} tier
 * @returns {{proxy:string, proxytype:string, proxyType:string, proxyAddress:string, proxyPort:number, proxyLogin?:string, proxyPassword?:string}|null}
 */
export function getSolverProxyParamsForTier(tier) {
  const url = getProxyUrlForTier(tier);
  if (!url) return null;
  try {
    const u = new URL(url);
    const user = u.username ? decodeURIComponent(u.username) : '';
    const pass = u.password ? decodeURIComponent(u.password) : '';
    const auth = user ? `${user}:${pass}@` : '';
    return {
      proxy: `${auth}${u.hostname}:${u.port}`,
      proxytype: 'HTTP',
      proxyType: 'http',
      proxyAddress: u.hostname,
      proxyPort: Number(u.port) || 33335,
      proxyLogin: user || undefined,
      proxyPassword: pass || undefined,
    };
  } catch {
    return null;
  }
}

export function webUnlockerZone() {
  return envFirst(UNLOCKER_ZONE_ENV);
}

export function webUnlockerConfigured() {
  return !!(envFirst(API_TOKEN_ENV) && webUnlockerZone());
}

export function brightDataCascadeAvailable() {
  return listProxyTiers().length > 0 || webUnlockerConfigured();
}

/**
 * Web Unlocker API — page fetch only (HTML/JSON body).
 * Does NOT return Turnstile/hCaptcha tokens for browser injection.
 * POST https://api.brightdata.com/request with Bearer BRIGHT_DATA_API_TOKEN.
 *
 * @param {string} url
 * @param {{ zone?: string, format?: 'raw'|'json', country?: string, method?: string, timeoutMs?: number, log?: (m:string)=>void }} [opts]
 * @returns {Promise<{ok:boolean, status:number, body:string|null, error?:string, zone?:string}>}
 */
export async function webUnlockerRequest(url, opts = {}) {
  const log = opts.log || (() => {});
  const token = envFirst(API_TOKEN_ENV);
  const zone = opts.zone || webUnlockerZone();
  if (!token) {
    log('brightdata-unlocker: no BRIGHT_DATA_API_TOKEN — skip');
    return { ok: false, status: 0, body: null, error: 'no-api-token' };
  }
  if (!zone) {
    log('brightdata-unlocker: no unlocker zone (set BRIGHT_DATA_WEB_UNLOCKER_ZONE) — skip');
    return { ok: false, status: 0, body: null, error: 'no-unlocker-zone' };
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, body: null, error: 'bad-url' };
  }

  const timeoutMs = Number(opts.timeoutMs || REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = {
    zone,
    url,
    format: opts.format || 'raw',
  };
  if (opts.country) payload.country = opts.country;
  if (opts.method) payload.method = opts.method;

  try {
    log(`brightdata-unlocker: POST zone=${zone} url=${String(url).slice(0, 80)}`);
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      log(`brightdata-unlocker: HTTP ${res.status}`);
      return {
        ok: false,
        status: res.status,
        body: body ? body.slice(0, 500) : null,
        error: `http-${res.status}`,
        zone,
      };
    }
    log(`brightdata-unlocker: ok body=${body.length} chars`);
    return { ok: true, status: res.status, body, zone };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 120);
    log(`brightdata-unlocker: failed ${msg}`);
    return { ok: false, status: 0, body: null, error: msg, zone };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Note for captcha-helper: Web Unlocker returns unlocked HTML, not a sitekey
 * token. Token injection still needs 2captcha/CapSolver (optionally via Bright
 * Data proxy for IP alignment). Scraping Browser is a separate browser driver.
 */
export const BRIGHT_DATA_CAPTCHA_ROLE = {
  webUnlocker: 'page-fetch-only',
  proxyTiers: 'solver-proxy-alignment',
  scrapingBrowser: 'remote-browser-driver',
};
