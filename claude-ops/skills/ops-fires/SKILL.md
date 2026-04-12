---
name: ops-fires
description: Production incidents dashboard. Reads ECS health, Sentry errors, CI failures. Offers to dispatch fix agents for active fires.
argument-hint: "[project-alias|all]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__sentry__authenticate
---

# OPS ► FIRES

## Pre-gathered infrastructure data

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{"clusters":[],"error":"infra check failed"}'
```

## CI failures (last 24h)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-ci 2>/dev/null || echo '[]'
```

## Your task

Analyze the pre-gathered data. Then run parallel checks:

1. **ECS health** — parse infra data for unhealthy services, stopped tasks, failed deployments.
2. **Sentry** — if Sentry MCP is connected, query recent unresolved errors. Otherwise note it's unavailable.
3. **CI** — parse CI data for failing pipelines, broken main/dev branches.
4. **GitHub Actions** — `gh run list --limit 20 --json status,conclusion,name,headBranch,createdAt 2>/dev/null`

Classify each issue by severity:

| Severity | Criteria                                          |
| -------- | ------------------------------------------------- |
| CRITICAL | Service down, DB unreachable, auth broken         |
| HIGH     | Elevated error rate, deploy stuck, CI main broken |
| MEDIUM   | Non-critical service degraded, flaky tests        |
| LOW      | Warning-level, non-urgent                         |

---

## Output format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► FIRES DASHBOARD — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL
[service] — [issue] — [since]

HIGH
[service] — [issue] — [since]

MEDIUM
[service] — [issue] — [since]

ECS HEALTH
[cluster] [service] [desired/running] [status]

CI STATUS
[repo] [branch] [workflow] [status] [last run]

SENTRY (top errors, 24h)
[error] [count] [first seen] [project]

──────────────────────────────────────────────────────
 Actions:
 a) Dispatch fix agent for [top critical issue]
 b) Dispatch fix agent for [second issue]
 c) View logs for [service]
 d) Open Sentry dashboard
 e) Open GitHub Actions
 f) All clear — nothing to do

 → Type a letter or describe what you need
──────────────────────────────────────────────────────
```

If no fires: show "ALL SYSTEMS OPERATIONAL" with last-checked timestamps.

---

## Dispatch fix agent

When user selects to fix an issue, spawn an Agent with:

- The error details and logs
- Access to the relevant repo
- Instruction to create a feature branch, fix, and open a PR
- Report back when done or blocked

Use the `agents/infra-monitor.md` agent definition for infra issues.

If `$ARGUMENTS` contains a project alias, filter to that project's services only.
