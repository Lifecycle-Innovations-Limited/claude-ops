// captcha-helper.mjs
// Detects a Cloudflare Turnstile / hCaptcha challenge on a Playwright page and
// solves it via the 2captcha HTTP API, then injects the returned token so the
// login/OAuth flow can proceed headlessly.
//
// Requires TWOCAPTCHA_API_KEY in env (hydrated by secrets-bootstrap.mjs from
// Doppler claude-ops/prd). Optional TWOCAPTCHA_PROXY_* makes 2captcha solve
// from a fixed IP range (useful when the token is IP-bound).
//
// Never throws. Never prints the API key or token. Returns structured results.

const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function captchaSolverAvailable() {
  return !!process.env.TWOCAPTCHA_API_KEY;
}

function proxyParams() {
  // 2captcha wants proxy=login:pass@host:port and proxytype=HTTP.
  const url = process.env.TWOCAPTCHA_PROXY_URL;
  if (url) {
    try {
      const u = new URL(url);
      const auth = u.username ? `${u.username}:${decodeURIComponent(u.password)}@` : '';
      return {
        proxy: `${auth}${u.hostname}:${u.port}`,
        proxytype: (u.protocol.replace(':', '') || 'http').toUpperCase(),
      };
    } catch {
      /* fall through */
    }
  }
  const host = process.env.TWOCAPTCHA_PROXY_HOST;
  const port = process.env.TWOCAPTCHA_PROXY_PORT;
  const user = process.env.TWOCAPTCHA_PROXY_USER_BASE;
  const pass = process.env.TWOCAPTCHA_PROXY_PASS;
  if (host && port) {
    const auth = user ? `${user}:${pass || ''}@` : '';
    return { proxy: `${auth}${host}:${port}`, proxytype: 'HTTP' };
  }
  return null;
}

/**
 * Inspect the page for a Turnstile / hCaptcha widget.
 * @param {import('playwright').Page} page
 * @returns {Promise<{provider:'turnstile'|'hcaptcha', sitekey:string, pageurl:string}|null>}
 */
export async function detectCaptcha(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const found = await page.evaluate(() => {
      const pick = (el, attr) => (el ? el.getAttribute(attr) : null);
      // Explicit widgets carry data-sitekey.
      const cf = document.querySelector(
        '.cf-turnstile[data-sitekey], [data-sitekey][data-callback], div[data-sitekey]',
      );
      const hc = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-widget-id][data-sitekey]');
      if (cf && (cf.className.includes('cf-turnstile') || document.querySelector('[name="cf-turnstile-response"]'))) {
        const sk = pick(cf, 'data-sitekey');
        if (sk) return { provider: 'turnstile', sitekey: sk };
      }
      if (hc) {
        const sk = pick(hc, 'data-sitekey');
        if (sk) return { provider: 'hcaptcha', sitekey: sk };
      }
      // Proper hostname check, not a substring match — `src.includes('hcaptcha.com')`
      // would also match e.g. `https://hcaptcha.com.evil.example/`.
      const hostOf = (u) => {
        try {
          return new URL(u, document.baseURI).hostname;
        } catch {
          return '';
        }
      };
      // Fallback: parse sitekey from a challenge iframe src.
      const frames = Array.from(document.querySelectorAll('iframe'));
      for (const f of frames) {
        const src = f.getAttribute('src') || '';
        const host = hostOf(src);
        if (host === 'challenges.cloudflare.com') {
          const m = src.match(/[?&](?:sitekey|k)=([^&]+)/);
          if (m) return { provider: 'turnstile', sitekey: decodeURIComponent(m[1]) };
        }
        if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) {
          const m = src.match(/[?&](?:sitekey|k)=([^&]+)/);
          if (m) return { provider: 'hcaptcha', sitekey: decodeURIComponent(m[1]) };
        }
      }
      // Generic sitekey attr anywhere (last resort → treat as turnstile).
      const any = document.querySelector('[data-sitekey]');
      if (any) {
        const sk = pick(any, 'data-sitekey');
        if (sk) return { provider: 'turnstile', sitekey: sk };
      }
      return null;
    });
    if (!found) return null;
    const pageurl = page.url();
    return { ...found, pageurl };
  } catch {
    return null;
  }
}

