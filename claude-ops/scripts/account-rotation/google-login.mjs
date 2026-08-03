// google-login.mjs — reusable Google sign-in via playwright + dcli-sourced creds.
// Usage: node google-login.mjs <email> <targetUrl> [headed=1]
// Prints FINAL_URL=<url> on success, exits 0 when targetUrl reached (or Google auth completed).
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const [email, targetUrl, passKey] = process.argv.slice(2);
if (!email || !targetUrl || !passKey) { console.error('usage: node google-login.mjs <email> <targetUrl> <passKeyInCredsFile>'); process.exit(2); }

const credsPath = process.env.GOOGLE_CREDS_PATH;
const creds = Object.fromEntries(
  readFileSync(credsPath, 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
);
const password = creds[passKey];
if (!password) { console.error('no password for ' + email); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);

function freshOtp() {
  const idKey = passKey.replace('_PASS', '_OTP_ID');
  const entryId = creds[idKey];
  const filter = entryId ? `id=${entryId}` : `email=${email}`;
  const out = execSync(`/opt/homebrew/bin/dcli password -o console -f otp '${filter}'`, { timeout: 20000 })
    .toString().replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n');
  const code = out[out.length - 1].trim();
  if (!/^\d{6}$/.test(code)) throw new Error('bad otp from dcli: ' + code.slice(0, 3) + '...');
  return code;
}

export async function googleLogin(page) {
  log('google signin start for ' + email);
  let idleRounds = 0;
  for (let step = 0; step < 25; step++) {
    const url = page.url();
    const onSignin = url.includes('accounts.google.com');
    if (!onSignin && step > 0) {
      log('left google signin flow: ' + url.slice(0, 90));
      return true;
    }
    // email field — v3 signin may nest the input in web components / frames
    let emailInput = null;
    for (const frame of page.frames()) {
      for (const sel of ['input[type="email"]', 'input#identifierId', 'input[name="identifier"]', 'input[aria-label*="mail" i]', 'input[autocomplete="username"]']) {
        emailInput = await frame.$(sel);
        if (emailInput && await emailInput.isVisible().catch(() => false)) break;
        emailInput = null;
      }
      if (emailInput) break;
    }
    if (emailInput) {
      await emailInput.fill(email);
      await page.keyboard.press('Enter');
      log('email submitted');
      idleRounds = 0;
      await sleep(3500);
      continue;
    }
    // password field — same frame-tolerant lookup
    let passInput = null;
    for (const frame of page.frames()) {
      for (const sel of ['input[type="password"]', 'input[name="Passwd"]', 'input[autocomplete="current-password"]']) {
        passInput = await frame.$(sel);
        if (passInput && await passInput.isVisible().catch(() => false)) break;
        passInput = null;
      }
      if (passInput) break;
    }
    if (passInput) {
      await passInput.fill(password);
      await page.keyboard.press('Enter');
      log('password submitted');
      idleRounds = 0;
      globalThis.__pwSubmits = (globalThis.__pwSubmits || 0) + 1;
      await sleep(4000);
      // detect wrong-password / hard errors right after submit (EN + NL)
      const errText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '');
      if (/Wrong password|incorrect password|Couldn.t sign you in|too many|onjuist|verkeerd|fout wachtwoord|Controleer je wachtwoord/i.test(errText)) {
        const stillPwd = await page.$('input[type="password"]');
        if (stillPwd) {
          log('ERROR after password: ' + errText.split('\n').filter(l => /wachtwoord|password|onjuist|verkeerd|sign/i.test(l)).slice(0,3).join(' | '));
          await page.screenshot({ path: `/tmp/google-login-error-${passKey}.png` }).catch(() => {});
          return false;
        }
      }
      if (globalThis.__pwSubmits >= 3) {
        log('password submitted 3x without progress — page says: ' + errText.split('\n').slice(0, 6).join(' | '));
        await page.screenshot({ path: `/tmp/google-login-error-${passKey}.png` }).catch(() => {});
        return false;
      }
      continue;
    }
    // TOTP input page — HIGHEST PRIORITY once visible (must run before chooser handlers,
    // because the TOTP page text itself matches chooser regexes)
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '');
    if (/2-Step Verification|verification code|authenticator/i.test(bodyText)) {
      const otpInput = await page.$('input[type="tel"], input[id*="totp" i], input[autocomplete="one-time-code"], input[type="text"][inputmode="numeric"]');
      if (otpInput && await otpInput.isVisible()) {
        const code = freshOtp();
        await otpInput.fill(code);
        await page.keyboard.press('Enter');
        log('totp submitted');
        idleRounds = 0;
        await sleep(4000);
        continue;
      }
    }
    // passkey/2FA challenge — pick Authenticator TOTP from the options list directly
    if (/passkey|Verifying it.?s you|Security Key|Try another way|Choose how to sign in/i.test(bodyText)) {
      // locate the li by text in DOM, then click via real mouse at its coordinates (Google binds mousedown, not click)
      const box = await page.evaluate(() => {
        const lis = [...document.querySelectorAll('li')];
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const target = lis.find(li => /verification code from the Google Authenticator/i.test(norm(li.innerText)))
                    || lis.find(li => /Authenticator app/i.test(norm(li.innerText)))
                    || lis.find(li => norm(li.innerText) === 'Try another way');
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: norm(target.innerText).slice(0, 60) };
      });
      if (box) {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await sleep(80);
        await page.mouse.up();
        log('challenge list → mouse-clicked "' + box.label + '"');
        idleRounds = 0;
        await sleep(4000);
        continue;
      }
    }
    // "choose an account" page — pick ours (only on the real chooser, not the account pill)
    if (/Choose an account/i.test(bodyText)) {
      const acct = await page.$(`text=${email}`);
      if (acct) {
        await acct.click().catch(() => {});
        log('account chooser clicked');
        idleRounds = 0;
        await sleep(3000);
        continue;
      }
    }
    // consent screens ("Continue" / "Allow")
    let clicked = false;
    for (const sel of ['button:has-text("Continue")', 'button:has-text("Allow")', '#submit_approve_access']) {
      const b = await page.$(sel);
      if (b && await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {});
        log('clicked ' + sel);
        clicked = true;
        idleRounds = 0;
        await sleep(3000);
        break;
      }
    }
    if (!clicked) {
      idleRounds++;
      if (idleRounds >= 3) {
        // nothing actionable for 3 rounds — if we're off accounts.google.com, call it success
        if (!page.url().includes('accounts.google.com')) return true;
      }
    }
    await sleep(2000);
  }
  log('google login flow did not converge; url=' + page.url().slice(0, 100));
  return false;
}

