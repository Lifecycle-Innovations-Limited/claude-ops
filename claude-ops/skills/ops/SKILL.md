---
name: ops
description: Business operations command center. Routes to the right ops command based on what you need — briefing, inbox, fires, projects, comms, triage, linear, revenue, deploy, or yolo mode.
argument-hint: "[command] [args]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
---

# OPS — Business Command Center

Route `$ARGUMENTS` to the correct ops skill:

| Input | Route to |
|-------|----------|
| (empty), go, morning, briefing | `/ops-go` |
| inbox, unread, messages | `/ops-inbox` |
| comms, send, whatsapp, email, slack, telegram | `/ops-comms $ARGUMENTS` |
| fires, incidents, down, sentry | `/ops-fires` |
| projects, dashboard, status | `/ops-projects` |
| next, priority, what | `/ops-next` |
| triage, issues | `/ops-triage` |
| linear, sprint, board | `/ops-linear` |
| revenue, money, mrr, costs | `/ops-revenue` |
| deploy, ship | `/ops-deploy` |
| yolo | `/ops-yolo` |

If `$ARGUMENTS` is empty, show a quick menu:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► COMMAND CENTER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 a) /ops-go        — Morning briefing
 b) /ops-inbox     — Inbox zero (all channels)
 c) /ops-fires     — Production incidents
 d) /ops-projects  — Project dashboard
 e) /ops-next      — What should I do next
 f) /ops-triage    — Cross-platform issue triage
 g) /ops-linear    — Linear sprint board
 h) /ops-revenue   — Revenue & costs
 i) /ops-deploy    — Deploy status
 j) /ops-yolo      — Run my business for a day

 → Type a letter or command name
──────────────────────────────────────────────────────
```

Use AskUserQuestion to get their choice, then invoke the corresponding skill.
