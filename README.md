```
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗       ██████╗ ██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝      ██╔═══██╗██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗  █████╗██║   ██║██████╔╝███████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ╚════╝██║   ██║██╔═══╝ ╚════██║
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗      ╚██████╔╝██║     ███████║
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝       ╚═════╝ ╚═╝     ╚══════╝
```

<div align="center">

**Business Operating System for Claude Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./claude-ops/LICENSE)
[![Version](https://img.shields.io/badge/version-0.8.0-blue.svg)](https://github.com/Lifecycle-Innovations-Limited/claude-ops/releases)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet.svg)](https://claude.ai/settings/plugins)

</div>

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  /ops:go  ►  MORNING BRIEFING                              2026-04-12  09:03 │
├─────────────────────────────────┬────────────────────────────────────────────┤
│  INFRA    ████████████████  ok  │  ECS: 4/4 healthy  RDS: ok  Redis: ok     │
│  CI/CD    ████████████░░░░  75% │  3 passing  1 failing  (my-api #847)  │
│  INBOX    ░░░░░░░░░░░░░░░░  14  │  Slack: 9  Telegram: 3  Gmail: 2 unread   │
│  PRs      ████████████████  3   │  3 ready to merge  1 needs review          │
│  SPRINT   ████████████░░░░  67% │  Sprint 24  —  8 of 12 issues complete     │
│  REVENUE  ████████████████  $   │  $2,847 MTD  ↑12% vs last month           │
├─────────────────────────────────┴────────────────────────────────────────────┤
│  Next action: merge feat/user-profile  ·  fix my-api CI  ·  reply @alice    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

One command. Sixty seconds. Your entire business, at a glance.

Turn Claude Code into a complete business operating system — infrastructure health, CI/CD status, unified inbox, open PRs, sprint state, revenue snapshot, and autonomous agents that act on your behalf.

```
╔══════════════════════════════╗
║        QUICK  START          ║
╚══════════════════════════════╝
```

```bash
# 1. Add the marketplace
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops

# 2. Install the plugin
/plugin install ops@lifecycle-innovations-limited-claude-ops

# 3. Configure your integrations (guided wizard)
/ops:setup
```

> The setup wizard walks through each integration interactively — install CLIs, connect channels, build your project registry. All credentials stored locally, never transmitted.

**Local development:**

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
claude --plugin-dir ./claude-ops
```

```
╔══════════════════════════════╗
║         COMMAND  SET         ║
╚══════════════════════════════╝
```

```
┌────────────────┬─────────────────────────────────────────────┬──────────────────────────────────┐
│  COMMAND       │  WHAT IT DOES                               │  INTEGRATIONS                    │
├────────────────┼─────────────────────────────────────────────┼──────────────────────────────────┤
│  /ops:go       │  Full morning briefing — one cmd, 60s       │  GitHub, Linear, Sentry, AWS     │
│  /ops:inbox    │  Unified inbox — read + triage all channels │  Slack, Telegram, WhatsApp, Gmail│
│  /ops:merge    │  Autonomous PR review + merge pipeline      │  GitHub Actions, GitHub CLI      │
│  /ops:comms    │  Send/read messages across any channel      │  Slack, Telegram, WhatsApp, Gmail│
│  /ops:fires    │  Production incidents + ECS health          │  AWS ECS, Sentry                 │
│  /ops:revenue  │  AWS spend, credits, runway estimate        │  AWS Cost Explorer               │
│  /ops:projects │  Portfolio dashboard — all projects         │  GitHub, Linear                  │
│  /ops:linear   │  Sprint board + issue management            │  Linear                          │
│  /ops:deploy   │  Deploy status across all projects          │  AWS ECS, Vercel, GitHub Actions │
│  /ops:triage   │  Cross-platform issue triage                │  Sentry, Linear, GitHub Issues   │
│  /ops:next     │  Priority-ranked "what should I do next"    │  Everything                      │
│  /ops:yolo     │  4 parallel C-suite AI agents — autonomous  │  Everything                      │
└────────────────┴─────────────────────────────────────────────┴──────────────────────────────────┘
```

```
╔══════════════════════════════╗
║       BEFORE  /  AFTER       ║
╚══════════════════════════════╝
```

```
┌────────────────────────────────────────────┬──────────────────────────────────────────────┐
│  WITHOUT claude-ops                        │  WITH claude-ops                             │
├────────────────────────────────────────────┼──────────────────────────────────────────────┤
│  Open 6+ tabs every morning                │  /ops:go  ——  one command, done              │
│  Context-switch between Slack/Telegram/    │  /ops:inbox  ——  unified view, all channels  │
│  email                                     │                                              │
│  Manually review and merge PRs one by one  │  /ops:merge  ——  autonomous pipeline         │
│  SSH into servers to check health          │  /ops:fires  ——  terminal dashboard          │
│  Forget to track AWS spend                 │  /ops:revenue  ——  automatic cost snapshot   │
│  Switch between Linear and GitHub          │  /ops:linear + /ops:projects  ——  unified    │
└────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

```
╔══════════════════════════════╗
║         REQUIREMENTS         ║
╚══════════════════════════════╝
```

Just [Claude Code](https://claude.ai/code) 1.0+. Everything else is installed automatically.

The setup wizard (`/ops:setup`) walks you through each integration interactively — "Do you want AWS CLI? [Yes/No]", "Connect Slack? [OAuth/Skip]", etc. Missing CLIs are auto-installed via Homebrew. MCP servers connect via OAuth. No config files to edit manually.

```
╔══════════════════════════════════════════╗
║      INTEGRATIONS: MCP  vs  CLI          ║
╚══════════════════════════════════════════╝
```

Most integrations offer two paths. The setup wizard lets you choose per-integration.

```
┌─────────────┬──────────────────────────────────┬────────────────────┬───────────────────────────────────────────────────────────────────┐
│  SERVICE    │  MCP (zero-config OAuth)          │  + CLI tool        │  WHAT YOU LOSE WITHOUT THE CLI                                    │
├─────────────┼──────────────────────────────────┼────────────────────┼───────────────────────────────────────────────────────────────────┤
│  GitHub     │  —                               │  gh  (auto)        │  EVERYTHING — CI logs, PR merge, issue triage all require gh      │
│  AWS        │  —                               │  aws  (auto)       │  EVERYTHING — ECS health, cost tracking, revenue are CLI-only     │
│  Linear     │  OAuth via Claude.ai  (12 tools) │  —                 │  Nothing — fully covered. 12 tools across 6 skills                │
│  Vercel     │  OAuth via Claude.ai             │  —                 │  Nothing — deploy status, build logs, runtime logs via MCP        │
│  Slack      │  OAuth via Claude.ai             │  local bot token   │  MCP covers most users. Token adds: unlimited search, private ch  │
│  Gmail      │  OAuth via Claude.ai  (read)     │  gog  (send+archive│  MCP = read-only. CLI enables autonomous send + archive           │
│  Calendar   │  OAuth via Claude.ai  (full)     │  gog  (read-only)  │  MCP has MORE features. Either works for briefings                │
│  Sentry     │  OAuth via Claude.ai             │  sentry-cli        │  MCP covers triage. CLI adds: source maps, release tracking       │
│  WhatsApp   │  —                               │  wacli             │  EVERYTHING — no MCP exists. wacli is the only path               │
│  Telegram   │  —                               │  bundled MCP server│  EVERYTHING — plugin ships its own MTProto server. Fully automated │
│  GSD        │  —                               │  auto-detected     │  Optional — roadmap state in dashboards. Skills degrade gracefully │
└─────────────┴──────────────────────────────────┴────────────────────┴───────────────────────────────────────────────────────────────────┘
```

> **TL;DR** — Linear and Vercel are MCP-only (and that's fine). GitHub and AWS are CLI-only (auto-installed). Gmail is where the choice matters most: MCP gives you read-only, CLI gives you full autonomous inbox management.

```
╔══════════════════════════════╗
║         ARCHITECTURE         ║
╚══════════════════════════════╝
```

**Token Efficiency**

All skills use pre-execution shell blocks (`!` fences) that gather data *before* the model context loads — zero extra latency, minimal token overhead.

**Plugin Structure**

> **Why the nested `claude-ops/claude-ops/` directory?** Claude Code's plugin marketplace system requires a two-level layout: the **repo root** acts as a marketplace container (with `.claude-plugin/marketplace.json` pointing `"source": "./claude-ops"`), while the **inner directory** is the actual plugin root (with `.claude-plugin/plugin.json`, skills, agents, etc.). This is how Claude Code resolves and caches plugins — it cannot be flattened.

```
claude-ops/                        ← marketplace root (repo)
├── .claude-plugin/
│   └── marketplace.json           # Points to ./claude-ops as the plugin source
├── README.md                      # This file
│
└── claude-ops/                    ← plugin root (where Claude Code loads from)
    ├── .claude-plugin/
    │   └── plugin.json            # Plugin manifest + userConfig schema
    │
    ├── skills/                    # 14 slash command skills
    │   ├── ops/                   # Router — dispatches to sub-skills
    │   ├── ops-go/                # Morning briefing
    │   ├── ops-inbox/             # Unified inbox
    │   ├── ops-comms/             # Cross-channel messaging
    │   ├── ops-merge/             # Autonomous PR pipeline
    │   ├── ops-fires/             # Production incidents
    │   ├── ops-deploy/            # Deploy status
    │   ├── ops-revenue/           # Cost tracking
    │   ├── ops-projects/          # Portfolio dashboard
    │   ├── ops-linear/            # Sprint management
    │   ├── ops-triage/            # Issue triage
    │   ├── ops-next/              # Next action advisor
    │   ├── ops-yolo/              # YOLO autonomous mode
    │   └── setup/                 # Interactive setup wizard
    │
    ├── agents/                    # 9 autonomous agents
    ├── bin/                       # Shell scripts + ops-shopify-create
    ├── hooks/                     # SessionStart health check
    ├── telegram-server/           # Bundled MCP server (gram.js)
    ├── templates/                 # App scaffolding templates
    ├── tests/                     # Bash-based validation suite
    ├── scripts/                   # Setup scripts + project registry
    ├── CLAUDE.md                  # Plugin-root rules
    └── .mcp.json                  # MCP server declarations
```

```
╔══════════════════════════════╗
║          CONTRIBUTING        ║
╚══════════════════════════════╝
```

PRs welcome. See [`claude-ops/README.md`](./claude-ops/README.md) for detailed documentation on each skill, agent, and integration.

```bash
# Development mode — load plugin from local directory
claude --plugin-dir ./claude-ops

# Reload after changes
/reload-plugins
```

```
╔══════════════════════════════╗
║            LICENSE           ║
╚══════════════════════════════╝
```

[MIT](./claude-ops/LICENSE) — built by [Lifecycle Innovations Limited](https://github.com/Lifecycle-Innovations-Limited)

```
─────────────────────────────────────────────────────────────────────────────
  claude-ops  v0.8.0  ·  MIT  ·  github.com/Lifecycle-Innovations-Limited
─────────────────────────────────────────────────────────────────────────────
```
