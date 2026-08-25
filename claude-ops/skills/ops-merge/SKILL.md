---
name: ops-merge
description: "OPS on-demand: This skill should be used when the user asks to \"merge PRs\", \"salvage branches\", or…"
argument-hint: '[--main] [--repo org/repo] [--dry-run] [--no-salvage] [--salvage-only]'
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
context: fork
---

## Runtime Context

Before executing, load:

1. **Preferences**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json` — read `owner`, `timezone`, project registry
2. **Daemon health**: `cat ${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json` — if `action_needed` set, surface to user
3. **Secrets**: GitHub token: env `$GITHUB_TOKEN` → Doppler MCP (`mcp__doppler__*`) → `doppler secrets get GITHUB_TOKEN --plain` → password manager

# OPS ► MERGE

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

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

## Pre-gathered salvage data (orphan worktrees, branches without PRs, uncommitted/unpushed work)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-merge-salvage-scan 2>/dev/null || echo '{"repos":[],"error":"salvage-scan failed"}'
```

## Your task

You are the **merge orchestrator**. Your job is to get every open PR across the owner's repos merged — fixing whatever blocks them first.

### Parse arguments

From `$ARGUMENTS`:

- `--main` → after all PRs merge to dev, also sync dev↔main for repos that have both branches
- `--repo <slug>` → scope to one repo only (e.g., `--repo your-org/my-api`)
- `--dry-run` → report what would happen, don't dispatch agents or merge anything
- `--force` → skip the confirmation prompt before merging
- `--no-salvage` → skip Phase 0 (Salvage). Behaves like the legacy PR-only pipeline.
- `--salvage-only` → run Phase 0 only and stop. Useful for "find and finish all loose local work" without touching the existing PR queue yet.
- (empty) → process all repos: salvage local work first, then merge PRs to dev only

### Phase 0 — Salvage scan (run BEFORE the PR queue)

**Goal:** every repo in every org gets a clean slate before the PR merge pipeline runs. Find and finish every piece of local work that isn't already on `dev`/`main` and isn't already in an open PR — orphan worktrees, feature branches without PRs, uncommitted/staged/stashed changes, and unpushed commits.

**Skip this phase only if `--no-salvage` is set.**

Parse the JSON returned by `ops-merge-salvage-scan`. For each repo with `has_salvage: true`, classify each finding into one of:

| Finding                                                            | Classification          | Action                                                                                             |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------- |
| Worktree with `dirty_files > 0` or `unpushed_commits > 0`          | `worktree-incomplete`   | Dispatch salvager: finish work in the worktree, commit, push, open PR if missing                   |
| Worktree on a branch with `has_open_pr: false`                     | `worktree-orphan-pr`    | Dispatch salvager: confirm work is complete (lint/type/test gate), push if needed, open PR         |
| Local branch with `integrated: false` and `has_open_pr: false`     | `branch-no-pr`          | Dispatch salvager: review state, push if unpushed, open PR targeting integration branch            |
| Local branch with `integrated: true` and `has_open_pr: false`      | `branch-already-merged` | Surface to user → `[Delete local branch]` / `[Keep]` (NEVER auto-delete — Safety Rails)            |
| Main checkout: `dirty_files > 0` or `staged_files > 0` or stash >0 | `checkout-dirty`        | Surface to user → `[Stash & continue]` / `[Open salvage worktree]` / `[Skip]`. Never auto-discard. |
| Main checkout: `unpushed_commits > 0` on a non-integration branch  | `checkout-unpushed`     | Dispatch salvager: push the branch, open PR if missing                                             |

**Print the salvage queue:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE — Phase 0: Salvage Queue
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Repo | Location | Branch | State | Classification | Action |
|------|----------|--------|-------|----------------|--------|
| my-api | .worktrees/feat-x | feat/x | 3 dirty, 2 unpushed | worktree-incomplete | salvage |
| my-app | (main checkout) | feat/y | 5 unpushed, no PR | checkout-unpushed | salvage |
| mise | refs/heads/old-experiment | old-experiment | integrated, no PR | branch-already-merged | confirm delete |
| ... | ... | ... | ... | ... | ... |

Salvageable: N  |  Needs user input: N  |  Clean: M
──────────────────────────────────────────────────────
```

If `--dry-run`, print the queue and stop here (skip Phase 1+).
If `--salvage-only`, run the salvage dispatch loop below, then stop (skip Phase 1+).

**Confirmation gate:** unless `--force`, use `AskUserQuestion` (max 4 options — Plugin Rule 1) to confirm before dispatching salvagers:

```
N pieces of loose local work found across M repos.

  [Salvage all N — dispatch agents]  [Let me pick which ones]  [Skip Phase 0 — go to PR queue]  [Abort]
```

**Dispatch salvager subagents** (max 5 concurrent, one repo per agent — never share the main checkout per CLAUDE.md worktree isolation rule). Use `subagent_type: "general-purpose"` for now (or a future `salvage-fixer` agent if one exists). Each salvager gets this brief:

```
Task: Finish and PR loose local work in <repo>
Repo path: <path from salvage scan>
Findings:
  - <classification>: <branch / worktree path> — <state summary>
  - ...

Worktree isolation: if the work lives in an existing .worktrees/* dir, work IN that directory.
If the work lives only on a local branch (no worktree), create one:
  git -C <repo path> worktree add .worktrees/salvage-<branch> <branch>

For each finding:
  1. cd into the worktree.
  2. Inspect state: `git status`, `git log <integration>..HEAD --oneline`, `git diff --stat`.
  3. **Stale-copy guard (mandatory, per candidate file before commit):**
     - Set `BASE=$(git merge-base HEAD origin/<integration_branch>)`.
     - List files you plan to salvage from the worktree.
     - For each file `<f>`:
       - If `git diff --quiet "$BASE..origin/<integration_branch>" -- "<f>"` is **false** (integration changed `<f>` since base), treat `<f>` as high risk.
       - For high-risk files, inspect both sides before staging:
         - `git diff "$BASE..origin/<integration_branch>" -- "<f>"`
         - `git diff "$BASE..HEAD" -- "<f>"`
       - Only stage hunks that are genuinely new work from the salvage branch. Do **not** stage a wholesale file replacement that drops integration-side hunks.
       - If you cannot prove the salvage branch is newer for `<f>`, mark the finding `aborted_for_review` (do not commit the file).
  4. Read recent commit messages + any TODOs/HEREs in the diff. Decide whether the work is:
       (a) complete and just needs commit/push/PR — proceed
       (b) incomplete but obvious next step — finish it
       (c) ambiguous or risky → ABORT this finding and return it for human review.
  5. If finishing work: make the smallest correct commit. Quality gate locally
     (per-repo: type-check + lint + relevant tests).
  6. Commit with a clear message. NEVER use --no-verify unless a hook is genuinely
     broken and unrelated to your change.
  7. Push: `git push -u origin <branch>` (or `--force-with-lease` if branch already remote).
  8. Open PR (only if has_open_pr=false in the brief):
       gh pr create --repo <repo> --base <integration_branch> --head <branch> \
         --title "<derived from commit messages>" \
         --body "Salvaged by /ops:merge Phase 0. <commit summary>"
  9. Return structured JSON:
       {
         "repo": "...",
         "branch": "...",
         "status": "pr_opened" | "pushed_only" | "aborted_for_review" | "failed",
         "pr_number": <int or null>,
         "pr_url": "<or null>",
         "end_sha": "<remote head>",
         "notes": "..."
       }

DO NOT call `gh pr merge` — newly opened PRs flow through Phase 1+ like any other PR.
DO NOT delete branches, worktrees, or stashes. Salvage = finish + PR, never destroy.
DO NOT touch files outside the assigned worktree.
```

**After all salvagers return:** re-run `ops-merge-scan` so the freshly opened PRs join the Phase 1 queue. Surface any `aborted_for_review` findings to the user with a brief explanation and `[Open in editor]` / `[Skip]` options.

**Branches classified `branch-already-merged` and `checkout-dirty`** are surfaced one-by-one to the user via `AskUserQuestion` (never auto-handled — see Safety Rails).

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
2. If green: `gh pr merge <number> --repo <repo> --squash` (never `--admin` — see "Never bypass a branch gate" below)
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

DO NOT file a tracking issue for a CI failure you could not fix — in ANY repo.
No `gh issue create`, no `github.rest.issues.create`, no cross-repo issue. If you
cannot get CI green, return the structured failure in your JSON result and STOP;
the orchestrator decides what happens next. (Rationale: emergent issue-filing on
unfixable CI produced 17+ duplicate `[TEAM] CI failure on PR #N` issues — one per
failing check, zero dedup, cross-posted into the wrong repo. A fixer's only valid
outputs are a pushed green SHA or a structured failure report — never an issue.)
If a tracking issue is ever genuinely wanted, that is the orchestrator's call and
it MUST first `gh issue list --search "PR #<n> in:title" --state open` to dedup.
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
   gh pr merge <pr> --repo <repo> --squash
   ```

   Never add `--admin`. If the merge is refused, that refusal is the gate doing its
   job — see "Never bypass a branch gate" below.

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

| Verification result                      | Action                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| All 7 checks pass                        | Orchestrator merges (step 5), verifies merge (steps 6-7), reports `✓ verified-merged` |
| Push SHA mismatch                        | Mark `fabricated_or_push_failed`, surface fixer's claimed vs actual SHAs to user      |
| Branch overwritten by other bot          | Mark `race_lost`, surface diff, ask user if re-dispatch or skip                       |
| CI still red                             | Mark `ci_red`, surface failing checks, do NOT merge                                   |
| Merge call failed                        | Capture stderr, mark `merge_failed`, surface to user                                  |
| Merge call succeeded but mergedAt absent | Mark `silent_merge_failure`, escalate immediately                                     |

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
4. Wait for CI with a bounded REST poll (never `--watch`, which is denied by `hooks/gh-watch-guard.sh`):
   `for i in $(seq 1 20); do gh api repos/<repo>/commits/<sha>/check-runs --jq '[.check_runs[].conclusion]'; sleep 30; done` — 20 ticks x 30s = 10 min ceiling
5. If CI green: `gh pr merge <sync-pr-number> --repo <repo> --merge` (merge commit, not squash; never `--admin`)
6. Pull main back into dev: `git -C <path> fetch origin && git -C <path> checkout dev && git -C <path> merge origin/main --no-edit`

### Phase 7 — Final report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MERGE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 0 — Salvage
| Repo | Finding | Result |
|------|---------|--------|
| my-api | feat/x worktree | ✓ pushed + PR #2999 opened |
| my-app | feat/y local-only | ✓ pushed + PR #4470 opened |
| mise | old-experiment (merged) | ⚠ surfaced for delete confirmation |

Salvaged: N pieces of work → N new PRs opened
Aborted for review: N
User-input pending: N (dirty checkouts, already-merged branches)

Phase 1–5 — PR merges
| Repo | PR | Result |
|------|----|--------|
| my-api | #2958 | ✓ merged to dev |
| my-api | #2999 | ✓ salvaged + merged to dev |
| my-app | #4456 | ✓ fixed CI + merged |
| mise | #10 | ✗ 3 critical bugs — skipped |

Merged: N PRs across M repos
Skipped: N (blocked/draft)
Failed: N (still need manual attention)

Phase 6 — Main sync
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
- **NEVER merge, or open a PR against, a repo the owner is not a member of.** The registry lists every locally cloned project, so a fork's upstream (`facebookresearch/*`, someone else's OSS) appears in the queue carrying open PRs from unrelated contributors. Those are read-only. Contributing upstream is a deliberate act the owner asks for, one PR at a time, never a pipeline sweep.

  **Check push access immediately before every `gh pr create`, `gh pr merge`, and `git push` — in every phase (0 salvage, 2 merge, 5 verified-merge, 6 main sync):**

  ```bash
  PERM=$(gh api "repos/$REPO" --jq '.permissions.push' 2>/dev/null || echo error)
  [ "$PERM" = "true" ] || { echo "refusing: no confirmed push access to $REPO ($PERM)"; exit 1; }
  ```

  **Fail closed.** Only a literal `true` proceeds. `false`, `null`, a network error, a renamed repo, or an empty response all refuse. The scan filtering the queue is not sufficient on its own: the queue can be stale, hand-edited, or passed in by an operator, and the step after it is a merge. Re-check at the point of action, not once at the start.

  `OPS_MERGE_INCLUDE_EXTERNAL=<owner/name>` authorises exactly one repo for one run, and only when the owner asked. It is a slug, never a boolean — a global on/off would re-open the whole registry to a pipeline whose next call is `gh pr merge`.
- **NEVER force-push to main/master**
- **NEVER merge with red CI** — fix root cause first
- **NEVER bypass review on PRs touching auth, payments, PII, or secrets** — these require `security-reviewer` subagent audit before merge
- **NEVER run `git reset --hard` on shared branches**
- **ALWAYS use worktrees** for fixes (multiple agents may be active)
- **NEVER bypass a branch gate.** Do not pass `--admin` to `gh pr merge`, and do not
  widen a ruleset, add yourself to a bypass list, or grant yourself admin to get a merge
  through. A refused merge is the protection working. See "Never bypass a branch gate" below.
- **ALWAYS confirm the base branch before merging.** Read `baseRefName` from
  `gh pr view <n> --json baseRefName` in the same step as the merge. A run scoped to one
  branch must refuse a PR whose base is a different one — a protected branch typically
  carries a review gate the scoped branch does not.
- **Max 10 PRs per invocation** to avoid GitHub API throttling
- **If a PR has > 50 files changed**, flag it for manual review instead of auto-merging

### Never bypass a branch gate

`gh pr merge --admin` merges past branch protection and org rulesets. It is banned in
this pipeline, in every phase, on every repo. So is any other route to the same outcome:
editing a ruleset's conditions, adding an actor to a bypass list, or promoting your own
account to get a merge through.

Why it matters here specifically: a merge queue sweeps many repos at once, and repo
governance is not uniform. Organisations commonly scope a review gate to a subset of
repos via a repository custom property, and protect only some branches. The pipeline
cannot see that policy from the PR alone — but the merge API can, and it enforces it.
`--admin` throws that enforcement away silently and succeeds, so the violation is only
discoverable afterwards, from the commit.

Rules:

1. Never pass `--admin` (or `--auto` as a workaround for a refused merge).
2. Read `baseRefName` in the same step as the merge and refuse any PR whose base is
   outside the run's declared scope. A default-branch merge and a protected-branch merge
   are different acts with different approvals.
3. Treat a refusal as a result, not an obstacle. `mergeStateStatus: BLOCKED` with green
   checks usually means a required approval or an unresolved review thread. Resolve the
   findings, request the human reviewer, report the PR as waiting, and move on.
4. If a merge is genuinely urgent and gated, that is the owner's decision to make, not
   the pipeline's. Surface it; never route around it.

A merge that landed via bypass cannot be silently undone. Report it immediately, name
the commit, and say which gate it skipped.

### Phase 0 (Salvage) Safety Rails

- **NEVER auto-delete a local branch, worktree, or stash** — even if classified `branch-already-merged`. Always surface to the user via `AskUserQuestion`.
- **NEVER `git stash drop` or `git checkout -- <file>` or `git clean`** in any checkout — uncommitted work is the user's, not the agent's, until they confirm.
- **NEVER auto-commit ambiguous changes.** If a salvager can't tell whether work is complete, it MUST return `aborted_for_review` and let the user decide.
- **NEVER commit stale snapshots over integration branch progress.** If integration branch and salvage branch both changed a file since merge-base, stage only provably new hunks (or abort for review).
- **NEVER share the main checkout between salvager subagents.** Per CLAUDE.md worktree isolation: each agent gets its own `.worktrees/salvage-<branch>` dir. Sharing the main checkout causes branch-switch collisions.
- **NEVER force-push a branch the salvager didn't originate work on** — salvagers may only push with `--force-with-lease` to branches whose tip they fetched at start of work.
- **NEVER salvage main/master/dev** — those are integration branches; loose work on them surfaces to the user, never auto-pushed.
- **NEVER touch files outside the assigned worktree.** Salvagers are scoped to one repo + one branch.
- **ALWAYS run the per-repo quality gate** (type-check + lint + tests) before pushing salvaged work.
- **ALWAYS open a PR (not direct push to dev/main)** — salvaged work flows through the same review/CI/merge gate as any other PR.

---

## Native tool usage

### Monitor — live CI watching

When waiting for CI after a fixer pushes (Phase 3-4), use `Monitor` with a bounded
REST poll. `gh run watch` is banned — it polls every 2-5s with no tick cap and
`hooks/gh-watch-guard.sh` denies it:

```
Monitor(command: "for i in $(seq 1 60); do s=$(gh api repos/<repo>/actions/runs/<run-id> --jq '.status+\" \"+(.conclusion//\"pending\")'); echo \"$s\"; case \"$s\" in completed*) break;; esac; sleep 30; done")
```

Finite tick count, 30s sleep floor, REST bucket rather than GraphQL.

### Tasks — progress tracking

Create a `TaskCreate` for the overall merge pipeline and individual tasks per PR. Update with `TaskUpdate` as each PR is fixed/merged/skipped. This gives the user a live checklist view.

### WebSearch — CI failure context

When a fixer agent encounters an obscure CI failure, use `WebSearch` to find known issues (e.g., npm registry outages, GitHub Actions incidents, flaky test patterns).

---

## Ledger Integration

**CLAIM_KEY:** `gh:pr:<owner>/<repo>#<number>` (e.g. `gh:pr:your-org/your-repo#42`)

### Pre-flight skip-check

```bash
CLAIM_KEY="gh:pr:<owner>/<repo>#<number>"
ledger query --claim-key "$CLAIM_KEY" --since=-PT24H
```

If `done` exists, the PR was already merged or closed this session — skip. If
`in_progress` exists from another agent, do not attempt a concurrent merge.

### Claim + resolve

```bash
# Claim when beginning CI fix or merge flow for a PR
ledger write \
  --claim-key "$CLAIM_KEY" \
  --kind "merge" \
  --status "in_progress" \
  --title "Merge: <repo>#<number> — <PR title>" \
  --ttl-sec 3600

# Resolve after merge completes or is skipped
ledger write \
  --claim-key "$CLAIM_KEY" \
  --kind "merge" \
  --status "done" \
  --title "Merge: <repo>#<number> — <PR title>" \
  --context "merged|skipped: <reason>"
```

## Additional resources

CLI detail: `references/cli.md`.
