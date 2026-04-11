# claude-ops

## Vision
A Claude Code plugin that turns any terminal session into a business command center. Manages communications (WhatsApp, Email, Slack, Telegram), keeps projects on track (Linear + GSD integration), monitors infrastructure, tracks revenue, and includes a YOLO mode that acts as your interim C-suite for a day.

## Type
Claude Code Plugin (publishable to marketplace)

## Tech Stack
- Shell scripts (bin/ executables for token-efficient data gathering)
- SKILL.md files (Claude Code skill system)
- Agent definitions (markdown subagent specs)
- Node.js MCP server (Telegram integration)
- JSON configuration (project registry)

## Architecture
- `/ops` skill family — business operations layer
- `/gsd-*` as prerequisite — project execution layer
- `bin/` scripts run BEFORE Claude sees data (80% token savings via `!`command`` injection)
- `registry.json` — single config file for all projects (paths, repos, infra, revenue)
- 4 C-suite agents for YOLO mode (CEO, CTO, CFO, COO)

## Non-Negotiables
- Token efficiency: shell pre-gathers, Claude analyzes
- Every skill ends with clear a/b/c interactive options
- YOLO mode tells hard truths, no sugar-coating
- GSD integration: ops decides WHAT, gsd decides HOW
- Publishable: new users only edit registry.json

## Integrations
- WhatsApp (wacli CLI)
- Email/Calendar (gog CLI)
- Slack (MCP)
- Telegram (bundled MCP server)
- Linear (MCP)
- Sentry (MCP + CLI)
- GitHub (gh CLI)
- AWS (aws CLI — ECS, Cost Explorer)
- GSD (get-shit-done plugin — prerequisite)

## Repository
- Dev: ~/Projects/claude-ops
- GitHub: auroracapital/claude-ops
- Install: `claude plugin install ops@auroracapital/claude-ops`
