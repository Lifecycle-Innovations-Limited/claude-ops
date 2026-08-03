// factory-cancel.mjs — log into Factory (Google SSO via existing profile) and reach billing.
// Usage: node factory-cancel.mjs [--execute]
import { chromium } from 'playwright';

const EXECUTE = process.argv.includes('--execute');
const GOOGLE_EMAIL = process.env.FACTORY_GOOGLE_EMAIL;
if (!GOOGLE_EMAIL) { console.error('set FACTORY_GOOGLE_EMAIL'); process.exit(2); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);
const shot = (p, n) => p.screenshot({ path: `/tmp/factory-${n}.png`, fullPage: true }).then(() => log('shot /tmp/factory-' + n + '.png')).catch(() => {});

const ctx = await chromium.launchPersistentContext('/tmp/google-login-profile-GMAIL_PASS', {
  headless: false, args: ['--window-position=100,100', '--window-size=1200,950', '--disable-blink-features=AutomationControlled'], viewport: null,
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = ctx.pages()[0] || await ctx.newPage();

async function clickWhenVisible(text, timeout = 15000) {
  const loc = p.getByText(text, { exact: false }).first();
  await loc.waitFor({ state: 'visible', timeout });
  await loc.click();
  log('clicked "' + text + '"');
}

await p.goto('https://app.factory.ai/', { timeout: 45000, waitUntil: 'domcontentloaded' });
await sleep(12000);

// cookies (optional)
try { await clickWhenVisible('AGREE', 4000); } catch (e) { log('no cookie banner'); }
await sleep(1000);

// LOG IN
await clickWhenVisible('LOG IN', 20000);
await sleep(6000);

// Google SSO
await clickWhenVisible('Continue with Google', 20000);
await sleep(8000);

// account chooser (if shown)
const t = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : '');
if (/Choose an account/i.test(t)) {
  await clickWhenVisible(GOOGLE_EMAIL, 10000);
  await sleep(10000);
}
log('URL after SSO: ' + p.url().slice(0, 110));
await shot(p, '10-dashboard');
const dt = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '');
log('dashboard text: ' + dt.split('\n').filter(l => l.trim()).slice(0, 25).join(' | '));

// look for settings/billing links
for (const probe of ['Settings', 'Billing', 'Usage', 'Plan', 'Subscription', 'Account']) {
  const loc = p.getByText(probe, { exact: true }).first();
  if (await loc.isVisible().catch(() => false)) log('nav item visible: ' + probe);
}

console.log('FINAL_URL=' + p.url());
await ctx.close();
