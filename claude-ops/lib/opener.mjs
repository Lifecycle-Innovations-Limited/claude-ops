// opener.mjs
//
// Node ESM mirror of lib/opener.sh — cross-OS helpers for launching URLs,
// files, and directories in the user's default handler. Zero npm deps; relies
// on the sibling os-detect.mjs for platform resolution.
//
// Usage as a module:
//   import { openUrl, openDir, openTarget } from "./opener.mjs";
//   await openUrl("https://example.com");
//
// Usage as a CLI:
//   node lib/opener.mjs url https://example.com
//   node lib/opener.mjs dir /path/to/folder
//   node lib/opener.mjs open anything
//
// Design notes:
//   - Spawned processes are detached + unrefed so parent exits cleanly even
//     if the opener lingers (common with xdg-open forking a browser).
//   - We do NOT try to detect whether the URL is already open somewhere; that
//     is intentionally out of scope.
//   - On Windows we spawn `cmd.exe /c start "" <target>` — the empty quoted
//     string is `start`'s title placeholder; without it, a path/URL
//     containing spaces gets eaten as the window title.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import process from 'node:process';
import { osId, opener } from './os-detect.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Mirror of hasBin() in os-detect.mjs, repeated locally so this module stays
 * self-contained and doesn't pull private helpers out of the sibling file.
 * @param {string} name
 * @returns {boolean}
 */
function hasBin(name) {
  try {
    if (process.platform === 'win32') {
      return spawnSync('where.exe', [name], { stdio: 'ignore' }).status === 0;
    }
    return (
      spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        stdio: 'ignore',
      }).status === 0
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the opener command, preferring os-detect.mjs's `opener()` and
 * falling back to a hardcoded cascade if that returns null.
 * @returns {string|null}
 */
function resolveOpener() {
  const detected = opener();
  if (detected) return detected;

  if (hasBin('open')) return 'open';
  if (hasBin('wslview')) return 'wslview';
  if (hasBin('xdg-open')) return 'xdg-open';
  if (hasBin('cmd.exe')) return 'cmd.exe /c start';
  return null;
}

/**
 * Split a command string like "cmd.exe /c start" into [program, ...args].
 * Returns null for empty input.
 * @param {string} cmd
 * @returns {[string, string[]]|null}
 */
function splitCmd(cmd) {
  if (!cmd) return null;
  const parts = cmd.trim().split(/\s+/);
  const [program, ...args] = parts;
  return [program, args];
}

/**
 * Log a breadcrumb to stderr in the same shape as opener.sh.
 * @param {string} cmd
 * @param {string} target
 */
function logOpen(cmd, target) {
  process.stderr.write(`opener: using ${cmd} for ${target}\n`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open an arbitrary target (URL, file, dir) in the host's default handler.
 * @param {string} target
 * @returns {Promise<{ok: boolean, command: string|null, target: string}>}
 */
export async function openTarget(target) {
  if (!target) {
    process.stderr.write('opener: missing target\n');
    return { ok: false, command: null, target: '' };
  }

  const cmd = resolveOpener();
  if (!cmd) {
    process.stderr.write('opener: no URL opener available on this host\n');
    return { ok: false, command: null, target };
  }

  logOpen(cmd, target);

  try {
    // Windows: always use `cmd.exe /c start "" <target>` with the empty title.
    const isWindowsStart = cmd === 'cmd.exe /c start' || osId() === 'windows' || process.platform === 'win32';

    if (isWindowsStart && cmd.includes('start')) {
      const child = spawn('cmd.exe', ['/c', 'start', '', target], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: false,
      });
      child.unref();
      return { ok: true, command: cmd, target };
    }

    const split = splitCmd(cmd);
    if (!split) {
      return { ok: false, command: cmd, target };
    }
    const [program, extraArgs] = split;
    const child = spawn(program, [...extraArgs, target], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, command: cmd, target };
  } catch (err) {
    process.stderr.write(`opener: spawn failed: ${err?.message || err}\n`);
    return { ok: false, command: cmd, target };
  }
}

/**
 * Open a URL. Scheme is validated — only http(s), mailto:, tel: are accepted.
 * @param {string} url
 * @returns {Promise<{ok: boolean, command: string|null, target: string}>}
 */
export async function openUrl(url) {
  if (!url) {
    process.stderr.write('opener: missing url\n');
    return { ok: false, command: null, target: '' };
  }
  if (!/^https?:\/\/|^mailto:|^tel:/.test(url)) {
    process.stderr.write(`opener: refusing to open non-URL scheme: ${url}\n`);
    return { ok: false, command: null, target: url };
  }
  return openTarget(url);
}

/**
 * Open a directory. Path is validated for existence and must be a directory.
 * @param {string} pathStr
 * @returns {Promise<{ok: boolean, command: string|null, target: string}>}
 */
export async function openDir(pathStr) {
  if (!pathStr) {
    process.stderr.write('opener: missing directory path\n');
    return { ok: false, command: null, target: '' };
  }
  try {
    const st = await fsp.stat(pathStr);
    if (!st.isDirectory()) {
      process.stderr.write(`opener: not a directory: ${pathStr}\n`);
      return { ok: false, command: null, target: pathStr };
    }
  } catch {
    process.stderr.write(`opener: directory does not exist: ${pathStr}\n`);
    return { ok: false, command: null, target: pathStr };
  }
  return openTarget(pathStr);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const [, , sub, ...rest] = process.argv;
  const target = rest[0] || '';
  let result;
  switch (sub) {
    case 'open':
      result = await openTarget(target);
      break;
    case 'url':
      result = await openUrl(target);
      break;
    case 'dir':
      result = await openDir(target);
      break;
    default:
      process.stderr.write('usage: opener.mjs {open|url|dir} <target>\n');
      process.exit(2);
  }
  process.exit(result.ok ? 0 : 1);
}
