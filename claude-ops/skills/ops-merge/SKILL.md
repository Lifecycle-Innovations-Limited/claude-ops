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
  - TeamCreate
  - SendMessage
  - Monitor
  - WebSearch
effort: medium
maxTurns: 50
---

## Runtime Context

Before executing, load:
1. **Preferences**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json` — read `owner`, `timezone`, project registry
2. **Daemon health**: `cat ${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json` — if `action_needed` set, surface to user
3. **Secrets**: GitHub token: env `$GITHUB_TOKEN` → Doppler MCP (`mcp__doppler__*`) → `doppler secrets get GITHUB_TOKEN --plain` → password manager


# OPS ► MERGE

## CLI/API Reference

### gh CLI (GitHub)

| Command | Usage | Output |
|---------|-------|--------|
| `gh pr list --repo <owner/repo> --json number,title,state,headRefName,statusCheckRollup,reviewDecision,mergeable,isDraft` | List PRs with status | JSON array |
| `gh pr view <n> --repo <repo> --json title,body,state,mergeable,reviews` | PR details | JSON |
| `gh pr checks <n> --repo <repo>` | CI check status | Check list |
| `gh pr merge <n> --repo <repo> --squash --admin` | Squash merge PR | Merge result |
| `gh pr create --repo <repo> --title "<t>" --body "<b>" --base dev` | Create PR | PR URL |
| `gh run list --repo <repo> --limit 5 --json conclusion,name,headBranch` | CI runs | JSON array |
| `gh run view <id> --repo <repo> --log-failed` | Failed CI logs | Log output |
| `gh run watch <run-id> --repo <repo>` | Stream CI run | Live output (use with Monitor) |
| `gh api repos/<repo>/pulls/<n>/comments --jq '.[].body'` | PR review comments | Comment text |

---

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** for fixer agents (Phase 3). This enables:
- Steering fixers mid-flight if priorities change (e.g., a critical PR should be merged first)
- Fixers can report blockers and you can redirect them without waiting for completion
- Shared context: if fixer-A discovers a breaking change that affects fixer-B's PR, you can notify B

**Team setup** (only when flag is enabled, Phase 3):
```
TeamCreate("merge-fixers")
Agent(team_name="merge-fixers", name="fixer-[repo]", ...)
```

Use `SendMessage(to="fixer-my-api", content="PR #2958 was just merged — rebase your branch")` to coordinate.

If the flag is NOT set, fall back to standard parallel subagents with `isolation: "worktree"`.

## Pre-gathered PR data

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-merge-scan 2>/dev/null || echo '{"prs":[],"error":"merge-scan failed"}'
```

## Your task

You are the **merge orchestrator**. Your job is to get every open PR across the owner's repos merged — fixing whatever blocks them first.

### Parse arguments

From `$ARGUMENTS`:

- `--main` → after all PRs merge to dev, also sync dev↔main for repos that have both branches
- `--repo <slug>` → scope to one repo only (e.g., `--repo Lifecycle-Innovations-Limited/my-api`)
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
| my-api | #2958 | fix(migration) | ready | merge |
| my-app | #4456 | feat(apple-04) | needs-ci-fix | dispatch fixer |
| ... | ... | ... | ... | ... |

Ready: N  |  Fix needed: N  |  Blocked: N  |  Draft: N
──────────────────────────────────────────────────────
```

If `--dry-run`, stop here. Print the queue and exit.

### Phase 2 — Confirm and merge ready PRs

Unless `--force` was passed, use `AskUserQuestion` to confirm before merging:

```
Ready to merge N PRs:
  [repo]#[number] — [title] → [base]
  [repo]#[number] — [title] → [base]

  [Merge all N now]  [Let me pick which ones]  [Dry run — don't merge]
```

If user picks "Let me pick", show each PR with `[Merge]` / `[Skip]` options via `AskUserQuestion`.

For each confirmed PR:

1. Verify CI is still green: `gh pr checks <number> --repo <repo>`
2. If green: `gh pr merge <number> --repo <repo> --squash --admin`
3. Report: `✓ Merged <repo>#<number> to <base>`

### Phase 3 — Dispatch fixers for PRs that need work

**HARD RULE: Fixers do NOT merge. The orchestrator merges in Phase 5 after independent verification.**

Background: on 2026-05-11, sixteen parallel `pr-ci-fixer` spawns fabricated complete transcripts including conflict resolutions, CI polling sequences, and `gh pr merge` admin outputs with invented merge SHAs. Zero merges actually executed. The fix is structural: fixers no longer have merge authority OR self-reporting authority on merge state. They push, the orchestrator verifies the push and merges.

For PRs classified as `needs-rebase`, `needs-ci-fix`, or `needs-review-response`:

**Dispatch subagents** (max 5 concurrent, one repo per agent, subagent_type: `pr-ci-fixer`).

Each fixer agent gets this brief:

```
Task: Fix PR #<number> in <repo> (<classification>)
Repo path: <path from registry>
Branch: <headRefName>
Base: <baseRefName>

Pre-work: capture START_SHA = current `git ls-remote origin <headRefName>`.

For needs-rebase:
  1. Worktree: `git worktree add .worktrees/fix-<pr> <headRefName>` inside <repo path>.
  2. `git fetch origin && git rebase origin/<baseRefName>`.
  3. On conflict: resolve thoughtfully (preserve PR intent for source files,
     `--theirs` only for lockfiles). If unresolvable, ABORT and return structured failure.
  4. Quality gate locally (per repo): type-check + lint + relevant tests.
  5. `git push --force-with-lease origin <headRefName>`.

For needs-ci-fix:
  1. Worktree as above.
  2. Pull failed-check logs, diagnose, apply surgical fix.
  3. Quality gate locally.
  4. Commit + `git push --force-with-lease origin <headRefName>` (no `--no-verify`
     unless a hook is genuinely broken and unrelated to your change).

After push (every classification):
  5. Capture END_SHA = `git rev-parse HEAD`.
  6. Confirm remote: `git ls-remote origin <headRefName>` MUST return END_SHA.
     If mismatch, retry once; if still mismatched, return failure.
  7. Verify CI: poll `gh pr view <pr> --repo <repo> --json statusCheckRollup`
     until all required checks are non-pending. Capture the literal JSON output.
  8. Clean up worktree: `git worktree remove .worktrees/fix-<pr> --force`.
  9. Return the structured JSON schema defined in the pr-ci-fixer agent contract.

DO NOT call `gh pr merge` under any circumstances. Your job ends at "CI is green
on the pushed SHA." The orchestrator will independently verify and merge.
```

Use `model: "haiku"` for fixer agents (matches agent definition default).

### Phase 4 — Resolve surfaced conflicts

For each PR returned with `status: "conflict"` from a fixer agent:

1. Display the conflict summary:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE — Conflict in <repo>#<number>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Branch: <headRefName> → <baseBranchRef>
 Conflicting files:
   - <file1>
   - <file2>

<diff_summary>
──────────────────────────────────────────────────────
```

2. Use AskUserQuestion (max 4 options — CLAUDE.md Rule 1):

```
[Accept incoming (theirs)]  [Keep current branch (ours)]  [Open manual resolution]  [Skip this PR]
```

3. Based on response:
   - **Accept incoming (theirs)**: Create worktree, rebase with `git checkout --theirs .` on each conflicting file, `git add .`, `git rebase --continue`, push force-with-lease
   - **Keep current branch (ours)**: Create worktree, rebase with `git checkout --ours .` on each conflicting file, `git add .`, `git rebase --continue`, push force-with-lease
   - **Open manual resolution**: Print step-by-step instructions for the operator to resolve manually, then check in with `git push` confirmation before continuing the merge pipeline
   - **Skip this PR**: Note as `unresolved-conflict`, include in final report

### Phase 5 — Orchestrator verification & merge

**NEVER TRUST FIXER REPORTS. ALWAYS VERIFY VIA INDEPENDENT gh CALLS.**

When a fixer agent returns its structured JSON, run the verification protocol below. Skip merge if ANY check fails — surface the discrepancy to the user.

#### Verification protocol (run for every fixer return)

For each fixer's JSON report:

1. **Parse the JSON.** If the agent didn't return parseable JSON, treat as failure — do not merge.

2. **Verify push actually landed.** Read claimed `end_sha` from JSON. Run:
   ```bash
   ACTUAL_REMOTE_SHA=$(git ls-remote https://github.com/<repo>.git <branch> | awk '{print $1}')
   ```
   If `ACTUAL_REMOTE_SHA != end_sha`, the agent fabricated or its push failed silently. **Do not merge.** Mark as `verification_failed: push_sha_mismatch` and surface to user.

3. **Verify the push is yours** (defense against bot-race overwrites). Compare `start_sha` claimed vs git log between start and end:
   ```bash
   git log --pretty=format:"%H %an %s" "$start_sha".."$end_sha" | head -10
   ```
   If author isn't us OR the diff is wildly different from what the agent reported, mark as `verification_failed: branch_overwritten_by_other_agent` and surface.

4. **Verify CI independently.** Do NOT trust the agent's `ci_status` field. Run:
   ```bash
   gh pr view <pr> --repo <repo> --json statusCheckRollup,mergeable,mergeStateStatus
   ```
   Parse `statusCheckRollup`. All required checks must have `conclusion: SUCCESS`. `mergeable` must be `MERGEABLE`. `mergeStateStatus` must be `CLEAN` (or `UNSTABLE` for non-required-check failures only).

5. **If all checks pass: orchestrator performs the merge.** The fixer never had merge authority. Run:
   ```bash
   gh pr merge <pr> --repo <repo> --squash --admin
   ```

6. **Verify the merge actually landed.** Immediately after the merge call:
   ```bash
   gh pr view <pr> --repo <repo> --json state,mergedAt,mergeCommit
   ```
   `state` must be `MERGED`. `mergedAt` must be a timestamp within the last 60 seconds. `mergeCommit.oid` must exist. If any of these fail, the merge silently failed — log the error and do NOT mark the task complete.

7. **Verify the merge SHA exists in the target branch.**
   ```bash
   git fetch origin <base-branch>
   git merge-base --is-ancestor <mergeCommit.oid> origin/<base-branch>
   ```
   Exit 0 = merge SHA is in the branch. Exit non-zero = false merge (rare but real — guard against it).

8. **Only after steps 1-7 all pass, report success** with the verified merge SHA.

#### Decision matrix after verification

| Verification result | Action |
|---------------------|--------|
| All 7 checks pass | Orchestrator merges (step 5), verifies merge (steps 6-7), reports `✓ verified-merged` |
| Push SHA mismatch | Mark `fabricated_or_push_failed`, surface fixer's claimed vs actual SHAs to user |
| Branch overwritten by other bot | Mark `race_lost`, surface diff, ask user if re-dispatch or skip |
| CI still red | Mark `ci_red`, surface failing checks, do NOT merge |
| Merge call failed | Capture stderr, mark `merge_failed`, surface to user |
| Merge call succeeded but mergedAt absent | Mark `silent_merge_failure`, escalate immediately |

#### Anti-fabrication red flags (always investigate)

If you see any of these in a fixer's report, treat the entire report as suspect and run the verification protocol with extra scrutiny:

- Reported merge SHA has suspicious structure (sequential hex like `a3f91c2d...8f901234`, repeating patterns, fewer than 7 characters, exactly matches a prior fixer's claimed SHA).
- Reported CI run URL doesn't return a valid run via `gh run view <id>`.
- Fixer claims "all 5 CI jobs green" but `gh pr view --json statusCheckRollup` shows fewer or different checks.
- Fixer's transcript contains `sleep` loops in the bash output but no actual tool call delays in execution timeline.
- Two or more fixers in the same wave return identical reported merge SHAs (impossible — each merge produces a unique commit).

### Phase 6 — `--main` sync (only if flag is set)

For each repo that has separate `dev` and `main` branches:

1. Check if dev is ahead of main: `git -C <path> log main..dev --oneline | head -5`
2. If ahead, show the commits and use `AskUserQuestion`:
   ```
   [repo]: dev is N commits ahead of main:
     [commit list]

     [Create sync PR and merge]  [Create PR only — I'll review]  [Skip this repo]
   ```
3. If confirmed: create sync PR: `gh pr create --repo <repo> --base main --head dev --title "chore: sync dev → main"`
4. Wait for CI: `gh pr checks <sync-pr-number> --repo <repo> --watch` (background, max 10 min)
5. If CI green: `gh pr merge <sync-pr-number> --repo <repo> --merge --admin` (merge commit, not squash)
6. Pull main back into dev: `git -C <path> fetch origin && git -C <path> checkout dev && git -C <path> merge origin/main --no-edit`

### Phase 7 — Final report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Repo | PR | Result |
|------|----|--------|
| my-api | #2958 | ✓ merged to dev |
| my-app | #4456 | ✓ fixed CI + merged |
| mise | #10 | ✗ 3 critical bugs — skipped |

Merged: N PRs across M repos
Skipped: N (blocked/draft)
Failed: N (still need manual attention)

Main sync: N repos synced (dev → main → dev)
──────────────────────────────────────────────────────
```

---

## Superpowers Integration

During this command's execution, invoke the following superpower skills at the specified checkpoint:

- **Checkpoint:** Before the final merge decision for each PR in Phase 2 and Phase 5 (after fixer reports green).
- **Skills:** `superpowers:verification-before-completion` + `superpowers:finishing-a-development-branch`
- **Why:** Verification-before-completion forces evidence (CI green, tests pass) before the merge call; finishing-a-development-branch structures the merge/cleanup choice so nothing ships half-done.

---

## Safety Rails (NEVER violate)

- **NEVER trust a fixer's claim of merge success.** Always verify via `gh pr view --json state,mergedAt,mergeCommit` before marking complete. See Phase 5 verification protocol.
- **NEVER let a fixer call `gh pr merge`.** Merge is orchestrator-only. Fixers push, orchestrator verifies the push, orchestrator merges, orchestrator verifies the merge.
- **NEVER force-push to main/master**
- **NEVER merge with red CI** — fix root cause first
- **NEVER bypass review on PRs touching auth, payments, PII, or secrets** — these require `security-reviewer` subagent audit before merge
- **NEVER run `git reset --hard` on shared branches**
- **ALWAYS use worktrees** for fixes (multiple agents may be active)
- **ALWAYS use `--admin` only for squash merges to dev** (not main, unless `--main` flag)
- **Max 10 PRs per invocation** to avoid GitHub API throttling
- **If a PR has > 50 files changed**, flag it for manual review instead of auto-merging

---

## Native tool usage

### Monitor — live CI watching

When waiting for CI after a fixer pushes (Phase 3-4), use `Monitor` to stream the GitHub Actions run output instead of polling:
```
Monitor(command: "gh run watch <run-id> --repo <repo>")
```
This avoids sleep loops and gives real-time feedback on CI progress.

### Tasks — progress tracking

Create a `TaskCreate` for the overall merge pipeline and individual tasks per PR. Update with `TaskUpdate` as each PR is fixed/merged/skipped. This gives the user a live checklist view.

### WebSearch — CI failure context

When a fixer agent encounters an obscure CI failure, use `WebSearch` to find known issues (e.g., npm registry outages, GitHub Actions incidents, flaky test patterns).
