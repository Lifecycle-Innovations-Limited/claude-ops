// claude-reauth.mjs — drive one Claude account reauth via playwright + gog magic-link polling.
// Usage: node claude-reauth.mjs <email> <oauthAuthorizeUrl> [gogInbox]
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const [email, authUrl] = process.argv.slice(2);
if (!email || !authUrl) { console.error('usage: node claude-reauth.mjs <email> <authUrl>'); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);

function gogSearch(query) {
  try {
    return execSync(`gog gmail search "${query.replace(/"/g, '\\"')}" --max 5 2>/dev/null`, { timeout: 30000 }).toString();
  } catch { return ''; }
}
function gogRead(id) {
  try { return execSync(`gog gmail read ${id} 2>/dev/null`, { timeout: 30000 }).toString(); } catch { return ''; }
}

async function waitMagicLink(sinceMs, maxWaitMs = 180000) {
  log(`polling gmail for magic link to ${email}...`);
  const linkRe = /https:\/\/claude\.ai\/magic-link#[^\s"'<>)\]}]+/;
  const codeRe = /(?:verification code|code is|code:)\s*[^0-9]{0,10}([0-9]{6})/i;
  while (Date.now() - sinceMs < maxWaitMs) {
    // Magic links arrive from mail.anthropic.com, subject "Your secure link to Claude.ai is here"
    const out = gogSearch(`from:mail.anthropic.com subject:"secure link" to:${email}`);
    const ids = [...out.matchAll(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}/gm)].map(m => m[1]);
    for (const id of ids) {
      const body = gogRead(id);
      const dateMatch = body.match(/Date:\s*(.+)/);
      if (dateMatch && Date.parse(dateMatch[1]) < sinceMs - 60000) continue; // stale
      const link = body.match(linkRe);
      if (link) return { type: 'link', value: link[0] };
      const code = body.match(codeRe);
      if (code) return { type: 'code', value: code[1] };
    }
    // also search without to: filter (forwards may not preserve to:)
    const out2 = gogSearch('from:mail.anthropic.com subject:"secure link" newer_than:10m');
    const ids2 = [...out2.matchAll(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}/gm)].map(m => m[1]);
    for (const id of ids2) {
      const body = gogRead(id);
      const dateMatch = body.match(/Date:\s*(.+)/);
      if (dateMatch && Date.parse(dateMatch[1]) < sinceMs - 60000) continue;
      if (!body.toLowerCase().includes(email.toLowerCase())) continue;
      const link = body.match(linkRe);
      if (link) return { type: 'link', value: link[0] };
      const code = body.match(codeRe);
      if (code) return { type: 'code', value: code[1] };
    }
    await sleep(8000);
  }
  return null;
}

const browser = await chromium.launch({ headless: false, args: ['--window-position=100,100', '--window-size=1100,900'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

log('logging out existing claude.ai session');
await page.goto('https://claude.ai/api/auth/logout', { timeout: 20000 }).catch(() => {});
await sleep(1500);

log('going to claude.ai login');
await page.goto('https://claude.ai/login', { timeout: 30000, waitUntil: 'domcontentloaded' });
await sleep(2500);

// fill email
const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="username"], input[placeholder*="mail" i]';
await page.waitForSelector(emailSel, { timeout: 15000 });
await page.fill(emailSel, email);
log('email filled');
// submit
for (const sel of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Continue with email")']) {
  try { await page.click(sel, { timeout: 3000 }); log(`clicked ${sel}`); break; } catch {}
}

const since = Date.now();
await sleep(3000);

// Sometimes the page shows a verification-code input instead of "link sent"
let result = null;
const codeInputSel = 'input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="code"], input[placeholder*="code" i]';
const hasCodeInput = await page.$(codeInputSel);

result = await waitMagicLink(since);
if (!result) { log('FAIL: no magic link/code found in time'); await browser.close(); process.exit(1); }

if (result.type === 'code') {
  log(`got verification code ${result.value}`);
  const inp = await page.$(codeInputSel);
  if (inp) { await inp.fill(result.value); await page.keyboard.press('Enter'); await sleep(4000); }
} else {
  log(`got magic link — navigating`);
  await page.goto(result.value, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(e => log('link nav warn: ' + e.message.slice(0,80)));
  await sleep(4000);
}

// After login, maybe a displayed verification code appears that must be entered back on the sign-in page.
// Check current state
log('post-login page: ' + page.url().slice(0, 100));

// Now go to the OAuth authorize URL
log('navigating to OAuth authorize URL');
await page.goto(authUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
await sleep(3000);
log('authorize page: ' + page.url().slice(0, 100) + ' | title=' + await page.title());

// Click Authorize / org selection if present
for (let attempt = 0; attempt < 3; attempt++) {
  if (page.url().includes('localhost:54545')) break;
  for (const sel of ['button:has-text("Authorize")', 'button:has-text("Allow")', 'button[type="submit"]', 'button:has-text("Continue")']) {
    try {
      const b = await page.$(sel);
      if (b) { await b.click({ timeout: 3000 }); log(`clicked ${sel}`); await sleep(3000); break; }
    } catch {}
  }
  if (page.url().includes('localhost:54545')) break;
  await sleep(2000);
}

const finalUrl = page.url();
if (finalUrl.includes('localhost:54545') || finalUrl.includes('127.0.0.1:54545')) {
  log('SUCCESS: callback reached — ' + finalUrl.slice(0, 120));
  await browser.close();
  process.exit(0);
}
log('FAIL: did not reach callback. final=' + finalUrl.slice(0, 120));
await page.screenshot({ path: `/tmp/claude-reauth-${email.replace(/[@.]/g, '_')}.png` }).catch(() => {});
await browser.close();
process.exit(1);
