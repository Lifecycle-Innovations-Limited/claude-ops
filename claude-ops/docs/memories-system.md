# Memories System

The memories system gives claude-ops persistent context about people, projects, and your communication patterns. Introduced in v0.5.0.

## How It Works

1. **Extraction** — the `memory-extractor` agent (`agents/memory-extractor.md`) runs every 30 minutes as a daemon service. It reads recent WhatsApp messages (via `wacli`) and email threads (via `gog`) and calls Claude Haiku to extract structured profiles.
2. **Storage** — profiles are written as markdown files to `~/.claude/plugins/data/ops-ops-marketplace/memories/`
3. **Consumption** — skills load the relevant memory files at runtime via the Runtime Context block at the top of each SKILL.md

## File Format

### Contact profiles (`memories/contacts/<name>.md`)

```markdown
# John Smith

## Contact Info
- WhatsApp: +15551234567
- Email: john@acme.com
- Company: Acme Corp

## Communication Preferences
- Prefers WhatsApp over email
- Responds quickly in the morning (PST)
- Informal tone — uses first names, short messages

## Context
- CEO of Acme Corp — potential enterprise customer
- Last conversation: pricing discussion 2026-04-10
- Waiting on: proposal we sent 2026-04-11

## Topics
- my-app integration
- enterprise pricing
- Q2 budget approval
```

### User preferences (`memories/preferences.md`)

```markdown
# Communication Preferences

## Style
- Short, direct messages — no filler
- Never start with "Hope you're well"
- Sign off with first name only

## Defaults
- Primary channel: WhatsApp
- Calendar timezone: America/New_York
- Working hours: 8am–7pm ET
```

### Project context (`memories/projects/<alias>.md`)

```markdown
# my-app

## Status
- Phase 6.2 in progress — push notifications backend
- Dev branch: feature/push-notifications
- Last deploy: 2026-04-12 14:30 UTC

## Key Contacts
- Alice (QA): alice@example.com
- Bob (backend): bob@example.com
```

## How Skills Consume Memories

Every skill has a Runtime Context block that loads memories at execution time:

```markdown
```!
# Load memories
MEMORIES_DIR="$CLAUDE_PLUGIN_ROOT/../data/memories"
cat "$MEMORIES_DIR/preferences.md" 2>/dev/null || echo "No preferences found"
ls "$MEMORIES_DIR/contacts/" 2>/dev/null | head -20
```
```

The `ops-inbox` and `ops-comms` skills do a contact lookup before drafting any reply:

1. Check `memories/contacts/<name>.md` for communication style and history
2. Check `memories/projects/` for relevant project context
3. Draft reply matching the contact's expected tone and the conversation's topic

## Manual Memory Management

```bash
# View all contact profiles
ls ~/.claude/plugins/data/ops-ops-marketplace/memories/contacts/

# Edit a contact profile
# (use your editor — files are plain markdown)
vim ~/.claude/plugins/data/ops-ops-marketplace/memories/contacts/john-smith.md

# Force a memory extraction run now
# (daemon normally does this every 30 min)
/ops:doctor --run-memory-extractor
```

## Memory Extraction Trigger

The daemon triggers extraction when:
- 30 minutes have elapsed since the last run
- The message count in `~/.wacli/.health` has increased by more than 5
- `/ops:doctor` is run with `--run-memory-extractor`

The extractor uses `claude-haiku-4-5-20251001` (fast + cheap) for all extraction work. It merges new information into existing profiles rather than overwriting, so context accumulates over time.

## Privacy

Memory files live entirely on your local machine at `~/.claude/plugins/data/ops-ops-marketplace/memories/`. They are never sent anywhere — they are just files on disk that skills read. The extractor reads your local wacli database and local email cache, not cloud APIs.
