/**
 * Soft captcha hook for public rotate.mjs.
 * Call from browser wall handlers when a page is available:
 *   const { trySolveCaptchaWall } = await import('./rotate-captcha-hook.mjs');
 *   await trySolveCaptchaWall(page, log, opts);
 */
import { loadCaptchaCascade } from './captcha-optional.mjs';

/**
 * @param {import('playwright').Page|null} page
 * @param {(m:string)=>void} [log]
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, layer?:string, reason?:string}>}
 */
export async function trySolveCaptchaWall(page, log = () => {}, opts = {}) {
  if (!page) {
    return { ok: false, reason: 'no-page' };
  }
  const c = await loadCaptchaCascade();
  if (!c.present) {
    log('[captcha-hook] cascade modules not present');
    return { ok: false, reason: 'no-modules' };
  }
  try {
    c.bootstrapRotatorSecrets(log);
  } catch {}
  try {
    if (c.ensureVirtualDisplay) await c.ensureVirtualDisplay(log);
  } catch {}

  if (c.solveCaptchaOnPage) {
    try {
      const r = await c.solveCaptchaOnPage(page, log, opts);
      // captcha-helper returns {present, solved, ...}; treat solved as success
      if (r?.ok || r?.solved) return { ok: true, layer: 'token-solver', reason: r.reason || r.provider };
    } catch (e) {
      log(`[captcha-hook] token solve: ${String(e.message || e).slice(0, 80)}`);
    }
  }

  if (c.runAutonomousCaptchaCascade) {
    try {
      const r = await c.runAutonomousCaptchaCascade(page, log, opts);
      if (r?.ok) return { ok: true, layer: r.layer };
      return { ok: false, reason: 'cascade-exhausted', layer: r?.layer || null };
    } catch (e) {
      log(`[captcha-hook] cascade: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  return { ok: false, reason: 'no-solver' };
}
