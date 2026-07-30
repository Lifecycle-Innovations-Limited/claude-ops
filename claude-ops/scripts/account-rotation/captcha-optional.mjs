/**
 * Soft-load captcha cascade modules when present in this install.
 * Safe no-ops when modules are missing (public thin rotate path).
 *
 * Prefer sibling files in this directory (port targets). Never hard-require host paths.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function tryImport(name) {
  const p = join(__dirname, name);
  if (!existsSync(p)) return null;
  try {
    return await import(pathToFileURL(p).href);
  } catch {
    return null;
  }
}

let _cache = null;

export async function loadCaptchaCascade() {
  if (_cache) return _cache;
  const captcha = await tryImport('captcha-helper.mjs');
  const visual = await tryImport('visual-captcha-solver.mjs');
  const bright = await tryImport('bright-data-cascade.mjs');
  const secrets = await tryImport('secrets-bootstrap.mjs');
  const vdisplay = await tryImport('virtual-display.mjs');
  _cache = {
    present: !!(captcha || visual),
    captcha,
    visual,
    bright,
    secrets,
    vdisplay,
    solveCaptchaOnPage: captcha?.solveCaptchaOnPage || null,
    captchaSolverAvailable: captcha?.captchaSolverAvailable || (() => false),
    runAutonomousCaptchaCascade: visual?.runAutonomousCaptchaCascade || null,
    solveInteractiveCaptchaVisually: visual?.solveInteractiveCaptchaVisually || null,
    runDesktopActCaptcha: visual?.runDesktopActCaptcha || null,
    runVncComputerUseCaptcha: visual?.runVncComputerUseCaptcha || null,
    bootstrapRotatorSecrets: secrets?.bootstrapRotatorSecrets || (() => {}),
    ensureVirtualDisplay: vdisplay?.ensureVirtualDisplay || (async () => null),
  };
  return _cache;
}

export function captchaModulesOnDisk() {
  return [
    'captcha-helper.mjs',
    'visual-captcha-solver.mjs',
    'bright-data-cascade.mjs',
    'secrets-bootstrap.mjs',
    'virtual-display.mjs',
  ].filter((n) => existsSync(join(__dirname, n)));
}
