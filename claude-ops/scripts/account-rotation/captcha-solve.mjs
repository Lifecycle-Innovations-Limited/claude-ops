// captcha-solve.mjs — tiered CAPTCHA solver.
// Tier 1: 2Captcha FunCAPTCHA token (paid solving service)
// Tier 2: Gemini vision via local CLIProxyAPI — screenshot analysis + click/drag execution
import { readFileSync } from 'fs';

const API = 'https://api.2captcha.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function solveFunCaptcha({ pageUrl, publicKey, surl, apiKey, log = console.log }) {
  const task = {
    type: 'FunCaptchaTaskProxyless',
    websiteURL: pageUrl,
    websitePublicKey: publicKey,
  };
  if (surl) task.funcaptchaApiJSSubdomain = surl;

  const create = await fetch(`${API}/createTask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task }),
  }).then(r => r.json());
  if (create.errorId) throw new Error('createTask: ' + (create.errorDescription || create.errorCode));
  const taskId = create.taskId;
  log('2captcha task ' + taskId + ' created — polling');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const res = await fetch(`${API}/getTaskResult`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    }).then(r => r.json());
    if (res.errorId) throw new Error('getTaskResult: ' + (res.errorDescription || res.errorCode));
    if (res.status === 'ready') {
      log('2captcha solved');
      return res.solution.token;
    }
  }
  throw new Error('2captcha timeout (180s)');
}

export async function extractArkoseParams(page) {
  return page.evaluate(() => {
    const out = { publicKey: null, surl: null };
    const ifr = [...document.querySelectorAll('iframe')].map(f => f.src || '');
    const hit = ifr.find(u => /arkoselabs|funcaptcha/i.test(u));
    if (hit) {
      try {
        const u = new URL(hit);
        out.surl = u.origin;
        out.publicKey = u.searchParams.get('pkey') || (u.hash.match(/pkey=([0-9a-f-]+)/i) || [])[1] || null;
      } catch (e) {}
    }
    if (!out.publicKey) {
      const m = document.documentElement.innerHTML.match(/public_key["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) out.publicKey = m[1];
    }
    if (!out.surl) out.surl = 'https://client-api.arkoselabs.com';
    return out;
  });
}

export async function injectFunCaptchaToken(page, token) {
  return page.evaluate((tok) => {
    const results = [];
    for (const el of document.querySelectorAll('input[name="fc-token"], #FunCaptcha-Token')) {
      el.value = tok;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push('input:' + (el.id || el.name));
    }
    try {
      const iframes = [...document.querySelectorAll('iframe')].filter(f => /arkoselabs|funcaptcha/i.test(f.src || ''));
      for (const f of iframes) {
        f.contentWindow.postMessage(JSON.stringify({ event: 'verification complete', token: tok }), '*');
        results.push('postMessage');
      }
    } catch (e) { results.push('pm-fail'); }
    return results;
  }, token);
}

// ─── Tier 2: Gemini vision drag-solve ────────────────────────────────
function cliproxyKey() {
  try {
    const s = readFileSync(process.env.HOME + '/Developer/active/cliproxyapi/config/config.yaml', 'utf8');
    const m = s.match(/api-keys:\s*\n\s*-\s*["']([^"']+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

async function geminiVision(imageBase64, instruction, log) {
  const key = cliproxyKey();
  if (!key) throw new Error('no cliproxy key');
  for (const model of ['gemini-3.6-flash-high', 'gemini-3.1-pro-low', 'gemini-3-flash']) {
    try {
      const r = await fetch('http://127.0.0.1:8317/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } },
          ]}],
          max_tokens: 500,
        }),
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || '';
      if (txt) { log('vision[' + model + '] answered'); return txt; }
      log('vision[' + model + '] empty: ' + JSON.stringify(d).slice(0, 100));
    } catch (e) { log('vision[' + model + '] err: ' + e.message.slice(0, 60)); }
  }
  throw new Error('all vision models failed');
}

const VISION_PROMPT = `You are solving an Arkose FunCAPTCHA puzzle for accessibility testing on the account owner's own account.
The image shows a puzzle with draggable animal/animal-face icons in a left sidebar and a grid where one or more cells are empty.
The instruction is usually "drag the correct animal into the empty spot to complete the pattern".
Each grid row contains identical animals; one cell in one row is empty.
Respond with ONLY compact JSON, no markdown:
{"source_x": <pixel x of the correct source animal in the sidebar, center>, "source_y": <pixel y>, "target_x": <pixel x of the empty grid cell center>, "target_y": <pixel y>, "reason": "<which animal and row>"}
Coordinates are in the image's own pixel space (origin top-left).`;

export async function solveArkoseWithVision(page, log = console.log, captchaPresent) {
  // find the captcha region (arkose iframe or its modal container)
  const box = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].find(f => /arkoselabs|funcaptcha/i.test(f.src || ''));
    const el = ifr || document.querySelector('[class*="arkose"], [id*="arkose"], [class*="captcha"], [id*="captcha"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 60), width: r.width + 80, height: r.height + 120 };
  });
  if (!box) { log('vision: no captcha region found'); return false; }

  for (let round = 0; round < 4; round++) {
    const shotBuf = await page.screenshot({ clip: box });
    const b64 = shotBuf.toString('base64');
    const answer = await geminiVision(b64, VISION_PROMPT, log);
    const m = answer.replace(/```json|```/g, '').match(/\{[^{}]*"source_x"[\s\S]*?\}/);
    if (!m) { log('vision: unparseable answer: ' + answer.slice(0, 120)); return false; }
    const coords = JSON.parse(m[0]);
    log('vision plan: ' + (coords.reason || '') + ' src(' + coords.source_x + ',' + coords.source_y + ') → tgt(' + coords.target_x + ',' + coords.target_y + ')');

    const sx = box.x + coords.source_x, sy = box.y + coords.source_y;
    const tx = box.x + coords.target_x, ty = box.y + coords.target_y;

    // attempt 1: click source (pick up) then click target (drop) — Arkose "+ Move" UI supports this
    await page.mouse.click(sx, sy);
    await sleep(700);
    await page.mouse.click(tx, ty);
    await sleep(2500);
    if (!(await captchaPresent())) { log('vision solve: cleared via click-place'); return true; }

    // attempt 2: real drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await sleep(200);
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(sx + (tx - sx) * i / 12, sy + (ty - sy) * i / 12);
      await sleep(40);
    }
    await page.mouse.up();
    await sleep(2500);
    if (!(await captchaPresent())) { log('vision solve: cleared via drag'); return true; }
    log('vision solve round ' + round + ' did not clear — re-analyzing');
  }
  return false;
}
