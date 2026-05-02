<div align="center">

# Memories System

*Persistent local context about people, projects, and your communication patterns — extracted from your chats, stored as markdown, never sent anywhere*

[![version](https://img.shields.io/badge/version-2.1.0-blue)](../CHANGELOG.md)
[![storage](https://img.shields.io/badge/storage-local%20markdown-22c55e)](.)
[![privacy](https://img.shields.io/badge/privacy-on--device-6366f1)](.)
[![extractor](https://img.shields.io/badge/extractor-haiku--4--5-f59e0b)](.)

</div>

---

The memories system gives claude-ops persistent context about people, projects, and your communication patterns. Introduced in v0.5.0, upgraded in v1.1.0 with richer project context blocks.

> [!IMPORTANT]
> **Files never leave your machine.** Memories are plain markdown on your local disk at `~/.claude/plugins/data/ops-ops-marketplace/memories/`. The extractor reads your local whatsapp-bridge database and local email cache — nothing is uploaded. See [Privacy](#-privacy) below.

---

## 🧠 How It Works

1. **Extraction** — the `memory-extractor` agent (`agents/memory-extractor.md`) runs every 30 minutes as a daemon service. It reads recent WhatsApp messages (via `whatsapp-bridge`) and email threads (via `gog`) and calls Claude Haiku to extract structured profiles.
2. **Storage** — profiles are written as markdown files to `~/.claude/plugins/data/ops-ops-marketplace/memories/`.
3. **Consumption** — skills load the relevant memory files at runtime via the Runtime Context block at the top of each `SKILL.md`.

### Extraction Flow

```mermaid
flowchart TB
    Trigger{Trigger?}
    Trigger -->|30 min elapsed| Start[memory-extractor agent spawns]
    Trigger -->|msg count +5| Start
    Trigger -->|/ops:doctor --run-memory-extractor| Start

    Start --> ReadLocal[Read LOCAL sources only]
    ReadLocal --> Bridge[(~/.whatsapp-bridge<br/>local SQLite)]
    ReadLocal --> Gog[(~/.gog<br/>local email cache)]

    Bridge --> Haiku[Claude Haiku 4.5<br/>structured extraction]
    Gog --> Haiku

    Haiku --> Merge[Merge into existing<br/>profiles — never overwrite]
    Merge --> Write[Write markdown]

    Write --> Contacts[memories/contacts/&lt;name&gt;.md]
    Write --> Prefs[memories/preferences.md]
    Write --> Projects[memories/projects/&lt;alias&gt;.md]

    Contacts --> Consumed[Consumed by skills<br/>at runtime]
    Prefs --> Consumed
    Projects --> Consumed

    Consumed --> Inbox[/ops:inbox]
    Consumed --> Comms[/ops:comms]
    Consumed --> Go[/ops:go]

    classDef primary fill:#6366f1,color:#fff
    classDef daemon fill:#f59e0b,color:#fff
    classDef agent fill:#8b5cf6,color:#fff
    classDef success fill:#22c55e,color:#fff

    class Trigger,ReadLocal primary
    class Start,Haiku agent
    class Bridge,Gog,Contacts,Prefs,Projects daemon
    class Consumed,Inbox,Comms,Go success
```

> [!NOTE]
> The extractor **merges** new information into existing profiles rather than overwriting — context accumulates over time. Rename or delete files manually if you want to reset a profile.

---

## 📄 File Format

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

---

## 🔌 How Skills Consume Memories

Every skill has a Runtime Context block that loads memories at execution time:

````markdown
```!
# Load memories
MEMORIES_DIR="$CLAUDE_PLUGIN_ROOT/../data/memories"
cat "$MEMORIES_DIR/preferences.md" 2>/dev/null || echo "No preferences found"
ls "$MEMORIES_DIR/contacts/" 2>/dev/null | head -20
```
````

The `ops-inbox` and `ops-comms` skills do a contact lookup before drafting any reply:

1. Check `memories/contacts/<name>.md` for communication style and history
2. Check `memories/projects/` for relevant project context
3. Draft reply matching the contact's expected tone and the conversation's topic

> [!TIP]
> Drop a pre-written contact card into `memories/contacts/` by hand and the extractor will merge future extractions into it rather than replacing it — useful for seeding context on new contacts.

---

## 🧰 Manual Memory Management

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

---

## ⏱️ Memory Extraction Trigger

The daemon triggers extraction when **any** of these conditions are met:

| Trigger | Condition |
|---------|-----------|
| Time-based | 30 minutes elapsed since last run |
| Volume-based | Message count in `~/.whatsapp-bridge/.health` increased by more than 5 |
| Manual | `/ops:doctor --run-memory-extractor` |

The extractor uses `claude-haiku-4-5-20251001` (fast + cheap) for all extraction work. It merges new information into existing profiles rather than overwriting, so context accumulates over time.

> [!NOTE]
> Haiku 4.5 is used deliberately here — memory extraction is a high-frequency, low-reasoning-depth workload. The tradeoff: cost stays low enough to run every 30 min on every user's machine.

---

## 🔒 Privacy

> [!IMPORTANT]
> **Memory files never leave your machine.**
>
> - **Location:** `~/.claude/plugins/data/ops-ops-marketplace/memories/`
> - **Storage:** plain markdown files on your local disk
> - **Sources:** the extractor reads your **local** whatsapp-bridge database and **local** email cache — not cloud APIs
> - **Upload:** nothing is sent to any server. Files are read by skills at runtime and that's it.
>
> If you want to wipe everything: `rm -rf ~/.claude/plugins/data/ops-ops-marketplace/memories/`.

> [!CAUTION]
> The **content** of a memory file may get included in the prompt context when a skill runs — which does reach Anthropic's API for that request, as with any Claude conversation. If you have contacts whose details you don't want included in any prompt, remove or redact their contact cards before running comms skills.
