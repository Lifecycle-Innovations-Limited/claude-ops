// captcha-helper.mjs
// Detects a Cloudflare Turnstile / hCaptcha challenge on a Playwright page and
// solves it via a pluggable chain of captcha services, then injects the token.
//
// Providers (first available wins; order overridable via CLAUDE_ROT_CAPTCHA_PROVIDERS):
//   1. twocaptcha  — TWOCAPTCHA_API_KEY (hosts: 2captcha.com → rucaptcha.com failover)
//   2. capsolver   — CAPSOLVER_API_KEY
//   3. capmonster  — CAPMONSTER_API_KEY / CAPMONSTER_CLIENT_KEY
//   4. anticaptcha — ANTICAPTCHA_API_KEY
//   5. yescaptcha  — YESCAPTCHA_CLIENT_KEY
//   6. brightdata  — FALLBACK only: re-solve via Bright Data residential→ISP→mobile
//                    proxy alignment (token still from 2captcha). Web Unlocker is
//                    page-fetch only — see bright-data-cascade.mjs (not token inject).
//
// Solvers remain FALLBACK only (CLAUDE_ROT_CAPTCHA_SOLVER_MODE=fallback): residential
// browser wait first (residualAfterWait), then this provider chain.
//
// Secrets hydrated by secrets-bootstrap.mjs from env / optional secrets bootstrap.
// Optional TWOCAPTCHA_PROXY_* makes 2captcha/rucaptcha solve from a fixed IP.
// headed Chrome CDP :9222 is direct AWS egress — proxied tokens are
// IP-mismatched by default. Use CLAUDE_ROT_CAPTCHA_FORCE_PROXY=1 to force proxy.
//
// Never throws. Never prints API keys or tokens. Returns structured results.

import {
  brightDataCascadeAvailable,
  listProxyTiers,
  getSolverProxyParamsForTier,
  webUnlockerConfigured,
  BRIGHT_DATA_CAPTCHA_ROLE,
} from './bright-data-cascade.mjs';

const REQUEST_TIMEOUT_MS = 15_000;

const TWOCAPTCHA_HOSTS = (process.env.CLAUDE_ROT_TWOCAPTCHA_HOSTS || '2captcha.com,rucaptcha.com')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function maskId(v) {
  const s = String(v || '');
  if (s.length <= 10) return s.slice(0, 4) + '…';
  return s.slice(0, 6) + '…';
}

/** Env keys that enable each provider. First matching key wins for that provider. */
export const PROVIDER_KEY_ENV = {
  twocaptcha: ['TWOCAPTCHA_API_KEY'],
  capsolver: ['CAPSOLVER_API_KEY'],
  capmonster: ['CAPMONSTER_API_KEY', 'CAPMONSTER_CLIENT_KEY'],
  anticaptcha: ['ANTICAPTCHA_API_KEY'],
  yescaptcha: ['YESCAPTCHA_CLIENT_KEY', 'YESCAPTCHA_API_KEY'],
  // brightdata is cascade-gated (proxy tiers / unlocker), not a single API key —
  // listed for CLAUDE_ROT_CAPTCHA_PROVIDERS override discovery only.
  brightdata: [
    'BRIGHT_DATA_API_TOKEN',
    'BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE',
    'BRIGHT_DATA_ISP_PROXY_ZONE',
    'BRIGHT_DATA_MOBILE_PROXY_ZONE',
    'BRIGHT_DATA_TOKEN',
  ],
};

