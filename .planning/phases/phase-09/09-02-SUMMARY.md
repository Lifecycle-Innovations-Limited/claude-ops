---
phase: "09"
plan: "02"
subsystem: skills/ops-merge, skills/ops-settings, skills/ops
tags: [merge, conflict-resolution, settings, credentials, routing]
dependency_graph:
  requires: []
  provides: [ops-merge-conflict-flow, ops-settings-skill, ops-router-settings-integrate]
  affects: [ops-merge, ops-settings, ops]
tech_stack:
  added: []
  patterns: [jq-parameterized-update, worktree-rebase, force-with-lease, AskUserQuestion-4-option]
key_files:
  created:
    - claude-ops/skills/ops-settings/SKILL.md
  modified:
    - claude-ops/skills/ops-merge/SKILL.md
    - claude-ops/skills/ops/SKILL.md
decisions:
  - Phase numbering: existing Phase 4/5/6 shifted to 5/6/7 to insert new conflict Phase 4
  - jq --arg used for all preferences.json writes (parameterized, no string interpolation)
  - force-with-lease used exclusively (not --force) to prevent clobbering concurrent pushes
  - AskUserQuestion capped at 4 options per CLAUDE.md Rule 1
metrics:
  duration_minutes: 15
  completed_date: "2026-04-14"
  tasks_completed: 2
  files_changed: 3
---

# Phase 09 Plan 02: Merge Conflict Resolution + /ops:settings Summary

**One-liner:** Full rebase-attempt → abort → 4-option conflict resolution flow in /ops:merge, plus new /ops:settings credential status dashboard with selective update and per-integration smoke tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add conflict resolution to /ops:merge Phase 3-4 | cdfc3af | claude-ops/skills/ops-merge/SKILL.md |
| 2 | Create /ops:settings skill + update ops router | cdfc3af | claude-ops/skills/ops-settings/SKILL.md, claude-ops/skills/ops/SKILL.md |

## What Was Built

### Task 1 — /ops:merge conflict resolution

Replaced the stub `For needs-rebase:` block in Phase 3 with a full automated rebase flow:

1. **Worktree creation** → `git worktree add /tmp/ops-rebase-<n> <branch>`
2. **Rebase attempt** → `git rebase origin/<base> 2>&1`
3. **Success path** → force-with-lease push + worktree cleanup + success report
4. **Failure path** → capture conflicting files, show diff, abort, emit structured JSON conflict report

Added new **Phase 4 — Resolve surfaced conflicts** between existing Phase 3 and Phase 4 (old phases 4/5/6 renumbered to 5/6/7):

- Displays a formatted conflict summary with branch, files, and diff
- `AskUserQuestion` with exactly 4 options: Accept incoming (theirs) / Keep current branch (ours) / Open manual resolution / Skip this PR
- Each option executes the appropriate `git checkout --theirs/--ours` + `git rebase --continue` + force-with-lease push sequence, or prints manual steps, or records `unresolved-conflict`

### Task 2 — /ops:settings skill

Created `claude-ops/skills/ops-settings/SKILL.md` with:

- **Credential Status Dashboard**: table view of all integrations showing ✅/⚠️/🔴 status
- **Liveness probes**: Stripe (HTTP 200), GitHub (`gh auth status`), AWS (`sts get-caller-identity`), Linear (jq check)
- **Selective update flow**: masked display → 4-option confirmation → jq parameterized write → immediate smoke test → pass/fail report
- **Smoke tests**: 8 integrations (Stripe, RevenueCat, Telegram, Slack, Shopify, Klaviyo, Datadog, New Relic)
- **Argument parsing**: `--status`, `--status <name>`, `<name>` direct jump

Updated `claude-ops/skills/ops/SKILL.md` router with two new routes after `doctor`:
- `settings, credentials, creds, config, reconfigure` → `/ops:ops-settings $ARGUMENTS`
- `integrate, connect, add-api, saas` → `/ops:ops-integrate $ARGUMENTS`

## Deviations from Plan

None — plan executed exactly as written.

## Threat Mitigations Applied

| Threat ID | Mitigation Applied |
|-----------|-------------------|
| T-09-02-01 | jq --arg parameterized updates throughout; tmpfile + mv pattern for atomic writes |
| T-09-02-02 | Masked key display with last 4 chars only; no full key values in output |
| T-09-02-03 | --force-with-lease used exclusively in all push paths, never bare --force |
| T-09-02-04 | Accepted — operator explicitly chose via AskUserQuestion; 4 bounded options |

## Verification Results

- skills-lint: 184 passed, 0 failed (ops-settings/SKILL.md passes frontmatter validation)
- ops/SKILL.md: contains "ops-settings" and "ops-integrate" route entries ✅
- ops-merge/SKILL.md: contains "rebase --abort", "force-with-lease", 4-option AskUserQuestion ✅
- AskUserQuestion: no skill has more than 4 options ✅

## Self-Check: PASSED

- [x] `claude-ops/skills/ops-settings/SKILL.md` — FOUND (created)
- [x] `claude-ops/skills/ops-merge/SKILL.md` — FOUND (modified)
- [x] `claude-ops/skills/ops/SKILL.md` — FOUND (modified)
- [x] Commit `cdfc3af` — FOUND in git log
