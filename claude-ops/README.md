# claude-ops

A Claude Code plugin that turns Claude into a business operating system. One command — `/ops:go` — gives you a complete morning briefing: infra health, CI status, unread messages, open PRs, sprint state, and revenue snapshot. Then route to any sub-skill for deep work.

## Features

| Skill           | Description                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| `/ops:setup`    | Interactive setup wizard — installs CLIs, configures channels, builds registry |
| `/ops:go`       | Morning briefing — all systems in one dashboard                                |
| `/ops:next`     | Priority-ordered next action (fires → comms → PRs → sprint → GSD)              |
| `/ops:inbox`    | Inbox zero across WhatsApp, Email, Slack, Telegram                             |
| `/ops:comms`    | Send/read messages across all channels                                         |
| `/ops:projects` | Portfolio dashboard — GSD phase, CI, PRs, dirty files                          |
| `/ops:linear`   | Linear sprint board, issue management, GSD sync                                |
| `/ops:triage`   | Cross-platform issue triage (Sentry + Linear + GitHub)                         |
| `/ops:fires`    | Production incidents dashboard with agent dispatch                             |
| `/ops:deploy`   | ECS + Vercel + GitHub Actions deploy status                                    |
| `/ops:revenue`  | AWS costs, credits, revenue pipeline, runway                                   |
| `/ops:yolo`     | 4-agent C-suite analysis + autonomous mode                                     |

## Requirements

