#!/usr/bin/env node
/**
 * ops-slack-autolink — extract Slack XOXC and XOXD tokens via Playwright.
 *
 * Ported from maorfr/slack-token-extractor (Python/Playwright) to keep the
 * claude-ops plugin pure-Node. Launches a persistent-profile Chromium with
 * Playwright, navigates to the user's Slack workspace, prompts them to log
 * in if needed, then pulls the xoxc- user token from localStorage and the
 * d= (xoxd-...) cookie from the browser cookie jar.
 *
 * Usage:
 *   ops-slack-autolink [--workspace URL] [--headless] [--profile-dir DIR]
 *
 * Options:
 *   --workspace     Slack workspace URL (default: https://app.slack.com/client/)
 *   --headless      Run headless (only works if profile already has a session)
 *   --profile-dir   Persistent browser profile dir (default: ~/.claude-ops/slack-profile)
 *   --ready-file    File to touch when login is complete (default: /tmp/slack-login-done)
 *   --scout-only    Only scan existing locations for tokens; don't launch browser
 *
 * Bridge protocol (stderr, one JSON event per line):
 *   {"type": "phase", "phase": 1 | 2, "message": "..."}
 *   {"type": "found", "source": "...", "xoxc_token": "...", "xoxd_token": "..."}
 *   {"type": "need_login", "message": "...", "ready_file": "..."}
 *   {"type": "error", "message": "..."}
 *
 * Final result (stdout, one JSON line):
 *   {"xoxc_token": "xoxc-...", "xoxd_token": "xoxd-...", "team_id": "T...", "source": "scout|playwright"}
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import {
  osId,
  isWsl,
  browserProfileDirs,
} from "../lib/os-detect.mjs";
import {
  setCredential,
  getCredential,
  deleteCredential,
  backendsAvailable,
} from "../lib/credential-store.mjs";

const OS_ID = osId();
const IS_WSL = isWsl();
const USER_ACCOUNT =
  userInfo().username || process.env.USER || process.env.USERNAME || "default";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "https://app.slack.com/client/" },
    headless: { type: "boolean", default: false },
    "profile-dir": {
      type: "string",
      default: join(homedir(), ".claude-ops", "slack-profile"),
    },
    "ready-file": { type: "string", default: "/tmp/slack-login-done" },
    "scout-only": { type: "boolean", default: false },
  },
});

const WORKSPACE = values.workspace;
const HEADLESS = values.headless;
const PROFILE_DIR = values["profile-dir"];
const READY_FILE = values["ready-file"];
const SCOUT_ONLY = values["scout-only"];

function emit(event) {
  process.stderr.write(JSON.stringify(event) + "\n");
}
function die(msg, extra = {}) {
  emit({ type: "error", message: msg, ...extra });
  process.exit(1);
}

// Validate --workspace before anything uses it — must be https:// and a *.slack.com host.
// Prevents file://, data:, chrome:// schemes that could load local state and poison
// localStorage-based token extraction.
function validateWorkspaceURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    die(`--workspace is not a valid URL: ${e.message}`, { raw });
  }
  if (u.protocol !== "https:")
    die(`--workspace must use https:// (got ${u.protocol})`, { raw });
  const host = u.hostname.toLowerCase();
  if (host !== "slack.com" && !host.endsWith(".slack.com")) {
    die(
      `--workspace hostname must be slack.com or a *.slack.com subdomain (got ${host})`,
      { raw },
    );
  }
  return u.toString();
}
const WORKSPACE_VALIDATED = validateWorkspaceURL(WORKSPACE);

// --- Phase 1: scout existing locations for already-extracted tokens ---
emit({
  type: "phase",
  phase: 1,
  message: "Scouting for existing Slack tokens",
});

async function scoutSources() {
  const sources = [];

  // 1. ~/.claude.json mcpServers.slack.env — where Claude Code stores them
  const claudeJson = join(homedir(), ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJson, "utf8"));
      const env = parsed?.mcpServers?.slack?.env;
      if (env) {
        const xoxc = env.SLACK_MCP_XOXC_TOKEN || env.SLACK_BOT_TOKEN;
        const xoxd = env.SLACK_MCP_XOXD_TOKEN;
        if (
          xoxc &&
          xoxc.startsWith("xoxc-") &&
          xoxd &&
          xoxd.startsWith("xoxd-")
        ) {
          sources.push({
            source: "claude.json:mcpServers.slack",
            xoxc_token: xoxc,
            xoxd_token: xoxd,
          });
        }
      }
    } catch {}
  }

  // 2. Shell env (live process)
  const envXoxc =
    process.env.SLACK_MCP_XOXC_TOKEN || process.env.SLACK_BOT_TOKEN;
  const envXoxd = process.env.SLACK_MCP_XOXD_TOKEN;
  if (envXoxc?.startsWith("xoxc-") && envXoxd?.startsWith("xoxd-")) {
    sources.push({
      source: "process.env",
      xoxc_token: envXoxc,
      xoxd_token: envXoxd,
    });
  }

  // 3. OS-native credential store (macOS Keychain, Linux libsecret, Windows
  //    credential manager — cmdkey on Windows can't read, so it's skipped).
  //    Items are stored under service=slack-xoxc / slack-xoxd, account=$USER.
  try {
    const xoxcHit = await getCredential("slack-xoxc", USER_ACCOUNT);
    const xoxdHit = await getCredential("slack-xoxd", USER_ACCOUNT);
    const xoxc = xoxcHit?.secret;
    const xoxd = xoxdHit?.secret;
    if (xoxc?.startsWith("xoxc-") && xoxd?.startsWith("xoxd-")) {
      sources.push({
        source: `credential-store:${xoxcHit.backend}`,
        xoxc_token: xoxc,
        xoxd_token: xoxd,
      });
    }
  } catch {}

  // 4. Shell profile files (OS-aware)
  const profiles = [];
  if (OS_ID !== "windows") {
    // Unix-style shell profiles (macOS, Linux, WSL)
    profiles.push(
      ...[".zshrc", ".bashrc", ".zprofile", ".envrc"].map((f) =>
        join(homedir(), f),
      ),
    );
  }
  if (OS_ID === "windows" || IS_WSL) {
    // PowerShell profiles — check common canonical locations.
    //   $PROFILE on Windows typically resolves to:
    //     %USERPROFILE%\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
    //   PowerShell 7+ uses the "PowerShell" folder instead of "WindowsPowerShell".
    if (OS_ID === "windows") {
      const userProfile = process.env.USERPROFILE || homedir();
      profiles.push(
        join(
          userProfile,
          "Documents",
          "WindowsPowerShell",
          "Microsoft.PowerShell_profile.ps1",
        ),
        join(
          userProfile,
          "Documents",
          "PowerShell",
          "Microsoft.PowerShell_profile.ps1",
        ),
      );
    } else if (IS_WSL) {
      // Best-effort: check the Windows-side PowerShell profile from /mnt/c.
      const winUser = process.env.USER || process.env.USERNAME || "";
      if (winUser) {
        profiles.push(
          `/mnt/c/Users/${winUser}/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`,
          `/mnt/c/Users/${winUser}/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`,
        );
      }
    }
  }
  for (const path of profiles) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const xoxcMatch = text.match(
        /SLACK(?:_MCP)?_XOXC_TOKEN=["']?(xoxc-[^"'\s]+)/,
      );
      const xoxdMatch = text.match(
        /SLACK(?:_MCP)?_XOXD_TOKEN=["']?(xoxd-[^"'\s]+)/,
      );
      if (xoxcMatch && xoxdMatch) {
        sources.push({
          source: path,
          xoxc_token: xoxcMatch[1],
          xoxd_token: xoxdMatch[1],
        });
      }
    } catch {}
  }

  // 5. Doppler (if configured; cheap probe)
  try {
    const dopRaw = execSync(`doppler secrets --json 2>/dev/null`, {
      encoding: "utf8",
    });
    const dop = JSON.parse(dopRaw);
    const xoxc =
      dop?.SLACK_MCP_XOXC_TOKEN?.computed || dop?.SLACK_BOT_TOKEN?.computed;
    const xoxd = dop?.SLACK_MCP_XOXD_TOKEN?.computed;
    if (xoxc?.startsWith("xoxc-") && xoxd?.startsWith("xoxd-")) {
      sources.push({ source: "doppler", xoxc_token: xoxc, xoxd_token: xoxd });
    }
  } catch {}

  return sources;
}

const scouted = await scoutSources();
for (const s of scouted) {
  emit({
    type: "found",
    source: s.source,
    xoxc_preview: s.xoxc_token.slice(0, 10) + "..." + s.xoxc_token.slice(-4),
    xoxd_preview: s.xoxd_token.slice(0, 10) + "..." + s.xoxd_token.slice(-4),
  });
}

if (scouted.length > 0) {
  // Deduplicate: if multiple sources have the same value, prefer highest-priority
  const first = scouted[0];
  // Try to get team_id from ~/.claude.json too, if available
  let teamId = null;
  const claudeJson = join(homedir(), ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJson, "utf8"));
      teamId = parsed?.mcpServers?.slack?.env?.SLACK_MCP_TEAM_ID || null;
    } catch {}
  }
  process.stdout.write(
    JSON.stringify({
      xoxc_token: first.xoxc_token,
      xoxd_token: first.xoxd_token,
      team_id: teamId,
      source: `scout:${first.source}`,
    }) + "\n",
  );
  process.exit(0);
}

if (SCOUT_ONLY) {
  die("no existing Slack tokens found in any scouted location (--scout-only)");
}

// --- Phase 2: Playwright-based extraction ---
// Scan installed browsers for an existing Slack session cookie, then launch
// Playwright with those cookies pre-injected so no manual login is needed.
emit({
  type: "phase",
  phase: 2,
  message: "No scouted tokens — scanning browsers for Slack session",
});

import { tmpdir } from "node:os";
import { cpSync, readdirSync } from "node:fs";

/**
 * Map an absolute browser-profile directory to a friendly name. Uses path
 * substrings so it works uniformly across macOS/Linux/Windows conventions
 * (e.g. "Google/Chrome", "google-chrome", "Chrome\\User Data").
 */
