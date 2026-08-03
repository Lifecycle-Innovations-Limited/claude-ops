// claude-reauth2.mjs — reauth one Claude account into CLIProxyAPI using:
//   playwright (bundled chromium) + existing Google session profile for in-browser Gmail magic-link reading.
// Usage: node claude-reauth2.mjs <claudeEmail> <oauthAuthorizeUrl>
// Env:   GOOGLE_LOGIN_PROFILE (default /tmp/google-login-profile-GMAIL_PASS)
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const [claudeEmail, authUrl] = process.argv.slice(2);
if (!claudeEmail || !authUrl) { console.error('usage: node claude-reauth2.mjs <claudeEmail> <oauthAuthorizeUrl>'); process.exit(2); }
const PROFILE = process.env.GOOGLE_LOGIN_PROFILE || '/tmp/google-login-profile-GMAIL_PASS';

function readKeyFromDotenv(name) {
  try {
    const s = readFileSync(process.env.HOME + '/.env', 'utf8');
    const m = s.match(new RegExp('^' + name + '="?([^"\\n]+)"?', 'm'));
    return m ? m[1] : null;
  } catch (e) { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const shot = (p, n) => p.screenshot({ path: `/tmp/reauth2-${n}.png` }).catch(() => {});

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, args: ['--window-position=100,100', '--window-size=1200,950', '--disable-blink-features=AutomationControlled'], viewport: null,
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const page = ctx.pages()[0] || await ctx.newPage();
const sentAt = Date.now();

// ── 1. claude.ai login → send magic link ─────────────────────────────
await page.goto('https://claude.ai/login', { timeout: 45000, waitUntil: 'domcontentloaded' });
await sleep(4000);
// If already logged in as someone, log out first
if (!page.url().includes('/login')) {
  log('existing session at ' + page.url().slice(0, 60) + ' — logging out');
  await page.goto('https://claude.ai/logout', { timeout: 30000 }).catch(() => {});
  await sleep(3000);
  await page.goto('https://claude.ai/login', { timeout: 45000, waitUntil: 'domcontentloaded' });
  await sleep(4000);
}
const emailInput = await page.$('input[type="email"]');
if (!emailInput) { log('FAIL: no email input on login page'); await shot(page, 'noemail'); process.exit(1); }
await emailInput.fill(claudeEmail);
await page.keyboard.press('Enter');
log('magic link requested for ' + claudeEmail);
await sleep(5000);
await shot(page, 'sent');

// ── 2. Gmail tab → extract newest magic link ─────────────────────────
const gmail = await ctx.newPage();
await gmail.goto('https://mail.google.com/mail/u/0/#search/from%3Amail.anthropic.com+subject%3A%22secure+link%22', { timeout: 60000, waitUntil: 'domcontentloaded' });
await sleep(8000);
let magicLink = null;
for (let attempt = 0; attempt < 20 && !magicLink; attempt++) {
  if (attempt > 0) { await gmail.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(7000); }
  // open the top message row
  const rows = await gmail.$$('tr.zA');
  if (!rows.length) { log('gmail: no rows yet (' + attempt + ')'); continue; }
  await rows[0].click().catch(() => {});
  await sleep(4000);
  // extract magic-link href from rendered message
  magicLink = await gmail.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="claude.ai/magic-link"], a[href*="claude.com/magic-link"]')];
    if (links.length) return links[0].href;
    // fallback: any href containing magic-link token
    const any = [...document.querySelectorAll('a')].find(a => /magic-link/i.test(a.href || ''));
    return any ? any.href : null;
  });
  if (magicLink) {
    // sanity: message must be fresh (< 10 min)
    const timeAttr = await gmail.evaluate(() => {
      const spans = [...document.querySelectorAll('span.g3')];
      return spans.length ? spans[spans.length - 1].getAttribute('title') : null;
    });
    log('gmail: found magic link (msg time: ' + (timeAttr || '?') + ')');
    if (timeAttr) {
      const msgTime = new Date(timeAttr).getTime();
      if (msgTime < sentAt - 60000) { log('stale message — waiting for fresh one'); magicLink = null; }
    }
  }
}
if (!magicLink) { log('FAIL: no magic link found'); await shot(gmail, 'gmail'); process.exit(1); }
log('magic link acquired');

