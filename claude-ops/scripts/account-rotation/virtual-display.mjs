/**
 * Ensure a reachable X display for headed Playwright/Chromium on headless Linux.
 * Reuses an existing Xvfb (:99+) when present; spawns one if needed.
 * No-op on macOS/Windows or when DISPLAY already works.
 */

import { existsSync, readdirSync } from 'fs';
import { spawn, spawnSync } from 'child_process';

const DISPLAY_RANGE_START = 99;
const DISPLAY_RANGE_END = 120;

function isDisplayReachable(display) {
  if (!display) return false;
  try {
    const r = spawnSync('xdpyinfo', ['-display', display], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function listUnixDisplays() {
  const dir = '/tmp/.X11-unix';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^X\d+$/.test(name))
    .map((name) => `:${name.slice(1)}`)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function pickFreeDisplayNum() {
  for (let n = DISPLAY_RANGE_START; n <= DISPLAY_RANGE_END; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !isDisplayReachable(`:${n}`)) return n;
  }
  return null;
}

async function waitForDisplay(display, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDisplayReachable(display)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function spawnXvfb(displayNum) {
  const display = `:${displayNum}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-ac', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  if (!(await waitForDisplay(display))) {
    try {
      proc.kill('SIGKILL');
    } catch {}
    throw new Error(`Xvfb on ${display} did not become reachable`);
  }
  return display;
}

/**
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string|null>} display string set on process.env, or null if unchanged
 */
export async function ensureVirtualDisplay(log = () => {}) {
  if (process.platform !== 'linux') return null;

  if (isDisplayReachable(process.env.DISPLAY)) {
    log(`[display] Using existing DISPLAY=${process.env.DISPLAY}`);
    return process.env.DISPLAY;
  }

  if (process.env.DISPLAY) {
    log(`[display] DISPLAY=${process.env.DISPLAY} unreachable — probing alternatives`);
  }

  for (const display of listUnixDisplays()) {
    if (isDisplayReachable(display)) {
      process.env.DISPLAY = display;
      log(`[display] Switched to reachable ${display}`);
      return display;
    }
  }

  const freeNum = pickFreeDisplayNum();
  if (freeNum == null) {
    throw new Error('No free display in :99-:120 and no reachable X server found');
  }

  log(`[display] Starting Xvfb on :${freeNum} for headed browser automation`);
  const display = await spawnXvfb(freeNum);
  process.env.DISPLAY = display;
  log(`[display] Ready DISPLAY=${display}`);
  return display;
}
