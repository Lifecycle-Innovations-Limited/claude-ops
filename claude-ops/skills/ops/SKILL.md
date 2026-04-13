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

## Runtime Context

Before routing, load:
1. **Preferences**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json` — read configured channels to determine available commands
2. **Daemon health**: `cat ${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json` — if `action_needed`, surface before routing


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
| marketing, email, klaviyo, ads, meta, seo, campaigns | `/ops:ops-marketing $ARGUMENTS` |
| ecom, shop, shopify, store, orders, inventory | `/ops:ops-ecom $ARGUMENTS` |
| voice, call, tts, transcribe, phone           | `/ops:ops-voice $ARGUMENTS` |
| yolo                                          | `/ops-yolo`             |
| doctor, health, fix, diagnose                 | `/ops:ops-doctor`       |
| speedup, clean, optimize, cleanup             | `/ops:ops-speedup`      |
| orchestrate, subagents, agents, dispatch, run | `/ops:ops-orchestrate $ARGUMENTS` |

If `$ARGUMENTS` is empty, launch the interactive dashboard: invoke `/ops:ops-dash` directly.

## CLI/API Reference

This skill is a router only — it does not call CLI tools directly. All tool usage is delegated to the target skill after routing. See the referenced skill's `## CLI/API Reference` section for details.
