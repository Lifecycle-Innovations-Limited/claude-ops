# Daemon Guide

The ops-daemon is a unified background process manager that runs persistently via macOS launchd. It replaced per-service launchd agents (introduced in v0.5.0).

## What the Daemon Does

1. **Keeps WhatsApp connected** — runs `wacli follow` in persistent mode with auto-reconnect on disconnect
2. **Auto-backfills @lid chats** — detects empty chats from the `@lid` addressing format and backfills message history
3. **Triggers memory extraction** — every 30 minutes, spawns the `memory-extractor` agent to update `memories/`
4. **Writes a health file** — maintains `~/.wacli/.health` so skills can pre-flight check before attempting WhatsApp reads

## Setup

The daemon is configured automatically by the setup wizard:

```
/ops:setup
# Step 5b: Background daemon
```

Or start it manually:

```bash
# Start via launchd (recommended — survives reboots)
launchctl load ~/Library/LaunchAgents/com.claude-ops.daemon.plist

# Start foreground (debug mode)
~/.claude/plugins/cache/ops-marketplace/ops/<version>/scripts/ops-daemon.sh start

# Check status
~/.claude/plugins/cache/.../scripts/ops-daemon.sh status
```

The daemon script lives at `scripts/ops-daemon.sh`.

## Health File Contract

The daemon writes `~/.wacli/.health` on every successful wacli sync. Skills read this file before any WhatsApp operation.

```json
{
  "status": "ok",
  "last_sync": "2026-04-13T07:45:00Z",
  "wacli_pid": 12345,
  "message_count": 1420
}
```

| Field | Meaning |
|-------|---------|
| `status` | `ok`, `degraded`, or `down` |
| `last_sync` | ISO timestamp of last successful wacli poll |
| `wacli_pid` | PID of the running wacli process |
| `message_count` | Total messages in local DB |

If `last_sync` is more than 10 minutes ago, the PreToolUse hook surfaces a warning before any WhatsApp command.

## PreToolUse Hook

`hooks/whatsapp-health-check.sh` runs automatically before any `wacli` call. It checks the health file and either:
- Proceeds silently if `status === ok` and `last_sync` is recent
- Surfaces a warning with instructions to restart the daemon if degraded

The hook is registered in `.claude/settings.json` under `preToolUse`.

## Brain Layer

The daemon includes a lightweight brain layer (`bin/ops-brain`) that:
- Pre-fetches briefing data every 5 minutes and caches it to `~/.claude/plugins/data/.../daemon-cache.json`
- Detects urgent message patterns (mentions of your name, "urgent", "ASAP", "fire", "down")
- Writes urgent flags to the health file so `/ops:go` can surface them instantly

This makes `/ops:go` load in under 3 seconds instead of gathering data live.

## Troubleshooting

```bash
# View daemon logs
tail -f /tmp/com.claude-ops.daemon.log

# Force restart
launchctl unload ~/Library/LaunchAgents/com.claude-ops.daemon.plist
launchctl load ~/Library/LaunchAgents/com.claude-ops.daemon.plist

# Run doctor to auto-fix daemon issues
/ops:doctor
```

Common issues:
- **`wacli not connected`** — run `/ops:setup whatsapp` to re-authenticate
- **`health file stale`** — daemon may have crashed; check `/tmp/com.claude-ops.daemon.log`
- **`memory extractor not running`** — check that haiku API key is configured in preferences or Doppler
