---
name: ops-projects
description: Portfolio dashboard — shows all projects with GSD phase, branch, uncommitted changes, CI status, and next action. Jump to any project by alias.
argument-hint: "[project-alias]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - WebFetch
---

# OPS ► PROJECTS DASHBOARD

## CLI/API Reference

### gh CLI (GitHub)

| Command | Usage | Output |
|---------|-------|--------|
| `gh pr list --repo <owner/repo> --json number,title,statusCheckRollup,reviewDecision,mergeable` | Open PRs with CI | JSON array |
| `gh run list --repo <repo> --limit 5 --json status,conclusion,name,headBranch` | CI runs | JSON array |
| `gh issue list --repo <repo> --json number,title,labels,state` | Issues | JSON array |

---

## Pre-gathered git status

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-git 2>/dev/null || echo '[]'
```

## Open PRs

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-prs 2>/dev/null || echo '[]'
```

## CI status

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-ci 2>/dev/null || echo '[]'
```

## Project registry

```!
cat "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null || echo '{}'
```

## GSD state (all active roadmaps)

```!
for d in $(jq -r '.projects[] | select(.gsd == true) | .paths[]' "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null); do
  expanded="${d/#\~/$HOME}"
  if [ -f "$expanded/.planning/STATE.md" ]; then
    alias=$(jq -r --arg p "$d" '.projects[] | select(.paths[] == $p) | .alias' "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null | head -1)
    phase=$(grep -m1 'current_phase' "$expanded/.planning/STATE.md" 2>/dev/null | sed 's/.*: //' || echo "?")
    branch=$(git -C "$expanded" branch --show-current 2>/dev/null || echo "?")
    dirty=$(git -C "$expanded" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    echo "{\"alias\":\"$alias\",\"path\":\"$d\",\"phase\":\"$phase\",\"branch\":\"$branch\",\"dirty\":$dirty}"
  fi
done | jq -s '.'
```

---

## Your task

Parse all pre-gathered data and render the portfolio dashboard.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► PROJECTS — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ALIAS         PHASE      BRANCH          DIRTY  CI    NEXT ACTION
 ────────────────────────────────────────────────────────────────
 example-app   7.2        feature/auth    3      ✓     finish auth tests
 example-api   5.0        dev             0      ✗     fix CI (unit tests)
 ...

OPEN PRs
 #123  example-api  fix: auth middleware  ✓ CI  ready to merge
 #456  example-app  feat: onboarding      ✗ CI  needs fix

──────────────────────────────────────────────────────
 Jump to project:
 a) example-app
 b) example-api
 c) example-worker
 d) ...

 Or type a project alias directly
──────────────────────────────────────────────────────
```

**CI column**: green ✓ if last run passed, red ✗ if failing, — if no CI.
**DIRTY**: number of uncommitted files.
**NEXT ACTION**: inferred from GSD phase state and open issues.

---

## Jump to project

If `$ARGUMENTS` contains a project alias, show a deep-dive for that project:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 [PROJECT] — DEEP DIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Path:    [path]
 Branch:  [branch]   Dirty: [N files]
 GSD:     Phase [N] — [phase name]
 CI:      [last 5 runs with status]
 PRs:     [open PRs]
 Sentry:  [recent errors for this project]

 Actions:
 a) Continue GSD work (/gsd-next)
 b) Fix CI failure
 c) Review open PRs
 d) Check fires (/ops-fires [alias])
```

Use AskUserQuestion after displaying either view.

---

## Native tool usage

### Tasks — project action tracking

When the user jumps to a project, use `TaskCreate` to track the action they take. This carries context forward if they switch between projects.

### WebFetch — CI enrichment

When `gh` is slow or rate-limited, use `WebFetch` to query GitHub Actions API directly for run status.
