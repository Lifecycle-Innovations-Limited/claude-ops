# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-04-11

### Added

#### Phase 1: Plugin Scaffold + Registry
- `scripts/registry.json` — 19-project registry with aliases, paths, repos, infra, revenue stage, GSD flag
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
