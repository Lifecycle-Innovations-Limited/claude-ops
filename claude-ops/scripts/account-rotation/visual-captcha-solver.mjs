// visual-captcha-solver.mjs
// Interactive hCaptcha / Turnstile wall solver via Gemini vision (agy) + Playwright clicks.
// Used AFTER token inject fails to clear a large pick/drag challenge.
// Never prints secrets. Fail-soft.

import { writeFileSync, unlinkSync, mkdtempSync, existsSync } from 'fs';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function agyBin() {
  if (process.env.CLAUDE_ROTATOR_AGY_BIN) return process.env.CLAUDE_ROTATOR_AGY_BIN;
  try {
    return execFileSync('which', ['agy'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch {
    return join(homedir(), '.local/bin/agy');
  }
}

function geminiModel() {
  return process.env.CLAUDE_ROTATOR_GEMINI_MODEL || 'Gemini 3.5 Flash (Medium)';
}

/** True when agy (Gemini CLI) is available. Self-contained — no ai-brain import. */
let _geminiChecked = null;
export function geminiAvailable() {
  if (_geminiChecked !== null) return _geminiChecked;
  if (process.env.CLAUDE_ROTATOR_DISABLE_GEMINI_BRAIN === '1') {
    _geminiChecked = false;
    return false;
  }
  try {
    execFileSync(agyBin(), ['--help'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    _geminiChecked = true;
  } catch {
    _geminiChecked = false;
  }
  return _geminiChecked;
}

async function visionDecide(screenshotB64, url, log) {
  if (!geminiAvailable()) {
    log('[visual-captcha] Gemini/agy unavailable');
    return null;
  }
  let tmpImg = null;
  const prompt = [
    'You are solving an interactive CAPTCHA (hCaptcha pick-images, drag, or Cloudflare checkbox) in a browser screenshot.',
    `Page URL: ${url}`,
    '',
    'Return ONLY one JSON object (no markdown fences):',
    '{',
    '  "done": boolean,  // true if challenge already passed / no captcha visible',
    '  "clicks": [{"x": number, "y": number}],  // viewport pixel coords to click (center of each target tile/checkbox)',
    '  "drag": {"from":{"x":n,"y":n},"to":{"x":n,"y":n}} | null,',
    '  "click_text": string | null,  // optional: visible button text to click after tiles (e.g. "Verify", "Next", "Skip")',
    '  "reason": string',
    '}',
    '',
    'Rules:',
    '- Coordinates are absolute viewport pixels from top-left of the screenshot (same size as image).',
    '- For "select all images with X": click the CENTER of each matching tile, then click Verify if present.',
    '- For empty checkbox "I am human" / "Verify you are human": one click on the checkbox square.',
    '- If a spinner is mid-solve, return done=false, clicks=[], reason=waiting.',
    '- If captcha is gone and login/email form is visible, done=true.',
    '- Prefer 1–6 clicks max per round. Do not invent coords outside the image.',
  ].join('\n');

  try {
    const dir = mkdtempSync(join(tmpdir(), 'vis-cap-'));
    tmpImg = join(dir, 'shot.png');
    writeFileSync(tmpImg, Buffer.from(screenshotB64, 'base64'));
    const full = `${prompt}\n\nScreenshot: @${tmpImg}`;
    const { stdout } = await execFileAsync(
      agyBin(),
      ['--print', full, '--model', geminiModel(), '--dangerously-skip-permissions'],
      { timeout: 90_000, maxBuffer: 2_000_000, env: process.env },
    );
    const text = (stdout || '').trim();
    log(`[visual-captcha] vision responded (${text.length} chars)`);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) {
    log(`[visual-captcha] vision failed: ${String(e.message || e).slice(0, 140)}`);
    return null;
  } finally {
    if (tmpImg) {
      try {
        unlinkSync(tmpImg);
      } catch {}
    }
  }
}

/**
 * Interactively clear a large captcha wall using vision + mouse.
 * @param {import('playwright').Page} page
 * @param {(m:string)=>void} log
 * @param {{ maxRounds?: number }} opts
 * @returns {Promise<boolean>} true if wall appears cleared
 */
export async function solveInteractiveCaptchaVisually(page, log = () => {}, opts = {}) {
  if (!page) return false;
  if (process.env.CLAUDE_ROT_VISUAL_CAPTCHA === '0') {
    log('[visual-captcha] disabled via CLAUDE_ROT_VISUAL_CAPTCHA=0');
    return false;
  }
  const maxRounds = Number(opts.maxRounds || process.env.CLAUDE_ROT_VISUAL_CAPTCHA_ROUNDS || 8);
  const vp = page.viewportSize() || { width: 1440, height: 900 };

  for (let round = 1; round <= maxRounds; round++) {
    let buf;
    try {
      buf = await page.screenshot({ type: 'png', fullPage: false, timeout: 8000 });
    } catch (e) {
      log(`[visual-captcha] screenshot failed: ${String(e.message || e).slice(0, 80)}`);
      return false;
    }
    const b64 = Buffer.from(buf).toString('base64');
    const decision = await visionDecide(b64, page.url(), log);
    if (!decision) {
      log(`[visual-captcha] round ${round}: no decision`);
      continue;
    }
    log(
      `[visual-captcha] round ${round}: done=${!!decision.done} clicks=${(decision.clicks || []).length} reason=${String(decision.reason || '').slice(0, 80)}`,
    );
    if (decision.done) return true;

    const clicks = Array.isArray(decision.clicks) ? decision.clicks : [];
    for (const c of clicks.slice(0, 8)) {
      const x = Math.max(2, Math.min(vp.width - 2, Number(c.x) || 0));
      const y = Math.max(2, Math.min(vp.height - 2, Number(c.y) || 0));
      if (!x || !y) continue;
      try {
        await page.mouse.click(x, y, { delay: 40 });
        await sleep(350 + Math.floor(Math.random() * 200));
      } catch (e) {
        log(`[visual-captcha] click failed ${x},${y}: ${String(e.message || e).slice(0, 60)}`);
      }
    }

    if (decision.drag?.from && decision.drag?.to) {
      try {
        const { from, to } = decision.drag;
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 12 });
        await page.mouse.up();
        await sleep(500);
      } catch {}
    }

    if (decision.click_text) {
      try {
        const t = String(decision.click_text);
        const btn = page.getByRole('button', { name: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
        if ((await btn.count()) > 0) await btn.first().click({ timeout: 3000 });
        else await page.getByText(t, { exact: false }).first().click({ timeout: 3000 }).catch(() => {});
      } catch {}
    }

    await sleep(1800);

    // Heuristic clear: no large hcaptcha challenge iframe visible
    try {
      const still = await page.evaluate(() => {
        const frames = Array.from(document.querySelectorAll('iframe'));
        for (const f of frames) {
          const src = f.getAttribute('src') || '';
          if (!/hcaptcha\.com/i.test(src) || !/frame=challenge/i.test(src)) continue;
          const r = f.getBoundingClientRect();
          if (r.width >= 200 && r.height >= 200 && r.bottom > 0) return true;
        }
        const t = (document.body?.innerText || '').slice(0, 500);
        if (/select all images|pick the|drag the|i am human|verify you are human/i.test(t)) return true;
        return false;
      });
      if (!still) {
        log(`[visual-captcha] wall cleared after round ${round}`);
        return true;
      }
    } catch {}
  }
  log('[visual-captcha] max rounds exhausted — wall still present');
  return false;
}

/**
 * Fire VNC computer-use agent against Claude VNC (:5902) as last autonomous resort.
 * Non-blocking optional; returns promise of success boolean.
 */
export async function runVncComputerUseCaptcha(log = () => {}, opts = {}) {
  if (process.env.CLAUDE_ROT_VNC_AGENT === '0') {
    log('[visual-captcha] VNC agent disabled');
    return false;
  }
  const vncPort = opts.vncPort || process.env.CLAUDE_VNC_PORT || '5902';
  const password =
    process.env.VNC_PASSWORD || process.env.CLAUDE_VNC_PASSWORD || process.env.VNC_PASS || '';
  const project = process.env.VNC_USE_PROJECT || join(homedir(), 'tools/vnc-use');
  if (!existsSync(join(project, 'pyproject.toml'))) {
    log('[visual-captcha] vnc-use project missing');
    return false;
  }
  const task =
    opts.task ||
    'On the visible Chrome window: solve any Cloudflare checkbox or hCaptcha image challenge for Claude login. Click the correct tiles, then Verify/Continue. Do not close the browser. Stop when the captcha is gone or a login/email form or success page is visible.';
  const args = [
    'run',
    '--project',
    project,
    'vnc-use',
    'run',
    '--task',
    task,
    '--vnc',
    `127.0.0.1::${vncPort}`,
    '--no-hitl',
    '--step-limit',
    String(opts.stepLimit || 25),
    '--timeout',
    String(opts.timeout || 180),
  ];
  if (password) {
    args.push('--password', password);
  }
  // Prefer non-metered if configured; leave MODEL_PROVIDER to env
  log(`[visual-captcha] starting VNC computer-use on :${vncPort}`);
  return await new Promise((resolve) => {
    const child = spawn('uv', args, {
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      out += d.toString();
    });
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      log('[visual-captcha] VNC agent timeout');
      resolve(false);
    }, (opts.timeout || 180) * 1000 + 5000);
    child.on('close', (code) => {
      clearTimeout(t);
      log(`[visual-captcha] VNC agent exit=${code} out=${out.slice(-200).replace(/\s+/g, ' ')}`);
      resolve(code === 0);
    });
  });
}


/**
 * Resolve desktop-act runner for background rotate-magic.
 * Prefers the portable stdio CLI (`desktop-act run`); falls back to local captcha wrapper.
 * No host-specific paths beyond $HOME + XDG cache (same layout every install).
 */
function resolveDesktopActRunner() {
  const home = homedir();
  const xdg = process.env.XDG_CACHE_HOME || join(home, '.cache');
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const explicit = process.env.DESKTOP_ACT_CLI || process.env.DESKTOP_ACT_CAPTCHA_BIN || '';
  let whichCli = '';
  try {
    whichCli = execFileSync('which', ['desktop-act'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch {
    /* not on PATH */
  }
  const candidates = [
    explicit,
    whichCli,
    pluginRoot ? join(pluginRoot, 'desktop-act', 'cli', 'desktop-act') : '',
    // Sibling plugin next to claude-ops when installed from ops-marketplace monorepo
    pluginRoot ? join(pluginRoot, '..', 'desktop-act', 'cli', 'desktop-act') : '',
    join(xdg, 'desktop-act-mcp/src/cli/desktop-act'),
    join(home, '.cache/desktop-act-mcp/src/cli/desktop-act'),
    join(home, '.local/bin/desktop-act'),
    join(home, '.local/bin/desktop-act-captcha-fallback'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      const base = p.split('/').pop() || '';
      const kind = base === 'desktop-act' || base === 'desktop_act_cli.py' ? 'cli' : 'wrapper';
      return { path: p, kind };
    }
  }
  return null;
}

function defaultDesktopDisplay() {
  // Reauth Chrome (start-reauth-chrome) defaults to DISPLAY=:1 for headed reauth seats.
  // :2 is the secondary VNC seat — only use if explicitly set.
  return (
    process.env.CLAUDE_DESKTOP_DISPLAY ||
    process.env.DESKTOP_ACT_DISPLAY ||
    process.env.DISPLAY ||
    ':1'
  );
}

/**
 * desktop-act autonomous act() loop on the real X/VNC display where headed Chrome runs.
 * Called from rotate-magic captcha cascade — no interactive session required.
 */
export async function runDesktopActCaptcha(log = () => {}, opts = {}) {
  if (process.env.CLAUDE_ROT_DESKTOP_ACT === '0') {
    log('[visual-captcha] desktop-act disabled (CLAUDE_ROT_DESKTOP_ACT=0)');
    return false;
  }
  const runner = resolveDesktopActRunner();
  if (!runner) {
    log('[visual-captcha] desktop-act runner missing (install cli/desktop-act or desktop-act-captcha-fallback)');
    return false;
  }
  const display = opts.display || defaultDesktopDisplay();
  const timeoutSec = Number(opts.timeout || process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180);
  const maxIter = Number(opts.maxIterations || process.env.DESKTOP_ACT_MAX_ITERATIONS || 25);
  const goal =
    opts.goal ||
    process.env.DESKTOP_ACT_CAPTCHA_GOAL ||
    [
      'Find the headed browser window with a Claude login or captcha challenge.',
      'Solve any Cloudflare "verify you are human" checkbox or hCaptcha image/tile challenge.',
      'Click correct tiles, then Verify/Next/Continue.',
      'Do not close the browser. Stop when captcha is gone or login/OAuth advances.',
    ].join(' ');

  const home = homedir();
  const xdg = process.env.XDG_CACHE_HOME || join(home, '.cache');
  const defaultHome = process.env.DESKTOP_ACT_HOME || join(xdg, 'desktop-act-mcp/src');
  const defaultVenv = process.env.DESKTOP_ACT_VENV || join(defaultHome, '.venv');
  const defaultCmd =
    process.env.DESKTOP_ACT_COMMAND ||
    (existsSync(join(defaultHome, 'mcp-server/run.sh'))
      ? join(defaultHome, 'mcp-server/run.sh')
      : '');

  // Use `act` (not `run`) so we drive the EXISTING headed Chrome display.
  // `run` would acquire a fresh empty Xvnc pool session and miss the captcha tab.
  let args;
  if (runner.kind === 'cli') {
    // Portable CLI: act() param is max_iterations (not max_steps).
    args = [
      'act',
      '--goal',
      goal,
      '--timeout',
      String(timeoutSec),
      '--max-iterations',
      String(maxIter),
      '--display',
      display,
    ];
  } else {
    // Wrapper historically called `run`; pass --no-acquire if supported, else act via env.
    args = [
      '--display',
      display,
      '--timeout',
      String(timeoutSec),
      '--goal',
      goal,
      '--mode',
      'act',
    ];
  }

  log(
    `[visual-captcha] starting desktop-act (${runner.kind}) display=${display} timeout=${timeoutSec}s bin=${runner.path}`,
  );

  return await new Promise((resolve) => {
    const child = spawn(runner.path, args, {
      env: {
        ...process.env,
        DISPLAY: display,
        DESKTOP_ACT_DISPLAY: display,
        DESKTOP_ACT_HOME: defaultHome,
        DESKTOP_ACT_VENV: defaultVenv,
        ...(defaultCmd ? { DESKTOP_ACT_COMMAND: defaultCmd } : {}),
        PATH: `${join(home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      out += d.toString();
    });
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      log('[visual-captcha] desktop-act timeout');
      resolve(false);
    }, timeoutSec * 1000 + 15_000);
    child.on('close', (code) => {
      clearTimeout(t);
      log(
        `[visual-captcha] desktop-act exit=${code} tail=${out.slice(-320).replace(/\s+/g, ' ')}`,
      );
      resolve(code === 0);
    });
  });
}

/**
 * Full autonomous captcha escalation for rotate-magic (no human session):
 *   1) Playwright + vision clicks on the live page
 *   2) desktop-act act() on the headed Chrome display
 *   3) optional VNC computer-use (last autonomous resort)
 *
 * Returns { ok, layer } so rotate can re-detect the wall after each layer.
 */
export async function runAutonomousCaptchaCascade(page, log = () => {}, opts = {}) {
  const includeVnc = opts.includeVnc !== false && process.env.CLAUDE_ROT_VNC_AGENT !== '0';
  const display = opts.display || defaultDesktopDisplay();
  const daTimeout = Number(opts.desktopTimeout || process.env.DESKTOP_ACT_CAPTCHA_TIMEOUT || 180);

  if (page && process.env.CLAUDE_ROT_VISUAL_CAPTCHA !== '0') {
    try {
      const visOk = await solveInteractiveCaptchaVisually(page, log, {
        maxRounds: opts.visualRounds || 6,
      });
      if (visOk) return { ok: true, layer: 'visual-ai' };
    } catch (e) {
      log(`[visual-captcha] cascade visual error: ${String(e.message || e).slice(0, 100)}`);
    }
  }

  if (process.env.CLAUDE_ROT_DESKTOP_ACT !== '0') {
    // Bring the Playwright tab to the front so desktop-act/X11 sees the captcha,
    // not an unrelated tab on the same DISPLAY.
    if (page) {
      try {
        await page.bringToFront();
        await page.evaluate(() => {
          try {
            window.focus();
          } catch {}
        });
      } catch (e) {
        log(`[visual-captcha] bringToFront warn: ${String(e.message || e).slice(0, 80)}`);
      }
      try {
        // Best-effort: raise any Chrome window whose title mentions Claude/hCaptcha.
        execFileSync(
          'bash',
          [
            '-lc',
            `DISPLAY=${JSON.stringify(display)} xdotool search --onlyvisible --name 'Claude|hCaptcha|Sign in' windowactivate --sync 2>/dev/null | head -1`,
          ],
          { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch {
        /* xdotool optional */
      }
    }
    try {
      const daOk = await runDesktopActCaptcha(log, {
        display,
        timeout: daTimeout,
        maxIterations: opts.maxIterations,
        goal: opts.goal,
      });
      if (daOk) return { ok: true, layer: 'desktop-act' };
    } catch (e) {
      log(`[visual-captcha] cascade desktop-act error: ${String(e.message || e).slice(0, 100)}`);
    }
  }

  if (includeVnc) {
    try {
      const vncOk = await runVncComputerUseCaptcha(log, {
        vncPort: opts.vncPort || process.env.CLAUDE_VNC_PORT || '5902',
        timeout: opts.vncTimeout || 120,
        stepLimit: opts.vncStepLimit || 25,
      });
      if (vncOk) return { ok: true, layer: 'vnc-use' };
    } catch (e) {
      log(`[visual-captcha] cascade vnc error: ${String(e.message || e).slice(0, 100)}`);
    }
  }

  return { ok: false, layer: null };
}

// CLI: node visual-captcha-solver.mjs --cdp 9223
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('visual-captcha-solver.mjs')) {
  const cdp = process.argv.includes('--cdp')
    ? process.argv[process.argv.indexOf('--cdp') + 1]
    : '9223';
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  const page = browser.contexts()[0]?.pages()?.[0];
  if (!page) {
    console.error('no page');
    process.exit(2);
  }
  const ok = await solveInteractiveCaptchaVisually(page, console.log);
  console.log(ok ? 'CLEARED' : 'STILL_BLOCKED');
  process.exit(ok ? 0 : 1);
}
