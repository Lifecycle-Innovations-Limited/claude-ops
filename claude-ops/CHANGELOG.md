# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed — public-repo hygiene pass

- **Scrubbed `scripts/registry.json` from all git history** via `git filter-repo` + force-push. The file contained real project data (paths, repo slugs, revenue stages, infra topology) and was tracked in the repo since day one. Now gitignored, with `scripts/registry.example.json` as a starter template.
- **Removed `.planning/` from tracked files** (`git rm -r --cached`). Previously leaked internal phase docs, ROADMAP.md, STATE.md, PROJECT.md. Gitignored going forward.
- **Refactored hardcoded project references to registry-driven iteration** in 7 files: `agents/yolo-cto.md`, `agents/yolo-coo.md`, `agents/infra-monitor.md`, `agents/triage-agent.md`, `agents/comms-scanner.md`, `skills/ops-deploy/SKILL.md`, `skills/ops-triage/SKILL.md`, `skills/ops-next/SKILL.md`, `skills/ops-projects/SKILL.md`. All loops now read `.projects[].repos[]` / `.paths[]` / `.infra.ecs_clusters[]` / `.infra.health_endpoints[]` from `scripts/registry.json` (with `registry.example.json` fallback). Sensible defaults shown in example tables use `example-app` / `example-api` instead of real project names.
- **Removed hardcoded personal data**: `sam.renders@gmail.com` in `agents/comms-scanner.md` replaced with preferences-driven `channels.email.account`. Hardcoded home-dir fallback `/Users/samrenders/Projects/claude-ops` removed from `skills/setup/SKILL.md` detector invocation.
- **Rewrote README installation section** to reflect marketplace-plugin install flow (`/plugin marketplace add` + `/plugin`), not manual `git clone` + `settings.json` editing.
- **Rewrote README Telegram section** to match the v0.2.0 user-auth rewrite (gram.js MTProto) with API ID / API hash / phone / session flow instead of obsolete Bot API token flow.
- **Bumped `marketplace.json` to 0.2.1** to match `plugin.json`.
- Registered `.gitignore` superset: `node_modules/`, `.env*`, editor swap files, `.planning/`, `.claude/worktrees/`, `.DS_Store`, `*.log`, `scripts/preferences.json`, `scripts/registry.json`.

### Added

#### Interactive setup wizard (`/ops:setup`)
- `skills/setup/SKILL.md` — end-to-end config wizard with `AskUserQuestion` selectors
- `bin/ops-setup-detect` — JSON state probe (tools, env vars, MCPs, registry, prefs)
- `bin/ops-setup-install` — idempotent Homebrew/apt installer for CLI dependencies
- `~/.claude/plugins/data/ops-ops-marketplace/preferences.json` — owner, timezone, verbosity, default channels, channel secrets. Lives in Claude Code's per-plugin data dir so it survives reinstalls and version bumps; never stored in the plugin source tree.
- Routes `setup|configure|init|install` in the `/ops` command router

#### WhatsApp auto-heal (Step 3b of wizard)
- Detects stuck `wacli sync` processes via stale store lock + age check
- Detects app-state key desync via `wacli sync` stderr probe (the `didn't find app state key` error class)
- Offers to kill stale sync / logout + re-pair interactively
- Automatic historical backfill via `wacli history backfill` on top 10 most-recent chats after a successful heal

#### Email + Calendar with MCP fallback
- **Email**: primary `gog` CLI (full read + send); fallback Claude Gmail MCP connector (read-only until user grants send perms in Claude Desktop → Connectors)
- **Calendar**: primary `gog cal` (shared gog OAuth token); fallback Google Calendar MCP connector (read-only until user grants write perms in Claude Desktop)
- Both record the chosen backend in the plugin-data `preferences.json` (`channels.email`, `channels.calendar`) so downstream skills (`/ops-go`, `/ops-next`, `/ops-fires`) can cross-correlate with today's schedule

## [0.1.0] — 2026-04-11

### Added

#### Phase 1: Plugin Scaffold + Registry
- `scripts/registry.example.json` — template for the per-user project registry (aliases, paths, repos, infra, revenue stage, GSD flag). Real `scripts/registry.json` is gitignored.
- `bin/ops-unread` — parallel unread counts for WhatsApp, Email, Slack, Telegram
- `bin/ops-git` — git status across all registry projects
- `bin/ops-prs` — open PRs across all registered GitHub repos
- `bin/ops-ci` — CI failures (last 24h) from GitHub Actions
- `bin/ops-infra` — ECS cluster and service health from AWS
- `bin/ops-gather` — meta-runner for all gather scripts

#### Phase 2: Morning Briefing
- `skills/ops-go/SKILL.md` — token-efficient morning briefing using `!` shell injection
- Pre-gathers all data in <10 seconds before model reads context
- Unified business dashboard with prioritized actions

#### Phase 3: Communications Hub
- `skills/ops-inbox/SKILL.md` — inbox zero across WhatsApp, Email, Slack, Telegram
- `skills/ops-comms/SKILL.md` — send/read routing with natural language parsing
- Telegram MCP integration (mcp__claude_ops_telegram__*)

#### Phase 4: Project Management
- `skills/ops-projects/SKILL.md` — portfolio dashboard with GSD state, CI, PRs
- `skills/ops-linear/SKILL.md` — Linear sprint board, issue management, GSD sync
- `skills/ops-triage/SKILL.md` — cross-platform triage (Sentry + Linear + GitHub)
- `skills/ops-fires/SKILL.md` — production incidents dashboard with agent dispatch
- `skills/ops-deploy/SKILL.md` — ECS + Vercel + GitHub Actions deploy status

#### Phase 5: Business Intelligence
- `skills/ops-revenue/SKILL.md` — AWS costs, credits, revenue pipeline, runway
- `skills/ops-next/SKILL.md` — priority-ordered next action (fires > comms > PRs > sprint > GSD)

#### Phase 6: YOLO Mode
- `skills/ops-yolo/SKILL.md` — 4-agent C-suite analysis + autonomous mode
- `agents/yolo-ceo.md` — Strategic analysis agent (claude-opus-4-5)
- `agents/yolo-cto.md` — Technical health agent (claude-sonnet-4-5)
- `agents/yolo-cfo.md` — Financial analysis agent (claude-sonnet-4-5)
- `agents/yolo-coo.md` — Operations execution agent (claude-sonnet-4-5)

#### Phase 7: Telegram MCP Server
- `telegram-server/index.js` — minimal MCP server using Telegram Bot API
- Tools: `send_message`, `get_updates`, `list_chats`
- `telegram-server/package.json` — @modelcontextprotocol/sdk dependency
- `.mcp.json` — Claude Code MCP server registration

#### Supporting Agents
- `agents/comms-scanner.md` — background comms monitoring agent
- `agents/infra-monitor.md` — infrastructure health monitoring agent
- `agents/project-scanner.md` — project state analysis agent
- `agents/revenue-tracker.md` — revenue and cost monitoring agent
- `agents/triage-agent.md` — issue triage and fix dispatch agent
