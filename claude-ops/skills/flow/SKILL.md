---
name: flow
description: "OPS on-demand: This skill should be used when the user asks to \"/ops:flow\", \"dev lifecycle\", or \"where…"
argument-hint: '[stage|intent] [args]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - TeamCreate
  - SendMessage
effort: medium
maxTurns: 20
---

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when a
lifecycle stage fans out into parallel, coordinated work (e.g. build + test +
review running together, or a multi-repo ship). This enables:

- Stage agents share context mid-flight (the test agent surfaces a regression →
  the build agent pivots before review starts)
- You can steer priorities in real time ("land the API change first, then docs")
- Agents report progress as each stage completes, so you sequence the merge

**Team setup** (only when the flag is enabled, and only for genuinely parallel stages):

```
TeamCreate("flow-lifecycle")
Agent(team_name="flow-lifecycle", name="stage-build", ...)
Agent(team_name="flow-lifecycle", name="stage-test", ...)
```

Steer with `SendMessage` / `broadcast`; share work via `TaskCreate`/`TaskUpdate`.

If the flag is NOT set, fall back to standard fire-and-forget subagents (the
default), or just route the stage to its single canonical command inline.

## Runtime Context

Before routing, compute where the user is on the lifecycle:

```bash
for _d in "$CLAUDE_PLUGIN_ROOT" \
          "$HOME/Developer/repos/claude-ops/claude-ops" \
          "$HOME/external-skills/claude-ops" \
          "$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops" \
          "$HOME/Projects/claude-ops/claude-ops"; do
  [ -n "$_d" ] && [ -x "$_d/bin/flow-state" ] && "$_d/bin/flow-state" && break
done
```

Build that list conditionally: an unset `CLAUDE_PLUGIN_ROOT` must contribute no
candidate, or it expands to the absolute path `/bin/flow-state`.

This prints: mode (PROJECT / AD-HOC), current `.planning/` phase (if any),
open PRs, and deploy state — the "you are here" marker. Read it first so
mode-sensitive routes (build / ship / review) resolve correctly.

The canonical map lives in `FLOW.md` (same dir). Read it when you need the
full per-stage ownership table; the dispatch table below is the routing copy.

---

# FLOW — One Lifecycle Entrypoint

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

**The one rule:** pick the abstraction level from repo state, then delegate
to the canonical tool.

- **PROJECT-MODE** (git root has `.planning/`): drive the **GSD phase state
  machine**; GSD phases call gstack/ops tools as sub-steps.
- **AD-HOC-MODE** (no `.planning/`): run the **gstack stateless lifecycle**.
- **OPS** (`/ops:*`): always available in either mode.

Route `$ARGUMENTS` (first token = intent) using this table:

| Intent keywords                                           | Resolves to                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| (empty), map, here, where                                 | print map (`Read FLOW.md`) + `bin/flow-state` output. **Stop — do not delegate.**                                                   |
| ideate, brainstorm, office-hours                          | `/office-hours`                                                                                                                     |
| hard-truths, yolo                                         | `/ops:ops-yolo`                                                                                                                     |
| spec, specify, scope, issue                               | `/spec $REST`                                                                                                                       |
| plan, roadmap, phase-plan                                 | **project** → `gsd-plan-phase`; **ad-hoc** → `/autoplan`                                                                            |
| ultraplan, deep-plan                                      | `gsd-ultraplan-phase`                                                                                                               |
| design, ui, mockup, html                                  | `/design-consultation $REST`                                                                                                        |
| build, execute, implement, code                           | **project** → `gsd-execute-phase`; **multi-project** → `gsd-manager`; **ad-hoc** → direct edits in an isolated worktree |
| feature-dev, fd, feature, architect-feature               | `/feature-dev $REST` (overlay — optional structured pipeline before/alongside build; does not replace GSD execute)                  |
| review, code-review, cr                                   | `/review` — **project** also runs `gsd-code-review`                                                                                 |
| security, cso, sec-review                                 | `/cso`                                                                                                                              |
| test, qa                                                  | `/qa $REST` — **project** also runs `gsd-verify-work`                                                                               |
| ios-qa, ios-test                                          | `/ios-qa`                                                                                                                           |
| ship, land                                                | **project** → `gsd-ship`; **ad-hoc single-repo** → `/ship`; **multi-repo salvage** → `/ops:ops-merge`                               |
| deploy, release, rollout                                  | `/ops:ops-deploy` then `/canary`                                                                                                    |
| canary                                                    | `/canary`                                                                                                                           |
| monitor, fires, incidents                                 | `/ops:ops-fires`                                                                                                                    |
| status, health                                            | `/ops:ops-status`                                                                                                                   |
| retro, reflect                                            | `/retro`                                                                                                                            |
| learn                                                     | `/learn`                                                                                                                            |
| ops, inbox, comms, marketing, finops, voice, home, daemon | `/ops:ops $ARGUMENTS` (hand the whole arg string to the ops sub-router)                                                             |
| projects, portfolio                                       | `/ops:ops-projects`                                                                                                                 |
| debug, investigate, root-cause, why                       | `/investigate` — **project** also runs `gsd-debug`                                                                                  |
| explore, onboard, understand, codebase                    | **project** → `gsd-map-codebase` / `gsd-onboard`; **ad-hoc** → `gsd-explore`                                                        |
| spike, prototype, try                                     | `gsd-spike` (throwaway, never lands)                                                                                                |
| docs, document, readme                                    | `/document-generate` — **project** also `gsd-docs-update`; post-ship `/document-release`                                            |
| diagram, chart, excalidraw, mermaid                       | `/diagram`                                                                                                                          |
| pdf, export                                               | `/make-pdf`                                                                                                                         |
| scrape, extract, pull-data                                | `/scrape` (codify a repeat flow with `/skillify`)                                                                                   |
| save-context, park, resume                                | `/context-save` / `/context-restore` — **project** → `gsd-pause-work` / `gsd-resume-work`                                           |
| freeze, guard, scope-edits                                | `/freeze` (dir scope), `/guard` (full), `/careful` (destructive-cmd warnings), `/unfreeze`                                          |
| design-review, ux-audit                                   | `/design-review`; iOS → `/ios-design-review`; devex → `/devex-review`                                                               |
| ios-fix, ios-clean, ios-sync                              | `/ios-fix`, `/ios-clean`, `/ios-sync`                                                                                               |
| benchmark, perf, regression                               | `/benchmark`                                                                                                                        |

### Routing notes

- **Hermes: gstack targets are files, not skills.** Every gstack route below
  (`/qa`, `/ship`, `/spec`, `/review`, `/cso`, `/autoplan`, `/canary`, `/retro`,
  `/learn`, `/office-hours`, `/design-consultation`, `/ios-qa`, `/browse`) lives
  OUTSIDE the indexed skills tree at `~/.local/share/gstack/<name>/SKILL.md`,
  deliberately, so its ~950k tokens do not load into every context.
  `skill_view("qa")` WILL fail. Load the route with
  `read_file ~/.local/share/gstack/<name>/SKILL.md`, then follow it. The
  `gstack-index` skill lists all 54 names. GSD routes are normal skills and do
  resolve via `skill_view` (`gsd-plan-phase`, `gsd-execute-phase`, ...).
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
- **`ops` passthrough**: for any `ops*` intent, forward the _entire_
  `$ARGUMENTS` to `/ops:ops` — it has its own sub-router; do not pre-parse it.

### Bare `/flow`

If `$ARGUMENTS` is empty: `Read FLOW.md`, then run `bin/flow-state`, and
present the lifecycle map with the current position highlighted. Offer the
next canonical stage as the suggested action. **Do not auto-advance.**

## CLI/API Reference

Router only — no direct tool calls. `bin/flow-state` is the sole helper
(detects mode + position). All execution is delegated to the canonical
target skill after routing.