async function post2captcha(fields, log) {
  const body = new URLSearchParams({ ...fields, key: process.env.TWOCAPTCHA_API_KEY, json: '1' });
  const res = await fetchWithTimeout(IN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (j.status !== 1) {
    log(`2captcha submit rejected: ${String(j.request || 'unknown').slice(0, 80)}`);
    return null;
  }
  return j.request; // captcha id
}

async function poll2captcha(id, log, { timeoutMs = 150_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 12_000));
  while (Date.now() < deadline) {
    const url = `${RES_URL}?key=${encodeURIComponent(process.env.TWOCAPTCHA_API_KEY)}&action=get&id=${encodeURIComponent(id)}&json=1`;
    let res;
    try {
      res = await fetchWithTimeout(url, {}, Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())));
    } catch (e) {
      log(`2captcha poll request failed: ${String(e.message || e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (j.status === 1) return j.request; // token
    if (j.request && j.request !== 'CAPCHA_NOT_READY') {
      log(`2captcha poll error: ${String(j.request).slice(0, 80)}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  log('2captcha poll timed out');
  return null;
}

/**
 * Submit a challenge to 2captcha and return the solved token, or null.
 * @param {{provider:string, sitekey:string, pageurl:string}} challenge
 */
export async function solveWith2captcha(challenge, log = () => {}, { timeoutMs = 150_000 } = {}) {
  if (!captchaSolverAvailable()) {
    log('2captcha: TWOCAPTCHA_API_KEY not set — cannot solve');
    return null;
  }
  const method = challenge.provider === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
  const fields = { method, sitekey: challenge.sitekey, pageurl: challenge.pageurl };
  const px = proxyParams();
  if (px) Object.assign(fields, px);
  log(
    `2captcha: submitting ${method} sitekey=${String(challenge.sitekey).slice(0, 12)}… (${px ? 'via proxy' : 'no proxy'})`,
  );
  const id = await post2captcha(fields, log).catch((e) => {
    log(`2captcha submit failed: ${String(e.message || e).slice(0, 80)}`);
    return null;
  });
  if (!id) return null;
  const token = await poll2captcha(id, log, { timeoutMs }).catch((e) => {
    log(`2captcha poll failed: ${String(e.message || e).slice(0, 80)}`);
    return null;
  });
  if (token) log(`2captcha: solved ${method} (token ${token.length} chars)`);
  return token;
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
          let el = document.querySelector(`[name="${name}"]`);
          if (!el) {
            el = document.createElement('textarea');
            el.name = name;
            el.style.display = 'none';
            (document.querySelector('form') || document.body).appendChild(el);
          }
          el.value = token;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          set = true;
        }
        // Invoke any registered widget callback.
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
                } catch {}
              }
            }
          }
        } catch {}
        try {
          for (const button of document.querySelectorAll('button')) {
            const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
            if (/authorize|allow|approve/i.test(text)) {
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
 * Full flow: detect → solve → inject. Returns { solved, provider } (solved=false
 * when no captcha present OR unsolvable). Never throws.
 * @param {import('playwright').Page} page
 * @param {(m:string)=>void} [log]
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function solveCaptchaOnPage(page, log = () => {}, opts = {}) {
  const challenge = await detectCaptcha(page);
  if (!challenge) return { solved: false, provider: null, present: false };
  log(`captcha: detected ${challenge.provider} on ${challenge.pageurl.slice(0, 60)}`);
  if (!captchaSolverAvailable()) {
    log('captcha: no TWOCAPTCHA_API_KEY — leaving challenge for manual/AI handling');
    return { solved: false, provider: challenge.provider, present: true };
  }
  const token = await solveWith2captcha(challenge, log, opts);
  if (!token) return { solved: false, provider: challenge.provider, present: true };
  const injected = await injectToken(page, challenge.provider, token, log);
  return { solved: injected, provider: challenge.provider, present: true };
}
