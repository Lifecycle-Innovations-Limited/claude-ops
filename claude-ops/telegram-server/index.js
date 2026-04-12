#!/usr/bin/env node
/**
 * Telegram MCP Server for claude-ops (USER-AUTH, not bot)
 *
 * Uses gram.js MTProto to authenticate as a personal Telegram account,
 * allowing access to real DM conversations — not just bot interactions.
 *
 * Required env vars:
 *   TELEGRAM_API_ID       — from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH     — from https://my.telegram.org/apps
 *   TELEGRAM_SESSION      — persisted string session (populated after first auth)
 *   TELEGRAM_PHONE        — phone number (E.164 format, e.g. +15551234567)
 *
 * First-run auth:
 *   Run `node index.js --auth` in a terminal. It will prompt for the SMS code
 *   and 2FA password, then print a TELEGRAM_SESSION string to save to env.
 *
 * Tools exposed:
 *   list_dialogs     — list recent conversations (DMs, groups, channels)
 *   get_messages     — fetch messages from a specific chat
 *   send_message     — send a message to a chat
 *   search_messages  — full-text search across all chats
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const API_ID = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const SESSION_STRING = process.env.TELEGRAM_SESSION || "";
const PHONE = process.env.TELEGRAM_PHONE || "";

if (!API_ID || !API_HASH) {
  process.stderr.write(
    "ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH are required.\n" +
      "Get them from https://my.telegram.org/apps (create a personal app, NOT a bot).\n",
  );
  process.exit(1);
}

const stringSession = new StringSession(SESSION_STRING);
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
  baseLogger: {
    log: () => {},
    warn: () => {},
    error: (...args) => process.stderr.write(args.join(" ") + "\n"),
    info: () => {},
    debug: () => {},
  },
});

// First-run interactive auth mode
if (process.argv.includes("--auth")) {
  const rl = readline.createInterface({ input, output });
  await client.start({
    phoneNumber: async () =>
      PHONE || (await rl.question("Phone number (E.164): ")),
    password: async () => await rl.question("2FA password (blank if none): "),
    phoneCode: async () => await rl.question("SMS code: "),
    onError: (err) => process.stderr.write(`Auth error: ${err.message}\n`),
  });
  rl.close();
  const saved = client.session.save();
  process.stdout.write("\n=== AUTH SUCCESSFUL ===\n");
  process.stdout.write("Save this to TELEGRAM_SESSION env var:\n\n");
  process.stdout.write(saved + "\n");
  await client.disconnect();
  process.exit(0);
}

// Non-interactive mode — requires saved session
if (!SESSION_STRING) {
  process.stderr.write(
    "ERROR: TELEGRAM_SESSION is not set. Run `node index.js --auth` first to generate it.\n",
  );
  process.exit(1);
}

// Connect using saved session
try {
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error(
      "Session is no longer valid — re-run `node index.js --auth`",
    );
  }
} catch (err) {
  process.stderr.write(`Failed to connect: ${err.message}\n`);
  process.exit(1);
}

// ── MCP server setup ──
const server = new Server(
  { name: "claude-ops-telegram", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_dialogs",
      description:
        "List recent Telegram conversations (DMs, groups, channels). Returns last-message preview, sender, timestamp, and unread count.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max dialogs to return (default 30, max 100)",
          },
          archived: {
            type: "boolean",
            description: "Include archived dialogs (default false)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_messages",
      description:
        "Fetch recent messages from a specific chat. Use chat_id from list_dialogs or a username like @example.",
      inputSchema: {
        type: "object",
        properties: {
          chat: {
            type: "string",
            description: "Chat ID (numeric) or @username",
          },
          limit: {
            type: "number",
            description: "Number of messages to fetch (default 20, max 100)",
          },
        },
        required: ["chat"],
      },
    },
    {
      name: "send_message",
      description:
        "Send a message to a Telegram chat or user (personal account, not bot).",
      inputSchema: {
        type: "object",
        properties: {
          chat: {
            type: "string",
            description: "Chat ID (numeric) or @username",
          },
          text: {
            type: "string",
            description: "Message text (supports Markdown)",
          },
        },
        required: ["chat", "text"],
      },
    },
    {
      name: "search_messages",
      description: "Full-text search across all Telegram conversations.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text",
          },
          limit: {
            type: "number",
            description: "Max results (default 20)",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

function formatPeer(entity) {
  if (!entity) return "Unknown";
  if (entity.title) return entity.title;
  const first = entity.firstName || "";
  const last = entity.lastName || "";
  const name = `${first} ${last}`.trim();
  if (name) return name;
  if (entity.username) return `@${entity.username}`;
  return String(entity.id || "Unknown");
}

function resolveChatArg(chat) {
  // Accept numeric ID or @username
  if (/^-?\d+$/.test(chat)) return parseInt(chat, 10);
  return chat.startsWith("@") ? chat : `@${chat}`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_dialogs") {
      const limit = Math.min(args?.limit || 30, 100);
      const includeArchived = args?.archived || false;

      const dialogs = await client.getDialogs({
        limit,
        archived: includeArchived,
      });

      const formatted = dialogs.map((d) => {
        const peer = formatPeer(d.entity);
        const lastMsg = d.message;
        const fromMe = lastMsg?.out || false;
        const text = lastMsg?.message || "[non-text message]";
        const ts = lastMsg?.date
          ? new Date(lastMsg.date * 1000).toISOString()
          : "";
        return {
          chat_id: String(d.id),
          name: peer,
          type: d.isChannel ? "channel" : d.isGroup ? "group" : "dm",
          unread: d.unreadCount || 0,
          last_message: {
            from_me: fromMe,
            text: text.slice(0, 200),
            timestamp: ts,
          },
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { dialogs: formatted, count: formatted.length },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "get_messages") {
      const chat = resolveChatArg(args.chat);
      const limit = Math.min(args?.limit || 20, 100);

      const messages = await client.getMessages(chat, { limit });

      const formatted = messages.map((m) => ({
        id: m.id,
        from_me: m.out,
        sender: formatPeer(m.sender),
        text: m.message || "[non-text message]",
        timestamp: m.date ? new Date(m.date * 1000).toISOString() : "",
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { messages: formatted, count: formatted.length },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "send_message") {
      const chat = resolveChatArg(args.chat);
      const result = await client.sendMessage(chat, { message: args.text });

      return {
        content: [
          {
            type: "text",
            text: `Message sent. ID: ${result.id}, to: ${chat}`,
          },
        ],
      };
    }

    if (name === "search_messages") {
      const limit = Math.min(args?.limit || 20, 100);
      // gram.js messages.search on global scope
      const { Api } = await import("telegram");
      const results = await client.invoke(
        new Api.messages.SearchGlobal({
          q: args.query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit,
        }),
      );

      const msgs = (results.messages || []).map((m) => ({
        id: m.id,
        text: m.message || "[non-text]",
        timestamp: m.date ? new Date(m.date * 1000).toISOString() : "",
        from_me: m.out || false,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { results: msgs, count: msgs.length },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Telegram MCP server running (user-auth mode)\n");

// Graceful shutdown
process.on("SIGINT", async () => {
  await client.disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await client.disconnect();
  process.exit(0);
});