// ── 3. open magic link → Claude session (may hit Arkose CAPTCHA — pause for human) ──
await page.goto(magicLink, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(e => log('magic nav: ' + e.message.slice(0, 60)));
await sleep(8000);

// CAPTCHA interlock: if Arkose/FunCAPTCHA present, notify user and wait for it to clear
async function captchaPresent() {
  return page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].some(f => /arkoselabs|funcaptcha|captcha/i.test(f.src || ''));
    const txt = document.body ? /Drag the correct|complete the pattern|verify you are human/i.test(document.body.innerText) : false;
    return ifr || txt;
  }).catch(() => false);
}
if (await captchaPresent()) {
  // 1. try 2Captcha automated solve first
  const apiKey = process.env.TWOCAPTCHA_API_KEY || readKeyFromDotenv('TWOCAPTCHA_API_KEY');
  let solved = false;
  if (apiKey) {
    try {
      const { solveFunCaptcha, extractArkoseParams, injectFunCaptchaToken } = await import('./captcha-solve.mjs');
      const params = await extractArkoseParams(page);
      log('arkose params: pkey=' + (params.publicKey || '?') + ' surl=' + params.surl);
      if (params.publicKey) {
        const token = await solveFunCaptcha({
          pageUrl: 'https://claude.ai/', publicKey: params.publicKey, surl: params.surl, apiKey, log,
        });
        const injected = await injectFunCaptchaToken(page, token);
        log('token injected via: ' + injected.join(','));
        await sleep(6000);
        solved = !(await captchaPresent());
        log(solved ? 'CAPTCHA cleared automatically' : 'token injected but captcha still present');
      }
    } catch (e) { log('2captcha failed: ' + e.message.slice(0, 120)); }
  }
  // 1b. vision tier (Gemini via CLIProxyAPI)
  if (!solved && await captchaPresent()) {
    try {
      const { solveArkoseWithVision } = await import('./captcha-solve.mjs');
      solved = await solveArkoseWithVision(page, log, captchaPresent);
      log(solved ? 'CAPTCHA cleared by vision solver' : 'vision solver did not clear');
    } catch (e) { log('vision solver failed: ' + e.message.slice(0, 120)); }
  }
  // 2. human fallback
  if (!solved && await captchaPresent()) {
    log('CAPTCHA still present — waiting for human solve (' + claudeEmail + ')');
    try {
      const { execSync } = await import('child_process');
      execSync(`osascript -e 'display notification "Solve the Claude CAPTCHA in the automation browser for ${claudeEmail}" with title "Claude reauth — action needed" sound name "Glass"'`);
      execSync(`say "Claude reauth needs you to solve a captcha"`);
    } catch (e) {}
    const deadline = Date.now() + 8 * 60 * 1000;
    while (await captchaPresent()) {
      if (Date.now() > deadline) { log('FAIL: captcha not solved in 8 min'); process.exit(1); }
      await sleep(3000);
    }
    log('captcha cleared by human — continuing');
  }
  await sleep(4000);
}
await shot(page, 'after-magic');
log('post-magic url: ' + page.url().slice(0, 80));

// ── 4. OAuth authorize → callback into CLIProxyAPI ───────────────────
await page.goto(authUrl, { timeout: 45000, waitUntil: 'domcontentloaded' });
await sleep(5000);
await shot(page, 'oauth');
// click authorize/allow if a button is shown
for (const sel of ['button:has-text("Authorize")', 'button:has-text("Allow")', 'button:has-text("Continue")', 'button[type="submit"]']) {
  const b = await page.$(sel);
  if (b && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); log('clicked ' + sel); break; }
}
await sleep(8000);
// account selector page (claude.ai/login?selectAccount=true) — pick our account
if (page.url().includes('selectAccount')) {
  log('account selector — clicking ' + claudeEmail);
  await page.evaluate((em) => {
    const els = [...document.querySelectorAll('button, a, div[role="button"], li, div')];
    const t = els.find(e => (e.innerText || '').trim().includes(em));
    if (t) t.click();
  }, claudeEmail);
  await sleep(6000);
  // possible authorize button after selection
  for (const sel of ['button:has-text("Authorize")', 'button:has-text("Allow")', 'button:has-text("Continue")']) {
    const b = await page.$(sel);
    if (b && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); log('clicked ' + sel); break; }
  }
  await sleep(6000);
}
log('final url: ' + page.url().slice(0, 100));
await shot(page, 'final');
console.log('REAUTH_DONE ' + claudeEmail);
await ctx.close();
