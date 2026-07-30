/**
 * Soft captcha hooks for public rotate.mjs.
 *
 * Prefer importing these helpers rather than inlining cascade imports, so
 * rotate.mjs stays thin when captcha modules are missing (dev checkouts).
 *
 *   import { trySolveCaptchaWall, detectCaptchaWall, captchaHardFailed } from './rotate-captcha-soft.mjs';
 *   await trySolveCaptchaWall(page, 'auth-step', log);
 */
let _captchaCascade = null;

export async function loadCaptchaCascade() {
  if (_captchaCascade !== null) return _captchaCascade;
  try {
    _captchaCascade = await import('./captcha-cascade.mjs');
  } catch (e) {
    _captchaCascade = false;
    try {
      console.error(`[captcha] cascade modules unavailable: ${String(e.message || e).slice(0, 120)}`);
    } catch {
      /* ignore */
    }
  }
  return _captchaCascade;
}

/**
 * Clear blocking post-verify / authorize walls when cascade modules exist.
 * @param {import('playwright').Page|null} page
 * @param {string} [reason]
 * @param {(m:string)=>void} [log]
 * @returns {Promise<boolean>}
 */
export async function trySolveCaptchaWall(page, reason = '', log = () => {}) {
  const mod = await loadCaptchaCascade();
  if (!mod || !page) return false;
  try {
    if (typeof mod.trySolveCaptchaWall === 'function') {
      return await mod.trySolveCaptchaWall(page, reason, log);
    }
    if (typeof mod.tryClearCaptchaWall === 'function') {
      return await mod.tryClearCaptchaWall(page, reason, log);
    }
    return await mod.maybeSolvePostVerifyVisualChallenge(page, reason, { log });
  } catch (e) {
    log(`[captcha] cascade error: ${String(e.message || e).slice(0, 120)}`);
    return false;
  }
}

/** @deprecated use trySolveCaptchaWall */
export const maybeClearCaptchaWall = trySolveCaptchaWall;

export async function detectCaptchaWall(page) {
  const mod = await loadCaptchaCascade();
  if (!mod || !page || typeof mod.detectPostVerifyVisualChallenge !== 'function') {
    return { present: false, kind: null, text: '', blocking: false };
  }
  try {
    return await mod.detectPostVerifyVisualChallenge(page);
  } catch {
    return { present: false, kind: null, text: '', blocking: false };
  }
}

export async function captchaHardFailed(page) {
  const mod = await loadCaptchaCascade();
  if (!mod || !page) return false;
  try {
    return mod.captchaHardFailed(page);
  } catch {
    return false;
  }
}
