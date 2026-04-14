// os-detect.mjs
//
// Node.js ESM mirror of lib/os-detect.sh. Provides a small, dependency-free
// toolkit for detecting the host OS family, architecture, preferred package
// manager, keyring backend, URL opener, shell, and browser profile
// directories. Field names and return values are kept in sync with the bash
// helper so consumers can mix-and-match between shell and Node contexts.
//
// Design goals:
//   - Zero npm deps (built-ins only: os, fs, path, child_process, process, url)
//   - Sync, cheap helpers for the common cases; async only where fs probing
//     benefits from it (browser profile discovery, aggregate JSON dump)
//   - Never throw on missing files — degrade to null/false/[]
//   - Runnable directly (`node lib/os-detect.mjs`) for debugging

import { readFileSync, promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a file synchronously, returning "" on any error. Used for the small
 * /proc and /etc files we probe — we never want a missing file to throw.
 * @param {string} p
 * @returns {string}
 */
function safeRead(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse a shell-style KEY=value file (e.g. /etc/os-release) into a plain
 * object. Strips surrounding single/double quotes from values.
 * @param {string} contents
 * @returns {Record<string, string>}
 */
function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Check whether a binary is resolvable on PATH. Uses `where.exe` on Windows
 * and `command -v` under /bin/sh everywhere else so we respect shell
 * builtins and aliases to hashed commands.
 * @param {string} name
 * @returns {boolean}
 */
function hasBin(name) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("where.exe", [name], { stdio: "ignore" });
      return r.status === 0;
    }
    const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      stdio: "ignore",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: basic detectors
// ---------------------------------------------------------------------------

/**
 * Returns true when running inside Windows Subsystem for Linux. Detected via
 * the "microsoft" marker Microsoft injects into /proc/version on WSL1/WSL2.
 * @returns {boolean}
 */
export function isWsl() {
  if (process.platform !== "linux") return false;
  const procVersion = safeRead("/proc/version").toLowerCase();
  return procVersion.includes("microsoft");
}

/**
 * High-level OS family identifier.
 * @returns {"macos"|"debian"|"fedora"|"arch"|"suse"|"alpine"|"linux"|"wsl"|"windows"|"unknown"}
 */
export function osId() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform !== "linux") return "unknown";

  if (isWsl()) return "wsl";

  const release = parseEnvFile(safeRead("/etc/os-release"));
  const candidates = [release.ID, ...(release.ID_LIKE || "").split(/\s+/)]
    .map((s) => (s || "").toLowerCase())
    .filter(Boolean);

  for (const id of candidates) {
    if (id === "debian" || id === "ubuntu") return "debian";
    if (
      id === "fedora" ||
      id === "rhel" ||
      id === "centos" ||
      id === "rocky" ||
      id === "almalinux"
    ) {
      return "fedora";
    }
    if (id === "arch" || id === "manjaro") return "arch";
    if (id.startsWith("opensuse") || id === "sles") return "suse";
    if (id === "alpine") return "alpine";
  }
  return "linux";
}

/**
 * Normalized CPU architecture string.
 * @returns {"x86_64"|"arm64"|"armv7"|"i686"|"unknown"}
 */
export function arch() {
  switch (process.arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "arm64";
    case "arm":
      return "armv7";
    case "ia32":
      return "i686";
    default:
      return "unknown";
  }
}

/**
 * First package manager found on PATH, in preference order. Mirrors the
 * cascade used by the bash helper so recommended install commands are
 * consistent across shells.
 * @returns {"brew"|"apt-get"|"dnf"|"pacman"|"zypper"|"apk"|"winget"|"scoop"|"choco"|null}
 */
export function pkgMgr() {
  // Homebrew wins everywhere it's installed (macOS and Linuxbrew).
  if (hasBin("brew")) return "brew";

  if (process.platform === "linux") {
    for (const m of ["apt-get", "dnf", "pacman", "zypper", "apk"]) {
      if (hasBin(m)) return m;
    }
  }

  if (process.platform === "win32") {
    for (const m of ["winget", "scoop", "choco"]) {
      if (hasBin(m)) return m;
    }
  }

  return null;
}

/**
 * Full shell command string to install `pkg` via the detected package
 * manager, or null when nothing suitable is available.
 * @param {string} pkg
 * @returns {string|null}
 */
export function pkgInstallCmd(pkg) {
  const mgr = pkgMgr();
  switch (mgr) {
    case "brew":
      return `brew install ${pkg}`;
    case "apt-get":
      return `sudo apt-get install -y ${pkg}`;
    case "dnf":
      return `sudo dnf install -y ${pkg}`;
    case "pacman":
      return `sudo pacman -S --noconfirm ${pkg}`;
    case "zypper":
      return `sudo zypper install -y ${pkg}`;
    case "apk":
      return `sudo apk add ${pkg}`;
    case "winget":
      return `winget install -e --id ${pkg}`;
    case "scoop":
      return `scoop install ${pkg}`;
    case "choco":
      return `choco install -y ${pkg}`;
    default:
      return null;
  }
}

