/**
 * Captcha cascade orchestration for unattended re-auth (rotate-magic).
 *
 * Portable extract of host rotate.mjs helpers:
 *   detectPostVerifyVisualChallenge, maybeSolvePageCaptcha,
 *   maybeSolvePostVerifyVisualChallenge, captchaHardFailed, writeCaptchaVncHandoff
 *
 * Soft-depends on captcha-helper.mjs + visual-captcha-solver.mjs (same directory).
 * Callers that lack solver keys still get autonomous visual → desktop-act → VNC.
 *
 * No host paths, no account emails. Handoff markers go under
 * $CLAUDE_PLUGIN_DATA_DIR/account-rotation/screenshots (or XDG data / tmp).
 *
 * See CAPTCHA-CASCADE.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { solveInteractiveCaptchaVisually, runAutonomousCaptchaCascade } from './visual-captcha-solver.mjs';
import { solveCaptchaOnPage, captchaSolverAvailable } from './captcha-helper.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _postVerifyCaptchaAttempts = new WeakMap();
const _vncHandoffWritten = new WeakSet();
const _captchaHardFail = new WeakSet();

/** Directory for CAPTCHA_VNC_HANDOFF marker + screenshots (portable). */
export function resolveCaptchaHandoffDir(env = process.env) {
  if (env.CLAUDE_ROT_CAPTCHA_HANDOFF_DIR) return env.CLAUDE_ROT_CAPTCHA_HANDOFF_DIR;
  const data =
    env.CLAUDE_PLUGIN_DATA_DIR || join(env.HOME || homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
  return join(data, 'account-rotation', 'screenshots');
}

/**
 * @param {(m: string) => void} [log]
 */
export async function maybeSolvePageCaptcha(
  page,
  reason = '',
  { timeoutMs = 180_000, attempt = 0, browserWaitMs, forceSolver, stalled, log = () => {} } = {},
) {
  if (!page) return false;
  try {
    const result = await solveCaptchaOnPage(page, (message) => log(`[captcha] ${message}`), {
      timeoutMs,
      attempt,
      browserWaitMs,
      forceSolver,
      stalled,
    });
    if (result.present && !result.solved && !captchaSolverAvailable()) {
      log(`[captcha] challenge present${reason ? ` (${reason})` : ''} but no solver key`);
    }
    if (result.present && !result.solved && captchaSolverAvailable()) {
      log(`[captcha] present but unsolved${reason ? ` (${reason})` : ''} — visual/interactive wall may need cascade`);
    }
    if (result.solved) {
      log(`[captcha] solved ${result.provider}${reason ? ` (${reason})` : ''}`);
      await sleep(1500);
    }
    return result.solved === true;
  } catch (e) {
    log(`[captcha] solve attempt failed: ${String(e.message || e).slice(0, 100)}`);
    return false;
  }
}

/** Post-Verify Cloudflare/hCaptcha visual challenges (pick/drag/image-grid). */
export async function detectPostVerifyVisualChallenge(page) {
  if (!page) return { present: false, kind: null, text: '', blocking: false };
  try {
    const text = await page
      .evaluate(() => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        let extra = '';
        try {
          for (const f of document.querySelectorAll('iframe')) {
            extra += ` ${f.getAttribute('title') || ''} ${f.getAttribute('aria-label') || ''}`;
          }
        } catch {
          /* ignore */
        }
        return `${body} ${extra}`.slice(0, 2500);
      })
      .catch(() => '');
    const t = String(text || '');
    let kind = null;
    if (/drag the icon to the place where it fits/i.test(t)) kind = 'drag-fit';
    else if (/pick items that dispense when you squeeze/i.test(t)) kind = 'pick-squeeze';
    else if (/click on items you would/i.test(t)) kind = 'click-items';
    else if (/please drag the icon/i.test(t)) kind = 'drag-fit';
    else if (/\b(select all|pick all|which of these|image challenge)\b/i.test(t) && /hcaptcha|challenge/i.test(t)) {
      kind = 'image-grid';
    }
    const promptKinds = new Set(['drag-fit', 'pick-squeeze', 'click-items', 'image-grid']);
    if (!kind) {
      const widget = await page
        .evaluate(() => {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 900;
          const hostOf = (src) => {
            try {
              return new URL(src, location.href).hostname.toLowerCase();
            } catch {
              return '';
            }
          };
          const isHcHost = (h) => h === 'hcaptcha.com' || h.endsWith('.hcaptcha.com');
          const isCfChallengeHost = (h) =>
            h === 'challenges.cloudflare.com' || h.endsWith('.challenges.cloudflare.com');
          const frames = Array.from(document.querySelectorAll('iframe')).map((f) => {
            const r = f.getBoundingClientRect();
            const visible =
              r.width > 0 && r.height > 0 && r.bottom > 8 && r.right > 8 && r.top < vh - 8 && r.left < vw - 8;
            const src = f.src || '';
            const host = hostOf(src);
            return {
              src,
              host,
              w: r.width,
              h: r.height,
              x: r.x,
              y: r.y,
              title: f.title || '',
              visible,
              isHc: isHcHost(host),
              isCf: isCfChallengeHost(host),
              isChallenge: /(?:^|[?&#])frame=challenge(?:&|#|$)/i.test(src),
            };
          });
          const largeHc = frames.find((f) => f.visible && f.isHc && f.isChallenge && f.w >= 350 && f.h >= 300);
          const anyHcChallenge = frames.some((f) => f.visible && f.isHc && f.isChallenge && f.w > 0 && f.h > 0);
          const anyHcOffscreen = frames.some((f) => !f.visible && f.isHc && f.isChallenge && f.w > 0 && f.h > 0);
          const hasCf = frames.some((f) => f.visible && f.isCf && f.w >= 200 && f.h >= 50);
          return {
            largeHc: !!largeHc,
            anyHcChallenge,
            anyHcOffscreen,
            hasCf,
            dims: frames
              .filter((f) => f.isHc || f.isCf || f.host.includes('cloudflare'))
              .map(
                (f) =>
                  `${Math.round(f.w)}x${Math.round(f.h)}@${Math.round(f.x)},${Math.round(f.y)}${f.visible ? '' : ':off'}`,
              )
              .slice(0, 4),
          };
        })
        .catch(() => ({}));
      if (widget?.largeHc) kind = 'hcaptcha-challenge-large';
      else if (widget?.hasCf) kind = 'cf-challenge-frame';
      else if (widget?.anyHcChallenge || widget?.anyHcOffscreen) {
        return {
          present: false,
          kind: 'hcaptcha-challenge-preload',
          text: t.slice(0, 200),
          blocking: false,
          dims: widget.dims || [],
        };
      }
    }
    const blocking =
      !!kind && (promptKinds.has(kind) || kind === 'hcaptcha-challenge-large' || kind === 'cf-challenge-frame');
    return { present: !!kind, kind, text: t.slice(0, 200), blocking };
  } catch {
    return { present: false, kind: null, text: '', blocking: false };
  }
}

export function captchaHardFailed(page) {
  return !!(page && _captchaHardFail.has(page));
}

/**
 * Dashboard marker only — not a human task. Autoloop re-dispatches on next tick.
 * @param {(m: string) => void} [log]
 */
export function writeCaptchaVncHandoff(page, visual, reason, log = () => {}) {
  try {
    if (page && _vncHandoffWritten.has(page)) {
      try {
        const marker = join(resolveCaptchaHandoffDir(), 'CAPTCHA_VNC_HANDOFF.json');
        // Read-or-skip (no existsSync→read race): missing file throws ENOENT.
        const prev = JSON.parse(readFileSync(marker, 'utf8'));
        prev.ts = new Date().toISOString();
        prev.reason = reason || visual?.kind || prev.reason || 'post-verify';
        prev.kind = visual?.kind || prev.kind || null;
        prev.url = page ? String(page.url()).slice(0, 200) : prev.url;
        writeFileSync(marker, JSON.stringify(prev, null, 2));
      } catch {
        /* ignore missing / unreadable marker */
      }
      return Promise.resolve(null);
    }
    const handoffDir = resolveCaptchaHandoffDir();
    mkdirSync(handoffDir, { recursive: true });
    const shotPath = join(handoffDir, `vnc-handoff-captcha-${Date.now()}.png`);
    const marker = join(handoffDir, 'CAPTCHA_VNC_HANDOFF.json');
    const payload = {
      ts: new Date().toISOString(),
      reason: reason || visual?.kind || 'post-verify',
      kind: visual?.kind || null,
      url: page ? String(page.url()).slice(0, 200) : null,
      screenshot: shotPath,
      instruction:
        'AUTONOMOUS ONLY — not a human task. magic-link-autoloop will re-dispatch this seat on the next tick. Cascade already tried: residential wait → token solvers → visual AI → desktop-act act on CLAUDE_DESKTOP_DISPLAY → VNC computer-use. Marker is for ops dashboards / failStreak. Do not spawn interactive agent reauth drivers (they thrash the global .rotating lock).',
    };
    if (page) _vncHandoffWritten.add(page);
    return page
      .screenshot({ path: shotPath })
      .catch(() => {})
      .then(() => {
        writeFileSync(marker, JSON.stringify(payload, null, 2));
        log(`[captcha] VNC handoff marker written: ${marker} shot=${shotPath}`);
        return marker;
      });
  } catch (e) {
    log(`[captcha] VNC handoff marker failed: ${String(e.message || e).slice(0, 100)}`);
    return Promise.resolve(null);
  }
}

/**
 * Full post-verify wall handling: residential/token solvers + autonomous cascade.
 * Returns true only when the blocking wall is actually gone.
 *
 * @param {import('playwright').Page} page
 * @param {string} [reason]
 * @param {{ log?: (m: string) => void }} [opts]
 */
export async function maybeSolvePostVerifyVisualChallenge(page, reason = '', opts = {}) {
  const log = opts.log || (() => {});
  if (!page) return false;
  const visual = await detectPostVerifyVisualChallenge(page);
  if (visual.present || visual.blocking) {
    log(`[captcha] post-verify visual challenge detected kind=${visual.kind}${reason ? ` (${reason})` : ''}`);
  }

  const maxAttempts = Number(
    process.env.CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS || (process.env.CLAUDE_ROT_VISUAL_CAPTCHA === '0' ? 2 : 4),
  );
  const used = _postVerifyCaptchaAttempts.get(page) || 0;

  const largeInteractive =
    visual.blocking && (visual.kind === 'hcaptcha-challenge-large' || visual.kind === 'cf-challenge-frame');
  if (largeInteractive && process.env.CLAUDE_ROT_LARGE_HC_TOKEN_FIRST !== '1') {
    log(
      `[captcha] large interactive wall kind=${visual.kind} — autonomous cascade first (set CLAUDE_ROT_LARGE_HC_TOKEN_FIRST=1 to force paid token path first)`,
    );
    _postVerifyCaptchaAttempts.set(page, used + 1);
    try {
      const escalated = await runAutonomousCaptchaCascade(page, (m) => log(m), {
        includeVnc: true,
        display: process.env.CLAUDE_DESKTOP_DISPLAY || process.env.DESKTOP_ACT_DISPLAY || process.env.DISPLAY || ':1',
        desktopTimeout: Number(process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180),
        visualRounds: Number(process.env.CLAUDE_ROT_VISUAL_CAPTCHA_ROUNDS || 8),
      });
      if (escalated.ok) {
        await sleep(1500);
        const still = await detectPostVerifyVisualChallenge(page);
        if (!still.blocking || escalated.layer === 'visual-ai') {
          log(
            `[captcha] autonomous cascade cleared large wall layer=${escalated.layer}${reason ? ` (${reason})` : ''}`,
          );
          return true;
        }
        log(
          `[captcha] cascade layer=${escalated.layer} reported ok but large wall still blocking — falling through to token path`,
        );
      }
    } catch (e) {
      log(`[captcha] large-wall cascade error: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  if (used >= maxAttempts) {
    log(
      `[captcha] attempt budget exhausted (${used}/${maxAttempts})${reason ? ` (${reason})` : ''} — escalating visual AI → desktop-act → VNC (no human session)`,
    );
    if (visual.blocking || visual.present) {
      try {
        const escalated = await runAutonomousCaptchaCascade(page, (m) => log(m), {
          includeVnc: true,
          display: process.env.CLAUDE_DESKTOP_DISPLAY || process.env.DESKTOP_ACT_DISPLAY || process.env.DISPLAY || ':1',
          desktopTimeout: Number(process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180),
          visualRounds: 6,
        });
        if (escalated.ok) {
          await sleep(1500);
          const still = await detectPostVerifyVisualChallenge(page);
          if (!still.blocking || escalated.layer === 'visual-ai') {
            log(`[captcha] autonomous cascade cleared wall layer=${escalated.layer} (budget)`);
            return true;
          }
          log(`[captcha] cascade layer=${escalated.layer} reported ok but page still blocking — treating as uncleared`);
        }
      } catch (e) {
        log(`[captcha] autonomous cascade error: ${String(e.message || e).slice(0, 120)}`);
      }
      await writeCaptchaVncHandoff(page, visual, `budget:${reason || visual.kind}`, log);
      _captchaHardFail.add(page);
    }
    return false;
  }

  _postVerifyCaptchaAttempts.set(page, used + 1);
  const injected = await maybeSolvePageCaptcha(page, reason || visual.kind || 'post-verify', {
    timeoutMs: Number(process.env.CLAUDE_ROT_CAPTCHA_TIMEOUT_MS || 180_000),
    attempt: used + 1,
    browserWaitMs: Number(process.env.CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS || 12000),
    log,
  });

  let wallCleared = false;
  if (injected) {
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const still = await detectPostVerifyVisualChallenge(page);
      if (still.blocking) continue;

      const otpStuck = await page
        .evaluate(() => {
          const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
          const hasCode = !!document.querySelector(
            '#code, [data-testid="code"], input[autocomplete="one-time-code"], input[name="code"]',
          );
          const err = /error verifying your code|invalid code|code expired/i.test(t);
          const otpPrompt = /verification code|enter the code/i.test(t);
          return { hasCode, err, otpPrompt, stillLogin: String(location.pathname || '').includes('/login') };
        })
        .catch(() => ({ hasCode: false, err: false, otpPrompt: false, stillLogin: false }));

      const advanced = await page
        .evaluate(() => {
          const path = String(location.pathname || '');
          const host = String(location.hostname || '');
          if (path.includes('/oauth/authorize') || path === '/authorize' || path === '/authorize/') return true;
          if (host === 'localhost' || host === '127.0.0.1') return true;
          const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
          if (!path.includes('/login')) {
            if (/\bAuthorize\b|\bAllow\b|\bApprove\b/i.test(t) && !/verification code/i.test(t)) return true;
            if (/Select (?:which )?organization/i.test(t)) return true;
            const hasCode = !!document.querySelector(
              '#code, [data-testid="code"], input[autocomplete="one-time-code"], input[name="code"]',
            );
            if (!hasCode) return true;
          }
          return false;
        })
        .catch(() => false);

      if (advanced) {
        wallCleared = true;
        break;
      }

      if (visual.blocking) {
        continue;
      }

      if (!still.present || still.kind === 'hcaptcha-challenge-preload') {
        if (otpStuck?.err) break;
        wallCleared = true;
        break;
      }
      if (!still.blocking && !still.present) {
        wallCleared = true;
        break;
      }
    }
    if (!wallCleared) {
      log(
        `[captcha] token injected but visual wall still present${reason ? ` (${reason})` : ''} — autonomous cascade (visual → desktop-act → vnc)`,
      );
      try {
        const escalated = await runAutonomousCaptchaCascade(page, (m) => log(m), {
          includeVnc: used + 1 >= maxAttempts,
          display: process.env.CLAUDE_DESKTOP_DISPLAY || process.env.DESKTOP_ACT_DISPLAY || process.env.DISPLAY || ':1',
          desktopTimeout: Number(process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180),
          visualRounds: 5,
        });
        if (escalated.ok) {
          await sleep(1500);
          const still = await detectPostVerifyVisualChallenge(page);
          if (!still.blocking || escalated.layer === 'visual-ai') {
            log(
              `[captcha] autonomous cascade cleared wall layer=${escalated.layer} after inject-without-clear${reason ? ` (${reason})` : ''}`,
            );
            wallCleared = true;
          }
        }
      } catch (e) {
        log(`[captcha] autonomous cascade after inject failed: ${String(e.message || e).slice(0, 120)}`);
      }
    } else {
      log(`[captcha] visual wall cleared after inject${reason ? ` (${reason})` : ''}`);
    }
  } else if (visual.blocking || visual.present) {
    log(
      `[captcha] no token inject${reason ? ` (${reason})` : ''} — autonomous cascade (visual → desktop-act${used + 1 >= maxAttempts ? ' → vnc' : ''})`,
    );
    try {
      const escalated = await runAutonomousCaptchaCascade(page, (m) => log(m), {
        includeVnc: used + 1 >= maxAttempts,
        display: process.env.CLAUDE_DESKTOP_DISPLAY || process.env.DESKTOP_ACT_DISPLAY || process.env.DISPLAY || ':1',
        desktopTimeout: Number(process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180),
        visualRounds: 5,
      });
      if (escalated.ok) {
        await sleep(1500);
        const still = await detectPostVerifyVisualChallenge(page);
        if (!still.blocking || escalated.layer === 'visual-ai') {
          log(`[captcha] autonomous cascade cleared wall layer=${escalated.layer} (no-inject path)`);
          wallCleared = true;
        }
      }
    } catch (e) {
      log(`[captcha] autonomous cascade (no-inject) error: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  if (!wallCleared && visual.blocking) {
    const after = _postVerifyCaptchaAttempts.get(page) || 0;
    if (after >= maxAttempts) {
      await writeCaptchaVncHandoff(page, visual, reason || visual.kind, log);
      _captchaHardFail.add(page);
    }
  }
  return wallCleared;
}

/**
 * Soft-load cascade API for rotate.mjs (static re-export convenience).
 */
export { solveCaptchaOnPage, captchaSolverAvailable, solveInteractiveCaptchaVisually, runAutonomousCaptchaCascade };

// Also re-export residual wait concept for callers that only import this module
export async function tryClearCaptchaWall(page, reason = '', log = () => {}) {
  return maybeSolvePostVerifyVisualChallenge(page, reason, { log });
}

/** Alias used by rotate soft-hooks and host-port notes (same as tryClearCaptchaWall). */
export async function trySolveCaptchaWall(page, reason = '', log = () => {}) {
  return maybeSolvePostVerifyVisualChallenge(page, reason, { log });
}
