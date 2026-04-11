# Phase 3: Communications Hub — Context

## Scope
Verify and enhance the two comms-facing skills: `ops-inbox` and `ops-comms`.

## Verification Checklist

### ops-inbox
- [x] Uses `` `!`${CLAUDE_PLUGIN_ROOT}/bin/ops-unread`` `` for pre-gathered unread counts
- [x] Handles WhatsApp (wacli), Email (Gmail MCP), Slack (MCP), Telegram
- [x] Telegram fallback: `telegram-cli` with graceful degradation
- [x] AskUserQuestion menu before processing
- [x] Completion summary with counts

### ops-comms
- [x] Routing table covers: whatsapp, email, slack, telegram, send/read patterns
- [x] Send flow resolves contact across channels (wacli → Slack MCP → email)
- [x] Email always creates draft first (safety)
- [x] Empty args shows channel picker menu

## Key Design Decisions
- Both skills use Telegram CLI (`telegram-cli`) as placeholder until Telegram MCP server is available (Phase 7)
- ops-inbox pre-gathers data via `bin/ops-unread` using `!` shell injection (zero extra latency)
- Comms routing is channel-agnostic: the skill finds the best channel automatically
