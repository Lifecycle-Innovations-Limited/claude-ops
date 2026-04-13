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
effort: medium
maxTurns: 20
---

# OPS — Business Command Center

Route `$ARGUMENTS` to the correct ops skill:

| Input                                         | Route to                |
| --------------------------------------------- | ----------------------- |
| (empty), dash, home, hq                       | `/ops:ops-dash`         |
| go, morning, briefing                         | `/ops-go`               |
| setup, configure, init, install               | `/ops:setup $ARGUMENTS` |
| inbox, unread, messages                       | `/ops-inbox`            |
| comms, send, whatsapp, email, slack, telegram | `/ops-comms $ARGUMENTS` |
| fires, incidents, down, sentry                | `/ops-fires`            |
| projects, dashboard, status                   | `/ops-projects`         |
| next, priority, what                          | `/ops-next`             |
| triage, issues                                | `/ops-triage`           |
| linear, sprint, board                         | `/ops-linear`           |
| revenue, money, mrr, costs                    | `/ops-revenue`          |
| deploy, ship                                  | `/ops-deploy`           |
| merge, prs, ship-prs                          | `/ops-merge $ARGUMENTS` |
| yolo                                          | `/ops-yolo`             |
| doctor, health, fix, diagnose                 | `/ops:ops-doctor`       |
| speedup, clean, optimize, cleanup             | `/ops:ops-speedup`      |
| orchestrate, subagents, agents, dispatch, run | `/ops:ops-orchestrate $ARGUMENTS` |

If `$ARGUMENTS` is empty, launch the interactive dashboard: invoke `/ops:ops-dash` directly.
