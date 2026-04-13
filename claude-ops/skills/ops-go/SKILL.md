---
name: ops-go
description: Token-efficient morning briefing. Pre-gathers all data via shell scripts, then presents a unified business dashboard with prioritized actions.
argument-hint: "[project-alias]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskList
  - CronCreate
  - CronList
  - WebFetch
---

# OPS ► MORNING BRIEFING

## Pre-gathered data

All data below was collected by shell scripts in <10 seconds:

### Infrastructure

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{"clusters":[],"error":"infra check failed"}'
```

### Git Status (all projects)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-git 2>/dev/null || echo '[]'
```

### Open PRs

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-prs 2>/dev/null || echo '[]'
```

### CI Failures (last 24h)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-ci 2>/dev/null || echo '[]'
```

### Unread Messages

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-unread 2>/dev/null || echo '{}'
```

### GSD State (active roadmaps)

```!
for d in $(jq -r '.projects[] | select(.gsd == true) | .paths[]' "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null); do
  expanded="${d/#\~/$HOME}"
  if [ -f "$expanded/.planning/STATE.md" ]; then
    alias=$(basename "$expanded")
    phase=$(grep -m1 'current_phase' "$expanded/.planning/STATE.md" 2>/dev/null | head -1 || echo "unknown")
    progress=$(grep -m1 'progress' "$expanded/.planning/STATE.md" 2>/dev/null | head -1 || echo "unknown")
    echo "$alias: $phase | $progress"
  fi
done
```

### Calendar (today)

```!
gog calendar list --date "$(date +%Y-%m-%d)" 2>/dev/null | head -20 || echo "calendar unavailable"
```

## Your task

Analyze ALL the pre-gathered data above and present it as a morning briefing. Follow the ops-briefing output style.

**Format:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MORNING BRIEFING — [DATE]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIRES (fix now)
[table of production issues, CI failures, broken deploys]

PRs NEEDING ACTION
[table: repo, PR#, title, status, action needed]

PORTFOLIO DASHBOARD
[table: project, phase, branch, uncommitted, CI, next action]

UNREAD
[WhatsApp: N, Email: N, Slack: check MCP, Calendar: N events today]

TODAY'S PRIORITIES (ranked by revenue impact + urgency)
1. [action] — [project] — [why]
2. ...
3. ...

──────────────────────────────────────────────────────
 What's next?
──────────────────────────────────────────────────────
 a) [highest priority action from analysis]
 b) [second priority]
 c) [third priority]
 d) [fourth priority]
 e) /ops-yolo — let me run your business today

 → Type a letter, project alias, or describe what you want
──────────────────────────────────────────────────────
```

**Priority ranking**: fires > degraded infra > CI failures > unread comms > ready-to-merge PRs > revenue-generating GSD work > stale projects.

If `$ARGUMENTS` contains a project alias, focus the briefing on that project only.

After presenting, use AskUserQuestion for the user's choice and route to the appropriate ops skill or project.

For Slack unread counts: if the pre-gathered data shows `"count": -1`, use `mcp__claude_ai_Slack__slack_search_public_and_private` with query `is:unread` to get actual counts. Do this as a parallel tool call while analyzing other data.

---

## Native tool usage

### Tasks — briefing action tracking

After presenting the briefing, create a `TaskCreate` for each recommended priority action. As the user works through them (or delegates via skill routing), update with `TaskUpdate`. This gives continuity across the session.

### Cron — scheduled briefings

After the first briefing, offer to schedule recurring briefings via `AskUserQuestion`:
```
  [Schedule daily at 9am]  [Schedule weekday mornings]  [No schedule]
```
Use `CronCreate` to set up the schedule. Show existing schedules with `CronList`.

### WebFetch — calendar enrichment

When `gog cal` fails, use `WebFetch` with the Google Calendar API as fallback:
```
WebFetch(url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=<today>T00:00:00Z&timeMax=<today>T23:59:59Z")
```
