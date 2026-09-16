#!/usr/bin/env bash
# release-pr-sweep.sh — pre-release pull-request sweep for ops-release.
#
# Sourced by bin/ops-release. Runs BEFORE the version bump so that everything
# that can land is already on main when the changelog and tag are cut.
#
# For every OPEN pull request targeting main (drafts and fork PRs included):
#
#   1. Classify   — state, draft flag, mergeable, mergeable_state, and the
#                   check runs for the head sha.
#   2. Unblock    — a PR from a fork has its workflow runs held at
#                   `action_required` until a maintainer approves them. Until
#                   that happens the required checks never start and
#                   mergeable_state sits at "blocked" forever. Approve the runs
#                   so CI can actually report.
#   3. Review     — one background agent per PR: read the diff, judge whether it
#                   is good, undraft it when ready, and fix failing checks.
#                   Independent PRs get independent agents, dispatched together.
#   4. Merge      — only PRs that are BOTH judged good AND fully green on the
#                   required checks. Anything else is reported and left open;
#                   the release proceeds without it.
#
# Merge criteria (all must hold):
#   - open, targets main, not a draft (after the agent's chance to undraft)
#   - no merge conflict (mergeable_state != dirty, mergeable != false)
#   - the agent verdict is literally GOOD
#   - every required check is present and completed for the head sha
#   - no check run concluded failure | timed_out | action_required | error
#     (skipped, neutral and cancelled are NOT failures)
#
# Deliberate no-ops — the sweep reports and moves on, never forces:
#   - the REST rate budget is low (bail before touching anything)
#   - a PR that does not target main
#   - a PR the agent did not clearly bless (anything other than GOOD)
#   - a PR that stays red, stays draft, or has conflicts
#   - a PR whose head sha moved while the sweep was running
#
# GitHub is read over REST (`gh api repos/...`) only. Never `gh pr checks` or
# `gh pr view` (GraphQL), never a poll loop with a short fixed sleep.

# Failure conclusions. Everything else that has completed counts as non-failing.
SWEEP_FAIL_CONCLUSIONS="${SWEEP_FAIL_CONCLUSIONS:-failure timed_out action_required error}"

# Checks that must exist and be finished before a PR may merge.
SWEEP_REQUIRED_CHECKS_DEFAULT='["lint-and-check (ubuntu-latest)","lint-and-check (ubuntu-24.04)","pii-gate","test-suite (ubuntu-latest)","test-suite (ubuntu-24.04)","CodeQL"]'

# REST core calls we refuse to start a sweep below.
SWEEP_RATE_FLOOR="${SWEEP_RATE_FLOOR:-300}"

# Wall clock a single review agent gets.
SWEEP_AGENT_TIMEOUT="${SWEEP_AGENT_TIMEOUT:-900}"

# Upper bound on PRs swept in one run, so a stale backlog cannot burn the budget.
SWEEP_MAX_PRS="${SWEEP_MAX_PRS:-20}"

sweep_log() { echo "ops-release: sweep: $*"; }
sweep_warn() { echo "ops-release: sweep: $*" >&2; }

# Run a command under a wall-clock bound. `timeout` is GNU-only, so fall back to
# python3, which ops-release already requires.
sweep_bounded() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$seconds" "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[2:], timeout=float(sys.argv[1]), check=False)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
  else
    "$@"
  fi
}

# --- GitHub reads -------------------------------------------------------------

# Remaining REST core budget. Prints a number; 0 when it cannot be read.
sweep_rate_remaining() {
  gh api /rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo 0
}

# Refuse to start when the budget is thin. A half-finished sweep that dies on a
# 403 mid-merge is worse than one that never ran.
sweep_rate_ok() {
  local remaining
  remaining="$(sweep_rate_remaining)"
  [[ "$remaining" =~ ^[0-9]+$ ]] || remaining=0
  if [ "$remaining" -lt "$SWEEP_RATE_FLOOR" ]; then
    sweep_warn "REST budget is $remaining (floor $SWEEP_RATE_FLOOR) — skipping the sweep"
    return 1
  fi
  sweep_log "REST budget $remaining"
  return 0
}

