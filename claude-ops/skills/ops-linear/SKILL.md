---
name: ops-linear
description: Linear command center. Shows current sprint, creates/updates issues, manages priorities, syncs with GSD phases.
argument-hint: "[sprint|create|update|sync|backlog|issue-id]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - mcp__claude_ai_Linear__list_issues
  - mcp__claude_ai_Linear__list_cycles
  - mcp__claude_ai_Linear__list_teams
  - mcp__claude_ai_Linear__list_projects
  - mcp__claude_ai_Linear__get_issue
  - mcp__claude_ai_Linear__save_issue
  - mcp__claude_ai_Linear__get_team
  - mcp__claude_ai_Linear__list_users
  - mcp__claude_ai_Linear__save_comment
  - mcp__claude_ai_Linear__list_issue_statuses
  - mcp__claude_ai_Linear__get_milestone
  - mcp__claude_ai_Linear__list_milestones
---

# OPS ► LINEAR COMMAND CENTER

## Phase 1 — Load data

Run in parallel:
1. `mcp__claude_ai_Linear__list_teams` — get all team IDs
2. `mcp__claude_ai_Linear__list_cycles` — get current and upcoming cycles per team
3. `mcp__claude_ai_Linear__list_users` — get team members

Then fetch issues for the current cycle: `mcp__claude_ai_Linear__list_issues` filtered to current cycle ID.

---

## Route by `$ARGUMENTS`

| Argument | Action |
|----------|--------|
| (empty), sprint | Show current sprint board |
| backlog | Show unassigned/unscheduled issues |
| create [title] | Create a new issue (prompt for details) |
| update [id] | Update issue by ID |
| sync | Sync GSD phases to Linear issues |
| [issue-id] | Show and edit that specific issue |

---

## Sprint board view

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 LINEAR ► SPRINT [N] — [start] → [end]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IN PROGRESS
 [id]  [priority]  [title]  [assignee]  [estimate]

TODO
 [id]  [priority]  [title]  [assignee]  [estimate]

DONE THIS SPRINT
 [id]  [title]  [completed date]

BLOCKED / CANCELLED
 [id]  [title]  [reason]

──────────────────────────────────────────────────────
 Sprint velocity: [done points] / [total points] ([%])
──────────────────────────────────────────────────────
 Actions:
 a) Create new issue
 b) Update issue status
 c) Move issue to/from sprint
 d) View backlog
 e) Sync with GSD phases

 → Type a letter, issue ID, or describe what you need
──────────────────────────────────────────────────────
```

---

## Create issue flow

Collect from user (or parse from `$ARGUMENTS`):
- Title
- Team (list choices if ambiguous)
- Priority (urgent/high/medium/low)
- Cycle (current sprint or backlog)
- Assignee (optional)
- Estimate (optional)

Use `mcp__claude_ai_Linear__save_issue` to create. Confirm: `Created [id]: [title]`

---

## GSD sync flow

Read all active GSD STATE.md files across projects. For each active phase:
1. Check if a Linear issue exists with matching phase reference.
2. If not, offer to create one.
3. If status differs (GSD says done, Linear says in-progress), offer to sync.

Update Linear issues to match GSD phase completion status.

Use AskUserQuestion after displaying any view to get the next action.
