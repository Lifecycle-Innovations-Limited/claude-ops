# claude-ops

A Claude Code plugin that turns Claude into a business operating system. One command — `/ops-go` — gives you a complete morning briefing: infra health, CI status, unread messages, open PRs, sprint state, and revenue snapshot. Then route to any sub-skill for deep work.

## Features

| Skill | Description |
|-------|-------------|
| `/ops:setup` | Interactive setup wizard — installs CLIs, configures channels, builds registry |
| `/ops-go` | Morning briefing — all systems in one dashboard |
| `/ops-next` | Priority-ordered next action (fires → comms → PRs → sprint → GSD) |
| `/ops-inbox` | Inbox zero across WhatsApp, Email, Slack, Telegram |
| `/ops-comms` | Send/read messages across all channels |
| `/ops-projects` | Portfolio dashboard — GSD phase, CI, PRs, dirty files |
| `/ops-linear` | Linear sprint board, issue management, GSD sync |
| `/ops-triage` | Cross-platform issue triage (Sentry + Linear + GitHub) |
| `/ops-fires` | Production incidents dashboard with agent dispatch |
| `/ops-deploy` | ECS + Vercel + GitHub Actions deploy status |
| `/ops-revenue` | AWS costs, credits, revenue pipeline, runway |
| `/ops-yolo` | 4-agent C-suite analysis + autonomous mode |

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 1.0+
- [GSD](https://github.com/auroracapital/get-shit-done) (prerequisite — provides project roadmap state)
- Node.js 18+ (for Telegram MCP server)
- AWS CLI (configured, for ECS + cost data)
- GitHub CLI (`gh`, for PRs and CI)

### Optional integrations
- `wacli` — WhatsApp CLI (for WhatsApp inbox)
- Gmail MCP — mcp__claude_ai_Gmail__* (for email)
- Slack MCP — mcp__claude_ai_Slack__* (for Slack)
- Linear MCP — mcp__claude_ai_Linear__* (for sprint management)
- Sentry MCP — mcp__sentry__* (for error triage)
- Vercel MCP — mcp__claude_ai_Vercel__* (for deploy status)

## Installation

```bash
# 1. Clone the plugin
git clone https://github.com/auroracapital/claude-ops ~/.claude/plugins/claude-ops

# 2. Set CLAUDE_PLUGIN_ROOT in your shell profile
echo 'export CLAUDE_PLUGIN_ROOT="$HOME/.claude/plugins/claude-ops"' >> ~/.zshrc
source ~/.zshrc

# 3. Make bin scripts executable
chmod +x $CLAUDE_PLUGIN_ROOT/bin/*

# 4. Register skills with Claude Code
# Add to ~/.claude/settings.json:
{
  "skills": {
    "paths": ["$HOME/.claude/plugins/claude-ops/skills"]
  }
}

# 5. Install Telegram MCP server (optional)
cd $CLAUDE_PLUGIN_ROOT/telegram-server && npm install
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

### Telegram Bot (optional)

1. Create a bot via [@BotFather](https://t.me/BotFather) and get your `TELEGRAM_BOT_TOKEN`
2. Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot)
3. Add to your Claude Code user config:
   ```json
   {
     "telegram_bot_token": "123456:ABC-DEF...",
     "telegram_owner_id": "987654321"
   }
   ```
4. Claude Code will auto-start the Telegram MCP server via `.mcp.json`

## Usage

### Morning Briefing

```
/ops-go
```

Pre-gathers all data in parallel via shell scripts, then presents a unified dashboard in <10 seconds.

### Next Action

```
/ops-next
/ops-next focus on healify
```

Applies the priority stack: fires > urgent comms > ready-to-merge PRs > Linear sprint > GSD work.

### Inbox Zero

```
/ops-inbox          # all channels
/ops-inbox email    # email only
/ops-inbox slack    # slack only
```

### Send a Message

```
/ops-comms send "hey, can we chat?" to John Smith
/ops-comms read whatsapp
```

### Fires Dashboard

```
/ops-fires
/ops-fires healify
```

Shows production incidents, ECS health, Sentry errors. Dispatches fix agents.

### YOLO Mode

```
/ops-yolo
```

Spawns 4 C-suite agents (CEO, CTO, CFO, COO) in parallel. Each analyzes the business from their perspective with full data access. Produces an unfiltered Hard Truths report.

After the report, type `YOLO` to hand over the controls — Claude will autonomously process inbox, merge ready PRs, fix fires, advance GSD phases, and deploy.

## Architecture

### Token Efficiency

All `ops-*` skills use the `!` shell injection pattern:

```markdown
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{}'
```
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
| `agents/yolo-ceo.md` | CEO perspective (claude-opus-4-5) |
| `agents/yolo-cto.md` | CTO perspective |
| `agents/yolo-cfo.md` | CFO perspective |
| `agents/yolo-coo.md` | COO perspective |

### Telegram MCP Server

The `telegram-server/` directory contains a minimal MCP server that exposes the Telegram Bot API as Claude tools. It uses Node's native `fetch()` (no heavy dependencies) and runs via stdio transport for Claude Code integration.

Tools:
- `mcp__claude_ops_telegram__send_message(chat_id, text)` — send a message (supports `OWNER` alias)
- `mcp__claude_ops_telegram__get_updates(limit?)` — fetch recent messages
- `mcp__claude_ops_telegram__list_chats()` — list known chats

## License

MIT — see [LICENSE](LICENSE)
