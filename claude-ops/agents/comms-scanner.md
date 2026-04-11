---
name: comms-scanner
description: Scans all communication channels for unread and urgent messages. Returns structured JSON with counts, previews, and urgency scores. Used by ops-inbox and ops-go for pre-gathering.
model: claude-sonnet-4-5
effort: low
maxTurns: 10
tools:
  - Bash
  - Read
disallowedTools:
  - Write
  - Edit
  - Agent
---

# COMMS SCANNER AGENT

Scan all channels for unread messages and return structured data. This agent is fast and read-only.

## Task

Run all channel scans in parallel and output a single JSON object:

```bash
# WhatsApp
wacli chats --unread --json 2>/dev/null || echo '{"error": "wacli not available"}'
```

```bash
# Email (unread count)
# Use Gmail CLI or gog
gog gmail list --unread --limit 50 --json 2>/dev/null || echo '{"error": "gog not available"}'
```

```bash
# Telegram
telegram-cli --exec "dialog_list" --json 2>/dev/null || echo '{"error": "telegram-cli not available"}'
```

Combine results into:

```json
{
  "timestamp": "[ISO8601]",
  "whatsapp": {
    "count": 0,
    "chats": [
      {
        "contact": "[name]",
        "messages": 0,
        "preview": "[text]",
        "timestamp": "[ISO8601]",
        "urgency": "high|medium|low"
      }
    ]
  },
  "email": {
    "count": 0,
    "threads": [
      {
        "from": "[sender]",
        "subject": "[subject]",
        "preview": "[text]",
        "timestamp": "[ISO8601]",
        "urgency": "high|medium|low"
      }
    ]
  },
  "slack": {
    "count": -1,
    "note": "fetch live via MCP"
  },
  "telegram": {
    "count": 0,
    "chats": []
  },
  "total_unread": 0,
  "urgent": []
}
```

## Urgency scoring

Mark a message `high` if:
- Sender is in contacts list with `vip: true`
- Message contains: "urgent", "ASAP", "down", "broken", "help", "emergency", "critical"
- Email subject starts with "Re: Re: Re:" (long chain needing response)

## Output

Print only the JSON to stdout. No preamble. No summary.
