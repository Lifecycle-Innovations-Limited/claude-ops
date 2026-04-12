# claude-ops — Business Operating System for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./claude-ops/LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/Lifecycle-Innovations-Limited/claude-ops/releases)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet.svg)](https://claude.ai/settings/plugins)

Turn Claude Code into a complete business operating system. One command — `/ops:go` — delivers a morning briefing covering infrastructure health, CI/CD status, unread messages, open PRs, sprint state, and revenue snapshot.

## Quick Start

```bash
# 1. Add the marketplace
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops

# 2. Install the plugin
/plugin install ops@lifecycle-innovations-limited-claude-ops

# 3. Configure your integrations
/ops:setup
```

The setup wizard walks through each integration interactively — install CLIs, connect channels, build your project registry. All credentials stored locally, never transmitted.

### Local Development

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
claude --plugin-dir ./claude-ops
```

---

## What It Does

| Command | What it does | Integrations |
|---------|-------------|--------------|
| `/ops:go` | Full morning briefing — one command, 60 seconds | GitHub, Linear, Sentry, AWS |
| `/ops:inbox` | Unified inbox — read + triage all channels | Slack, Telegram, WhatsApp, Gmail |
| `/ops:merge` | Autonomous PR review + merge pipeline | GitHub Actions, GitHub CLI |
| `/ops:comms` | Send/read messages across any channel | Slack, Telegram, WhatsApp, Gmail |
| `/ops:fires` | Production incidents + ECS health dashboard | AWS ECS, Sentry |
| `/ops:revenue` | AWS spend, credits, runway estimate | AWS Cost Explorer |
| `/ops:projects` | Portfolio dashboard — all projects at a glance | GitHub, Linear |
| `/ops:linear` | Sprint board, issue management | Linear |
| `/ops:deploy` | Deploy status across all projects | AWS ECS, Vercel, GitHub Actions |
| `/ops:triage` | Cross-platform issue triage | Sentry, Linear, GitHub Issues |
| `/ops:next` | Priority-ranked "what should I do next" | Everything |
| `/ops:yolo` | 4 parallel C-suite AI agents — fully autonomous | Everything |

---

## Before vs After

| Without claude-ops | With claude-ops |
|--------------------|-----------------|
| Open 6+ tabs every morning | `/ops:go` — one command |
| Context-switch between Slack, Telegram, email | `/ops:inbox` — unified inbox |
| Manually review and merge PRs | `/ops:merge` — autonomous pipeline |
| SSH into servers to check health | `/ops:fires` — terminal dashboard |
| Forget to track AWS spend | `/ops:revenue` — automatic cost snapshot |
| Switch between Linear and GitHub | `/ops:linear` + `/ops:projects` — unified view |

---

## Requirements

Just [Claude Code](https://claude.ai/code) 1.0+. Everything else is installed automatically.

The setup wizard (`/ops:setup`) walks you through each integration interactively — "Do you want AWS CLI? [Yes/No]", "Connect Slack? [OAuth/Skip]", etc. Missing CLIs are auto-installed via Homebrew. MCP servers connect via OAuth. No config files to edit manually.

### Integrations: MCP vs CLI

Most integrations offer two paths. The setup wizard lets you choose per-integration.

| Integration | MCP-only (zero-config OAuth) | + CLI tool | What you lose without the CLI |
|-------------|------------------------------|------------|-------------------------------|
| **GitHub** | -- | `gh` (auto-installed) | **Everything** — GitHub is CLI-only. CI logs, PR merge, issue triage all require `gh` |
| **AWS** | -- | `aws` (auto-installed) | **Everything** — ECS health, cost tracking, revenue dashboard are CLI-only |
| **Linear** | OAuth via Claude.ai | -- | Nothing — fully covered by MCP. 12 tools used across 6 skills |
| **Vercel** | OAuth via Claude.ai | -- | Nothing — deploy status, build logs, runtime logs all via MCP |
| **Slack** | OAuth via Claude.ai | local bot token | MCP works for most users. Local token adds: unlimited search (no quota), private channel access without bot membership |
| **Gmail** | OAuth via Claude.ai | `gog` CLI | MCP can only **create drafts** — cannot send or archive. `gog` enables autonomous send + archive in `/ops:inbox` |
| **Calendar** | OAuth via Claude.ai | `gog` CLI | MCP actually has *more* features (create events, RSVP, find free time). `gog` only reads. Either works for briefings |
| **Sentry** | OAuth via Claude.ai | `sentry-cli` | MCP covers issue search + triage. CLI adds: source map upload, release tracking (not used by current skills) |
| **WhatsApp** | -- | `wacli` | **Everything** — no MCP exists. `wacli` is the only path for WhatsApp inbox |
| **Telegram** | -- | bundled MCP server | **Everything** — no Claude.ai connector exists. Plugin ships its own MTProto MCP server |
| **GSD** | -- | auto-detected | Project roadmap state in dashboards. Fully optional — skills degrade gracefully |

**TL;DR**: Linear and Vercel are MCP-only (and that's fine). GitHub and AWS are CLI-only (auto-installed). Gmail is where the choice matters most — MCP gives you read-only, CLI gives you full autonomous inbox management.

---

## Architecture

### Token Efficiency

All skills use pre-execution shell blocks (`!` fences) that gather data *before* the model context loads — zero extra latency, minimal token overhead.

### Plugin Structure

```
claude-ops/
├── .claude-plugin/
│   └── plugin.json        # Plugin manifest + userConfig schema
├── skills/                # 14 slash command skills
│   ├── ops/               # Router — dispatches to sub-skills
│   ├── ops-go/            # Morning briefing
│   ├── ops-inbox/         # Unified inbox
│   ├── ops-comms/         # Cross-channel messaging
│   ├── ops-merge/         # Autonomous PR pipeline
│   ├── ops-fires/         # Production incidents
│   ├── ops-deploy/        # Deploy status
│   ├── ops-revenue/       # Cost tracking
│   ├── ops-projects/      # Portfolio dashboard
│   ├── ops-linear/        # Sprint management
│   ├── ops-triage/        # Issue triage
│   ├── ops-next/          # Next action advisor
│   ├── ops-yolo/          # YOLO autonomous mode
│   └── setup/             # Interactive setup wizard
├── agents/                # 9 autonomous agents
│   ├── yolo-ceo.md        # CEO synthesizer (Opus)
│   ├── yolo-cto.md        # CTO technical analysis
│   ├── yolo-cfo.md        # CFO financial analysis
│   ├── yolo-coo.md        # COO operations analysis
│   ├── triage-agent.md    # Issue investigation + fix
│   ├── comms-scanner.md   # Inbox state scanner
│   ├── infra-monitor.md   # Infrastructure health
│   ├── project-scanner.md # Project portfolio scanner
│   └── revenue-tracker.md # Revenue/cost monitor
├── bin/                   # Shell scripts for data gathering
├── hooks/                 # SessionStart health check
├── telegram-server/       # Bundled MCP server (gram.js)
├── scripts/               # Setup scripts + project registry
└── .mcp.json              # MCP server declarations
```

---

## Contributing

PRs welcome. See [`claude-ops/README.md`](./claude-ops/README.md) for detailed documentation on each skill, agent, and integration.

```bash
# Development mode — load plugin from local directory
claude --plugin-dir ./claude-ops

# Reload after changes
/reload-plugins
```

## License

[MIT](./claude-ops/LICENSE) — built by [Lifecycle Innovations Limited](https://github.com/Lifecycle-Innovations-Limited)
