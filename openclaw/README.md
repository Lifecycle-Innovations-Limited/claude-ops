# claude-ops for OpenClaw

> OpenClaw port of the claude-ops business operating system

## Overview

This is a complete port of [claude-ops](https://github.com/Lifecycle-Innovations-Limited/claude-ops) 
to [OpenClaw](https://github.com/openclaw/openclaw), bringing 56 business operating system skills 
to the OpenClaw ecosystem.

## What's Included

- **56 skills** across 6 categories
- **51 Telegram bot commands**
- **Morning briefings** (ops:go)
- **Unified inbox** (ops:inbox)
- **Project dashboard** (ops:projects)
- **Revenue tracking** (ops:revenue)
- **Infrastructure monitoring** (ops:monitor)
- **Competitor intelligence** (ops:competitors)
- **Autonomous agents** (ops:yolo)
- **...and 49 more**

## Installation

### Prerequisites
- [OpenClaw](https://docs.openclaw.ai) installed and running
- Telegram bot configured (optional)
- g-brain and mem-zero connections (optional)

### Quick Install

```bash
# Clone the port
git clone https://github.com/auroracapital/claude-ops.git
cd claude-ops/openclaw

# Copy skills to OpenClaw workspace
cp -r skills/* ~/.openclaw/workspace/skills/

# Verify installation
openclaw skills check
```

### Telegram Commands

All commands are available via `/ops_*` bot commands:

| Command | Description |
|---------|-------------|
| `/ops` | Main dashboard |
| `/ops_go` | Morning briefing |
| `/ops_status` | System health |
| `/ops_inbox` | Unified inbox |
| `/ops_task` | Task management |
| `/ops_projects` | Portfolio view |
| `/ops_revenue` | Revenue snapshot |
| `/ops_deploy` | Deployment status |
| `/ops_monitor` | Infrastructure |
| `/ops_competitors` | Competitor intel |

## Configuration

Run the setup wizard:

```
/ops:setup
```

Or manually edit `skills/claude-ops/config.md`:

```yaml
owner: Your Name
timezone: Europe/Amsterdam
projects:
  - name: Project 1
    status: active
    priority: P0
```

## Architecture

```
Original claude-ops (Claude Code)  →  OpenClaw Port
─────────────────────────────────────────────────────
62 skills                          →  56 skills (core)
Claude Code plugin system          →  Native SKILL.md
launchd daemon (macOS)             →  OpenClaw cron/heartbeat
Local markdown files               →  g-brain + mem-zero
Custom MTProto server              →  OpenClaw channels
Claude subagents                   →  sessions_spawn
macOS Keychain                     →  OpenClaw secrets
```

## Skills Reference

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
- `ops:deploy` — Deployments
- `ops:monitor` — APM metrics
- `ops:fires` — Incidents
- `ops:triage` — Issue triage

### Business
- `ops:revenue` — MRR snapshot
- `ops:ecom` — Shopify ops
- `ops:marketing` — Marketing metrics
- `ops:gtm` — Go-to-market
- `ops:competitors` — Competitor intel
- `ops:leadgen` — Lead generation

### Automation
- `ops:yolo` — C-suite agents
- `ops:orchestrate` — Parallel engine
- `ops:socials` — Social media
- `ops:daemon` — Background services

### Maintenance
- `ops:doctor` — Auto-repair
- `ops:speedup` — Performance
- `ops:status` — Health check
- `ops:update` — Update plugin

### Utilities
- `ops:mac` — macOS tools
- `ops:home` — Home automation
- `ops:aws-audit` — AWS audit
- `ops:voice` — Voice calls
- `ops:ship` — Shipping

## Contributing

1. Fork the repository
2. Create a feature branch
3. Test your changes with OpenClaw
4. Submit a pull request

## License

MIT — see [LICENSE](../LICENSE)

## Credits

- Original claude-ops by [Lifecycle Innovations Limited](https://github.com/Lifecycle-Innovations-Limited)
- OpenClaw port by [Sam Feldt](https://github.com/auroracapital)