function envFirst(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

export function listConfiguredProviders() {
  const names = Object.entries(PROVIDER_KEY_ENV)
    .filter(([name, keys]) => {
      if (name === 'brightdata') return brightDataCascadeAvailable();
      return !!envFirst(keys);
    })
    .map(([name]) => name);
  return names;
}

export function captchaSolverAvailable() {
  // Token inject needs a real solver key; Bright Data alone cannot inject.
  const tokenSolvers = listConfiguredProviders().filter((p) => p !== 'brightdata');
  if (tokenSolvers.length > 0) return true;
  // Proxy-aligned path still needs TWOCAPTCHA (or other) under the hood.
  return false;
}

/** Ordered provider names for this process. */
export function providerOrder() {
  const raw = process.env.CLAUDE_ROT_CAPTCHA_PROVIDERS;
  const configured = listConfiguredProviders();
  if (raw) {
    const wanted = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const ordered = wanted.filter((p) => configured.includes(p));
    // Append any remaining configured providers not listed.
    for (const p of configured) if (!ordered.includes(p)) ordered.push(p);
    return ordered;
  }
  // Default: twocaptcha first, other token solvers, then Bright Data cascade last.
  const preferred = ['twocaptcha', 'capsolver', 'capmonster', 'anticaptcha', 'yescaptcha', 'brightdata'];
  return preferred.filter((p) => configured.includes(p));
}

import net from 'node:net';
const { createConnection } = net;

/** True when local EFG SOCKS (CLAUDE_ROT_EFG_SOCKS_*) accepts connections. */
export async function residentialEgressHealthy() {
  const host = process.env.CLAUDE_ROT_EFG_SOCKS_HOST || '127.0.0.1';
  const port = Number(process.env.CLAUDE_ROT_EFG_SOCKS_PORT || 1089);
  return await new Promise((resolve) => {
    const s = createConnection({ host, port });
    const t = setTimeout(() => {
      try {
        s.destroy();
      } catch {}
      resolve(false);
    }, 800);
    s.once('connect', () => {
      clearTimeout(t);
      try {
        s.end();
      } catch {}
      resolve(true);
    });
    s.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * Solvers are fallback-only by default (CLAUDE_ROT_CAPTCHA_SOLVER_MODE=fallback).
 * @param {{ attempt?: number, force?: boolean, stalled?: boolean }} [ctx]
 */
export async function captchaSolverAllowed(ctx = {}) {
  const mode = (process.env.CLAUDE_ROT_CAPTCHA_SOLVER_MODE || 'fallback').toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'never') return { allowed: false, reason: 'mode-off' };
  if (mode === 'always' || mode === 'on') return { allowed: true, reason: 'mode-always' };
  if (ctx.force) return { allowed: true, reason: 'force' };
  if (ctx.stalled) return { allowed: true, reason: 'stalled' };
  const healthy = await residentialEgressHealthy();
  if (!healthy) return { allowed: true, reason: 'residential-down' };
  const after = Number(process.env.CLAUDE_ROT_CAPTCHA_SOLVER_AFTER_ATTEMPTS || 1);
  const attempt = Number(ctx.attempt || 0);
  if (attempt >= after) return { allowed: true, reason: `attempt>=${after}` };
  return { allowed: false, reason: 'prefer-residential-browser' };
}

function proxyParams() {
  // + 2026-07-30: solvers are fallback-only. When used, prefer EFG SOCKS
  // so token IP matches residential PAC browser (not third-party US residential).
  const preferEfg =
    process.env.CLAUDE_ROT_CAPTCHA_PREFER_EFG_SOCKS === '1' ||
    process.env.CLAUDE_ROT_OAUTH_EGRESS === 'efg-socks-reauth-only';
  if (preferEfg && process.env.CLAUDE_ROT_CAPTCHA_SKIP_EFG_PROXY !== '1') {
    const host = process.env.CLAUDE_ROT_EFG_SOCKS_HOST || '127.0.0.1';
    const port = process.env.CLAUDE_ROT_EFG_SOCKS_PORT || '1089';
    return {
      proxy: `${host}:${port}`,
      proxytype: 'SOCKS5',
      proxyType: 'socks5',
      proxyAddress: host,
      proxyPort: Number(port) || 1089,
    };
  }
  // Bright Data residential/ISP proxy as next solver IP path (fallback cascade)
  if (
    process.env.CLAUDE_ROT_CAPTCHA_BRIGHT_PROXY === '1' ||
    process.env.CLAUDE_ROT_CAPTCHA_SOLVER_MODE === 'fallback'
  ) {
    try {
      // lazy sync require not available in ESM — use env-built superproxy if zones present
      const customer = process.env.BRIGHT_DATA_CUSTOMER || process.env.BRIGHT_DATA_USERID;
      const zone =
        process.env.BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE ||
        process.env.BRIGHT_DATA_ISP_PROXY_ZONE ||
        process.env.BRIGHT_DATA_ZONE;
      const pass =
        process.env.BRIGHT_DATA_RESIDENTIAL_PROXY_PASSWORD ||
        process.env.BRIGHT_DATA_ISP_PROXY_PASSWORD ||
        process.env.BRIGHT_DATA_TOKEN;
      if (customer && zone && pass && process.env.CLAUDE_ROT_CAPTCHA_USE_PROXY === '1') {
        const host = process.env.BRIGHT_DATA_PROXY_HOST || 'brd.superproxy.io';
        const port = Number(process.env.BRIGHT_DATA_PROXY_PORT || 44445);
        const user = `brd-customer-${customer}-zone-${zone}-country-nl`;
        return {
          proxy: `${user}:${pass}@${host}:${port}`,
          proxytype: 'HTTP',
          proxyType: 'http',
          proxyAddress: host,
          proxyPort: port,
          proxyLogin: user,
          proxyPassword: pass,
        };
      }
    } catch {}
  }
  if (process.env.CLAUDE_ROT_CAPTCHA_FORCE_PROXY !== '1') {
    if (process.env.CLAUDE_ROT_CAPTCHA_USE_PROXY === '1') {
      /* fall through */
    } else {
      return null;
    }
  }
  const url =
    process.env.TWOCAPTCHA_PROXY_HTTP_URL ||
    process.env.TWOCAPTCHA_PROXY_SOCKS5_URL ||
    process.env.TWOCAPTCHA_PROXY_URL;
  if (url) {
    try {
      const u = new URL(url);
      const auth = u.username ? `${u.username}:${decodeURIComponent(u.password)}@` : '';
      return {
        proxy: `${auth}${u.hostname}:${u.port}`,
        proxytype: (u.protocol.replace(':', '') || 'http').toUpperCase(),
        // CapMonster / CapSolver / AntiCaptcha shape
        proxyType: (u.protocol.replace(':', '') || 'http').toLowerCase(),
        proxyAddress: u.hostname,
        proxyPort: Number(u.port) || undefined,
        proxyLogin: u.username || undefined,
        proxyPassword: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      /* fall through */
    }
  }
  const host = process.env.TWOCAPTCHA_PROXY_HOST || process.env.TWOCAPTCHA_PROXY_SOCKS5_HOST;
  const port = process.env.TWOCAPTCHA_PROXY_PORT || process.env.TWOCAPTCHA_PROXY_SOCKS5_PORT;
  const user = process.env.TWOCAPTCHA_PROXY_USERNAME || process.env.TWOCAPTCHA_PROXY_USER_BASE;
  const pass = process.env.TWOCAPTCHA_PROXY_PASSWORD || process.env.TWOCAPTCHA_PROXY_PASS;
  if (host && port) {
    const auth = user ? `${user}:${pass || ''}@` : '';
    const type = (
      process.env.TWOCAPTCHA_PROXY_TYPE ||
      process.env.TWOCAPTCHA_PROXY_SOCKS5_TYPE ||
      'HTTP'
    ).toUpperCase();
    return {
      proxy: `${auth}${host}:${port}`,
      proxytype: type,
      proxyType: type.toLowerCase(),
      proxyAddress: host,
      proxyPort: Number(port) || undefined,
      proxyLogin: user || undefined,
      proxyPassword: pass || undefined,
    };
  }
  return null;
}

/**
 * Inspect the page for a Turnstile / hCaptcha widget.
 * @param {import('playwright').Page} page
 * @returns {Promise<{provider:'turnstile'|'hcaptcha', sitekey:string, pageurl:string, action?:string, data?:string, challengePage?:boolean, invisible?:boolean, userAgent?:string, domain?:string}|null>}
 */
export async function detectCaptcha(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const found = await page.evaluate(() => {
      const pick = (el, attr) => (el ? el.getAttribute(attr) : null);
      const cf = document.querySelector(
        '.cf-turnstile[data-sitekey], [data-sitekey][data-callback], div[data-sitekey]',
      );
      const hc = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-widget-id][data-sitekey]');
      if (cf && (cf.className.includes('cf-turnstile') || document.querySelector('[name="cf-turnstile-response"]'))) {
        const sk = pick(cf, 'data-sitekey');
        if (sk) {
          const result = { provider: 'turnstile', sitekey: sk };
          const action = pick(cf, 'data-action');
          const cdata = pick(cf, 'data-cdata');
          if (action) result.action = action;
          if (cdata) result.data = cdata;
          return result;
        }
      }
      if (hc) {
        const sk = pick(hc, 'data-sitekey');
        if (sk) {
          const result = { provider: 'hcaptcha', sitekey: sk };
          const rq = pick(hc, 'data-rqdata') || pick(hc, 'data-data');
          if (rq) result.data = rq;
          const size = (pick(hc, 'data-size') || '').toLowerCase();
          if (size === 'invisible') result.invisible = true;
          return result;
        }
      }
      const frames = Array.from(document.querySelectorAll('iframe'));
      let invisibleHc = false;
      let hcDomain = null;
      const hostOf = (src) => {
        try {
          return new URL(src, location.href).hostname.toLowerCase();
        } catch {
          return '';
        }
      };
      const isHcHost = (h) => h === 'hcaptcha.com' || h.endsWith('.hcaptcha.com');
      const isCfChallengeHost = (h) => h === 'challenges.cloudflare.com' || h.endsWith('.challenges.cloudflare.com');
      for (const f of frames) {
        const src = f.getAttribute('src') || '';
        const host = hostOf(src);
        if (isCfChallengeHost(host)) {
          const m = src.match(/[?&](?:sitekey|k)=([^&]+)/);
          if (m) return { provider: 'turnstile', sitekey: decodeURIComponent(m[1]), challengePage: true };
          const pathMatch = src.match(/(0x[0-9A-Za-z_-]{20,})/);
          if (pathMatch) return { provider: 'turnstile', sitekey: pathMatch[1], challengePage: true };
        }
        if (isHcHost(host)) {
          hcDomain = host || null;
          if (/frame=checkbox-invisible/i.test(src)) invisibleHc = true;
          const m = src.match(/[?&](?:sitekey|k)=([^&]+)/);
          if (m) {
            return {
              provider: 'hcaptcha',
              sitekey: decodeURIComponent(m[1]),
              invisible: invisibleHc || /frame=checkbox-invisible/i.test(src),
              domain: hcDomain || undefined,
            };
          }
        }
      }
      const html = document.documentElement?.innerHTML || '';
      const skHtml = html.match(/sitekey["'\s:=]+([a-f0-9-]{20,})/i);
      if (skHtml) {
        const hasHcFrame = frames.some((f) => {
          const h = hostOf(f.getAttribute('src') || '');
          return isHcHost(h);
        });
        if (hasHcFrame || /hcaptcha/i.test(html)) {
          const rq = html.match(/rqdata["'\s:=]+([^"'\s&]{16,})/);
          return {
            provider: 'hcaptcha',
            sitekey: skHtml[1],
            invisible: invisibleHc || frames.some((f) => /checkbox-invisible/i.test(f.getAttribute('src') || '')),
            domain: hcDomain || 'newassets.hcaptcha.com',
            data: rq ? rq[1] : undefined,
          };
        }
      }
      const any = document.querySelector('[data-sitekey]');
      if (any) {
        const sk = pick(any, 'data-sitekey');
        if (sk) return { provider: 'turnstile', sitekey: sk };
      }
      return null;
    });
    if (!found) return null;
    const pageurl = page.url();
    let userAgent;
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {}
    return { ...found, pageurl, userAgent: userAgent || undefined };
  } catch {
    return null;
  }
}

// ─── TwoCaptcha / RuCaptcha (legacy in.php / res.php, multi-host) ───────────

async function post2captchaOnHost(host, fields, log) {
  const body = new URLSearchParams({
    ...fields,
    key: process.env.TWOCAPTCHA_API_KEY,
    json: '1',
  });
  const res = await fetchWithTimeout(`https://${host}/in.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    log(`2captcha(${host}) submit HTTP ${res.status}`);
    return null;
  }
  const j = await res.json().catch(() => ({}));
  if (j.status !== 1) {
    log(`2captcha(${host}) submit rejected: ${String(j.request || 'unknown').slice(0, 80)}`);
    return null;
  }
  return j.request;
}

async function poll2captchaOnHost(host, id, log, { timeoutMs = 150_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 12_000));
  while (Date.now() < deadline) {
    const url = `https://${host}/res.php?key=${encodeURIComponent(process.env.TWOCAPTCHA_API_KEY)}&action=get&id=${encodeURIComponent(id)}&json=1`;
    let res;
    try {
      res = await fetchWithTimeout(url, {}, Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())));
    } catch (e) {
      log(`2captcha(${host}) poll request failed: ${String(e.message || e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (!res.ok) {
      log(`2captcha(${host}) poll HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (j.status === 1) return j.request;
    if (j.request && j.request !== 'CAPCHA_NOT_READY') {
      log(`2captcha(${host}) poll error: ${String(j.request).slice(0, 80)}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  log(`2captcha(${host}) poll timed out`);
  return null;
}

function build2captchaFields(challenge) {
  const method = challenge.provider === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
  const fields = { method, sitekey: challenge.sitekey, pageurl: challenge.pageurl };
  if (method === 'turnstile') {
    if (challenge.action) fields.action = challenge.action;
    if (challenge.data) fields.data = challenge.data;
  }
  if (method === 'hcaptcha') {
    if (challenge.invisible || process.env.CLAUDE_ROT_HCAPTCHA_INVISIBLE === '1') {
      fields.invisible = '1';
    }
    if (challenge.enterprise || process.env.CLAUDE_ROT_HCAPTCHA_ENTERPRISE === '1') {
      fields.enterprise = '1';
    }
    if (challenge.data) fields.data = challenge.data;
    if (challenge.domain) fields.domain = challenge.domain;
    if (challenge.userAgent) fields.userAgent = challenge.userAgent;
  }
  const px = proxyParams();
  if (px?.proxy) {
    fields.proxy = px.proxy;
    fields.proxytype = px.proxytype;
  }
  return { method, fields, viaProxy: !!px?.proxy };
}

/**
 * Submit a challenge to 2captcha (with rucaptcha host failover) and return token.
 * @param {{provider:string, sitekey:string, pageurl:string, action?:string, data?:string, invisible?:boolean, userAgent?:string, domain?:string, enterprise?:boolean, challengePage?:boolean}} challenge
 */
export async function solveWith2captcha(challenge, log = () => {}, { timeoutMs = 150_000 } = {}) {
  if (!envFirst(PROVIDER_KEY_ENV.twocaptcha)) {
    log('2captcha: TWOCAPTCHA_API_KEY not set — cannot solve');
    return null;
  }
  const { method, fields, viaProxy } = build2captchaFields(challenge);
  log(
    `2captcha: submitting ${method} sitekey=${maskId(challenge.sitekey)}` +
      `${challenge.challengePage ? ' (challenge-page)' : ''}` +
      `${fields.invisible ? ' invisible' : ''}` +
      `${fields.enterprise ? ' enterprise' : ''}` +
      ` (${viaProxy ? 'via proxy' : 'no proxy / browser-IP match'})` +
      ` hosts=[${TWOCAPTCHA_HOSTS.join(',')}]`,
  );

  for (const host of TWOCAPTCHA_HOSTS) {
    const id = await post2captchaOnHost(host, fields, log).catch((e) => {
      log(`2captcha(${host}) submit failed: ${String(e.message || e).slice(0, 80)}`);
      return null;
    });
    if (!id) continue;
    const token = await poll2captchaOnHost(host, id, log, { timeoutMs }).catch((e) => {
      log(`2captcha(${host}) poll failed: ${String(e.message || e).slice(0, 80)}`);
      return null;
    });
    if (token) {
      log(`2captcha(${host}): solved ${method} (token ${token.length} chars)`);
      return token;
    }
    // On unsolvable / timeout, try next host once (rucaptcha often healthier).
    log(`2captcha: host ${host} failed — trying next host if any`);
  }
  return null;
}

// ─── CapMonster / CapSolver / AntiCaptcha / YesCaptcha (createTask JSON API) ─

const JSON_PROVIDER_ENDPOINTS = {
  capmonster: {
    create: 'https://api.capmonster.cloud/createTask',
    result: 'https://api.capmonster.cloud/getTaskResult',
  },
  capsolver: {
    create: 'https://api.capsolver.com/createTask',
    result: 'https://api.capsolver.com/getTaskResult',
  },
  anticaptcha: {
    create: 'https://api.anti-captcha.com/createTask',
    result: 'https://api.anti-captcha.com/getTaskResult',
  },
  yescaptcha: {
    create: 'https://api.yescaptcha.com/createTask',
    result: 'https://api.yescaptcha.com/getTaskResult',
  },
};

function buildJsonTask(providerName, challenge) {
  const px = proxyParams();
  const isHc = challenge.provider === 'hcaptcha';
  const useProxy = !!px?.proxyAddress;
  let type;
  if (isHc) {
    // CapSolver prefers HCaptchaTaskProxyLess / HCaptchaTurboTask; CapMonster uses HCaptchaTaskProxyless.
    if (providerName === 'capsolver') {
      type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess';
    } else {
      type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
    }
  } else {
    // Turnstile
    if (providerName === 'capsolver') {
      type = useProxy ? 'AntiTurnstileTask' : 'AntiTurnstileTaskProxyLess';
    } else if (providerName === 'capmonster') {
      type = useProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless';
    } else {
      type = useProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless';
    }
  }

  /** @type {Record<string, unknown>} */
  const task = {
    type,
    websiteURL: challenge.pageurl,
    websiteKey: challenge.sitekey,
  };
  if (isHc) {
    if (challenge.invisible || process.env.CLAUDE_ROT_HCAPTCHA_INVISIBLE === '1') {
      task.isInvisible = true;
    }
    if (challenge.enterprise || process.env.CLAUDE_ROT_HCAPTCHA_ENTERPRISE === '1') {
      task.isEnterprise = true;
    }
    if (challenge.data) task.data = challenge.data; // rqdata
    if (challenge.userAgent) task.userAgent = challenge.userAgent;
  } else {
    if (challenge.action) task.action = challenge.action;
    if (challenge.data) task.data = challenge.data;
  }
  if (useProxy && px) {
    task.proxyType = px.proxyType || 'http';
    task.proxyAddress = px.proxyAddress;
    task.proxyPort = px.proxyPort;
    if (px.proxyLogin) task.proxyLogin = px.proxyLogin;
    if (px.proxyPassword) task.proxyPassword = px.proxyPassword;
  }
  return task;
}

async function solveWithJsonProvider(providerName, challenge, log = () => {}, { timeoutMs = 150_000 } = {}) {
  const key = envFirst(PROVIDER_KEY_ENV[providerName] || []);
  if (!key) {
    log(`${providerName}: no API key — skip`);
    return null;
  }
  const endpoints = JSON_PROVIDER_ENDPOINTS[providerName];
  if (!endpoints) {
    log(`${providerName}: unknown provider endpoints`);
    return null;
  }
  const task = buildJsonTask(providerName, challenge);
  log(
    `${providerName}: submitting ${task.type} sitekey=${maskId(challenge.sitekey)}` +
      `${challenge.challengePage ? ' (challenge-page)' : ''}`,
  );

  let createRes;
  try {
    createRes = await fetchWithTimeout(endpoints.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: key, task }),
    });
  } catch (e) {
    log(`${providerName}: createTask failed: ${String(e.message || e).slice(0, 80)}`);
    return null;
  }
  const createBody = await createRes.json().catch(() => ({}));
  // CapSolver: errorId 0 + taskId; CapMonster/AntiCaptcha same; some return status ready immediately.
  if (createBody.errorId && createBody.errorId !== 0) {
    log(
      `${providerName}: createTask error: ${String(createBody.errorCode || createBody.errorDescription || createBody.errorId).slice(0, 100)}`,
    );
    return null;
  }
  // CapSolver may return solution immediately (status ready).
  if (createBody.status === 'ready' && createBody.solution) {
    const tok = createBody.solution.gRecaptchaResponse || createBody.solution.token || createBody.solution.text;
    if (tok) {
      log(`${providerName}: solved immediately (token ${String(tok).length} chars)`);
      return tok;
    }
  }
  const taskId = createBody.taskId;
  if (taskId == null) {
    log(`${providerName}: createTask missing taskId: ${String(createBody.errorDescription || 'unknown').slice(0, 80)}`);
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 8_000));
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetchWithTimeout(
        endpoints.result,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientKey: key, taskId }),
        },
        Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
      );
    } catch (e) {
      log(`${providerName}: getTaskResult failed: ${String(e.message || e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (j.errorId && j.errorId !== 0) {
      log(`${providerName}: result error: ${String(j.errorCode || j.errorDescription || j.errorId).slice(0, 100)}`);
      return null;
    }
    if (j.status === 'ready' && j.solution) {
      const tok = j.solution.gRecaptchaResponse || j.solution.token || j.solution.text;
      if (tok) {
        log(`${providerName}: solved (token ${String(tok).length} chars)`);
        return tok;
      }
      log(`${providerName}: ready but no token field in solution`);
      return null;
    }
    // processing / idle
    await new Promise((r) => setTimeout(r, 5_000));
  }
  log(`${providerName}: poll timed out`);
  return null;
}

/**
 * Bright Data FALLBACK: after token solvers fail, re-submit via 2captcha using
 * each Bright Data proxy tier (residential → ISP → mobile) so the solve IP can
 * align with a Bright Data egress path.
 *
 * Web Unlocker is intentionally NOT used here — it returns page HTML, not a
 * Turnstile/hCaptcha token suitable for injectToken(). See BRIGHT_DATA_CAPTCHA_ROLE.
 *
 * @returns {Promise<string|null>}
 */
export async function solveWithBrightDataCascade(challenge, log = () => {}, opts = {}) {
  const tiers = listProxyTiers();
  if (tiers.length === 0) {
    if (webUnlockerConfigured()) {
      log(
        `brightdata: Web Unlocker configured (${BRIGHT_DATA_CAPTCHA_ROLE.webUnlocker}) — ` +
          'not usable for token inject; need proxy tiers + TWOCAPTCHA_API_KEY',
      );
    } else {
      log('brightdata: no proxy tiers configured — skip');
    }
    return null;
  }
  if (!envFirst(PROVIDER_KEY_ENV.twocaptcha)) {
    log(
      'brightdata: proxy tiers present but TWOCAPTCHA_API_KEY missing — ' +
        'cannot proxy-align a token solve (Web Unlocker is page-fetch only)',
    );
    return null;
  }

  log(
    `brightdata: proxy-aligned solve tiers=[${tiers.map((t) => t.tier).join(' → ')}] ` +
      `(role=${BRIGHT_DATA_CAPTCHA_ROLE.proxyTiers})`,
  );

  // Temporarily force Bright Data proxy into proxyParams() via env override.
  // Save/restore so we do not leak tier proxy into later non-BD attempts.
  const saved = {
    FORCE: process.env.CLAUDE_ROT_CAPTCHA_FORCE_PROXY,
    USE: process.env.CLAUDE_ROT_CAPTCHA_USE_PROXY,
    PREFER_EFG: process.env.CLAUDE_ROT_CAPTCHA_PREFER_EFG_SOCKS,
    HTTP_URL: process.env.TWOCAPTCHA_PROXY_HTTP_URL,
    SOCKS_URL: process.env.TWOCAPTCHA_PROXY_SOCKS5_URL,
    PROXY_URL: process.env.TWOCAPTCHA_PROXY_URL,
    OAUTH_EGRESS: process.env.CLAUDE_ROT_OAUTH_EGRESS,
  };

  try {
    // Prefer Bright Data HTTP proxy over EFG for this cascade only.
    process.env.CLAUDE_ROT_CAPTCHA_PREFER_EFG_SOCKS = '0';
    if (process.env.CLAUDE_ROT_OAUTH_EGRESS === 'efg-socks-reauth-only') {
      // proxyParams() treats this as prefer-EFG; clear for BD tier pass only.
      delete process.env.CLAUDE_ROT_OAUTH_EGRESS;
    }
    process.env.CLAUDE_ROT_CAPTCHA_FORCE_PROXY = '1';
    process.env.CLAUDE_ROT_CAPTCHA_USE_PROXY = '1';

    for (const { tier, zone } of tiers) {
      const px = getSolverProxyParamsForTier(tier);
      if (!px?.proxy) {
        log(`brightdata: tier=${tier} zone=${zone} — no proxy URL, skip`);
        continue;
      }
      // proxyParams() reads TWOCAPTCHA_PROXY_HTTP_URL first when FORCE_PROXY=1.
      const url = `http://${px.proxyLogin ? `${encodeURIComponent(px.proxyLogin)}:${encodeURIComponent(px.proxyPassword || '')}@` : ''}${px.proxyAddress}:${px.proxyPort}`;
      process.env.TWOCAPTCHA_PROXY_HTTP_URL = url;
      delete process.env.TWOCAPTCHA_PROXY_SOCKS5_URL;
      delete process.env.TWOCAPTCHA_PROXY_URL;
      log(`brightdata: trying tier=${tier} zone=${zone} via 2captcha+proxy`);
      const token = await solveWith2captcha(challenge, log, opts);
      if (token) {
        log(`brightdata: solved via tier=${tier}`);
        return token;
      }
      log(`brightdata: tier=${tier} failed — next tier if any`);
    }
  } finally {
    const restore = (k, v) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('CLAUDE_ROT_CAPTCHA_FORCE_PROXY', saved.FORCE);
    restore('CLAUDE_ROT_CAPTCHA_USE_PROXY', saved.USE);
    restore('CLAUDE_ROT_CAPTCHA_PREFER_EFG_SOCKS', saved.PREFER_EFG);
    restore('TWOCAPTCHA_PROXY_HTTP_URL', saved.HTTP_URL);
    restore('TWOCAPTCHA_PROXY_SOCKS5_URL', saved.SOCKS_URL);
    restore('TWOCAPTCHA_PROXY_URL', saved.PROXY_URL);
    restore('CLAUDE_ROT_OAUTH_EGRESS', saved.OAUTH_EGRESS);
  }
  return null;
}

/**
 * Try every configured provider in order until one returns a token.
 * @returns {Promise<{token:string|null, provider:string|null, tried:string[]}>}
 */
export async function solveWithAnyProvider(challenge, log = () => {}, opts = {}) {
  const order = providerOrder();
  if (order.length === 0) {
    log('captcha: no solver providers configured');
    return { token: null, provider: null, tried: [] };
  }
  log(`captcha: provider chain [${order.join(' → ')}]`);
  const tried = [];
  for (const name of order) {
    tried.push(name);
    let token = null;
    if (name === 'twocaptcha') {
      token = await solveWith2captcha(challenge, log, opts);
    } else if (name === 'brightdata') {
      token = await solveWithBrightDataCascade(challenge, log, opts);
    } else {
      token = await solveWithJsonProvider(name, challenge, log, opts);
    }
    if (token) return { token, provider: name, tried };
    log(`captcha: provider ${name} failed — falling through`);
  }
  return { token: null, provider: null, tried };
}

/**
 * Inject a solved token into the page's hidden response field(s) and fire any
 * widget callback so the form treats the challenge as passed.
 */
export async function injectToken(page, provider, token, log = () => {}) {
  if (!page || !token) return false;
  try {
    const ok = await page.evaluate(
      ({ provider, token }) => {
        const names =
          provider === 'hcaptcha'
            ? ['h-captcha-response', 'g-recaptcha-response']
            : ['cf-turnstile-response', 'g-recaptcha-response'];
        let set = false;
        for (const name of names) {
          const els = Array.from(document.querySelectorAll(`[name="${name}"]`));
          if (els.length === 0) {
            const el = document.createElement('textarea');
            el.name = name;
            el.style.display = 'none';
            (document.querySelector('form') || document.body).appendChild(el);
            els.push(el);
          }
          for (const el of els) {
            el.value = token;
            el.innerHTML = token;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            set = true;
          }
        }
        try {
          for (const widget of document.querySelectorAll('[data-callback], .h-captcha, .g-recaptcha, [data-sitekey]')) {
            const cbName = widget.getAttribute('data-callback');
            if (cbName && typeof window[cbName] === 'function') {
              try {
                window[cbName](token);
              } catch {}
            }
          }
        } catch {}
        try {
          if (provider === 'hcaptcha' && window.hcaptcha) {
            const api = window.hcaptcha;
            if (typeof api.setResponse === 'function') {
              try {
                api.setResponse(token);
              } catch {}
            }
            const clients = api._c || api.clients || api._clients;
            if (clients && typeof clients === 'object') {
              for (const id of Object.keys(clients)) {
                try {
                  const client = clients[id];
                  if (client && typeof client.callback === 'function') client.callback(token);
                  if (client?.config && typeof client.config.callback === 'function') {
                    client.config.callback(token);
                  }
                  if (client) {
                    try {
                      client.response = token;
                    } catch {}
                    try {
                      if (client.config) client.config.response = token;
                    } catch {}
                  }
                } catch {}
              }
            }
            try {
              if (typeof api.close === 'function') api.close();
            } catch {}
          }
        } catch {}
        try {
          for (const f of document.querySelectorAll('iframe')) {
            const src = f.getAttribute('src') || '';
            if (!/hcaptcha|turnstile|cloudflare/i.test(src)) continue;
            try {
              f.contentWindow?.postMessage(
                JSON.stringify({
                  source: 'hcaptcha',
                  label: 'challenge-closed',
                  contents: { event: 'challenge-passed', response: token },
                }),
                '*',
              );
            } catch {}
            try {
              f.contentWindow?.postMessage({ event: 'challenge-passed', response: token }, '*');
            } catch {}
          }
        } catch {}
        try {
          for (const button of document.querySelectorAll('button')) {
            const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
            if (/authorize|allow|approve|verify/i.test(text)) {
              button.disabled = false;
              button.removeAttribute('disabled');
              button.removeAttribute('aria-disabled');
            }
          }
        } catch {}
        return set;
      },
      { provider, token },
    );
    if (ok) log(`captcha: token injected (${provider})`);
    return ok;
  } catch (e) {
    log(`captcha: token injection failed: ${String(e.message || e).slice(0, 80)}`);
    return false;
  }
}

/**
 * Full flow: detect → solve (provider chain) → inject.
 * Returns { solved, provider, present, injected?, solver? }.
 * Never throws.
 * @param {import('playwright').Page} page
 * @param {(m:string)=>void} [log]
 * @param {{ timeoutMs?: number, enterpriseRetry?: boolean }} [opts]
 */
export async function solveCaptchaOnPage(page, log = () => {}, opts = {}) {
  const challenge = await detectCaptcha(page);
  if (!challenge) return { solved: false, provider: null, present: false };
  log(`captcha: detected ${challenge.provider} on ${String(challenge.pageurl || '').slice(0, 60)}`);

  // Fast path for headed reauth: skip paid token solvers and let
  // rotate.mjs runAutonomousCaptchaCascade (visual → desktop-act → vnc).
  if (process.env.CLAUDE_ROT_SKIP_TOKEN_SOLVERS === '1') {
    log('captcha: token solvers skipped (CLAUDE_ROT_SKIP_TOKEN_SOLVERS=1) — visual/desktop-act cascade owns this wall');
    return { solved: false, provider: challenge.provider, present: true, skipped: true, reason: 'skip-token-solvers' };
  }

  // Residential-first: wait for browser path before paying for solvers.
  // After wait, if captcha still present → treat as stalled residual (solver allowed).
  let residualAfterWait = false;
  const waitMs = Number(opts.browserWaitMs ?? process.env.CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS ?? 0);
  if (waitMs > 0 && !opts.skipBrowserWait) {
    log(`captcha: residential-first wait ${waitMs}ms before solver fallback`);
    await new Promise((r) => setTimeout(r, waitMs));
    const still = await detectCaptcha(page);
    if (!still) {
      log('captcha: cleared during residential wait — solver not used');
      return { solved: true, provider: challenge.provider, present: true, solver: null, residential: true };
    }
    residualAfterWait = true;
    log('captcha: still present after residential wait — enabling solver fallback');
  }

  const gate = await captchaSolverAllowed({
    attempt:
      opts.attempt ?? (residualAfterWait ? Number(process.env.CLAUDE_ROT_CAPTCHA_SOLVER_AFTER_ATTEMPTS || 1) : 0),
    force: opts.forceSolver || residualAfterWait,
    stalled: opts.stalled || residualAfterWait,
  });
  if (!gate.allowed) {
    log(`captcha: solver skipped (${gate.reason}) — residential browser path preferred`);
    return { solved: false, provider: challenge.provider, present: true, skipped: true, reason: gate.reason };
  }
  log(`captcha: solver fallback allowed (${gate.reason})`);

  if (!captchaSolverAvailable()) {
    log(
      'captcha: no solver keys — set TWOCAPTCHA_API_KEY and/or CAPSOLVER_API_KEY / CAPMONSTER_API_KEY / ANTICAPTCHA_API_KEY / YESCAPTCHA_CLIENT_KEY',
    );
    return { solved: false, provider: challenge.provider, present: true };
  }
  if (challenge.provider === 'hcaptcha') {
    // do NOT force invisible=true for every hCaptcha. Anthropic's
    // post-verify pick/drag wall is a large interactive challenge; submitting
    // it as invisible yields a token that injects but never clears the wall.
    // Default invisible only when detectCaptcha saw checkbox-invisible / size=invisible
    // and no large on-screen challenge frame is present.
    let largeInteractive = false;
    try {
      largeInteractive = await page.evaluate(() => {
        const frames = Array.from(document.querySelectorAll('iframe'));
        for (const f of frames) {
          const src = f.getAttribute('src') || '';
          let host = '';
          try {
            host = new URL(src, location.href).hostname.toLowerCase();
          } catch {
            continue;
          }
          const isHc = host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com');
          if (!isHc || !/(?:^|[?&#])frame=challenge(?:&|#|$)/i.test(src)) continue;
          const r = f.getBoundingClientRect();
          const style = window.getComputedStyle(f);
          const visible =
            r.width >= 200 &&
            r.height >= 200 &&
            r.bottom > 0 &&
            r.right > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || '1') > 0.1;
          if (visible) return true;
        }
        return false;
      });
    } catch {
      largeInteractive = false;
    }
    if (largeInteractive || process.env.CLAUDE_ROT_HCAPTCHA_FORCE_VISIBLE === '1') {
      challenge.invisible = false;
      // Anthropic interactive path is enterprise-shaped more often than not.
      if (challenge.enterprise == null) challenge.enterprise = true;
      log('captcha: large interactive hCaptcha detected — solving as visible/enterprise (not invisible)');
    } else if (challenge.invisible == null) {
      // Preserve detectCaptcha's invisible flag when set; otherwise leave unset
      // so 2captcha gets a normal (visible) hcaptcha task.
      challenge.invisible = false;
    }
    if (!challenge.domain) challenge.domain = 'newassets.hcaptcha.com';
  }

  let { token, provider: solver, tried } = await solveWithAnyProvider(challenge, log, opts);

  // One enterprise retry when first attempt fails (common Anthropic path).
  if (!token && challenge.provider === 'hcaptcha' && opts.enterpriseRetry !== false) {
    log('captcha: retrying hcaptcha with enterprise=1 across provider chain');
    const retry = await solveWithAnyProvider({ ...challenge, enterprise: true }, log, opts);
    token = retry.token;
    solver = retry.provider;
    tried = [...(tried || []), ...(retry.tried || []).map((t) => `${t}:enterprise`)];
  }

  if (!token) {
    return {
      solved: false,
      provider: challenge.provider,
      present: true,
      tried: tried || [],
    };
  }
  const injected = await injectToken(page, challenge.provider, token, log);
  return {
    solved: injected,
    provider: challenge.provider,
    present: true,
    injected,
    solver: solver || null,
    tried: tried || [],
  };
}
