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
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "https://app.slack.com/client/" },
    headless: { type: "boolean", default: false },
    "profile-dir": { type: "string", default: join(homedir(), ".claude-ops", "slack-profile") },
    "ready-file": { type: "string", default: "/tmp/slack-login-done" },
    "scout-only": { type: "boolean", default: false },
  },
});

const WORKSPACE = values.workspace;
const HEADLESS = values.headless;
const PROFILE_DIR = values["profile-dir"];
const READY_FILE = values["ready-file"];
const SCOUT_ONLY = values["scout-only"];

function emit(event) { process.stderr.write(JSON.stringify(event) + "\n"); }
function die(msg, extra = {}) { emit({ type: "error", message: msg, ...extra }); process.exit(1); }

// Validate --workspace before anything uses it — must be https:// and a *.slack.com host.
// Prevents file://, data:, chrome:// schemes that could load local state and poison
// localStorage-based token extraction.
function validateWorkspaceURL(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { die(`--workspace is not a valid URL: ${e.message}`, { raw }); }
  if (u.protocol !== "https:") die(`--workspace must use https:// (got ${u.protocol})`, { raw });
  const host = u.hostname.toLowerCase();
  if (host !== "slack.com" && !host.endsWith(".slack.com")) {
    die(`--workspace hostname must be slack.com or a *.slack.com subdomain (got ${host})`, { raw });
  }
  return u.toString();
}
const WORKSPACE_VALIDATED = validateWorkspaceURL(WORKSPACE);

// --- Phase 1: scout existing locations for already-extracted tokens ---
emit({ type: "phase", phase: 1, message: "Scouting for existing Slack tokens" });

function scoutSources() {
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
        if (xoxc && xoxc.startsWith("xoxc-") && xoxd && xoxd.startsWith("xoxd-")) {
          sources.push({ source: "claude.json:mcpServers.slack", xoxc_token: xoxc, xoxd_token: xoxd });
        }
      }
    } catch {}
  }

  // 2. Shell env (live process)
  const envXoxc = process.env.SLACK_MCP_XOXC_TOKEN || process.env.SLACK_BOT_TOKEN;
  const envXoxd = process.env.SLACK_MCP_XOXD_TOKEN;
  if (envXoxc?.startsWith("xoxc-") && envXoxd?.startsWith("xoxd-")) {
    sources.push({ source: "process.env", xoxc_token: envXoxc, xoxd_token: envXoxd });
  }

  // 3. macOS keychain (generic password items named slack-xoxc / slack-xoxd)
  if (process.platform === "darwin") {
    try {
      const xoxc = execSync(`security find-generic-password -s slack-xoxc -w 2>/dev/null`, { encoding: "utf8" }).trim();
      const xoxd = execSync(`security find-generic-password -s slack-xoxd -w 2>/dev/null`, { encoding: "utf8" }).trim();
      if (xoxc?.startsWith("xoxc-") && xoxd?.startsWith("xoxd-")) {
        sources.push({ source: "keychain", xoxc_token: xoxc, xoxd_token: xoxd });
      }
    } catch {}
  }

  // 4. Shell profile files
  const profiles = [".zshrc", ".bashrc", ".zprofile", ".envrc"].map(f => join(homedir(), f));
  for (const path of profiles) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const xoxcMatch = text.match(/SLACK(?:_MCP)?_XOXC_TOKEN=["']?(xoxc-[^"'\s]+)/);
      const xoxdMatch = text.match(/SLACK(?:_MCP)?_XOXD_TOKEN=["']?(xoxd-[^"'\s]+)/);
      if (xoxcMatch && xoxdMatch) {
        sources.push({ source: path, xoxc_token: xoxcMatch[1], xoxd_token: xoxdMatch[1] });
      }
    } catch {}
  }

  // 5. Doppler (if configured; cheap probe)
  try {
    const dopRaw = execSync(`doppler secrets --json 2>/dev/null`, { encoding: "utf8" });
    const dop = JSON.parse(dopRaw);
    const xoxc = dop?.SLACK_MCP_XOXC_TOKEN?.computed || dop?.SLACK_BOT_TOKEN?.computed;
    const xoxd = dop?.SLACK_MCP_XOXD_TOKEN?.computed;
    if (xoxc?.startsWith("xoxc-") && xoxd?.startsWith("xoxd-")) {
      sources.push({ source: "doppler", xoxc_token: xoxc, xoxd_token: xoxd });
    }
  } catch {}

  return sources;
}

const scouted = scoutSources();
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
  process.stdout.write(JSON.stringify({
    xoxc_token: first.xoxc_token,
    xoxd_token: first.xoxd_token,
    team_id: teamId,
    source: `scout:${first.source}`,
  }) + "\n");
  process.exit(0);
}