/**
 * Preferred secret-storage backend identifier.
 *   - macOS: Keychain via `security`
 *   - Linux: libsecret via `secret-tool` (if present on PATH)
 *   - Windows / WSL-with-cmd.exe: Windows Credential Manager
 * @returns {"security"|"secret-tool"|"wincred"|null}
 */
export function keyringBackend() {
  if (process.platform === "darwin") return "security";
  if (process.platform === "win32") return "wincred";
  if (isWsl() && hasBin("cmd.exe")) return "wincred";
  if (process.platform === "linux" && hasBin("secret-tool")) return "secret-tool";
  return null;
}

/**
 * Best-effort command for opening URLs/files in the host GUI.
 * @returns {"open"|"xdg-open"|"wslview"|"cmd.exe /c start"|null}
 */
export function opener() {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "cmd.exe /c start";
  if (isWsl()) {
    if (hasBin("wslview")) return "wslview";
    if (hasBin("cmd.exe")) return "cmd.exe /c start";
  }
  if (hasBin("xdg-open")) return "xdg-open";
  return null;
}

/**
 * Basename of the user's interactive shell, with platform-aware fallbacks.
 * @returns {string}
 */
export function shell() {
  const s = process.env.SHELL;
  if (s) return path.basename(s);
  if (process.platform === "win32") return "pwsh";
  return "bash";
}

// ---------------------------------------------------------------------------
// Public: async probes
// ---------------------------------------------------------------------------

/**
 * Candidate Chrome/Chromium/Brave/Arc user-data directories for this host.
 * Paths that don't exist are filtered out.
 * @returns {Promise<string[]>}
 */
export async function browserProfileDirs() {
  const home = homedir();
  /** @type {string[]} */
  const candidates = [];

  if (process.platform === "darwin") {
    const sup = path.join(home, "Library", "Application Support");
    candidates.push(
      path.join(sup, "Google", "Chrome"),
      path.join(sup, "Chromium"),
      path.join(sup, "BraveSoftware", "Brave-Browser"),
      path.join(sup, "Arc", "User Data"),
    );
  } else if (process.platform === "linux") {
    const config = path.join(home, ".config");
    candidates.push(
      path.join(config, "google-chrome"),
      path.join(config, "chromium"),
      path.join(config, "BraveSoftware", "Brave-Browser"),
    );
    // On WSL, also probe the Windows-side profile under /mnt/c.
    if (isWsl()) {
      const winUser = process.env.USER || process.env.USERNAME || "";
      if (winUser) {
        const winLocal = `/mnt/c/Users/${winUser}/AppData/Local`;
        candidates.push(
          path.join(winLocal, "Google", "Chrome", "User Data"),
          path.join(winLocal, "Chromium", "User Data"),
          path.join(winLocal, "BraveSoftware", "Brave-Browser", "User Data"),
        );
      }
    }
  } else if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, "AppData", "Local")
        : "");
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Google", "Chrome", "User Data"),
        path.join(localAppData, "Chromium", "User Data"),
        path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      );
    }
  }

  const checks = await Promise.all(
    candidates.map(async (p) => {
      try {
        await fsp.access(p);
        return p;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((p) => p !== null);
}

/**
 * Aggregate OS summary — same schema as the bash helper's JSON output.
 * @returns {Promise<{
 *   os: string,
 *   distro_id: string,
 *   arch: string,
 *   pkg_mgr: string|null,
 *   keyring_backend: string|null,
 *   opener: string|null,
 *   shell: string,
 *   is_wsl: boolean,
 *   browser_profiles: string[]
 * }>}
 */
export async function osJson() {
  const release = parseEnvFile(safeRead("/etc/os-release"));
  return {
    os: osId(),
    distro_id: release.ID || "",
    arch: arch(),
    pkg_mgr: pkgMgr(),
    keyring_backend: keyringBackend(),
    opener: opener(),
    shell: shell(),
    is_wsl: isWsl(),
    browser_profiles: await browserProfileDirs(),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint: `node lib/os-detect.mjs` prints the full JSON report.
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
// Also handle symlinks and realpath differences that can trip the naive check.
const invokedViaRealpath =
  process.argv[1] &&
  import.meta.url === `file://${fileURLToPath(import.meta.url)}`.replace(
    /^file:\/\//,
    "file://",
  ) &&
  process.argv[1].endsWith("os-detect.mjs");

if (invokedDirectly || invokedViaRealpath) {
  const obj = await osJson();
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
