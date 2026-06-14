# FLOW — User Guide

`/flow` is the **single entrypoint** for the whole dev lifecycle. It unifies three
command systems that used to collide on `ship / review / plan / deploy / qa / triage`:

- **gstack** — dev-lifecycle role prompts + the `/browse` browser engine
- **GSD** — the `.planning/` phase state machine (defends against context-rot)
- **claude-ops** — `/ops:*` business-ops + the always-on daemon

It does **not** merge them. All three stay installed and self-updating. `/flow` is a
thin router that picks the one canonical command per stage.

## The one rule

`/flow` reads your repo state and picks the abstraction level:

| Repo state                | Mode        | What runs                                                                  |
| ------------------------- | ----------- | -------------------------------------------------------------------------- |
| git root has `.planning/` | **PROJECT** | GSD phase machine; phases call gstack/ops tools as sub-steps               |
| no `.planning/`           | **AD-HOC**  | gstack stateless lifecycle (`/spec→build→/review→/qa→/ship`)               |
| any                       | **OPS**     | `/ops:*` always available (inbox, fires, marketing, daemon, voice, finops) |

You never choose the mode — the router does, from `bin/flow-state`.

## Usage

```
/flow                 # print the lifecycle map + "you are here" (mode, phase, PRs)
/flow ideate          # → /office-hours
/flow spec <thing>    # → /spec
/flow plan            # project → gsd-plan-phase; ad-hoc → /autoplan
/flow design          # → /design-consultation → /design-shotgun → /design-html
/flow build           # project → gsd-execute-phase; ad-hoc → direct edits (worktree)
/flow review          # → /review + /cso (+ gsd-code-review in project-mode)
/flow test            # → /qa + /browse  (/ios-qa for iOS)
/flow ship            # project → gsd-ship; ad-hoc → /ship; salvage → /ops:ops-merge
/flow deploy          # → /ops:ops-deploy → /canary
/flow monitor         # → /ops:ops-fires + /ops:ops-status
/flow retro           # → /retro + /learn
/flow ops inbox       # → /ops:ops inbox  (whole arg handed to the ops sub-router)
/flow projects        # → /ops:ops-projects (read-only dashboard over GSD .planning/)
```

## Canonical command per stage

The authoritative table lives in [`skills/flow/FLOW.md`](../skills/flow/FLOW.md). Edit there,
not in three separate doctrines. The same map is mirrored in `~/.claude/CLAUDE.md` under
**FLOW DOCTRINE**.

## What changed for existing commands

No command was deleted. Duplicates were **demoted via description**: their skill
`description:` now states their narrow remaining role and names the canonical (e.g.
personal `/morning` → "DEMOTED: canonical briefing is /ops:ops-go"). This is the lever
that fixes model routing — when a description is unambiguous, the model picks correctly.
It's fully reversible; a later v2 can prune once `/flow` is trusted.

Ownership boundaries that are now **sole-owner**:

- **ops / comms / autonomy** → claude-ops `/ops:*`
- **project-state** (phases, `.planning/`) → GSD; `/ops:ops-projects` is the read-only view
- **browser** → gstack `/browse` (unchanged; safety-critical rules in CLAUDE.md)

## Files

- `skills/flow/SKILL.md` — the router
- `skills/flow/FLOW.md` — canonical lifecycle map (single source of truth)
- `bin/flow-state` — "you are here" detector (mode + phase + PRs); `--json` for machines
