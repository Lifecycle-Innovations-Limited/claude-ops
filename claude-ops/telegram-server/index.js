#!/usr/bin/env node
/**
 * Telegram MCP Server for claude-ops
 * Provides tools: send_message, get_updates, list_chats
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = process.env.TELEGRAM_OWNER_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  process.stderr.write("ERROR: TELEGRAM_BOT_TOKEN is not set\n");
  process.exit(1);
}

// Known chats cache (populated from get_updates)
const knownChats = new Map();

async function telegramRequest(method, params = {}) {
  const url = `${API_BASE}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API returned error: ${JSON.stringify(data)}`);
  }

  return data.result;
}

const server = new Server(
  {
    name: "claude-ops-telegram",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send_message",
        description: "Send a message to a Telegram chat or user",
        inputSchema: {
          type: "object",
          properties: {
            chat_id: {
              type: "string",
              description:
                "The chat ID or username to send the message to. Use OWNER for the bot owner.",
            },
            text: {
              type: "string",
              description: "The message text to send (supports Markdown)",
            },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "get_updates",
        description:
          "Fetch recent messages and updates from the Telegram bot. Returns the last 20 messages.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of updates to fetch (max 100, default 20)",
            },
          },
          required: [],
        },
      },
      {
        name: "list_chats",
        description:
          "List known chats that have interacted with the bot. Populated from recent updates.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "send_message") {
      const { chat_id, text } = args;

      // Resolve OWNER alias
      const resolvedChatId =
        chat_id === "OWNER" && OWNER_ID ? OWNER_ID : chat_id;

      if (!resolvedChatId) {
        throw new Error(
          "chat_id is required. Set TELEGRAM_OWNER_ID to use 'OWNER' alias."
        );
      }

      const result = await telegramRequest("sendMessage", {
        chat_id: resolvedChatId,
        text,
        parse_mode: "Markdown",
      });

      return {
        content: [
          {
            type: "text",
            text: `Message sent successfully to chat ${result.chat.id}. Message ID: ${result.message_id}`,
          },
        ],
      };
    }

    if (name === "get_updates") {
      const limit = Math.min(args?.limit || 20, 100);

      const updates = await telegramRequest("getUpdates", {
        limit,
        allowed_updates: ["message", "edited_message"],
      });

      // Cache chats from updates
      for (const update of updates) {
        const msg = update.message || update.edited_message;
        if (msg?.chat) {
          const chat = msg.chat;
          const key = String(chat.id);
          knownChats.set(key, {
            id: chat.id,
            type: chat.type,
            title: chat.title || null,
            username: chat.username || null,
            first_name: chat.first_name || null,
            last_name: chat.last_name || null,
            display:
              chat.title ||
              [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
              chat.username ||
              key,
          });
        }
      }

      if (updates.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No recent updates found.",
            },
          ],
        };
      }

      const formatted = updates
        .map((update) => {
          const msg = update.message || update.edited_message;
          if (!msg) return null;
          const sender =
            [msg.from?.first_name, msg.from?.last_name]
              .filter(Boolean)
              .join(" ") ||
            msg.from?.username ||
            "Unknown";
          const chatName =
            msg.chat.title ||
            [msg.chat.first_name, msg.chat.last_name]
              .filter(Boolean)
              .join(" ") ||
            msg.chat.username ||
            String(msg.chat.id);
          const date = new Date(msg.date * 1000).toISOString();
          const edited = update.edited_message ? " [edited]" : "";
          return `[${date}]${edited} ${sender} in ${chatName} (${msg.chat.id}): ${msg.text || "[non-text message]"}`;
        })
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Recent updates (${updates.length}):\n\n${formatted}`,
          },
        ],
      };
    }

    if (name === "list_chats") {
      // Also fetch recent updates to populate the cache
      try {
        const updates = await telegramRequest("getUpdates", {
          limit: 100,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          const msg = update.message;
          if (msg?.chat) {
            const chat = msg.chat;
            const key = String(chat.id);
            knownChats.set(key, {
              id: chat.id,
              type: chat.type,
              title: chat.title || null,
              username: chat.username || null,
              first_name: chat.first_name || null,
              last_name: chat.last_name || null,
              display:
                chat.title ||
                [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
                chat.username ||
                key,
            });
          }
        }
      } catch (e) {
        // Non-fatal: use whatever is already in cache
      }

      if (knownChats.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: 'No known chats yet. Send a message to the bot first, or run get_updates to populate the chat list.',
            },
          ],
        };
      }

      const chatList = Array.from(knownChats.values())
        .map(
          (c) =>
            `• ${c.display} (ID: ${c.id}, type: ${c.type}${c.username ? ", @" + c.username : ""})`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Known chats (${knownChats.size}):\n\n${chatList}`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Telegram MCP server running\n");
