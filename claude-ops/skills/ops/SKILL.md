---
name: ops
description: Single discovery router for all business operations. Use for communications, projects, infrastructure, revenue, marketing, releases, fleet management, automation, or any OPS capability; it loads and invokes only the relevant specialist instructions on demand.
argument-hint: '[command] [args]'
allowed-tools:
  - Read
  - Skill
effort: medium
maxTurns: 20
---

# OPS — Lazy Capability Router

This is the single broad discovery entry for the OPS plugin. Specialist skill and agent
bodies are intentionally absent from startup context.

## Route

1. If `$ARGUMENTS` is empty, invoke the `ops:ops-dash` skill.
2. Otherwise, read [the capability index](references/capabilities.json).
3. Match the user's complete request—not merely one keyword—to exactly one specialist skill.
4. Invoke that skill through the `Skill` tool using its exact namespaced name:
   `ops:<skill-name>`. Forward the user's original arguments and intent unchanged.
5. If two specialists genuinely fit, choose the narrower one. Ask only when the choice
   would materially change an external action.

Do not reproduce or summarize a specialist workflow from the index. Invoke the specialist
so Claude Code loads its full body, allowed tools, effort, hooks, and turn budget on demand.
Never invoke `ops:ops` from this router; that would recurse.

The capability index is routing metadata, not authority to perform an action. All approval,
secrets, outbound-message, destructive-operation, and worktree gates remain owned by the
selected specialist and the global hooks.
