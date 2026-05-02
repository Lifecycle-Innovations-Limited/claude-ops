# claude-ops

> **v2.0.9** — Autonomy Layer · Deploy Auto-Fix · Safety Hooks · Specialist Agents · Recap Marquee · Multi-Account Rotator · Multi-Workspace Slack · ops-ci Current-State Filter · Credentials Audit · 35 Skills · 18 Agents

## What's new since v2.0.0

- **v2.0.9** — ops-ci current-state filter (57% noise reduction in `/ops:fires`); MANDATORY pre-dispatch staleness check in ops-fires SKILL
- **v2.0.8** — multi-workspace Slack support; userConfig schema fixes
- **v2.0.7** — Telegram keychain fallback + SSE/user-config preflight
- **v2.0.6** — `/ops:credentials` audit skill + plugin.json field hints
- **v2.0.5** — userConfig enums + per-integration toggles

A Claude Code plugin that turns Claude into a business operating system **and** an autonomy layer. Run `/ops` for the interactive command center — pixel-art dashboard with instant hotkey access to morning briefings, inbox, fires, deploys, revenue, and YOLO mode. Or just keep working — v2's hooks watch every merge, every build, every commit, every push, and every agent dispatch in the background.

---

## What's new in v2.0

Purely additive — no v1 behaviour changes by default. Full migration guide: [`docs/migrating-from-v1.md`](docs/migrating-from-v1.md). Full changelog: [`CHANGELOG.md`](CHANGELOG.md#200--2026-04-26).

### v2 capability matrix

| Subsystem | Trigger | Outcome | Skill | userConfig | Doc |
|-----------|---------|---------|-------|------------|-----|
| Post-merge deploy auto-fix | `gh pr merge *` | Watches deploy → audits `/health` → verifies `/version` SHA → dispatches Haiku `deploy-fixer` on failure | [`/ops:deploy-fix`](skills/ops-deploy-fix/SKILL.md) | `deploy_fix_enabled` (default `true`) + 14 more | [deploy-fix.md](docs/deploy-fix.md) |
| Build-failure auto-fix | `npm run build:*` | Dispatches Haiku `build-fixer` on failure | (same skill) | `monitor_build_failures` (default `true`) | [deploy-fix.md](docs/deploy-fix.md) |
| Specialized agent auto-suggestion | `Agent` tool with `subagent_type=general-purpose` | Silently swaps to matching specialist via `updatedInput` | (transparent) | `suggest_specialized_agents` (default `true`) | [agents.md](docs/agents.md) |
| Secret-commit guard | `git commit *` | Denies commit when staged diff contains secrets | (always-on) | — | [safety-hooks.md](docs/safety-hooks.md) |
| `rm -rf` anchor block | `rm -rf *` | Denies destructive paths (`/`, `~`, `$HOME`, `..`, `.`) | (always-on) | — | [safety-hooks.md](docs/safety-hooks.md) |
| Direct main-push warning | `git push *` on `main`/`master`/`prod` | `permissionDecision: ask` to confirm | (always-on) | — | [safety-hooks.md](docs/safety-hooks.md) |
| Task* tracking nudge | every Nth non-Task tool call | One-line `additionalContext` reminder | (transparent) | `task_reminder_enabled` (default `true`) | [CHANGELOG](CHANGELOG.md#4-universal-task-tracking-nudge) |
| Recap marquee | every 30s | Multi-session digest in tmux `status-right` / `statusLine` | [`/ops:recap`](skills/ops-recap/SKILL.md) | `recap_marquee_enabled` (default `true`) | [recap.md](docs/recap.md) |
| Multi-account Claude Max rotator | quota approaching cap | launchd daemon swaps `Claude Code-credentials` keychain entry to next account | [`/ops:rotate`](skills/ops-rotate/SKILL.md), [`/ops:rotate-setup`](skills/ops-rotate-setup/SKILL.md) | `account_rotation_enabled` (default `false` — opt-in) | [CHANGELOG](CHANGELOG.md#6-multi-account-claude-max-rotator) |

### v2 quick start — deploy auto-fix in 60 seconds

```bash
/plugin update ops@lifecycle-innovations-limited-claude-ops
/ops:setup                       # walks through new steps 2d, 3o, 6.5a–6.5d
/ops:deploy-fix configure        # map your repos → /health + /version URLs
# done — every future `gh pr merge` is now watched + verified + auto-fixed
/ops:deploy-fix                  # live status, today's runs, budget remaining
```

Per-repo budget caps (default 3/hour), single-flight locks, content-hash dedup, and a transient classifier (auto-`gh run rerun`s on npm/network blips instead of dispatching an agent) keep spend bounded. Notification channels: `macos`/`ntfy`/`pushover`/`discord`/`telegram`/`none`.

### v2 docs

- [`docs/deploy-fix.md`](docs/deploy-fix.md) — auto-fix architecture, registry, dedup/budget, troubleshooting, FAQ.
- [`docs/agents.md`](docs/agents.md) — pre-installed specialists + how to add your own + how the auto-suggestion hook works.
- [`docs/safety-hooks.md`](docs/safety-hooks.md) — the three safety hooks + per-hook disable.
- [`docs/recap.md`](docs/recap.md) — recap marquee daemon + tmux/`statusLine` setup.
- [`docs/migrating-from-v1.md`](docs/migrating-from-v1.md) — v1 → v2 (no breaking changes).
- [`docs/INDEX.md`](docs/INDEX.md) — full documentation index.

---

## Features

| Skill             | Description                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| `/ops`            | Interactive command center dashboard (visual HQ)                               |
| `/ops:dash`       | Same as `/ops` — pixel-art dashboard with hotkey navigation                    |
| `/ops:setup`      | Interactive setup wizard — installs CLIs, configures channels, builds registry |
| `/ops:go`         | Morning briefing — all systems in one dashboard                                |
| `/ops:next`       | Priority-ordered next action (fires > comms > PRs > sprint > GSD)              |
| `/ops:inbox`      | Inbox zero across WhatsApp, Email, Slack, Telegram, Notion                     |
| `/ops:comms`      | Send/read messages across all channels                                         |
| `/ops:projects`   | Portfolio dashboard — GSD phase, CI, PRs, dirty files                          |
| `/ops:linear`     | Linear sprint board, issue management, GSD sync                                |
| `/ops:triage`     | Cross-platform issue triage (Sentry + Linear + GitHub)                         |
| `/ops:fires`      | Production incidents dashboard with agent dispatch                             |
| `/ops:deploy`     | ECS + Vercel + GitHub Actions deploy status                                    |
| `/ops:revenue`    | AWS costs, credits, revenue pipeline, runway                                   |
| `/ops:merge`      | Auto-fix CI + merge all ready PRs                                              |
| `/ops:speedup`    | Cross-platform system optimizer (macOS/Linux/WSL)                              |
| `/ops:yolo`       | 4-agent C-suite analysis + autonomous mode                                     |
| `/ops:ecom`       | E-commerce operations — Shopify orders, inventory, fulfillment, analytics      |
| `/ops:marketing`  | Marketing analytics — email campaigns, ads (Meta/Google), SEO, social          |
| `/ops:voice`      | Voice channel management — Bland AI calls, ElevenLabs TTS, Whisper transcribe  |
| `/ops:orchestrate`| Autonomous multi-project work engine with parallel agents                      |
| `/ops:gtm`        | Cross-channel go-to-market planner (paid/unpaid/sales/automation)              |
| `/ops:package`    | Carrier-agnostic shipping (MyParcel/Sendcloud/DHL/PostNL/DPD/UPS/FedEx)        |
| `/ops:whatsapp-biz`| WhatsApp Business catalog, product, and order operations                      |
| `/ops:monitor`    | APM + metrics probe (Datadog/New Relic/OTEL)                                   |
| `/ops:integrate`  | Connect new external services to the plugin partner registry                   |
| `/ops:status`     | Current plugin + channel + daemon + registry health snapshot                   |
| `/ops:settings`   | View/edit preferences, toggle features, rotate credentials                     |
| `/ops:daemon`     | Start/stop/health for the launchd background daemon                            |
| `/ops:doctor`     | Plugin config auto-diagnosis and repair                                        |
| `/ops:uninstall`  | Clean removal — unload daemon, wipe cache, deregister marketplace              |
| `/ops:deploy-fix` | **v2** — Status/tail/configure/test for the post-merge + build auto-fix subsystem |
| `/ops:recap`      | **v2** — Status/tail/configure/restart for the multi-session recap marquee daemon |
| `/ops:rotate`     | **v2** — Manually rotate the active Claude Max account                         |
| `/ops:rotate-setup` | **v2** — Multi-account onboarding for the rotator                            |

### Dashboard hotkeys

The `/ops:dash` command center provides instant navigation:

```
 QUICK ACTIONS                    INTEL
 1 Morning briefing              6 Revenue & costs
 2 Inbox zero                    7 Linear sprint
 3 Fire check                    8 Deploy status
 4 Project dashboard             9 Triage issues
 5 What's next?                  0 System speedup

 POWER                           COMMS
 a YOLO mode                     d Send message
 b Auto-merge PRs                e C-suite reports
 c Setup wizard

 META
 f Settings & config             h Help / FAQ / Wiki
 g Share your setup              q Exit
```

## What's New in v1.7.0

### `/gtm` — cross-channel go-to-market planner
New strategy layer on top of `/ops:marketing`. Intakes audience, positioning, constraints, and targets, then generates a full plan across paid, unpaid, sales, and AI-automation avenues. Plan items hand off to `/ops:marketing` sub-commands via the `Skill` tool so credential resolution and API calls stay single-sourced. Approval gates are enforced for every paid or outbound action.

### `/ops:projects` — portfolio dashboard
Renders every project in your GSD registry with active phase, task count, dirty-file count, and open-PR status. Reads from `$OPS_DATA_DIR/registry.json` which is synced by the `gsd-registry-sync` daemon service every 5 minutes.

### `ops-speedup` v2 parity
Full feature parity with the legacy v1 bash script: `--gpu` reports GPU + Neural Engine utilization via `powermetrics` (macOS), `--power` surfaces top energy consumers from `top -o pmem` / `ps -eo`, `--os-actions` performs cross-platform kernel_task / WindowServer restarts and launchd/systemd service masking behind an allowlist.

### `ops-memory-extractor` — Claude Code OAuth
The background memory extractor now prefers the Claude Code OAuth token stored in macOS Keychain (`Claude Code-credentials`) over `ANTHROPIC_API_KEY`. Calls are billed against your Claude Max subscription instead of your API credit. The token is never exported to the shell environment, so parent terminal sessions stay unaffected. Falls back to `ANTHROPIC_API_KEY` (env → keychain → Doppler).

### Persistent WhatsApp follower
`whatsapp-bridge` (Baileys) now manages WhatsApp connectivity via the `com.samrenders.whatsapp-bridge` LaunchAgent. Previously `whatsapp-bridge-keepalive.sh` kept `whatsapp-bridge --follow` alive — that daemon has been decommissioned (see `legacy/`). Which tore down the persistent connection every 5-20 minutes. Fixed via `INITIAL_BACKFILL_DELAY=30` plus a reentrant guard against overlapping sweeps.

### Full Plugin Feature Adoption
- All 35 skills: `effort`, `maxTurns`, `disallowedTools`, `model` annotations
- All 18 agents: `memory` (cross-session learning), `initialPrompt`, `isolation`
- PreToolUse hooks for WhatsApp health checks and MCP auto-reconnect
- Runtime Context loading in every skill (preferences, daemon health, memories, secrets)
- CLI/API reference tables in all operational skills

## Requirements

- [Claude Code](https://claude.ai/code) 1.0+
- GitHub CLI (`gh`) — for PRs and CI status

Everything else is optional. The setup wizard (`/ops:setup`) auto-detects what's installed and configures accordingly.

### Integrations

The setup wizard (`/ops:setup`) walks through each one interactively. You choose per-integration whether to install the CLI, connect the MCP, or skip.

#### CLI-only (no MCP alternative)

| Tool | Auto-installed | What it does |
|------|---------------|--------------|
| `gh` (GitHub CLI) | Yes (Homebrew) | PRs, CI logs, issue triage, merge pipeline — used by 8+ skills |
| `aws` (AWS CLI) | Yes (Homebrew) | ECS health, Cost Explorer, CloudWatch — used by ops-fires, ops-revenue, ops-deploy |
| `whatsapp-bridge` (WhatsApp) | Bundled ([source](https://github.com/Lifecycle-Innovations-Limited/whatsapp-mcp)) | WhatsApp inbox, send/read, contact lookup via `mcp__whatsapp__*` tools |
| Node.js 18+ | Yes (Homebrew) | Runs the bundled Telegram MCP server |

#### MCP-only (no CLI needed)

| MCP | Connected via | What it does |
|-----|--------------|--------------|
| Linear | OAuth (Claude.ai) | Sprint cycles, issues, projects — 12 tools across 6 skills. Fully covers all Linear functionality |
| Vercel | OAuth (Claude.ai) | Deploy status, build logs, runtime logs. Read-only (deploys triggered via CI) |

#### Choose: MCP, CLI, or both

| Integration | MCP path | CLI path | What you lose with MCP only |
|-------------|----------|----------|----------------------------|
| **Gmail** | Claude.ai OAuth — read threads, create drafts | `gog` CLI — full send, archive, label management | MCP **cannot send emails** (drafts only) and **cannot archive**. `/ops:inbox` autonomous mode requires `gog` |
| **Google Calendar** | Claude.ai OAuth — list, create, RSVP, find free time | `gog cal` — read today's events | MCP has *more* features. `gog` is simpler for read-only briefing context. Either works |
| **Slack** | Claude.ai OAuth — read, send, search | Local bot token via `ops-slack-autolink` | MCP has **quota limits**. Local token gives unlimited search + private channel access without bot membership |
| **Sentry** | Claude.ai OAuth — issue search, triage, resolve | `sentry-cli` — releases, source maps, deploy tracking | Current skills only use search/triage (MCP is fine). CLI adds release management (not used yet) |

#### Plugin-bundled

| Integration | What it is | Setup |
|-------------|-----------|-------|
| Telegram MCP server | gram.js MTProto user-auth — reads your DMs (not a bot) | `/ops:setup telegram` — enter phone number + 2 verification codes, everything else is fully automated (app creation, session generation, keychain storage) |
| [GSD](https://github.com/gsd-build/get-shit-done) | Project roadmap state in dashboards | Auto-detected. Skills degrade gracefully without it |

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

After the wizard finishes, it automatically writes the credentials to the MCP config — no manual pasting required. Just restart Claude Code to activate the Telegram MCP server.

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

```
┌─────────────────────────────────────────────────┐
│                  Claude Code                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Skills   │ │  Agents  │ │     Hooks        │ │
│  │  (30)     │ │  (14)    │ │  PreToolUse      │ │
│  │  /ops:*   │ │  yolo-*  │ │  SessionStart    │ │
│  └────┬──────┘ └────┬─────┘ │  Stop            │ │
│       │              │       └──────────────────┘ │
│       ▼              ▼                            │
│  ┌─────────────────────────────────────────────┐ │
│  │           Runtime Context Layer              │ │
│  │  preferences.json · daemon-health.json      │ │
│  │  memories/ · secrets (Doppler/vault)         │ │
│  └──────────────────────┬──────────────────────┘ │
└─────────────────────────┼────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────┐
│              ops-daemon (launchd)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ bridge  │ │ memory   │ │   brain layer    │ │
│  │ sync     │ │ extractor│ │ briefing cache   │ │
│  │ (follow) │ │ (cron)   │ │ urgent detect    │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└──────────────────────────────────────────────────┘
```

### Token Efficiency

All `ops-*` skills use the `!` shell injection pattern:

````markdown
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{}'
```
````

This runs shell scripts *before* the model context is loaded, so data is pre-gathered with zero extra latency.

### Agent Files

| Agent | Purpose |
|-------|---------|
| `agents/comms-scanner.md` | Background comms monitoring |
| `agents/infra-monitor.md` | Infrastructure health monitoring |
| `agents/project-scanner.md` | Project state analysis |
| `agents/revenue-tracker.md` | Revenue and cost monitoring |
| `agents/triage-agent.md` | Issue triage and fix dispatch (worktree-isolated) |
| `agents/daemon-agent.md` | Daemon start/stop/health management |
| `agents/doctor-agent.md` | Plugin config diagnosis and auto-repair |
| `agents/memory-extractor.md` | Contact profile and context extraction (Haiku, prefers Claude Code OAuth) |
| `agents/marketing-optimizer.md` | Parses marketing-dash output and proposes next-step campaigns |
| `agents/monitor-agent.md` | APM/metrics probe (Datadog/New Relic/OTEL) |
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

## Contributing

PRs welcome. See [`docs/`](docs/) for reference documentation:

- [`docs/skills-reference.md`](docs/skills-reference.md) — every skill, its triggers, and what it does
- [`docs/agents-reference.md`](docs/agents-reference.md) — agents and their tool surfaces
- [`docs/daemon-guide.md`](docs/daemon-guide.md) — background brain: services, cron, health
- [`docs/memories-system.md`](docs/memories-system.md) — long-term memory store + extraction
- [`docs/os-compatibility.md`](docs/os-compatibility.md) — macOS/Linux/WSL/Windows support matrix, per-channel install paths, credential cascade, daemon registration
- [`docs/marketplace-submissions.md`](docs/marketplace-submissions.md) — submission status across platform.claude.com, buildwithclaude.com, aitmpl.com, claudemarketplaces.com

Cross-platform support is tested in CI via [`.github/workflows/cross-os.yml`](.github/workflows/cross-os.yml) (ubuntu-latest, macos-latest, windows-latest).

## License

MIT — see [LICENSE](LICENSE)
