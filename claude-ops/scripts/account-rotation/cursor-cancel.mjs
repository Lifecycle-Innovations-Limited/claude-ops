// cursor-cancel.mjs — cancel a Cursor subscription via Google SSO + dashboard billing.
// Usage: GOOGLE_CREDS_PATH=... node cursor-cancel.mjs <email> <passKey> [--execute]
// Without --execute: stops before the final confirm (dry run, screenshots only).
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const [email, passKey, ...flags] = process.argv.slice(2);
const EXECUTE = flags.includes('--execute');
if (!email || !passKey) { console.error('usage: node cursor-cancel.mjs <email> <passKey> [--execute]'); process.exit(2); }

const creds = Object.fromEntries(
  readFileSync(process.env.GOOGLE_CREDS_PATH, 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const shot = (page, name) => page.screenshot({ path: `/tmp/cursor-cancel-${name}.png`, fullPage: true }).then(() => log('shot: /tmp/cursor-cancel-' + name + '.png')).catch(() => {});

const PROFILE_DIR = `/tmp/google-login-profile-${passKey}`;
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: ['--window-position=100,100', '--window-size=1200,950', '--disable-blink-features=AutomationControlled'],
  viewport: null,
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = ctx.pages()[0] || await ctx.newPage();

// 1. Go to a protected page — Cursor redirects to authenticator.cursor.sh with the SSO buttons
await page.goto('https://cursor.com/settings', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(4000);
await shot(page, '01-signin');

// 2. Click Google SSO if present
for (const sel of ['button:has-text("Continue with Google")', 'button:has-text("Google")', 'a:has-text("Continue with Google")', '[data-testid*="google" i]']) {
  const b = await page.$(sel);
  if (b && await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    log('clicked SSO ' + sel);
    break;
  }
}
await sleep(6000);

// 3. If we land on Google chooser, pick the account
const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '');
if (/Choose an account/i.test(body)) {
  await page.evaluate((em) => {
    const els = [...document.querySelectorAll('div[role="link"], li, div')];
    const t = els.find(e => (e.innerText || '').trim().startsWith(em.split('@')[0]));
    if (t) t.click();
  }, email);
  log('picked google account from chooser');
  await sleep(5000);
}
log('post-SSO url: ' + page.url().slice(0, 100));
await shot(page, '02-post-sso');

// 4. Go to dashboard settings
await page.goto('https://cursor.com/settings', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(4500);
log('settings url: ' + page.url().slice(0, 100));
await shot(page, '03-settings');

// 5. Find billing / subscription management
const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
const planLine = pageText.split('\n').find(l => /pro|business|free|trial|plan/i.test(l) && l.length < 80);
log('plan indicator: ' + (planLine || 'not found').trim());

let clicked = null;
for (const sel of ['a:has-text("Billing")', 'button:has-text("Billing")', 'text=Manage subscription', 'a:has-text("Manage")', 'text=Billing']) {
  const b = await page.$(sel);
  if (b && await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    clicked = sel;
    log('clicked ' + sel);
    await sleep(4000);
    break;
  }
}
await shot(page, '04-billing');

// 6. Cancel button
for (const sel of ['button:has-text("Cancel subscription")', 'button:has-text("Cancel plan")', 'text=Cancel subscription', 'button:has-text("Cancel")']) {
  const b = await page.$(sel);
  if (b && await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    log('clicked ' + sel);
    await sleep(3000);
    break;
  }
}
await shot(page, '05-cancel-dialog');

// 7. Confirm dialog (only with --execute)
const confirm = await page.$('button:has-text("Confirm")') || await page.$('button:has-text("Yes, cancel")') || await page.$('button:has-text("Cancel subscription")');
if (confirm && await confirm.isVisible().catch(() => false)) {
  if (EXECUTE) {
    await confirm.click().catch(() => {});
    log('CONFIRMED cancellation');
    await sleep(4000);
  } else {
    log('DRY RUN — confirm button present but not clicked (pass --execute)');
  }
} else {
  log('no confirm button found');
}
await shot(page, '06-final');
console.log('FINAL_URL=' + page.url());
await ctx.close();