- [Claude Code](https://claude.ai/code) 1.0+
- GitHub CLI (`gh`) — for PRs and CI status

Everything else is optional. The setup wizard (`/ops:setup`) auto-detects what's installed and configures accordingly.

### Integrations

The setup wizard (`/ops:setup`) walks through each one interactively. You choose per-integration whether to install the CLI, connect the MCP, or skip.

#### CLI-only (no MCP alternative)

| Tool               | Auto-installed                                            | What it does                                                                       |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gh` (GitHub CLI)  | Yes (Homebrew)                                            | PRs, CI logs, issue triage, merge pipeline — used by 8+ skills                     |
| `aws` (AWS CLI)    | Yes (Homebrew)                                            | ECS health, Cost Explorer, CloudWatch — used by ops-fires, ops-revenue, ops-deploy |
| `wacli` (WhatsApp) | Manual (see wacli README)                                 | WhatsApp inbox, send/read, contact lookup — no MCP equivalent exists               |
| Node.js 18+        | Yes (Homebrew)                                            | Runs the bundled Telegram MCP server                                               |

#### MCP-only (no CLI needed)

| MCP    | Connected via     | What it does                                                                                      |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| Linear | OAuth (Claude.ai) | Sprint cycles, issues, projects — 12 tools across 6 skills. Fully covers all Linear functionality |
| Vercel | OAuth (Claude.ai) | Deploy status, build logs, runtime logs. Read-only (deploys triggered via CI)                     |

#### Choose: MCP, CLI, or both

| Integration         | MCP path                                             | CLI path                                              | What you lose with MCP only                                                                                  |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Gmail**           | Claude.ai OAuth — read threads, create drafts        | `gog` CLI — full send, archive, label management      | MCP **cannot send emails** (drafts only) and **cannot archive**. `/ops:inbox` autonomous mode requires `gog` |
| **Google Calendar** | Claude.ai OAuth — list, create, RSVP, find free time | `gog cal` — read today's events                       | MCP has _more_ features. `gog` is simpler for read-only briefing context. Either works                       |
| **Slack**           | Claude.ai OAuth — read, send, search                 | Local bot token via `ops-slack-autolink`              | MCP has **quota limits**. Local token gives unlimited search + private channel access without bot membership |
| **Sentry**          | Claude.ai OAuth — issue search, triage, resolve      | `sentry-cli` — releases, source maps, deploy tracking | Current skills only use search/triage (MCP is fine). CLI adds release management (not used yet)              |

#### Plugin-bundled

| Integration                                                           | What it is                                             | Setup                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram MCP server                                                   | gram.js MTProto user-auth — reads your DMs (not a bot) | `/ops:setup telegram` — enter phone number + 2 verification codes, everything else is fully automated (app creation, session generation, keychain storage) |
| [GSD](https://github.com/Lifecycle-Innovations-Limited/get-shit-done) | Project roadmap state in dashboards                    | Auto-detected. Skills degrade gracefully without it                                                                                                        |

## Installation

`claude-ops` is distributed as a Claude Code marketplace plugin. Install it directly from inside Claude Code — you don't need to clone anything manually or edit any settings files.

```bash
# 1. Add the marketplace (one-time)
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops

# 2. Install the plugin
/plugin install ops@lifecycle-innovations-limited-claude-ops

# 3. Configure integrations (Telegram, Slack, AWS, etc.)
/ops:setup
```

The plugin's Telegram MCP server auto-installs its Node dependencies on first run via `npm install` inside the installed cache dir. You don't need to run it yourself.

If you prefer a local directory marketplace (useful for plugin development), clone the repo anywhere and register it:

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops ~/Projects/claude-ops-marketplace
# then inside Claude Code:
/plugin marketplace add ~/Projects/claude-ops-marketplace
```

## Setup

### Interactive wizard (recommended)

```
/ops:setup
```

Walks you through every configuration step inside Claude Code with structured selectors:

- Installs missing CLIs (`jq`, `gh`, `aws`, `doppler`, `sentry-cli`…) via Homebrew
- Collects tokens for each channel you enable (Telegram, WhatsApp, Email, Slack)
- Configures calendar (gog calendar → Google Calendar MCP fallback)
- Builds `scripts/registry.json` project-by-project
- Saves preferences (owner name, timezone, briefing verbosity, default channels, channel secrets) to `~/.claude/plugins/data/ops-ops-marketplace/preferences.json` — outside the plugin source tree so they survive plugin reinstalls and version bumps
- Exports `CLAUDE_PLUGIN_ROOT` in your shell profile

Jump straight to a section with e.g. `/ops:setup telegram`, `/ops:setup calendar`, `/ops:setup registry`, `/ops:setup cli`.

### Project Registry

Copy `scripts/registry.example.json` to `scripts/registry.json` (which is gitignored) and fill in your projects:

```json
{
  "version": "1.0",
  "owner": "Your Name",
  "projects": [
    {
      "alias": "myapp",
      "paths": ["~/Projects/myapp"],
      "repos": ["github-org/myapp"],
      "org": "github-org",
      "type": "monorepo",
      "infra": { "ecs_clusters": ["myapp-production"], "platform": "aws" },
      "revenue": { "model": "saas", "stage": "growth", "mrr": 5000 },
      "gsd": true,
      "priority": 1
    }
  ]
}
```

### Telegram (optional — user-auth, not bot)

The plugin uses **your personal Telegram account** via gram.js MTProto — not a bot — because bots can't read user DMs, which is the main use case for `/ops:inbox telegram`.

**Recommended path — let the wizard do it:**

```
/ops:setup telegram
```

This invokes `bin/ops-telegram-autolink.mjs`, which takes your phone number, performs the `my.telegram.org` HTTP login flow, extracts `api_id` + `api_hash` (creating a Telegram app for you if none exists), runs the gram.js auth flow to generate a session string, and stores everything in macOS keychain. Zero browser automation — `my.telegram.org` is server-rendered HTML, so the wizard uses plain HTTP requests. You just enter the two codes Telegram sends to your Telegram app.

After the wizard finishes, it prints the values you need to paste into `/plugin settings` for `ops@ops-marketplace` (the plugin cannot write to `~/.claude.json` on its own — that's Claude Code's job via the `/plugin` UI).

**Manual path (if you already have an app):**

1. Get your `api_id` + `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps). Create a personal app (NOT a bot).
2. Open `/plugin` in Claude Code → `ops@ops-marketplace` → Settings. Fill in `telegram_api_id`, `telegram_api_hash`, `telegram_phone` (E.164).
3. Generate a session string: `node ~/.claude/plugins/cache/ops-marketplace/ops/<latest>/telegram-server/index.js --auth`. Prompts for code + 2FA, prints a `TELEGRAM_SESSION` string.
4. Paste into `telegram_session` in plugin settings. Restart Claude Code.

After that, `/ops:inbox telegram`, `/ops:comms send "..." to John Smith`, and the YOLO autonomous loop can read and reply to your DMs directly.

## Usage

### Morning Briefing

```
/ops:go
```

Pre-gathers all data in parallel via shell scripts, then presents a unified dashboard in <10 seconds.

### Next Action

```
/ops:next
/ops:next focus on <project-alias>
```

Applies the priority stack: fires > urgent comms > ready-to-merge PRs > Linear sprint > GSD work.

### Inbox Zero

```
/ops:inbox          # all channels
/ops:inbox email    # email only
/ops:inbox slack    # slack only
```

### Send a Message

```
/ops:comms send "hey, can we chat?" to John Smith
/ops:comms read whatsapp
```

### Fires Dashboard

```
/ops:fires
/ops:fires <project-alias>
```

Shows production incidents, ECS health, Sentry errors. Dispatches fix agents.

### YOLO Mode

```
/ops:yolo
```

Spawns 4 C-suite agents (CEO, CTO, CFO, COO) in parallel. Each analyzes the business from their perspective with full data access. Produces an unfiltered Hard Truths report.

After the report, type `YOLO` to hand over the controls — Claude will autonomously process inbox, merge ready PRs, fix fires, advance GSD phases, and deploy.

## Architecture

### Token Efficiency

All `ops-*` skills use the `!` shell injection pattern:

````markdown
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{}'
```
````

```

This runs shell scripts *before* the model context is loaded, so data is pre-gathered with zero extra latency.

### Agent Files

| Agent | Purpose |
|-------|---------|
| `agents/comms-scanner.md` | Background comms monitoring |
| `agents/infra-monitor.md` | Infrastructure health monitoring |
| `agents/project-scanner.md` | Project state analysis |
| `agents/revenue-tracker.md` | Revenue and cost monitoring |
| `agents/triage-agent.md` | Issue triage and fix dispatch |
| `agents/yolo-ceo.md` | CEO perspective (Opus, high effort) |
| `agents/yolo-cto.md` | CTO perspective |
| `agents/yolo-cfo.md` | CFO perspective |
| `agents/yolo-coo.md` | COO perspective |

### Telegram MCP Server

The `telegram-server/` directory contains an MCP server built on [gram.js](https://gram.js.org) (MTProto) that authenticates as your personal Telegram account — **not** as a bot. This is a hard requirement for `/ops:inbox telegram` because the Bot API cannot read user DMs.

Tools:
- `list_dialogs` — list recent conversations (DMs, groups, channels)
- `get_messages` — fetch messages from a specific chat
- `send_message` — send a message to a chat
- `search_messages` — full-text search across all your chats

See [telegram-server/README.md](telegram-server/README.md) for first-run auth flow and troubleshooting. The plugin's `.mcp.json` wires all four env vars (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE`, `TELEGRAM_SESSION`) from your `user_config` in Claude Code plugin settings — you never paste tokens into files directly.

## License

MIT — see [LICENSE](LICENSE)
```
