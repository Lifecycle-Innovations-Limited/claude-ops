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
# FLOW_TARGET: the project you are actually working on. Default to the shell's
# cwd, but pass an explicit path when the harness's tool cwd is not the project
# (see the mode-resolution note below).
FLOW_TARGET="${FLOW_TARGET:-$PWD}"
FLOW_STATE=""
for _d in "${CLAUDE_PLUGIN_ROOT:-}" \
          "$HOME/Developer/repos/claude-ops/claude-ops" \
          "$HOME/external-skills/claude-ops" \
          "$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops" \
          "$HOME/Projects/claude-ops/claude-ops"; do
  [ -n "$_d" ] && [ -x "$_d/bin/flow-state" ] && { FLOW_STATE="$_d/bin/flow-state"; break; }
done
[ -n "$FLOW_STATE" ] || { echo "flow: no executable bin/flow-state found" >&2; exit 1; }
"$FLOW_STATE" "$FLOW_TARGET"
```

Both failures are **fail-closed on purpose**. If no helper resolves, or the
target path is not a directory, stop and say so — do not route. `MODE` is what
decides GSD vs gstack, so routing without it silently picks the wrong half of
the lifecycle, which is worse than an error.

Use `${CLAUDE_PLUGIN_ROOT:-}`, not `$CLAUDE_PLUGIN_ROOT`: the bare form aborts
under `set -u`, and an unguarded `${CLAUDE_PLUGIN_ROOT}/bin/flow-state` expands
to the absolute path `/bin/flow-state` when the variable is unset.

**Always pass the target path explicitly.** `flow-state` defaults to `$PWD`,
and on some harnesses the shell tool does NOT run in the directory the user
launched from — Hermes, for example, runs terminal commands in `$HOME`. A
bare `flow-state` there inspects the home directory, finds no `.planning/`,
and reports `MODE=AD-HOC` for every project. PROJECT-MODE then never triggers,
so the GSD phase state machine is silently unreachable and every request falls
through to the ad-hoc gstack lifecycle. Resolve the project directory first
(the repo the user named, or the one under discussion) and pass it.

This prints: mode (PROJECT / AD-HOC), current `.planning/` phase (if any),
open PRs, and deploy state — the "you are here" marker. Read it first so
mode-sensitive routes (build / ship / review) resolve correctly.

The canonical map lives in `LIFECYCLE-MAP.md` (same dir). Read it when you need the
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
| (empty), map, here, where                                 | print map (`Read LIFECYCLE-MAP.md`) + `bin/flow-state` output. **Stop — do not delegate.**                                                   |
| ideate, brainstorm, office-hours                          | `/office-hours`                                                                                                                     |
| hard-truths, yolo                                         | `/ops:ops-yolo`                                                                                                                     |
| spec, specify, scope, issue                               | `/spec $REST`                                                                                                                       |
| plan, roadmap, phase-plan                                 | **project** → `gsd-plan-phase`; **ad-hoc** → `/autoplan`                                                                            |
| ultraplan, deep-plan                                      | `gsd-ultraplan-phase`                                                                                                               |
| design, ui, mockup, html                                  | `/design-consultation $REST`                                                                                                        |
| build, execute, implement, code                           | **multi-project** (checked FIRST) → `gsd-manager`; else **project** → `gsd-execute-phase`; **ad-hoc** → direct edits in an isolated worktree |
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
- **Mode resolution**: use the `MODE=` line from `flow-state`, and pass it the
  PROJECT path (see Runtime Context). PROJECT when the git root has
  `.planning/`; AD-HOC otherwise. If you did not pass a path and the harness
  runs shell commands somewhere other than the project (Hermes uses `$HOME`),
  `MODE` is meaningless — it describes that directory, not the user's work.
  A universal `AD-HOC` across unrelated projects is the symptom.
  "multi-project" = the user named >1 repo/project or asked for
  portfolio-wide work.
- **Delegation only.** This skill never does the work itself — it invokes the
  canonical command via the `Skill` tool (or prints the route if the target is
  a personal/plugin slash-command the model should call next). After routing,
  the target skill's own `## CLI/API Reference` governs execution.
- **Ambiguity**: if intent spans two stages, prefer the earliest unfulfilled
  stage for the current `flow-state` position.
- **`ops` passthrough**: for any `ops*` intent, forward the _entire_
  `$ARGUMENTS` to `/ops:ops` — it has its own sub-router; do not pre-parse it.

### Bare `/flow`

If `$ARGUMENTS` is empty: `Read LIFECYCLE-MAP.md`, then reuse the Runtime
Context result above (the same `"$FLOW_STATE" "$FLOW_TARGET"` invocation — do
not call `bin/flow-state` bare, it would report on the harness's cwd rather
than the project), and present the lifecycle map with the current position
highlighted. Offer the next canonical stage as the suggested action.
**Do not auto-advance.**

## CLI/API Reference

Router only — no direct tool calls. `bin/flow-state` is the sole helper
(detects mode + position). All execution is delegated to the canonical
target skill after routing.
