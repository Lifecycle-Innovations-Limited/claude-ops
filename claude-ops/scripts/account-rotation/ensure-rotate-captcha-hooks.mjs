/**
 * Ensures plugin rotate.mjs has trySolveCaptchaWall call sites at browser walls.
 * Idempotent. Safe to run from rotate-magic entry or tests.
 *
 * Mutates sibling rotate.mjs once when markers are missing.
 */
import { readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROTATE = join(__dirname, 'rotate.mjs');

const MARKER = 'auth-step-${step}'; // template marker after patch
const MARKER_PLAIN = 'auth-step-'; // simpler detect

export function rotateCaptchaHooksPresent(src = null) {
  let text = src;
  if (text == null) {
    // Read directly and treat ENOENT as "absent" rather than testing existence
    // first: the existsSync/readFileSync pair is a TOCTOU race, and the read
    // already tells us everything the check would have.
    try {
      text = readFileSync(ROTATE, 'utf8');
    } catch {
      text = '';
    }
  }
  return (
    text.includes("from './rotate-captcha-soft.mjs'") ||
    (text.includes('trySolveCaptchaWall') && text.includes('oauth-authorize') && text.includes(MARKER_PLAIN))
  );
}

export function ensureRotateCaptchaHooks({ dryRun = false } = {}) {
  // Read first; ENOENT is the "missing" signal. No existsSync pre-check.
  let text;
  try {
    text = readFileSync(ROTATE, 'utf8');
  } catch {
    return { ok: false, reason: 'rotate-missing' };
  }
  if (rotateCaptchaHooksPresent(text)) {
    return { ok: true, changed: false, reason: 'already-present' };
  }

  // 1) Replace inline soft-load helpers with import from rotate-captcha-soft.mjs
  const helperRe =
    /\/\/ Optional captcha cascade[\s\S]*?async function captchaHardFailed\(page\) \{[\s\S]*?\n\}\n\nconst __dirname/;
  if (helperRe.test(text)) {
    text = text.replace(
      helperRe,
      `// Soft captcha hooks — trySolveCaptchaWall on browser walls (CAPTCHA-CASCADE.md).
// Helpers live in rotate-captcha-soft.mjs so thin checkouts can omit cascade modules.
import {
  trySolveCaptchaWall,
  maybeClearCaptchaWall,
  detectCaptchaWall,
  captchaHardFailed,
} from './rotate-captcha-soft.mjs';

const __dirname`,
    );
  } else if (!text.includes("from './rotate-captcha-soft.mjs'")) {
    // Fallback: inject import after bg-respawn import
    const importAnchor = `import { respawnBgSessions } from './bg-respawn.mjs';\n`;
    if (text.includes(importAnchor)) {
      text = text.replace(
        importAnchor,
        importAnchor +
          `import {\n  trySolveCaptchaWall,\n  maybeClearCaptchaWall,\n  detectCaptchaWall,\n  captchaHardFailed,\n} from './rotate-captcha-soft.mjs';\n`,
      );
    }
    // Strip old helper block if still present (best-effort)
    text = text.replace(
      /let _captchaCascade = null;\nasync function loadCaptchaCascade\(\) \{[\s\S]*?async function captchaHardFailed\(page\) \{[\s\S]*?\n\}\n\n/,
      '',
    );
  }

  // 2) Step-loop wall handling
  if (!text.includes(MARKER_PLAIN + '${step}') && !text.includes('auth-step-')) {
    const stepNeedle = `  for (let step = 0; step < 20; step++) {
    await sleep(2500);
    const url = await driver.currentUrl().catch(() => '');
    log(\`Step \${step} [\${driver.name}]: \${url.substring(0, 100)}\`);

    // Claude sometimes renders the email login form while preserving the
`;
    const stepInsert = `  for (let step = 0; step < 20; step++) {
    await sleep(2500);
    const url = await driver.currentUrl().catch(() => '');
    log(\`Step \${step} [\${driver.name}]: \${url.substring(0, 100)}\`);

    // Browser walls (post-Verify pick/drag hCaptcha / CF): clear before OTP re-submit
    // or AI-brain thrash. Soft no-op when cascade modules missing.
    if (driver._page && /claude\\.(ai|com)/i.test(url || '')) {
      const visualWall = await detectCaptchaWall(driver._page);
      if (visualWall.blocking) {
        const cleared = await trySolveCaptchaWall(
          driver._page,
          \`auth-step-\${step}:\${visualWall.kind || 'wall'}\`,
          log,
        );
        if (await captchaHardFailed(driver._page)) {
          log(
            \`[captcha] aborting: budget exhausted with blocking wall kind=\${visualWall.kind} — see CAPTCHA_VNC_HANDOFF (autoloop retries)\`,
          );
          return false;
        }
        if (cleared) {
          log(\`[captcha] step \${step}: wall cleared kind=\${visualWall.kind}\`);
          if (driver._authUrl) {
            try {
              await driver.goto(driver._authUrl);
            } catch {}
            await sleep(2000);
          }
          stallCount = 0;
          continue;
        }
      } else if (visualWall.kind === 'hcaptcha-challenge-preload') {
        log('[captcha] preload challenge frame noted (non-blocking)');
      }
    }

    // Claude sometimes renders the email login form while preserving the
`;
    if (text.includes(stepNeedle)) {
      text = text.replace(stepNeedle, stepInsert);
    }
  }

  // 3) Authorize path
  if (!text.includes("trySolveCaptchaWall(driver._page, 'oauth-authorize'")) {
    const authNeedle = `    if (oauthPath.includes('/oauth/authorize') || (oauthPath.endsWith('/authorize') && url.includes('claude'))) {
      // Magic-link route: we authenticated via a single-use link delivered to
`;
    const authInsert = `    if (oauthPath.includes('/oauth/authorize') || (oauthPath.endsWith('/authorize') && url.includes('claude'))) {
      // Clear captcha wall on authorize (can reappear after session settle).
      if (driver._page) {
        await trySolveCaptchaWall(driver._page, 'oauth-authorize', log);
        if (await captchaHardFailed(driver._page)) {
          log('[captcha] aborting on /oauth/authorize — budget exhausted');
          return false;
        }
      }
      // Magic-link route: we authenticated via a single-use link delivered to
`;
    if (text.includes(authNeedle)) {
      text = text.replace(authNeedle, authInsert);
    }
  }

  // 4) Inline magic-link verify path
  if (!text.includes('after-inline-code-verify')) {
    const inlineNeedle = `            await sleep(4000);
            // After magic link login, session is now valid — re-navigate to authUrl
            // so the OAuth flow can complete (org chooser → authorize → callback)
            if (driver._authUrl) {
              // For multi-org accounts (same email, multiple workspaces like
              // user-personal vs user-team), force an explicit org
              // pick BEFORE hitting /oauth/authorize. Otherwise claude.ai uses
              // the "last active" org silently, and both sibling vaults end up
              // holding the same org's token.
              const isMultiOrg =
                account.label && account.orgName && account.orgName.toLowerCase() !== account.email.toLowerCase();
`;
    const inlineInsert = `            await sleep(4000);
            // Post-verify captcha wall after inline code/link path (mirrors finishMagicLinkLogin)
            if (driver._page) {
              await trySolveCaptchaWall(driver._page, 'after-inline-code-verify', log);
              if (await captchaHardFailed(driver._page)) {
                log(
                  '[magic-link] aborting: captcha budget exhausted after inline verify — see CAPTCHA_VNC_HANDOFF',
                );
                return false;
              }
            }
            // After magic link login, session is now valid — re-navigate to authUrl
            // so the OAuth flow can complete (org chooser → authorize → callback)
            if (driver._authUrl) {
              // For multi-org accounts (same email, multiple workspaces like
              // user-personal vs user-team), force an explicit org
              // pick BEFORE hitting /oauth/authorize. Otherwise claude.ai uses
              // the "last active" org silently, and both sibling vaults end up
              // holding the same org's token.
              const isMultiOrg =
                account.label && account.orgName && account.orgName.toLowerCase() !== account.email.toLowerCase();
`;
    if (text.includes(inlineNeedle)) {
      text = text.replace(inlineNeedle, inlineInsert);
    }
  }

  // Normalize remaining maybeClearCaptchaWall calls
  text = text.replaceAll('await maybeClearCaptchaWall(', 'await trySolveCaptchaWall(');

  if (dryRun) {
    return { ok: true, changed: true, dryRun: true, presentAfter: rotateCaptchaHooksPresent(text) };
  }
  // Write atomically: temp file in the same directory + rename(2). A direct
  // writeFileSync over the path we read leaves a window in which rotate.mjs can
  // be replaced between read and write, and a crash mid-write would truncate the
  // live script. rename(2) is atomic within a filesystem, so readers see either
  // the old file or the complete new one.
  const tmp = `${ROTATE}.tmp-${process.pid}`;
  try {
    let mode = 0o644;
    try {
      mode = statSync(ROTATE).mode & 0o777;
    } catch {}
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, ROTATE);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  return { ok: true, changed: true, presentAfter: rotateCaptchaHooksPresent(text) };
}

// CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const r = ensureRotateCaptchaHooks({ dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok && r.presentAfter !== false ? 0 : 1);
}
