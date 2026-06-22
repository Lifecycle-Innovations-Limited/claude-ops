---
name: ops-feature-dev
description: Guided feature development — delegates to the feature-dev plugin's 7-phase workflow (explore, architect, implement, review). Use before ad-hoc builds or as pre-work before gsd-execute-phase.
argument-hint: '[feature description]'
allowed-tools:
  - Skill
  - Agent
  - AskUserQuestion
  - TodoWrite
  - Read
  - TeamCreate
  - SendMessage
effort: medium
maxTurns: 40
---

# OPS ► FEATURE DEV

Thin router into the **feature-dev** companion plugin. Do not re-implement its phases here.

## When to use

- **Ad-hoc repos** (no `.planning/`): optional structured alternative to jumping straight into `/flow build`.
- **Project repos** (`.planning/` present): run **before** `gsd-execute-phase` when you want exploration + architecture + clarifying questions; execution still canonical via GSD.
- **Review**: gstack `/review` and `gsd-code-review` stay canonical; feature-dev Phase 6 is available via explicit `/feature-dev` or auto-swap to `feature-dev:code-reviewer`.

## Routing

If `$ARGUMENTS` is empty, invoke `/feature-dev` with no args (discovery phase).

Otherwise invoke `/feature-dev $ARGUMENTS` via the **Skill** tool.

## Integration notes

- Requires the **feature-dev** plugin installed (`/ops:setup` Step 2c or `/plugin install feature-dev`).
- Specialist auto-swap (`feature-dev:code-*`) is handled by `bin/ops-suggest-specialized-agent` when the plugin is present.
- Does **not** replace `/flow build`, `/review`, or `gsd-execute-phase` — it overlays them.

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when running feature-dev phases that spawn multiple specialists (e.g., explorer + architect in parallel).

**Team setup** (only when flag is enabled):

```
TeamCreate("feature-dev")
Agent(team_name="feature-dev", name="explorer", ...)
Agent(team_name="feature-dev", name="architect", ...)
```

If the flag is NOT set, use standard parallel subagents or sequential `/feature-dev` phases.
