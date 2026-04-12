#!/usr/bin/env node
/**
 * ops-telegram-autolink — extract api_id / api_hash from my.telegram.org
 * and generate a gram.js session string, producing a ready-to-paste
 * user_config block for the claude-ops plugin's Telegram MCP.
 *
 * NO BROWSER required. my.telegram.org uses plain HTML form posts + session
 * cookies, so this works over pure HTTP. Much simpler and faster than the
 * Playwright approach.
 *
 * Usage:
 *   ops-telegram-autolink --phone +15551234567 [options]
 *
 * Options:
 *   --phone        E.164 phone number (required)
 *   --app-title    Label for the Telegram app entry (default: "claude-ops")
 *   --app-short    Short name for the app entry (default: "claude_ops")
 *   --skip-session Skip gram.js session generation (only extract api_id/hash)
 *   --code-file    File path to read codes from (default: /tmp/telegram-code.txt)
 *
 * Bridge protocol:
 *   Progress/prompts → stderr as single-line JSON events:
 *     {"type": "phase", ...}
 *     {"type": "step", ...}
 *     {"type": "need_code", "channel": "web_login" | "gram_auth", ...}
 *     {"type": "error", "message": "..."}
 *   Final result   → stdout as single-line JSON:
 *     {"api_id": "...", "api_hash": "...", "phone": "...", "session": "..."}
 *
 *   When the caller sees a need_code event, it should prompt the user for
 *   the code from Telegram and write it (digits only) to the file in
 *   --code-file. The script polls the file every 2s, unlinks it after read.
 *
 * Depends on: telegram (gram.js). No cheerio — selectors are extracted via
 * simple regex to keep the dep footprint minimal.
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const { values } = parseArgs({
  options: {
    phone: { type: "string" },
    "app-title": { type: "string", default: "claude-ops" },
    "app-short": { type: "string", default: "claude_ops" },
    "skip-session": { type: "boolean", default: false },
    "code-file": { type: "string", default: "/tmp/telegram-code.txt" },
  },
});

const PHONE = values.phone;
const APP_TITLE = values["app-title"];
const APP_SHORT = values["app-short"];
const SKIP_SESSION = values["skip-session"];
const CODE_FILE = values["code-file"];

function emit(event) {
  process.stderr.write(JSON.stringify(event) + "\n");
}

function die(message, extra = {}) {
  emit({ type: "error", message, ...extra });
  process.exit(1);
}

if (!PHONE || !/^\+\d{7,15}$/.test(PHONE)) {
  die("missing or invalid --phone (E.164 required, e.g. +15551234567)");
}

if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);

/**
 * Wait for the bridge file to appear with a valid code, then consume it.
 */