function browserNameForDir(dir) {
  const d = dir.replace(/\\/g, "/").toLowerCase();
  if (d.includes("/google/chrome beta") || d.includes("chrome-beta"))
    return "Google Chrome Beta";
  if (d.includes("/google/chrome") || d.includes("google-chrome"))
    return "Google Chrome";
  if (d.includes("bravesoftware")) return "Brave";
  if (d.includes("/arc/")) return "Arc";
  if (d.includes("/chromium")) return "Chromium";
  if (d.includes("microsoft edge") || d.includes("edge/user data"))
    return "Microsoft Edge";
  if (d.includes("com.operasoftware.opera") || d.includes("/opera"))
    return "Opera";
  if (d.includes("/comet")) return "Comet";
  if (d.includes("/vivaldi")) return "Vivaldi";
  if (d.includes("/orion")) return "Orion";
  return basename(dir);
}

/**
 * Detect installed browser profiles that might contain Slack cookies.
 * Returns [{name, cookieDb, localStorageDir, userDataDir}] sorted by preference.
 *
 * On macOS we include several extra Chromium-forks (Edge/Opera/Vivaldi/Orion
 * /Comet), the Slack desktop app containers, Firefox, and Safari. On
 * Linux/Windows we rely on browserProfileDirs() for the canonical Chrome/
 * Chromium/Brave/Arc set, plus Firefox where applicable. Direct cookie
 * decryption below is still macOS-only; other platforms fall through to the
 * Playwright path.
 */
