---
name: claude-ops
version: "2.0"
description: >
  Business operating system for OpenClaw. 56 skills for morning briefings,
  unified inbox, PR management, infrastructure monitoring, revenue tracking,
  and autonomous agents. Ported from claude-ops to OpenClaw best practices.
triggers:
  - "ops"
  - "claude-ops"
  - "business os"
usable_tools:
  - exec
  - read
  - edit
  - write
  - web_fetch
  - web_search
  - kimi_search
  - kimi_fetch
  - browser
  - message
  - sessions_spawn
  - g-brain__query
  - g-brain__search
  - g-brain__get_page
  - g-brain__put_page
  - g-brain__list_pages
  - g-brain__think
  - feishu_calendar_event
  - feishu_task_task
  - feishu_im_user_search_messages
  - feishu_im_user_get_messages
---

# claude-ops for OpenClaw v2.0

## Overview

Complete business operating system with **56 skills** across 6 categories:

| Category | Skills | Description |
|----------|--------|-------------|
| Daily Ops | 6 | Morning briefing, inbox, merge, dashboard |
| Project & Eng | 9 | Projects, Linear, deploy, monitor, triage |
| Business | 9 | Revenue, ecom, marketing, competitors |
| Automation | 6 | YOLO agents, orchestration, socials |
| Maintenance | 10 | Doctor, speedup, update, credentials |
| Utilities | 16 | Mac, home, fleet, AWS audit, shipping |

## Quick Start

```
/ops:setup    # Run setup wizard
/ops:go       # Morning briefing
/ops:status   # System health
```

## All Commands

### Daily Ops
- `ops:go` — Morning briefing
- `ops:inbox` — Unified inbox
- `ops:merge` — PR pipeline
- `ops:next` — Priority action
- `ops:dash` — Visual dashboard
- `ops:recap` — Session digest

### Project & Engineering
- `ops:projects` — Portfolio
- `ops:linear` — Sprint board
- `ops:triage` — Issue triage
- `ops:fires` — Incidents
- `ops:deploy` — Deployments
- `ops:deploy-fix` — Auto-fix
- `ops:monitor` — APM metrics
- `ops:feature-dev` — Feature dev
- `ops:test` — Test suite

### Business
- `ops:revenue` — MRR snapshot
- `ops:ecom` — Shopify ops
- `ops:marketing` — Marketing metrics
- `ops:gtm` — Go-to-market
- `ops:competitors` — Competitor intel
- `ops:leadgen` — Lead gen
- `ops:voice` — Voice calls
- `ops:package` — Shipping
- `ops:accounts` — CRM

### Automation
- `ops:yolo` — C-suite agents
- `ops:orchestrate` — Parallel engine
- `ops:whatsapp-biz` — WA Business
- `ops:daemon` — Background svcs
- `ops:socials` — Social media
- `ops:social-planner` — Content planner

### Maintenance
- `ops:doctor` — Auto-repair
- `ops:speedup` — Optimize
- `ops:status` — Health check
- `ops:update` — Update plugin
- `ops:uninstall` — Remove
- `ops:credentials` — Secrets
- `ops:secret-sync` — Sync secrets
- `ops:settings` — Configure
- `ops:integrate` — Add service
- `ops:mcp` — MCP servers

### Utilities
- `ops:comms` — Communications
- `ops:mac` — macOS tools
- `ops:home` — Home automation
- `ops:fleet` — Device mgmt
- `ops:unifi` — Network
- `ops:ar` — AR utils
- `ops:desk` — Workspace
- `ops:pocket` — Read-later
- `ops:aws-audit` — AWS audit
- `ops:release` — Releases
- `ops:resume` — Recovery
- `ops:rotate` — Acc rotation
- `ops:rotate-setup` — Setup rot
- `ops:ship` — Shipping
- `ops:statusline` — Terminal
- `ops:tonight` — Evening wrap

## Telegram Commands

All ops commands available as `/ops_*` bot commands:
- `/ops` — Dashboard
- `/ops_go` — Morning briefing
- `/ops_status` — Health check
- `/ops_inbox` — Unified inbox
- `/ops_task` — Task management
- ... (51 total commands)

## Architecture

### OpenClaw Port Differences

| Original | OpenClaw Port |
|----------|---------------|
| Claude Code plugin system | Native SKILL.md |
| launchd daemon | OpenClaw cron |
| Local markdown files | g-brain + mem-zero |
| Custom MTProto server | OpenClaw channels |
| Claude subagents | sessions_spawn |
| macOS Keychain | OpenClaw secrets |

### Data Flow

```
User → Telegram/WhatsApp → OpenClaw Gateway
                                ↓
                    Skill Router (claude-ops)
                                ↓
                    Skill Execution (56 skills)
                                ↓
                    Tools (exec, web, brain, etc.)
                                ↓
                    Response → User
```

## Configuration

Stored in `skills/claude-ops/config.md`:

```yaml
owner: Sam Feldt
timezone: Europe/Amsterdam
channels:
  telegram: ✅
  whatsapp: ✅
  email: ⚠️
projects:
  - Healify (P0)
  - RYTEBOX (P1)
  - Brand Relaunch (P1)
integrations:
  g-brain: ✅
  mem-zero: ✅
  github: ✅
  feishu: ✅
```

## Setup

```bash
# Run setup wizard
/ops:setup

# Or manually:
1. Configure owner info
2. Connect channels
3. Add service credentials
4. Register projects
5. Test with /ops:go
```

## Roadmap

- [x] Core 56 skills
- [x] Telegram bot commands (51)
- [x] Setup wizard
- [ ] Morning briefing implementation
- [ ] Unified inbox aggregation
- [ ] Project dashboard
- [ ] Deployment tracking
- [ ] Revenue monitoring
- [ ] Competitor intelligence
- [ ] C-suite autonomous agents

## License

MIT — ported from https://github.com/Lifecycle-Innovations-Limited/claude-ops
