# FLOW — The Canonical Lifecycle Map

> Single source of truth for **which command runs at each lifecycle stage**.
> The `/flow` router (`skills/flow/SKILL.md`) reads this file to dispatch.
> Three systems stay installed and self-updating; this map is the only
> place that decides who owns what. Edit here, not in three doctrines.

---

## The one routing rule: project-mode vs ad-hoc-mode

`/flow` picks the **abstraction level from repo state first**, then delegates
to the canonical tool. This single mechanism dissolves the worst collisions
(ship / build / review / orchestrate) — there is no forced "winner", the
router defaults correctly per context.

- **PROJECT-MODE** — the repo (or cwd's git root) has a `.planning/` directory.
  `/flow` drives the **GSD phase state machine**
  (`spec → discuss → plan → execute → verify → ship → milestone`). Each GSD
  phase _calls gstack / ops tools as sub-steps_ (e.g. execute-phase invokes
  `/browse` for QA, `/design-html` for UI, `ops:ops-deploy` for rollout).
  **State + rigor come from GSD; the tools come from gstack / ops.**

- **AD-HOC-MODE** — no `.planning/` dir; a quick, stateless change.
  `/flow` runs the **gstack stateless lifecycle** directly
  (`/spec → build → /review → /qa → /ship`) with zero `.planning/` overhead.

- **OPS / COMMS / AUTONOMY** — claude-ops `/ops:*`. Always available
  orthogonally in **either** mode (inbox, fires, marketing, daemon, voice,
  finops, home). Never gated on repo state.

Detection contract: a repo is project-mode iff `git rev-parse --show-toplevel`
resolves and `<toplevel>/.planning/` exists. Otherwise ad-hoc-mode. `bin/flow-state`
computes this and the "you are here" position.

---

## Canonical command per stage

For each stage exactly **one** canonical command runs. The rest are
"also invoked" (fired as sub-steps by the canonical) or "demoted"
(kept installed, but their `description:` is rewritten to name the canonical).

| Stage             | Canonical                                                                                                                                                      | Also invoked (sub-steps)                                             | Demoted → points at canonical                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **ideate**        | gstack `/office-hours`                                                                                                                                         | `ops:ops-yolo` (C-suite Hard Truths)                                 | —                                                                                                     |
| **spec**          | gstack `/spec` (5-phase → GitHub issue → worktree agent)                                                                                                       | feeds GSD engine                                                     | `gsd-spec-phase` (engine, not entrypoint)                                                             |
| **plan**          | **GSD** `gsd-plan-phase` / `gsd-ultraplan-phase` (goal-backward, `.planning/PLAN.md`) wrapped by gstack `/autoplan` role reviews                               | `gsd-plan-review-convergence`                                        | `/plan-*-review` (run via `/autoplan`); `giga plan`                                                   |
| **design**        | gstack `/design-consultation` → `/design-shotgun` → `/design-html`                                                                                             | Pencil/Figma (DESIGN-FIRST rule)                                     | —                                                                                                     |
| **build**         | project → **GSD** `gsd-execute-phase` (fresh-context waves) / `gsd-master-orchestrator` (multi-project, ≤5 subagents/action); ad-hoc → direct edits + worktree | optional overlay: **feature-dev** `/feature-dev` (explore → architect → implement → review); worktree isolation (mandatory) | `ops:ops-orchestrate`, `superpowers:dispatching-parallel-agents`, personal `subagents`/`orchestrator` |
| **review**        | gstack `/review` (pre-land) + `/cso` (security)                                                                                                                | project also runs `gsd-code-review` (phase-gated → CODE-REVIEW.md); optional **feature-dev** Phase 6 via explicit `/feature-dev` or auto-swap `feature-dev:code-reviewer` | standalone `code-review` / `security-review`; `gsd-review`                                                                            |
| **test**          | gstack `/qa` + `/browse` (web), `/ios-qa` (iOS)                                                                                                                | project also runs `gsd-verify-work` + `gsd-add-tests`                | standalone `e2e`                                                                                      |
| **ship**          | project → **GSD** `gsd-ship` (phase→PR, `.planning`-filtered branch); ad-hoc single-repo → gstack `/ship`; multi-repo salvage → `ops:ops-merge`                | `gsd-pr-branch` cleans the branch                                    | `commit-commands:commit-push-pr`                                                                      |
| **deploy**        | claude-ops `ops:ops-deploy` + gstack `/land-and-deploy` → `/canary`                                                                                            | `ops:ops-deploy-fix` (autofix)                                       | `/setup-deploy` (config only)                                                                         |
| **monitor**       | claude-ops `ops:ops-fires` + `ops:ops-status` + `ops:ops-monitor`                                                                                              | gstack `/health`, `/landing-report`                                  | `gsd-health`, `gsd-progress`, personal `status`                                                       |
| **retro / learn** | gstack `/retro` + `/learn`                                                                                                                                     | `gsd-extract-learnings` / `gsd-milestone-summary` at milestone close | `giga consolidate`; `ops:ops-recap` (kept)                                                            |
| **ops / comms**   | **claude-ops `/ops:*` — SOLE OWNER**                                                                                                                           | —                                                                    | personal `morning` / `wrap` → `ops-go`; `next` → `ops-next`                                           |
| **project-state** | **GSD `.planning/` — SOLE OWNER**; `ops:ops-projects` is the read-only dashboard over it (via `gsd-registry-sync` cron)                                        | `ops:ops-linear` syncs phases→Linear                                 | personal `my-project-gsd`                                                                             |

---

## Router dispatch table (keyword → target)

`/flow <intent>` keyword-matches the first column; mode-sensitive rows
resolve via `bin/flow-state`. Mirrors the `/ops:ops` routing-table pattern.

| Intent keywords                                           | Stage         | Resolves to                                                                                          |
| --------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| (empty), map, here, where                                 | —             | print this map + `bin/flow-state` "you are here"                                                     |
| ideate, brainstorm, office-hours, hard-truths             | ideate        | `/office-hours` (+ `/ops:ops-yolo` if "hard truths")                                                 |
| spec, specify, scope, issue                               | spec          | `/spec`                                                                                              |
| plan, roadmap, phase-plan                                 | plan          | project → `gsd-plan-phase`; ad-hoc → `/autoplan`                                                     |
| ultraplan, deep-plan                                      | plan          | `gsd-ultraplan-phase`                                                                                |
| design, ui, mockup, html                                  | design        | `/design-consultation`                                                                               |
| build, execute, implement, code                           | build         | project → `gsd-execute-phase`; multi-project → `gsd-master-orchestrator`; ad-hoc → direct + worktree |
| feature-dev, fd, feature, architect-feature               | build         | `/feature-dev $REST` (overlay; does not replace GSD execute)                                           |
| review, code-review, cr                                   | review        | `/review` (+ `gsd-code-review` if project)                                                           |
| security, cso, sec-review                                 | review        | `/cso`                                                                                               |
| test, qa, e2e                                             | test          | `/qa` (+ `gsd-verify-work` if project)                                                               |
| ios-qa, ios-test                                          | test          | `/ios-qa`                                                                                            |
| ship, pr, land                                            | ship          | project → `gsd-ship`; ad-hoc → `/ship`; salvage → `/ops:ops-merge`                                   |
| deploy, release, rollout                                  | deploy        | `/ops:ops-deploy` → `/canary`                                                                        |
| canary                                                    | deploy        | `/canary`                                                                                            |
| monitor, fires, incidents, status, health                 | monitor       | `/ops:ops-fires` (+ `/ops:ops-status`)                                                               |
| retro, learn, reflect                                     | retro         | `/retro` (+ `/learn`)                                                                                |
| ops, inbox, comms, marketing, finops, voice, home, daemon | ops           | `/ops:ops $REST` (delegate whole arg to ops sub-router)                                              |
| projects, portfolio, state                                | project-state | `/ops:ops-projects`                                                                                  |

When the intent is ambiguous between two stages, prefer the **earliest**
unfulfilled stage for the current `flow-state` position.