async function detectBrowserProfiles() {
  const home = homedir();
  const found = [];

  // --- Chromium-based browsers from the shared detector --------------------
  const chromiumDirs = (await browserProfileDirs()).map((dir) => ({
    name: browserNameForDir(dir),
    dir,
  }));

  // On macOS, also probe browsers that browserProfileDirs() doesn't cover
  // (Edge/Opera/Vivaldi/Orion/Comet/Chrome Beta). Keeps parity with the
  // pre-refactor behavior.
  if (OS_ID === "macos") {
    const appSupport = join(home, "Library", "Application Support");
    const extras = [
      { name: "Google Chrome Beta", dir: join(appSupport, "Google", "Chrome Beta") },
      { name: "Microsoft Edge", dir: join(appSupport, "Microsoft Edge") },
      { name: "Opera", dir: join(appSupport, "com.operasoftware.Opera") },
      { name: "Comet", dir: join(appSupport, "Comet") },
      { name: "Vivaldi", dir: join(appSupport, "Vivaldi") },
      { name: "Orion", dir: join(appSupport, "Orion") },
    ];
    for (const e of extras) {
      if (existsSync(e.dir) && !chromiumDirs.some((c) => c.dir === e.dir)) {
        chromiumDirs.push(e);
      }
    }
  }

  for (const { name, dir } of chromiumDirs) {
    const profiles = ["Default"];
    try {
      const entries = readdirSync(dir);
      for (const e of entries) {
        if (/^Profile \d+$/.test(e)) profiles.push(e);
      }
    } catch {
      continue;
    }

    for (const profile of profiles) {
      const cookieDb = join(dir, profile, "Cookies");
      const localStorageDir = join(dir, profile, "Local Storage", "leveldb");
      // Chrome/Chromium on some platforms store cookies under Network/Cookies
      const netCookieDb = join(dir, profile, "Network", "Cookies");
      const cookieDbFinal = existsSync(cookieDb)
        ? cookieDb
        : existsSync(netCookieDb)
          ? netCookieDb
          : null;
      if (cookieDbFinal) {
        found.push({
          name: `${name}/${profile}`,
          cookieDb: cookieDbFinal,
          localStorageDir,
          userDataDir: dir,
          profile,
        });
      }
    }
  }

  // --- Slack desktop app (macOS-only container layout) --------------------
  if (OS_ID === "macos") {
    const appSupport = join(home, "Library", "Application Support");
    const slackDesktopPaths = [
      // Mac App Store version (sandboxed)
      join(
        home,
        "Library",
        "Containers",
        "com.tinyspeck.slackmacgap",
        "Data",
        "Library",
        "Application Support",
        "Slack",
      ),
      // Direct download version (non-sandboxed)
      join(appSupport, "Slack"),
    ];
    for (const slackDir of slackDesktopPaths) {
      const cookieDb = join(slackDir, "Cookies");
      const localStorageDir = join(slackDir, "Local Storage", "leveldb");
      if (existsSync(cookieDb)) {
        found.unshift({
          name: "Slack Desktop",
          cookieDb,
          localStorageDir,
          userDataDir: slackDir,
          profile: ".",
        });
      }
    }
  }

  // --- Firefox (SQLite cookies.sqlite, unencrypted) -----------------------
  const firefoxDirs = [];
  if (OS_ID === "macos") {
    firefoxDirs.push(
      join(home, "Library", "Application Support", "Firefox", "Profiles"),
    );
  } else if (process.platform === "linux") {
    firefoxDirs.push(join(home, ".mozilla", "firefox"));
    if (IS_WSL) {
      const winUser = process.env.USER || process.env.USERNAME || "";
      if (winUser) {
        firefoxDirs.push(
          `/mnt/c/Users/${winUser}/AppData/Roaming/Mozilla/Firefox/Profiles`,
        );
      }
    }
  } else if (OS_ID === "windows") {
    const appData =
      process.env.APPDATA ||
      (process.env.USERPROFILE
        ? join(process.env.USERPROFILE, "AppData", "Roaming")
        : null);
    if (appData) {
      firefoxDirs.push(join(appData, "Mozilla", "Firefox", "Profiles"));
    }
  }
  for (const firefoxDir of firefoxDirs) {
    try {
      const profiles = readdirSync(firefoxDir);
      for (const p of profiles) {
        const cookieDb = join(firefoxDir, p, "cookies.sqlite");
        if (existsSync(cookieDb)) {
          found.push({
            name: `Firefox/${p}`,
            cookieDb,
            localStorageDir: null,
            userDataDir: join(firefoxDir, p),
            profile: p,
            isFirefox: true,
          });
        }
      }
    } catch {}
  }

  // --- Safari (macOS-only binary cookie file) -----------------------------
  if (OS_ID === "macos") {
    const safariCookies = join(
      home,
      "Library",
      "Cookies",
      "Cookies.binarycookies",
    );
    if (existsSync(safariCookies)) {
      found.push({
        name: "Safari",
        cookieDb: safariCookies,
        localStorageDir: null,
        userDataDir: null,
        profile: ".",
        isSafari: true,
      });
    }
  }

  return found;
}

