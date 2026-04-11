---
name: ops-next
description: Business-level "what should I do next". Priority stack — fires > unread comms > ready-to-merge PRs > Linear sprint > revenue-generating GSD work. Uses pre-gathered data and routes to the right skill.
argument-hint: "[context]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__claude_ai_Linear__list_issues
  - mcp__claude_ai_Linear__list_cycles
  - mcp__claude_ai_Slack__slack_search_public_and_private
---

# OPS ► NEXT ACTION

## Pre-gathered data

### Infrastructure & fires
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{"clusters":[]}'
```

### Git & PRs
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-prs 2>/dev/null || echo '[]'
```

### CI status
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-ci 2>/dev/null || echo '[]'
```

### Unread messages
```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-unread 2>/dev/null || echo '{}'
```

### GSD active phases
```!
for d in $(jq -r '.projects[] | select(.gsd == true) | .paths[]' "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null); do
  expanded="${d/#\~/$HOME}"
  if [ -f "$expanded/.planning/STATE.md" ]; then
    alias=$(basename "$expanded")
    cat "$expanded/.planning/STATE.md" 2>/dev/null | head -30
    echo "---NEXT---"
  fi
done
```

---

## Your task

Apply the priority stack to all pre-gathered data:

### Priority 1 — FIRES
Check infra data for: unhealthy ECS tasks, stopped services, failed deployments.
Check CI for: broken `main` or `dev` branches.
If any fires exist → **recommend `/ops-fires` immediately**.

### Priority 2 — URGENT COMMS
Check unread counts. If WhatsApp or email has unread messages from humans (not automated):
- Estimate urgency from sender/preview if available
- If urgent comms → **recommend `/ops-inbox [channel]`**

### Priority 3 — READY-TO-MERGE PRs
Check PRs for: CI green + no unresolved review comments + not draft.
If any ready → **recommend reviewing that PR now**.
Check: `gh pr list --state open --json number,title,statusCheckRollup,reviewDecision 2>/dev/null`

### Priority 4 — LINEAR SPRINT
Fetch current sprint issues: use `mcp__claude_ai_Linear__list_cycles` then `mcp__claude_ai_Linear__list_issues` filtered to current cycle.
Find highest-priority issue that is in progress or unstarted.

### Priority 5 — GSD WORK
From GSD state, find the highest revenue-impact active phase across all projects.
Revenue weighting: read `revenue.stage` and `priority` from `scripts/registry.json` — projects with lower priority numbers (higher priority) and revenue stage of `growth` or `active` outrank `pre-launch` or `development`. Within the same tier, prioritize closest-to-done phases.

---

## Output format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► NEXT ACTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 TOP PRIORITY: [fires|comms|PR|sprint|gsd]
 ▶ [specific action in one sentence]

 WHY: [1-2 sentence rationale]

──────────────────────────────────────────────────────
 Full priority stack:
 1. [action] — [why] → [/skill or command]
 2. [action] — [why] → [/skill or command]
 3. [action] — [why] → [/skill or command]
 4. [action] — [why] → [/skill or command]
 5. [action] — [why] → [/skill or command]

──────────────────────────────────────────────────────
 a) Do #1 now
 b) Do #2 now
 c) Show me everything (/ops-go)
 d) I'll decide — just show the briefing

 → Pick or describe what you want
──────────────────────────────────────────────────────
```

Use AskUserQuestion. When user selects an option, invoke the corresponding skill directly — don't describe it, do it.

If `$ARGUMENTS` contains context (e.g., "focus on <project-alias>"), constrain the analysis to that context.