if (SCOUT_ONLY) {
  die("no existing Slack tokens found in any scouted location (--scout-only)");
}

// --- Phase 2: Playwright-based extraction ---
emit({ type: "phase", phase: 2, message: "No scouted tokens — launching Playwright to extract" });

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  die("playwright is not installed. Run `npm install playwright` in the plugin's telegram-server/ directory and `npx playwright install chromium`.");
}

mkdirSync(PROFILE_DIR, { recursive: true });
emit({ type: "step", message: `Launching Chromium (headless=${HEADLESS}, profile=${PROFILE_DIR})` });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  viewport: { width: 1280, height: 800 },
});

const page = context.pages()[0] || await context.newPage();

try {
  emit({ type: "step", message: `Navigating to ${WORKSPACE_VALIDATED}` });
  await page.goto(WORKSPACE_VALIDATED);
  try { await page.waitForLoadState("networkidle", { timeout: 30_000 }); } catch {}

  const currentUrl = page.url();
  if (/signin|sign_in|ssb\/signin/i.test(currentUrl)) {
    if (HEADLESS) {
      die("Not logged in and running headless. Run without --headless first to establish a session in the profile dir.");
    }
    emit({
      type: "need_login",
      message: "Log in to Slack in the open Chromium window, then touch the ready-file to continue",
      ready_file: READY_FILE,
    });
    // Wait for the caller to touch READY_FILE once the user finishes login
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      if (existsSync(READY_FILE)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!existsSync(READY_FILE)) die("timeout waiting for login completion");
    try { await page.waitForURL(/\/client\//, { timeout: 15_000 }); } catch {}
    try { await page.waitForLoadState("networkidle", { timeout: 30_000 }); } catch {}
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
      } catch { return null; }
    });
  }
  if (!teamId) die("Could not determine Slack team ID — make sure you're viewing a workspace");
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
    } catch { return null; }
  }, teamId);
  if (!xoxcToken) {
    // fallback: regex scan of inline JS
    xoxcToken = await page.evaluate(() => {
      const m = document.body.innerHTML.match(/"token":"(xoxc-[^"]+)"/);
      return m ? m[1] : null;
    });
  }
  if (!xoxcToken) die("Could not find XOXC token — ensure the workspace is fully loaded");

  // Extract XOXD ('d' cookie) from the context cookie jar
  const cookies = await context.cookies();
  const dCookie = cookies.find((c) => c.name === "d" && /slack\.com/.test(c.domain));
  if (!dCookie) die("Could not find 'd' cookie (XOXD token)");
  const xoxdToken = dCookie.value.startsWith("xoxd-") ? dCookie.value : `xoxd-${dCookie.value}`;

  await context.close();

  process.stdout.write(JSON.stringify({
    xoxc_token: xoxcToken,
    xoxd_token: xoxdToken,
    team_id: teamId,
    source: "playwright",
  }) + "\n");
  process.exit(0);
} catch (err) {
  try { await context.close(); } catch {}
  die(`playwright extraction failed: ${err.message}`);
}