const PROFILE_DIR = process.env.GOOGLE_LOGIN_PROFILE || '/tmp/google-login-profile-' + passKey;
const launchArgs = [
  '--window-position=100,100', '--window-size=1100,900',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=AutomationControlled',
  '--lang=en-US,en',
];
let ctx;
try {
  // Preferred: real Chrome stable (Google accepts it far more often than bundled chromium)
  ctx = await chromium.launchPersistentContext(PROFILE_DIR + '-chrome', {
    headless: false, channel: 'chrome', args: launchArgs, viewport: null, timeout: 15000,
  });
  log('driver: real chrome channel');
} catch (e) {
  log('chrome channel failed (' + e.message.slice(0, 60) + ') — bundled chromium');
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, args: launchArgs, viewport: null,
  });
}
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  // Hide WebAuthn/passkey support so Google offers password+TOTP instead of passkey-first
  try { delete window.PublicKeyCredential; } catch (e) { window.PublicKeyCredential = undefined; }
  Object.defineProperty(navigator, 'credentials', { get: () => undefined, configurable: true });
});
const page = ctx.pages()[0] || await ctx.newPage();

// Step 1: authenticate at Google directly (email field on first screen)
await page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin',
  { timeout: 40000, waitUntil: 'domcontentloaded' });
await sleep(3000);

const ok = await googleLogin(page);
if (!ok) {
  log('LOGIN_FAIL at google');
  console.log('FINAL_URL=' + page.url());
  await page.screenshot({ path: `/tmp/google-login-fail.png` }).catch(() => {});
  await ctx.close();
  process.exit(1);
}

// Step 2: now navigate to the real target (Google session is established in this context)
log('google session established — navigating to target ' + targetUrl);
await page.goto(targetUrl, { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(e => log('target nav warn: ' + e.message.slice(0, 80)));
await sleep(4000);

// If the target shows its own "Sign in with Google" button, click it (session exists now)
for (const sel of ['button:has-text("Continue with Google")', 'button:has-text("Sign in with Google")', 'a:has-text("Sign in with Google")']) {
  const b = await page.$(sel);
  if (b && await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    log('clicked target SSO button ' + sel);
    await sleep(5000);
    break;
  }
}

log('LOGIN_OK');
console.log('FINAL_URL=' + page.url());
await page.screenshot({ path: `/tmp/google-login-ok.png` }).catch(() => {});
await sleep(2000);
await ctx.close();
process.exit(0);