/**
 * Query a cookie DB for the Slack 'd' cookie. Handles:
 * - Chromium/Electron SQLite (encrypted_value in 'cookies' table)
 * - Firefox SQLite (value in 'moz_cookies' table, unencrypted)
 * - Safari binary cookies (presence check only via file scan)
 * Returns the browser name if found, null otherwise.
 */
function querySlackCookieFromDb(cookieDb, browserName, opts = {}) {
  try {
    if (opts.isSafari) {
      // Safari uses Cookies.binarycookies — binary format. Check with strings.
      const result = execSync(
        `strings "${cookieDb}" 2>/dev/null | grep -c "slack.com"`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      return parseInt(result, 10) > 0 ? browserName : null;
    }

    if (opts.isFirefox) {
      // Firefox uses moz_cookies table with plaintext values
      const checkResult = execSync(
        `sqlite3 "${cookieDb}" "SELECT length(value) FROM moz_cookies WHERE host LIKE '%.slack.com' AND name = 'd' LIMIT 1;" 2>/dev/null`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      return checkResult && parseInt(checkResult, 10) > 0 ? browserName : null;
    }

    // Chromium / Electron — encrypted_value in 'cookies' table
    const checkResult = execSync(
      `sqlite3 "${cookieDb}" "SELECT length(encrypted_value) FROM cookies WHERE host_key LIKE '%.slack.com' AND name = 'd' LIMIT 1;" 2>/dev/null`,
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    return checkResult && parseInt(checkResult, 10) > 0 ? browserName : null;
  } catch {
    return null;
  }
}

const browserProfiles = await detectBrowserProfiles();
emit({
  type: "step",
  message: `Found ${browserProfiles.length} browser profile(s) to scan`,
});

let selectedBrowser = null;
for (const bp of browserProfiles) {
  const hasSlack = querySlackCookieFromDb(bp.cookieDb, bp.name, {
    isFirefox: bp.isFirefox,
    isSafari: bp.isSafari,
  });
  if (hasSlack) {
    emit({ type: "step", message: `✓ ${bp.name} has Slack cookies` });
    selectedBrowser = bp;
    break;
  } else {
    emit({ type: "step", message: `○ ${bp.name} — no Slack cookies` });
  }
}

// --- Direct cookie decryption (no Playwright needed for extraction) ---
import { createHash, pbkdf2Sync, createDecipheriv } from "node:crypto";

/**
 * Decrypt a Chromium encrypted cookie value on macOS.
 * Each Chromium app stores its key in the keychain as "<AppName> Safe Storage".
 * Encryption: PBKDF2(key, "saltysalt", 1003, 16) → AES-128-CBC with IV=16 spaces.
 * Encrypted values start with "v10" (3-byte prefix).
 */
function decryptChromiumCookie(encryptedHex, keychainService) {
  try {
    const masterKey = execSync(
      `security find-generic-password -w -s "${keychainService}" 2>/dev/null`,
      { encoding: "utf8" },
    ).trim();
    if (!masterKey) return null;

    const derivedKey = pbkdf2Sync(masterKey, "saltysalt", 1003, 16, "sha1");
    const encrypted = Buffer.from(encryptedHex, "hex");

    // Strip "v10" prefix (3 bytes)
    if (encrypted.length < 4) return null;
    const prefix = encrypted.slice(0, 3).toString("ascii");
    if (prefix !== "v10") return null;
    const ciphertext = encrypted.slice(3);

    const iv = Buffer.alloc(16, " ");
    const decipher = createDecipheriv("aes-128-cbc", derivedKey, iv);
    decipher.setAutoPadding(false);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Remove PKCS7 padding manually
    const padLen = decrypted[decrypted.length - 1];
    if (padLen > 0 && padLen <= 16) {
      decrypted = decrypted.slice(0, decrypted.length - padLen);
    }

    // Chrome v130+ prepends a 32-byte SHA256 domain hash before the value.
    // The real cookie value is URL-encoded ASCII text.
    const raw = decrypted.toString("latin1");
    // The 'd' cookie value is URL-encoded (contains %2B, %2F, %3D etc.)
    // Find the longest URL-encoded chunk — that's the real value.
    const allMatches = [...raw.matchAll(/[A-Za-z0-9%+/=_-]{30,}/g)];
    if (allMatches.length > 0) {
      // Pick the longest match (the domain hash is 32 bytes of binary, not ASCII)
      return allMatches.sort((a, b) => b[0].length - a[0].length)[0][0];
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Map browser name to its keychain Safe Storage service name.
 */
function keychainServiceFor(browserName) {
  const name = browserName.split("/")[0]; // strip "/Default" etc.
  const map = {
    "Google Chrome": "Chrome Safe Storage",
    "Google Chrome Beta": "Chrome Beta Safe Storage",
    Comet: "Comet Safe Storage",
    Arc: "Arc Safe Storage",
    Brave: "Brave Safe Storage",
    "Microsoft Edge": "Microsoft Edge Safe Storage",
    Chromium: "Chromium Safe Storage",
    Opera: "Opera Safe Storage",
    Vivaldi: "Vivaldi Safe Storage",
    Orion: "Orion Safe Storage",
    "Slack Desktop": "Slack Safe Storage",
  };
  return map[name] || `${name} Safe Storage`;
}

/**
 * Extract the xoxc token from a Chromium localStorage leveldb.
 * Uses classic-level for proper LevelDB reading (raw file scanning
 * breaks on LevelDB's internal binary framing).
 * Falls back to raw file scanning if classic-level is unavailable.
 */
async function extractXoxcFromLocalStorage(localStorageDir) {
  if (!localStorageDir || !existsSync(localStorageDir)) return null;

  // Try proper LevelDB reading first
  try {
    const { ClassicLevel } = await import("classic-level");
    // Copy to temp to avoid lock conflicts with running browser
    const tmpCopy = join(tmpdir(), `ops-slack-ls-${Date.now()}`);
    cpSync(localStorageDir, tmpCopy, { recursive: true });
    // Remove LOCK file so we can open read-only
    try {
      unlinkSync(join(tmpCopy, "LOCK"));
    } catch {}

    const db = new ClassicLevel(tmpCopy, {
      createIfMissing: false,
      valueEncoding: "utf8",
      keyEncoding: "utf8",
    });
    await db.open({ readOnly: true });

    let token = null;
    for await (const [, value] of db.iterator()) {
      if (value && value.includes("xoxc-")) {
        const m = value.match(/xoxc-[0-9a-zA-Z._-]+/);
        if (m && m[0].length > 20) {
          token = m[0];
          break;
        }
      }
    }
    await db.close();
    // Clean up temp copy
    try {
      execSync(`rm -rf "${tmpCopy}"`, { timeout: 5000 });
    } catch {}
    if (token) return token;
  } catch {}

  // Fallback: raw file scanning (less reliable due to LevelDB binary framing)
  try {
    const files = readdirSync(localStorageDir).filter(
      (f) => f.endsWith(".ldb") || f.endsWith(".log"),
    );
    for (const f of files) {
      try {
        const data = readFileSync(join(localStorageDir, f));
        const text = data.toString("latin1");
        const match = text.match(/xoxc-[0-9A-Za-z._-]+/);
        if (match && match[0].length > 20) return match[0];
      } catch {}
    }
  } catch {}
  return null;
}

// --- Try direct extraction if we found a browser with cookies ---
if (selectedBrowser && !selectedBrowser.isSafari) {
  emit({
    type: "step",
    message: `Attempting direct cookie decryption from ${selectedBrowser.name}`,
  });

  const keychainSvc = keychainServiceFor(selectedBrowser.name);

  // Extract and decrypt the 'd' cookie
  let xoxdToken = null;
  if (selectedBrowser.isFirefox) {
    // Firefox cookies are plaintext
    try {
      xoxdToken = execSync(
        `sqlite3 "${selectedBrowser.cookieDb}" "SELECT value FROM moz_cookies WHERE host LIKE '%.slack.com' AND name = 'd' LIMIT 1;" 2>/dev/null`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
    } catch {}
  } else {
    // Chromium — read encrypted value as hex, decrypt
    try {
      const hexValue = execSync(
        `sqlite3 "${selectedBrowser.cookieDb}" "SELECT hex(encrypted_value) FROM cookies WHERE host_key LIKE '%.slack.com' AND name = 'd' LIMIT 1;" 2>/dev/null`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (hexValue) {
        xoxdToken = decryptChromiumCookie(hexValue, keychainSvc);
      }
    } catch {}
  }

  if (xoxdToken) {
    // Clean up: if decrypted value contains an embedded xoxd-, extract from there
    const xoxdIdx = xoxdToken.lastIndexOf("xoxd-");
    if (xoxdIdx > 0) {
      xoxdToken = xoxdToken.slice(xoxdIdx);
    } else if (!xoxdToken.startsWith("xoxd-")) {
      xoxdToken = `xoxd-${xoxdToken}`;
    }
    emit({
      type: "step",
      message: `✓ Decrypted 'd' cookie (${xoxdToken.slice(0, 10)}...${xoxdToken.slice(-4)})`,
    });

    // Extract xoxc from localStorage
    const xoxcToken = await extractXoxcFromLocalStorage(
      selectedBrowser.localStorageDir,
    );
    if (xoxcToken) {
      emit({
        type: "step",
        message: `✓ Found xoxc token from localStorage (${xoxcToken.slice(0, 10)}...${xoxcToken.slice(-4)})`,
      });

      // Extract team ID from localStorage or xoxc pattern
      let teamId = null;
      if (selectedBrowser.localStorageDir) {
        try {
          const files = readdirSync(selectedBrowser.localStorageDir).filter(
            (f) => f.endsWith(".ldb") || f.endsWith(".log"),
          );
          for (const f of files) {
            try {
              const data = readFileSync(
                join(selectedBrowser.localStorageDir, f),
                "latin1",
              );
              const m = data.match(/"team_id"\s*:\s*"(T[A-Z0-9]+)"/);
              if (m) {
                teamId = m[1];
                break;
              }
            } catch {}
          }
        } catch {}
      }

      // Validate tokens against Slack API
      emit({ type: "step", message: "Validating tokens against Slack API..." });
      let authResult = null;
      try {
        const res = await fetch("https://slack.com/api/auth.test", {
          headers: {
            Authorization: `Bearer ${xoxcToken}`,
            Cookie: `d=${xoxdToken}`,
          },
        });
        authResult = await res.json();
      } catch {}

      if (authResult?.ok) {
        teamId = authResult.team_id || teamId;
        emit({
          type: "step",
          message: `✓ Validated — ${authResult.url} (${authResult.team_id})`,
        });
      } else {
        emit({
          type: "step",
          message: `⚠ Validation failed: ${authResult?.error || "unknown"} — tokens may be stale`,
        });
      }

      // Persist via cascading credential store (macOS Keychain → libsecret →
      // Windows Credential Manager → keytar → encrypted JSON → plaintext).
      try {
        const xoxcRes = await setCredential(
          "slack-xoxc",
          USER_ACCOUNT,
          xoxcToken,
        );
        const xoxdRes = await setCredential(
          "slack-xoxd",
          USER_ACCOUNT,
          xoxdToken,
        );
        if (xoxcRes.ok && xoxdRes.ok) {
          emit({
            type: "step",
            message: `✓ Saved tokens via credential-store (${xoxcRes.backend})`,
          });
        } else {
          emit({
            type: "step",
            message: `○ Credential-store save partial: xoxc=${xoxcRes.backend}/${xoxcRes.ok} xoxd=${xoxdRes.backend}/${xoxdRes.ok}`,
          });
        }
      } catch (e) {
        emit({
          type: "step",
          message: `○ Credential-store save failed: ${e.message}`,
        });
      }

      // Register Slack MCP server in Claude Code (fully automated)
      try {
        execSync(
          `claude mcp add slack -s user -e SLACK_XOXC_TOKEN='${xoxcToken.replace(/'/g, "'\\''")}'` +
            ` -e SLACK_XOXD_TOKEN='${xoxdToken.replace(/'/g, "'\\''")}'` +
            ` -- npx -y @anthropic-ai/slack-mcp@latest`,
          { timeout: 15000, stdio: "pipe" },
        );
        emit({
          type: "step",
          message: "✓ Registered Slack MCP server in Claude Code",
        });
      } catch {
        emit({
          type: "step",
          message: "○ Could not auto-register MCP — run: claude mcp add slack",
        });
      }

      // Success — emit result
      process.stdout.write(
        JSON.stringify({
          xoxc_token: xoxcToken,
          xoxd_token: xoxdToken,
          team_id: teamId,
          source: `direct:${selectedBrowser.name}`,
        }) + "\n",
      );
      process.exit(0);
    } else {
      emit({
        type: "step",
        message: `○ Could not find xoxc in localStorage — falling back to Playwright`,
      });
    }
  } else {
    emit({
      type: "step",
      message: `○ Could not decrypt cookie from ${selectedBrowser.name} — falling back to Playwright`,
    });
  }
}

// --- Playwright fallback (only if direct extraction failed) ---
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  die(
    "playwright is not installed and direct cookie extraction failed. Run `npm install playwright` in the plugin root and `npx playwright install chromium`.",
  );
}

// Resolve the Playwright persistent-profile directory.
//
// If the user explicitly passed --profile-dir, honor it. Otherwise prefer the
// first real Chrome/Chromium profile discovered by browserProfileDirs() so we
// inherit an existing login where possible. Fall back to a per-user dir under
// $XDG_DATA_HOME (or ~/.local/share on Linux/macOS, or the default elsewhere).
async function resolvePlaywrightProfileDir() {
  // --profile-dir was explicitly provided and differs from the library default?
  const libDefault = join(homedir(), ".claude-ops", "slack-profile");
  if (PROFILE_DIR && PROFILE_DIR !== libDefault) return PROFILE_DIR;

  try {
    const dirs = await browserProfileDirs();
    const chromeDir = dirs.find((d) => {
      const low = d.replace(/\\/g, "/").toLowerCase();
      return low.includes("chrome") || low.includes("chromium");
    });
    if (chromeDir) return chromeDir;
  } catch {}

  // Nothing pre-existing — use an XDG-compliant fresh profile.
  const xdgData =
    process.env.XDG_DATA_HOME ||
    join(homedir(), ".local", "share");
  return join(xdgData, "claude-ops", "chromium-profile");
}

const LAUNCH_PROFILE_DIR = await resolvePlaywrightProfileDir();
mkdirSync(LAUNCH_PROFILE_DIR, { recursive: true });
emit({
  type: "step",
  message: `Launching Chromium (headless=${HEADLESS}, profile=${LAUNCH_PROFILE_DIR})`,
});

let context;
try {
  context = await chromium.launchPersistentContext(LAUNCH_PROFILE_DIR, {
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
  });
} catch (err) {
  // Common on headless Linux hosts / CI sandboxes where no $DISPLAY exists
  // and Playwright's Chromium cannot attach to a windowing system.
  const msg = String(err?.message || err);
  const looksHeadlessy =
    /missing (x server|display)|\$DISPLAY|xcb|cannot open display|no protocol specified|Host system is missing dependencies/i.test(
      msg,
    );
  if (looksHeadlessy || !HEADLESS) {
    emit({
      type: "error",
      message:
        "no display available — run ops:setup slack on a machine with a desktop environment",
      os: OS_ID,
      headless_available: false,
      detail: msg,
    });
    process.exit(1);
  }
  die(`playwright launch failed: ${msg}`);
}

const page = context.pages()[0] || (await context.newPage());

try {
  emit({ type: "step", message: `Navigating to ${WORKSPACE_VALIDATED}` });
  await page.goto(WORKSPACE_VALIDATED);
  try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
  } catch {}

  const currentUrl = page.url();
  if (/signin|sign_in|ssb\/signin/i.test(currentUrl)) {
    if (HEADLESS) {
      die(
        "Not logged in and running headless. Run without --headless first to establish a session in the profile dir.",
      );
    }
    emit({
      type: "need_login",
      message:
        "Log in to Slack in the open Chromium window, then touch the ready-file to continue",
      ready_file: READY_FILE,
    });
    // Wait for the caller to touch READY_FILE once the user finishes login
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      if (existsSync(READY_FILE)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!existsSync(READY_FILE)) die("timeout waiting for login completion");
    try {
      await page.waitForURL(/\/client\//, { timeout: 15_000 });
    } catch {}
    try {
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
    } catch {}
  }

  // Extract team ID
  let teamId = null;
  const urlMatch = page.url().match(/\/client\/([A-Z0-9]+)/);
  if (urlMatch) teamId = urlMatch[1];
  if (!teamId) {
    teamId = await page.evaluate(() => {
      try {
        const cfg = JSON.parse(localStorage.localConfig_v2 || "{}");
        return Object.keys(cfg.teams || {})[0] || null;
      } catch {
        return null;
      }
    });
  }
  if (!teamId)
    die(
      "Could not determine Slack team ID — make sure you're viewing a workspace",
    );
  emit({ type: "step", message: `Found team_id=${teamId}` });

  // Extract XOXC from localStorage
  let xoxcToken = await page.evaluate((tid) => {
    try {
      const cfg = JSON.parse(localStorage.localConfig_v2 || "{}");
      if (cfg.teams?.[tid]?.token) return cfg.teams[tid].token;
      for (const [, data] of Object.entries(cfg.teams || {})) {
        if (data?.token?.startsWith("xoxc-")) return data.token;
      }
      return null;
    } catch {
      return null;
    }
  }, teamId);
  if (!xoxcToken) {
    // fallback: regex scan of inline JS
    xoxcToken = await page.evaluate(() => {
      const m = document.body.innerHTML.match(/"token":"(xoxc-[^"]+)"/);
      return m ? m[1] : null;
    });
  }
  if (!xoxcToken)
    die("Could not find XOXC token — ensure the workspace is fully loaded");

  // Extract XOXD ('d' cookie) from the context cookie jar
  const cookies = await context.cookies();
  const dCookie = cookies.find(
    (c) => c.name === "d" && /slack\.com/.test(c.domain),
  );
  if (!dCookie) die("Could not find 'd' cookie (XOXD token)");
  const xoxdToken = dCookie.value.startsWith("xoxd-")
    ? dCookie.value
    : `xoxd-${dCookie.value}`;

  await context.close();

  process.stdout.write(
    JSON.stringify({
      xoxc_token: xoxcToken,
      xoxd_token: xoxdToken,
      team_id: teamId,
      source: "playwright",
    }) + "\n",
  );
  process.exit(0);
} catch (err) {
  try {
    await context.close();
  } catch {}
  die(`playwright extraction failed: ${err.message}`);
}