# Open PRs against main, newest last. Emits a compact JSON array.
sweep_open_prs() {
  local repo="$1"
  gh api "repos/$repo/pulls?state=open&base=main&per_page=100" 2>/dev/null \
    | jq -c '[ .[] | {
        number,
        title,
        draft: (.draft // false),
        head_sha: .head.sha,
        head_label: (.head.label // ""),
        base_ref: (.base.ref // ""),
        fork: ((.head.repo.full_name // "") != (.base.repo.full_name // ""))
      } ]' 2>/dev/null
}

# Single PR, re-read for the fields the list endpoint does not compute.
sweep_pr_detail() {
  local repo="$1" num="$2"
  gh api "repos/$repo/pulls/$num" 2>/dev/null \
    | jq -c '{
        number,
        draft: (.draft // false),
        state,
        head_sha: .head.sha,
        base_ref: (.base.ref // ""),
        mergeable: .mergeable,
        mergeable_state: (.mergeable_state // "unknown")
      }' 2>/dev/null
}

# Check runs for a head sha, normalized to {name, status, conclusion}.
sweep_check_runs() {
  local repo="$1" sha="$2"
  gh api "repos/$repo/commits/$sha/check-runs?per_page=100" 2>/dev/null \
    | jq -c '[ .check_runs[]? | {
        name,
        status,
        conclusion: (.conclusion // "")
      } ]' 2>/dev/null
}

# green | pending | failed, for a normalized check-runs array plus the required list.
# skipped / neutral / cancelled are explicitly NOT failures.
sweep_check_verdict() {
  local runs="$1" required="${2:-$SWEEP_REQUIRED_CHECKS_DEFAULT}"
  jq -r --argjson required "$required" --arg fails "$SWEEP_FAIL_CONCLUSIONS" '
    ($fails | split(" ")) as $bad
    | if any(.[]; .conclusion as $c | $bad | index($c)) then "failed"
      elif (($required - [.[] | select(.status == "completed") | .name]) | length) > 0 then "pending"
      elif any(.[]; .status != "completed") then "pending"
      else "green" end' <<<"$runs" 2>/dev/null || echo "pending"
}

# Names of the checks that are actually failing, for the report.
sweep_failing_names() {
  jq -r --arg fails "$SWEEP_FAIL_CONCLUSIONS" '
    ($fails | split(" ")) as $bad
    | [ .[] | select(.conclusion as $c | $bad | index($c)) | .name ] | join(", ")' <<<"$1" 2>/dev/null
}

# --- Fork CI unblock ----------------------------------------------------------

# A fork PR's workflow runs sit at status=action_required until a maintainer
# approves them, so the required checks never start and mergeable_state stays
# "blocked" forever. This is the defect that stalled two good external PRs.
# Approve every held run for the head sha. Prints how many it approved.
sweep_approve_held_runs() {
  local repo="$1" sha="$2" ids id approved=0
  ids="$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" 2>/dev/null \
    | jq -r '.workflow_runs[]? | select(.status == "action_required") | .id' 2>/dev/null)" || ids=""
  for id in $ids; do
    if gh api --method POST "repos/$repo/actions/runs/$id/approve" >/dev/null 2>&1; then
      approved=$((approved + 1))
    else
      sweep_warn "could not approve held run $id"
    fi
  done
  printf '%s\n' "$approved"
}

# --- Review agent -------------------------------------------------------------

sweep_agent_prompt() {
  local repo="$1" num="$2" title="$3" draft="$4" verdict="$5" failing="$6"
  cat <<PROMPT
You are reviewing pull request #$num ("$title") on the PUBLIC repository $repo,
ahead of a release that will merge it if, and only if, it is good and green.

Current state: draft=$draft, checks=$verdict${failing:+, failing checks: $failing}

Do this with the gh CLI. Read GitHub over REST ('gh api repos/...') only: the
GraphQL-backed pr-checks and pr-view subcommands are banned here, as is any
tight poll loop around gh.

1. Read the full diff ('gh pr diff $num --repo $repo') and judge whether the
   change is correct, in keeping with the repository's conventions, and safe to
   land unattended.
2. If it is good but still a draft, mark it ready: 'gh pr ready $num --repo $repo'.
3. If required checks are failing, read the failing logs, fix the cause in the
   PR's own branch, and push. Never weaken, delete or skip a check to get green.
   Never merge it yourself, never force-push over someone else's history, and
   never reach for an administrator merge override.
4. The repository is PUBLIC: do not add personal names, email addresses or home
   directory paths to any file.

Then end your reply with exactly one line, on its own:

  SWEEP_VERDICT: GOOD     - the change is correct and should be merged
  SWEEP_VERDICT: SKIP     - anything else: unsure, risky, out of scope, or you
                            could not make it green

If your judgement is not clearly positive, say SKIP. A sweep that merges
something bad is far worse than a sweep that skips it.
PROMPT
}

# Run one review agent. Writes its transcript to $3. Always returns 0 — a dead
# agent is a SKIP, not a failed release.
sweep_run_agent() {
  local repo="$1" pr_json="$2" out="$3"
  local num title draft verdict failing prompt
  num="$(jq -r '.number' <<<"$pr_json")"
  title="$(jq -r '.title // ""' <<<"$pr_json")"
  draft="$(jq -r '.draft' <<<"$pr_json")"
  verdict="$(jq -r '.verdict // "unknown"' <<<"$pr_json")"
  failing="$(jq -r '.failing // ""' <<<"$pr_json")"
  prompt="$(sweep_agent_prompt "$repo" "$num" "$title" "$draft" "$verdict" "$failing")"

  if [ -n "${SWEEP_AGENT_CMD:-}" ]; then
    # Deliberately unquoted: the override is a command line, not one word.
    # shellcheck disable=SC2086
    printf '%s' "$prompt" | sweep_bounded "$SWEEP_AGENT_TIMEOUT" $SWEEP_AGENT_CMD >"$out" 2>/dev/null || true
    return 0
  fi
  if command -v claude_invoke >/dev/null 2>&1; then
    printf '%s' "$prompt" | claude_invoke --no-session-persistence -p >"$out" 2>/dev/null || true
  elif command -v claude >/dev/null 2>&1; then
    printf '%s' "$prompt" | sweep_bounded "$SWEEP_AGENT_TIMEOUT" claude -p >"$out" 2>/dev/null || true
  else
    : >"$out"
  fi
  return 0
}

# GOOD only when the agent said so in the exact agreed form. Silence, a crash,
# an empty transcript or anything ambiguous reads as SKIP.
sweep_agent_verdict() {
  local out="$1"
  [ -s "$out" ] || { echo "SKIP"; return 0; }
  if grep -qE '^[[:space:]]*SWEEP_VERDICT:[[:space:]]*GOOD[[:space:]]*$' "$out"; then
    echo "GOOD"
  else
    echo "SKIP"
  fi
}

# --- Main ---------------------------------------------------------------------

# release_pr_sweep <repo>
# Never returns non-zero for a PR it declined to merge: the release goes ahead
# without it. Returns 1 only when the sweep itself could not run.
release_pr_sweep() {
  local repo="$1"
  local prs count i pr num title draft head_sha base_ref fork detail
  local runs verdict failing approved merged=0 skipped=0
  local workdir pr_file line agent_says detail
  local d_state d_draft d_sha d_mergeable d_mstate
  local agent_jobs=() report=()

  command -v jq >/dev/null 2>&1 || { sweep_warn "jq required"; return 1; }
  sweep_rate_ok || return 1

  prs="$(sweep_open_prs "$repo")" || prs=""
  if ! jq -e 'type == "array"' <<<"${prs:-null}" >/dev/null 2>&1; then
    sweep_warn "could not list open pull requests — skipping the sweep"
    return 1
  fi
  count="$(jq 'length' <<<"$prs")"
  if [ "$count" -eq 0 ]; then
    sweep_log "no open pull requests against main — nothing to sweep"
    return 0
  fi
  if [ "$count" -gt "$SWEEP_MAX_PRS" ]; then
    sweep_warn "$count open PRs exceeds SWEEP_MAX_PRS=$SWEEP_MAX_PRS — sweeping the first $SWEEP_MAX_PRS"
    count="$SWEEP_MAX_PRS"
  fi
  sweep_log "$count open pull request(s) against main"

  workdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$workdir'" RETURN

  # Pass 1 — classify and unblock fork CI, then dispatch every agent together so
  # independent PRs are reviewed in parallel.
  for ((i = 0; i < count; i++)); do
    pr="$(jq -c ".[$i]" <<<"$prs")"
    num="$(jq -r '.number' <<<"$pr")"
    title="$(jq -r '.title' <<<"$pr")"
    draft="$(jq -r '.draft' <<<"$pr")"
    head_sha="$(jq -r '.head_sha' <<<"$pr")"
    base_ref="$(jq -r '.base_ref' <<<"$pr")"
    fork="$(jq -r '.fork' <<<"$pr")"

    if [ "$base_ref" != "main" ]; then
      report+=("#$num skipped: targets $base_ref, not main")
      skipped=$((skipped + 1))
      continue
    fi

    runs="$(sweep_check_runs "$repo" "$head_sha")"
    [ -n "$runs" ] || runs='[]'
    verdict="$(sweep_check_verdict "$runs")"

    # The action_required defect: held fork runs mean the required checks never
    # even start. Approve them, then re-read so the agent sees the truth.
    local held=0
    if jq -e 'any(.[]; .conclusion == "action_required" or .status == "action_required")' <<<"$runs" >/dev/null 2>&1; then
      held=1
    fi
    if [ "$fork" = "true" ]; then held=1; fi
    if [ "$held" -eq 1 ]; then
      approved="$(sweep_approve_held_runs "$repo" "$head_sha")"
      if [ "${approved:-0}" -gt 0 ]; then
        sweep_log "#$num: approved $approved held workflow run(s) (fork CI was waiting on a maintainer)"
        runs="$(sweep_check_runs "$repo" "$head_sha")"
        [ -n "$runs" ] || runs='[]'
        verdict="$(sweep_check_verdict "$runs")"
      fi
    fi

    failing="$(sweep_failing_names "$runs")"
    sweep_log "#$num draft=$draft fork=$fork checks=$verdict${failing:+ failing=$failing}"

    printf '%s' "$(jq -c -n --argjson pr "$pr" --arg v "$verdict" --arg f "$failing" \
      '$pr + {verdict: $v, failing: $f}')" >"$workdir/$num.pr.json"
    sweep_run_agent "$repo" "$(cat "$workdir/$num.pr.json")" "$workdir/$num.agent.txt" &
    agent_jobs+=("$!")
  done

  # Independent PRs, independent agents, all in flight at once.
  # (Guarded: bash 3.2 treats an empty array as unbound under `set -u`.)
  if [ "${#agent_jobs[@]}" -gt 0 ]; then
    for i in "${agent_jobs[@]}"; do wait "$i" 2>/dev/null || true; done
  fi

  # Pass 2 — re-read every PR after the agents have had their say, then merge
  # only what is both good and green.
  for pr_file in "$workdir"/*.pr.json; do
    [ -f "$pr_file" ] || continue
    pr="$(cat "$pr_file")"
    num="$(jq -r '.number' <<<"$pr")"
    head_sha="$(jq -r '.head_sha' <<<"$pr")"
    local agent_says
    agent_says="$(sweep_agent_verdict "$workdir/$num.agent.txt")"

    if [ "$agent_says" != "GOOD" ]; then
      report+=("#$num left open: the review agent did not bless it (verdict $agent_says)")
      skipped=$((skipped + 1))
      continue
    fi

    detail="$(sweep_pr_detail "$repo" "$num")"
    if ! jq -e '.number' <<<"${detail:-null}" >/dev/null 2>&1; then
      report+=("#$num left open: could not re-read the PR after review")
      skipped=$((skipped + 1))
      continue
    fi
    local d_state d_draft d_sha d_mergeable d_mstate
    d_state="$(jq -r '.state' <<<"$detail")"
    d_draft="$(jq -r '.draft' <<<"$detail")"
    d_sha="$(jq -r '.head_sha' <<<"$detail")"
    d_mergeable="$(jq -r '.mergeable' <<<"$detail")"
    d_mstate="$(jq -r '.mergeable_state' <<<"$detail")"

    if [ "$d_state" != "open" ]; then
      report+=("#$num skipped: no longer open ($d_state)")
      skipped=$((skipped + 1)); continue
    fi
    if [ "$d_draft" = "true" ]; then
      report+=("#$num left open: still a draft after review")
      skipped=$((skipped + 1)); continue
    fi
    if [ "$d_mergeable" = "false" ] || [ "$d_mstate" = "dirty" ]; then
      report+=("#$num left open: merge conflict with main")
      skipped=$((skipped + 1)); continue
    fi

    runs="$(sweep_check_runs "$repo" "$d_sha")"
    [ -n "$runs" ] || runs='[]'
    verdict="$(sweep_check_verdict "$runs")"
    if [ "$verdict" != "green" ]; then
      failing="$(sweep_failing_names "$runs")"
      report+=("#$num left open: checks are $verdict${failing:+ ($failing)}")
      skipped=$((skipped + 1)); continue
    fi

    # Bind the merge to the sha we actually judged. Never --admin, never force.
    if gh pr merge "$num" --repo "$repo" --squash --delete-branch \
         --match-head-commit "$d_sha" >/dev/null 2>&1; then
      sweep_log "#$num merged (good + green on $d_sha)"
      report+=("#$num merged")
      merged=$((merged + 1))
    else
      report+=("#$num left open: merge was refused (protection, or the head moved)")
      skipped=$((skipped + 1))
    fi
  done

  sweep_log "merged $merged, left open $skipped"
  if [ "${#report[@]}" -gt 0 ]; then
    for line in "${report[@]}"; do sweep_log "  $line"; done
  fi
  return 0
}