async function waitForCode(maxSec = 300) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < maxSec * 1000) {
    if (existsSync(CODE_FILE)) {
      const raw = readFileSync(CODE_FILE, "utf8").trim();
      if (/^[\w]{3,20}$/.test(raw)) {
        try {
          unlinkSync(CODE_FILE);
        } catch {}
        return raw;
      }
    }
    if (Date.now() - lastLog > 15000) {
      emit({
        type: "heartbeat",
        waited_s: Math.floor((Date.now() - start) / 1000),
      });
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(`timeout waiting for code file at ${CODE_FILE}`);
}

/**
 * Simple cookie jar — just enough to keep the my.telegram.org session.
 */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  update(response) {
    const raw = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const c of raw || []) {
      const [kv] = c.split(";");
      const eq = kv.indexOf("=");
      if (eq > 0)
        this.cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  header() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

// --- Phase 1: my.telegram.org HTTP flow ---
emit({
  type: "phase",
  phase: 1,
  message: "Extracting api_id / api_hash from my.telegram.org",
});

const jar = new CookieJar();
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function httpPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: jar.header(),
      Referer: "https://my.telegram.org/auth",
      Origin: "https://my.telegram.org",
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
  jar.update(res);
  return res;
}

async function httpGet(url) {
  const res = await fetch(url, {
    headers: { ...COMMON_HEADERS, Cookie: jar.header() },
    redirect: "manual",
  });
  jar.update(res);
  return res;
}

// Step 1.1: request a login code for PHONE
emit({ type: "step", message: `POST /auth/send_password for ${PHONE}` });
const sendRes = await httpPost("https://my.telegram.org/auth/send_password", {
  phone: PHONE,
});
const sendText = await sendRes.text();
if (sendText.includes("Sorry, too many tries")) {
  die("my.telegram.org rate-limited your account. Wait ~8 hours and retry.");
}
let randomHash;
try {
  const parsed = JSON.parse(sendText);
  randomHash = parsed.random_hash;
  if (!randomHash) throw new Error("no random_hash in response");
} catch (e) {
  die("send_password response was not valid JSON", {
    body: sendText.slice(0, 200),
  });
}
emit({
  type: "step",
  message: "Telegram has sent a code to your Telegram account",
});

// Step 1.2: wait for code from the bridge
emit({
  type: "need_code",
  channel: "web_login",
  message: `Enter the code from Telegram → write it to ${CODE_FILE}`,
  code_file: CODE_FILE,
});
const webCode = await waitForCode(300);

// Step 1.3: POST login with phone + random_hash + password=code
emit({ type: "step", message: "POST /auth/login" });
const loginRes = await httpPost("https://my.telegram.org/auth/login", {
  phone: PHONE,
  random_hash: randomHash,
  password: webCode,
});
const loginBody = await loginRes.text();
if (loginBody && /error|invalid|wrong/i.test(loginBody)) {
  die(`login rejected: ${loginBody.slice(0, 150)}`);
}

// Step 1.4: GET /apps to see if an app already exists
emit({ type: "step", message: "GET /apps" });
let appsRes = await httpGet("https://my.telegram.org/apps");
let appsHtml = await appsRes.text();

// Parse selectors based on esfelurm/Apis-Telegram reference:
//   <label>App api_id:</label> ... <div>...<span>12345678</span>...
// Works as long as my.telegram.org keeps its server-side HTML shape.
function extract(html) {
  const idMatch = html.match(
    /App api_id[^<]*<\/label>[\s\S]*?<span[^>]*>\s*(\d{5,12})\s*<\/span>/i,
  );
  const hashMatch = html.match(
    /App api_hash[^<]*<\/label>[\s\S]*?<span[^>]*>\s*([a-f0-9]{32})\s*<\/span>/i,
  );
  // Fallback: plain code tags sometimes used
  const altHash = html.match(/api_hash[^<]*<[^>]+>\s*([a-f0-9]{32})/i);
  return {
    apiId: idMatch ? idMatch[1] : null,
    apiHash: hashMatch ? hashMatch[1] : altHash ? altHash[1] : null,
  };
}

let { apiId, apiHash } = extract(appsHtml);

if (!apiId || !apiHash) {
  // Step 1.5: no app exists → create one
  emit({ type: "step", message: "No existing app — creating one" });
  // Extract CSRF token / hash value from the create-app form if present
  const hashInput = appsHtml.match(
    /name=['"]hash['"]\s+value=['"]([a-z0-9]+)['"]/i,
  );
  const createParams = {
    hash: hashInput ? hashInput[1] : "",
    app_title: APP_TITLE,
    app_shortname: APP_SHORT,
    app_url: "https://github.com/claude-ops-marketplace/claude-ops",
    app_platform: "desktop",
    app_desc: "claude-ops — automated operations for Claude Code",
  };
  const createRes = await httpPost(
    "https://my.telegram.org/apps/create",
    createParams,
  );
  const createBody = await createRes.text();
  if (createRes.status >= 400 || /error/i.test(createBody.slice(0, 200))) {
    die(`/apps/create failed (HTTP ${createRes.status})`, {
      body: createBody.slice(0, 200),
    });
  }
  // Re-fetch the apps page now that an app exists
  appsRes = await httpGet("https://my.telegram.org/apps");
  appsHtml = await appsRes.text();
  ({ apiId, apiHash } = extract(appsHtml));
}

if (!apiId || !apiHash) {
  die(
    "could not extract api_id/api_hash from /apps HTML — selectors may have changed",
  );
}

emit({
  type: "phase",
  phase: 1,
  message: "Extracted credentials",
  api_id: apiId,
});

// --- Phase 2: gram.js session generation ---
if (SKIP_SESSION) {
  process.stdout.write(
    JSON.stringify({
      api_id: apiId,
      api_hash: apiHash,
      phone: PHONE,
      session: null,
    }) + "\n",
  );
  process.exit(0);
}

emit({ type: "phase", phase: 2, message: "Generating gram.js session string" });

const stringSession = new StringSession("");
const client = new TelegramClient(stringSession, parseInt(apiId, 10), apiHash, {
  connectionRetries: 3,
  baseLogger: {
    log: () => {},
    warn: () => {},
    error: (...a) => emit({ type: "gram_error", message: a.join(" ") }),
    info: () => {},
    debug: () => {},
  },
});

// Remove any leftover code file from the web-login step so we don't reuse it
if (existsSync(CODE_FILE)) {
  try {
    unlinkSync(CODE_FILE);
  } catch {}
}

try {
  await client.start({
    phoneNumber: async () => PHONE,
    password: async () => {
      // 2FA password is separate from the phone code. If the user has 2FA
      // enabled, we'd need another bridge file. For MVP, default to empty
      // and let gram.js error loudly if 2FA is required.
      emit({
        type: "need_password",
        message:
          "Telegram 2FA password required. Write to /tmp/telegram-password.txt or leave unset for no-2FA accounts",
        password_file: "/tmp/telegram-password.txt",
      });
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        if (existsSync("/tmp/telegram-password.txt")) {
          const pw = readFileSync("/tmp/telegram-password.txt", "utf8").trim();
          try {
            unlinkSync("/tmp/telegram-password.txt");
          } catch {}
          return pw;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return "";
    },
    phoneCode: async () => {
      emit({
        type: "need_code",
        channel: "gram_auth",
        message: `Telegram sent a SECOND code for gram.js auth. Write digits-only to ${CODE_FILE}`,
        code_file: CODE_FILE,
      });
      return await waitForCode(300);
    },
    onError: (err) => emit({ type: "gram_error", message: err.message }),
  });
} catch (err) {
  die(`gram.js auth failed: ${err.message}`);
}

const sessionStr = client.session.save();

// Step 2.1: Validate session
emit({ type: "step", message: "Validating session..." });
try {
  await client.connect();
  const me = await client.getMe();
  emit({
    type: "step",
    message: `✓ Validated — ${me.firstName} (@${me.username || "no-username"})`,
  });
  await client.disconnect();
} catch (e) {
  emit({ type: "step", message: `⚠ Session validation failed: ${e.message}` });
  await client.disconnect().catch(() => {});
}

// Step 2.2: Save to macOS keychain
if (process.platform === "darwin") {
  try {
    for (const [svc, val] of [
      ["telegram-api-id", apiId],
      ["telegram-api-hash", apiHash],
      ["telegram-phone", PHONE],
      ["telegram-session", sessionStr],
    ]) {
      execSync(
        `security add-generic-password -U -s "${svc}" -a "$USER" -w '${val.replace(/'/g, "'\\''")}'`,
        { timeout: 5000 },
      );
    }
    emit({ type: "step", message: "✓ Saved credentials to macOS keychain" });
  } catch (e) {
    emit({ type: "step", message: `○ Keychain save failed: ${e.message}` });
  }
}

// Step 2.3: Register MCP server
try {
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT ||
    execSync("echo $CLAUDE_PLUGIN_ROOT", { encoding: "utf8" }).trim();
  const telegramServerPath = pluginRoot
    ? `${pluginRoot}/telegram-server/index.js`
    : null;
  if (telegramServerPath) {
    execSync(
      `claude mcp add telegram -s user` +
        ` -e TELEGRAM_API_ID='${apiId}'` +
        ` -e TELEGRAM_API_HASH='${apiHash}'` +
        ` -e TELEGRAM_PHONE='${PHONE}'` +
        ` -e TELEGRAM_SESSION='${sessionStr.replace(/'/g, "'\\''")}'` +
        ` -- node "${telegramServerPath}"`,
      { timeout: 15000, stdio: "pipe" },
    );
    emit({
      type: "step",
      message: "✓ Registered Telegram MCP server in Claude Code",
    });
  }
} catch {
  emit({
    type: "step",
    message: "○ Could not auto-register MCP — run: claude mcp add telegram",
  });
}

const result = {
  api_id: apiId,
  api_hash: apiHash,
  phone: PHONE,
  session: sessionStr,
};
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(0);
