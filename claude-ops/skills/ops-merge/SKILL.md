---
name: ops-merge
description: Autonomous PR merge pipeline. Scans all repos for open PRs, dispatches subagents to fix CI, resolve conflicts, address review comments, then merges. Use --main to also sync dev↔main branches.
argument-hint: "[--main] [--repo org/repo] [--dry-run]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - TaskCreate
  - TaskUpdate
  - TaskList
  - AskUserQuestion
---

# OPS ► MERGE

## Pre-gathered PR data

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-merge-scan 2>/dev/null || echo '{"prs":[],"error":"merge-scan failed"}'
```

## Your task

You are the **merge orchestrator**. Your job is to get every open PR across Sam's repos merged — fixing whatever blocks them first.

### Parse arguments

From `$ARGUMENTS`:

- `--main` → after all PRs merge to dev, also sync dev↔main for repos that have both branches
- `--repo <slug>` → scope to one repo only (e.g., `--repo Lifecycle-Innovations-Limited/healify-api`)
- `--dry-run` → report what would happen, don't dispatch agents or merge anything
- `--force` → skip the confirmation prompt before merging
- (empty) → process all repos, merge to dev only

### Phase 1 — Classify the PR queue

Parse the pre-gathered JSON. For each PR, it's already classified as one of:

| Classification          | Meaning                                                           | Action                                      |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `ready`                 | CI green, approved, no conflicts                                  | Merge immediately                           |
| `needs-rebase`          | `mergeable: CONFLICTING`                                          | Dispatch fixer: rebase on base branch       |
| `needs-ci-fix`          | CI failures in `statusCheckRollup`                                | Dispatch fixer: investigate logs, fix, push |
| `needs-review-response` | `reviewDecision: CHANGES_REQUESTED`                               | Dispatch fixer: resolve comments            |
| `blocked`               | `mergeStateStatus: BLOCKED` (branch protection, required reviews) | Note why, skip                              |
| `draft`                 | `isDraft: true`                                                   | Skip — not ready for merge                  |

Print the queue:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE — PR Queue
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Repo | PR | Title | Status | Action |
|------|----|-------|--------|--------|
| healify-api | #2958 | fix(migration) | ready | merge |
| healify | #4456 | feat(apple-04) | needs-ci-fix | dispatch fixer |
| ... | ... | ... | ... | ... |

Ready: N  |  Fix needed: N  |  Blocked: N  |  Draft: N
──────────────────────────────────────────────────────
```

If `--dry-run`, stop here. Print the queue and exit.

### Phase 2 — Merge ready PRs immediately

For each `ready` PR:

1. Verify CI is still green: `gh pr checks <number> --repo <repo>`
2. If green: `gh pr merge <number> --repo <repo> --squash --admin`
3. Report: `✓ Merged <repo>#<number> to <base>`

### Phase 3 — Dispatch fixers for PRs that need work

For PRs classified as `needs-rebase`, `needs-ci-fix`, or `needs-review-response`:

**Dispatch subagents in parallel** (max 5 concurrent, one repo per agent):

Each fixer agent gets a worktree and this brief:

```
Task: Fix PR #<number> in <repo> (<classification>)
Repo path: <path from registry>
Branch: <headRefName>

<classification-specific instructions>

For needs-rebase:
  1. Create worktree from the PR branch
  2. Rebase on <baseBranchRef>: `git rebase <base>`
  3. Resolve any conflicts (prefer incoming for .planning/, prefer HEAD for code)
  4. Push with --force-with-lease --no-verify
  5. Verify PR is now MERGEABLE

For needs-ci-fix:
  1. Get failed check logs: `gh run view <id> --repo <repo> --log-failed | tail -80`
  2. Diagnose the failure
  3. Fix the code in a worktree
  4. Commit + push --no-verify
  5. Wait for CI to re-run (or report what was fixed)

For needs-review-response:
  1. Read review comments: `gh api repos/<repo>/pulls/<number>/comments --jq '.[].body'`
  2. Address each comment in code
  3. Reply to each comment via gh api
  4. Push fixes
  5. Re-request review if needed

After fixing:
  - Report back: what was wrong, what was fixed, is CI green now?
  - If CI is green and no more blockers: merge with `gh pr merge <number> --repo <repo> --squash --admin`
```

Use `model: "sonnet"` for all fixer agents.

### Phase 4 — Collect results and merge

As fixers complete:

1. Verify the PR is now green: `gh pr checks <number> --repo <repo>`
2. If green: merge immediately
3. If still red: report what's still broken

### Phase 5 — `--main` sync (only if flag is set)

For each repo that has separate `dev` and `main` branches:

1. Check if dev is ahead of main: `git -C <path> log main..dev --oneline | head -5`
2. If ahead, create sync PR: `gh pr create --repo <repo> --base main --head dev --title "chore: sync dev → main"`
3. Wait for CI: `gh pr checks <sync-pr-number> --repo <repo> --watch` (background, max 10 min)
4. If CI green: `gh pr merge <sync-pr-number> --repo <repo> --merge --admin` (merge commit, not squash)
5. Pull main back into dev: `git -C <path> fetch origin && git -C <path> checkout dev && git -C <path> merge origin/main --no-edit`

### Phase 6 — Final report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Repo | PR | Result |
|------|----|--------|
| healify-api | #2958 | ✓ merged to dev |
| healify | #4456 | ✓ fixed CI + merged |
| mise | #10 | ✗ 3 critical bugs — skipped |

Merged: N PRs across M repos
Skipped: N (blocked/draft)
Failed: N (still need manual attention)

Main sync: N repos synced (dev → main → dev)
──────────────────────────────────────────────────────
```

---

## Safety Rails (NEVER violate)

- **NEVER force-push to main/master**
- **NEVER merge with red CI** — fix root cause first
- **NEVER bypass review on PRs touching auth, payments, PII, or secrets** — these require `security-reviewer` subagent audit before merge
- **NEVER run `git reset --hard` on shared branches**
- **ALWAYS use worktrees** for fixes (multiple agents may be active)
- **ALWAYS use `--admin` only for squash merges to dev** (not main, unless `--main` flag)
- **Max 10 PRs per invocation** to avoid GitHub API throttling
- **If a PR has > 50 files changed**, flag it for manual review instead of auto-merging
