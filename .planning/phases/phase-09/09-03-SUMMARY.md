---
phase: "09"
plan: "03"
subsystem: "ops-monitor, ops-integrate, monitor-agent"
tags: [monitoring, apm, datadog, newrelic, otel, saas-integration, partner-registry]
dependency_graph:
  requires: []
  provides: [ops-monitor skill, ops-integrate skill, monitor-agent, monitoring userConfig keys]
  affects: [ops router, plugin.json]
tech_stack:
  added: [Datadog API v1/v2, New Relic GraphQL API, OpenTelemetry healthz]
  patterns: [agent-spawn-from-skill, partner-registry-jq, atomic-tmpfile-swap, haiku-polling-agent]
key_files:
  created:
    - claude-ops/agents/monitor-agent.md
    - claude-ops/skills/ops-monitor/SKILL.md
    - claude-ops/skills/ops-integrate/SKILL.md
  modified:
    - claude-ops/skills/ops/SKILL.md
    - claude-ops/.claude-plugin/plugin.json
decisions:
  - "monitor-agent uses claude-haiku-4-5 per D-01 decision — lightweight, frequent polling, no write access"
  - "partner_registry stored in preferences.json (local, gitignored) not a separate file"
  - "ops router adds monitor row only — settings/integrate rows already present from Plan 02"
metrics:
  duration: "~15 min"
  completed: "2026-04-14"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 2
---

# Phase 09 Plan 03: /ops:monitor + /ops:integrate Skills Summary

**One-liner:** Haiku-4-5 APM probe agent + unified Datadog/New Relic/OTEL monitoring skill + generic SaaS API onboarding with local partner registry.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create monitor-agent + ops-monitor/SKILL.md + plugin.json userConfig | 70cf25d | agents/monitor-agent.md, skills/ops-monitor/SKILL.md, .claude-plugin/plugin.json |
| 2 | Create ops-integrate/SKILL.md + update ops router | 70cf25d | skills/ops-integrate/SKILL.md, skills/ops/SKILL.md |

## What Was Built

### monitor-agent.md
- Model: `claude-haiku-4-5`, `effort: low`, `maxTurns: 15`
- `disallowedTools: [Write, Edit, Agent]` — fully read-only probe agent
- Preflight reads credentials from `preferences.json` via `jq`
- Datadog: polls `/api/v1/monitor` for Alert/Warn state + `/api/v2/apm/traces` for top error traces
- New Relic: GraphQL query for `CRITICAL` severity entities
- OTEL: `GET $OTEL_ENDPOINT/healthz` for collector health
- Outputs structured JSON with `summary.severity` (critical/warning/healthy) and `backends_configured`
- Keys passed as `-H` headers only — never in URLs or terminal output (T-09-03-01 mitigation)

### ops-monitor/SKILL.md
- `--setup`: AskUserQuestion (≤4 options) → collect credentials → atomic tmpfile write → smoke test
- Default: spawns `monitor-agent` via Agent tool, displays formatted dashboard with ✅/⚠️/🔴/⬜ icons
- `--watch`: 60-second poll loop, diff-based output showing 🆕 new / ✅ resolved
- `--backend <name>`: filter to single backend
- CLI/API reference table for all three backends

### ops-integrate/SKILL.md
- `--list`: renders partner registry as table
- 5-step onboarding: discover → confirm (user-gated) → credential → health check → registry write
- jq `--arg` parameterized writes prevent JSON injection (T-09-03-02 mitigation)
- User confirms discovered URL before any credential collection or write (T-09-03-03 mitigation)
- Atomic tmpfile swap for all preference writes
- `partner_registry` stored in `preferences.json` (local only, gitignored)

### ops/SKILL.md router
- Added row: `monitor, apm, alerts, datadog, newrelic, otel → /ops:ops-monitor $ARGUMENTS`
- `settings` and `integrate` rows were already present from Plan 02 — not duplicated

### plugin.json
- 5 new `userConfig` keys: `datadog_api_key` (sensitive), `datadog_app_key` (sensitive), `newrelic_api_key` (sensitive), `newrelic_account_id`, `otel_endpoint`
- JSON validated: `jq .` passes

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Deviation avoidance] ops router already had settings/integrate rows**
- **Found during:** Task 2
- **Issue:** Plan said to add all 3 rows but Plan 02 had already added settings/integrate
- **Fix:** Added only the monitor row — checked with Grep before editing per plan instructions
- **Files modified:** claude-ops/skills/ops/SKILL.md

## Known Stubs

None — all data flows wired. Agent spawns `monitor-agent` which reads live credentials and polls real APIs. Partner registry reads/writes from/to `preferences.json` at runtime.

## Threat Flags

None beyond what is documented in the plan's threat model (T-09-03-01 through T-09-03-04, all mitigated in implementation).

## Self-Check: PASSED

- [x] `claude-ops/agents/monitor-agent.md` — exists, has `haiku-4-5`, has `disallowedTools`
- [x] `claude-ops/skills/ops-monitor/SKILL.md` — exists, has --setup, --watch, default flows
- [x] `claude-ops/skills/ops-integrate/SKILL.md` — exists, has `partner_registry`
- [x] `claude-ops/skills/ops/SKILL.md` — has `ops-monitor`, `ops-settings`, `ops-integrate` routes
- [x] `claude-ops/.claude-plugin/plugin.json` — valid JSON, has `datadog_api_key`
- [x] lint: 200 passed, 0 failed
- [x] commit: 70cf25d
