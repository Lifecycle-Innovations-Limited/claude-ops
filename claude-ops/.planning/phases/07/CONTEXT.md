# Phase 7: Telegram MCP Server — Context

## Scope
Build a minimal MCP server that exposes Telegram Bot API as tools.

## Files Created
- /.mcp.json — MCP server registration pointing to telegram-server/index.js
- /telegram-server/package.json — Node.js package with @modelcontextprotocol/sdk
- /telegram-server/index.js — MCP server implementation

## Tools Exposed
- send_message(chat_id, text) — send to any chat, OWNER alias resolves to TELEGRAM_OWNER_ID
- get_updates(limit?) — fetch recent messages, populates chat cache
- list_chats() — list known chats from recent updates

## Architecture
- Uses Telegram Bot API REST API directly (no heavy telegram lib dependency)
- Native fetch() (Node 18+)
- ESM module format
- Graceful error handling returns isError: true instead of crashing
