#!/usr/bin/env node
// Auto-auth: read Telegram code from /tmp/telegram-code.txt (file-based input).
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const PHONE = process.env.TELEGRAM_PHONE;
const CODE_FILE = "/tmp/telegram-code.txt";

if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);

if (!API_ID || !API_HASH || !PHONE) {
  console.error("missing env");
  process.exit(1);
}

function readFileCode() {
  if (existsSync(CODE_FILE)) {
    const c = readFileSync(CODE_FILE, "utf8").trim();
    if (/^\d{4,8}$/.test(c)) return c;
  }
  return null;
}

async function waitForCode(maxSec = 180) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < maxSec * 1000) {
    const code = readFileCode();
    if (code) {
      console.error(`code found: ${code}`);
      return code;
    }
    if (Date.now() - lastLog > 10000) {
      console.error(
        `waiting for code — write to ${CODE_FILE} (${Math.floor((Date.now() - start) / 1000)}s)`,
      );
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timeout");
}

const stringSession = new StringSession("");
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
  baseLogger: {
    log: () => {},
    warn: () => {},
    error: (...a) => console.error(...a),
    info: () => {},
    debug: () => {},
  },
});

await client.start({
  phoneNumber: async () => PHONE,
  password: async () => {
    console.error("2FA: empty");
    return "";
  },
  phoneCode: async () => {
    console.error("Telegram sent code; waiting for /tmp/telegram-code.txt");
    return await waitForCode(180);
  },
  onError: (err) => console.error("auth err:", err.message),
});

const saved = client.session.save();
console.log("=== SESSION STRING ===");
console.log(saved);
console.log("=== END ===");
// 0o600: /tmp is world-readable on macOS (drwxrwxrwt). Without this mode
// any local process could read the session string during the window between
// write and whoever reads it next.
writeFileSync("/tmp/telegram-session.txt", saved, { mode: 0o600 });
// writeFileSync mode only applies to NEW files; if it already existed,
// chmod explicitly.
try {
  (await import("node:fs")).chmodSync("/tmp/telegram-session.txt", 0o600);
} catch {}
console.error("session saved to /tmp/telegram-session.txt (0600)");
await client.disconnect();
process.exit(0);
