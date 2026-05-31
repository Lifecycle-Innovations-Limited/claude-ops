---
name: flow
description: ONE entrypoint for the whole dev lifecycle — ideate, spec, plan, design, build, review, test, ship, deploy, monitor, retro. Routes to the single canonical command per stage (gstack / GSD / claude-ops) and picks project-mode (GSD phase machine) vs ad-hoc-mode (gstack stateless) from repo `.planning/` state. Bare `/flow` prints the lifecycle map + your current "you are here" position.
argument-hint: "[stage|intent] [args]"
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

Before routing, compute where the user is on the lifecycle:

```bash
"${CLAUDE_PLUGIN_ROOT:-$HOME/Projects/claude-ops/claude-ops}/bin/flow-state"
```

This prints: mode (PROJECT / AD-HOC), current `.planning/` phase (if any),
open PRs, and deploy state — the "you are here" marker. Read it first so
mode-sensitive routes (build / ship / review) resolve correctly.

The canonical map lives in `FLOW.md` (same dir). Read it when you need the
full per-stage ownership table; the dispatch table below is the routing copy.

---

# FLOW — One Lifecycle Entrypoint

**The one rule:** pick the abstraction level from repo state, then delegate
to the canonical tool.

- **PROJECT-MODE** (git root has `.planning/`): drive the **GSD phase state
  machine**; GSD phases call gstack/ops tools as sub-steps.
- **AD-HOC-MODE** (no `.planning/`): run the **gstack stateless lifecycle**.
- **OPS** (`/ops:*`): always available in either mode.

Route `$ARGUMENTS` (first token = intent) using this table:

| Intent keywords | Resolves to |
| --- | --- |
| (empty), map, here, where | print map (`Read FLOW.md`) + `bin/flow-state` output. **Stop — do not delegate.** |
| ideate, brainstorm, office-hours | `/office-hours` |
| hard-truths, yolo | `/ops:ops-yolo` |
| spec, specify, scope, issue | `/spec $REST` |
| plan, roadmap, phase-plan | **project** → `gsd-plan-phase`; **ad-hoc** → `/autoplan` |
| ultraplan, deep-plan | `gsd-ultraplan-phase` |
| design, ui, mockup, html | `/design-consultation $REST` |
| build, execute, implement, code | **project** → `gsd-execute-phase`; **multi-project** → `gsd-master-orchestrator`; **ad-hoc** → direct edits in an isolated worktree |
| review, code-review, cr | `/review` — **project** also runs `gsd-code-review` |
| security, cso, sec-review | `/cso` |
| test, qa | `/qa $REST` — **project** also runs `gsd-verify-work` |
| ios-qa, ios-test | `/ios-qa` |
| ship, land | **project** → `gsd-ship`; **ad-hoc single-repo** → `/ship`; **multi-repo salvage** → `/ops:ops-merge` |
| deploy, release, rollout | `/ops:ops-deploy` then `/canary` |
| canary | `/canary` |
| monitor, fires, incidents | `/ops:ops-fires` |
| status, health | `/ops:ops-status` |
| retro, reflect | `/retro` |
| learn | `/learn` |
| ops, inbox, comms, marketing, finops, voice, home, daemon | `/ops:ops $ARGUMENTS` (hand the whole arg string to the ops sub-router) |
| projects, portfolio | `/ops:ops-projects` |

### Routing notes

- **`$REST`** = `$ARGUMENTS` with the leading intent token removed.
- **Mode resolution**: use the `MODE=` line from `flow-state`. PROJECT when
  the git root has `.planning/`; AD-HOC otherwise. "multi-project" = the user
  named >1 repo/project or asked for portfolio-wide work.
- **Delegation only.** This skill never does the work itself — it invokes the
  canonical command via the `Skill` tool (or prints the route if the target is
  a personal/plugin slash-command the model should call next). After routing,
  the target skill's own `## CLI/API Reference` governs execution.
- **Ambiguity**: if intent spans two stages, prefer the earliest unfulfilled
  stage for the current `flow-state` position.
- **`ops` passthrough**: for any `ops*` intent, forward the *entire*
  `$ARGUMENTS` to `/ops:ops` — it has its own sub-router; do not pre-parse it.

### Bare `/flow`

If `$ARGUMENTS` is empty: `Read FLOW.md`, then run `bin/flow-state`, and
present the lifecycle map with the current position highlighted. Offer the
next canonical stage as the suggested action. **Do not auto-advance.**

## CLI/API Reference

Router only — no direct tool calls. `bin/flow-state` is the sole helper
(detects mode + position). All execution is delegated to the canonical
target skill after routing.
