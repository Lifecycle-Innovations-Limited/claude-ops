#!/usr/bin/env bash
# ops-deploy-monitor.sh <owner/repo> <pr_number>
#
# Spawned by ops-deploy-fix-merge-trigger after a PR merges. Watches the deploy
# workflow, audits service health, dispatches Haiku fixer on failure.
# Single-flight via lock; budget-capped per repo per hour; transient detection.
#
# Rate discipline (matches ~/.claude/scripts/gh-pr-watch.sh):
#   * NO `gh run watch` / `gh pr checks --watch` — those poll every 2-5s with no
#     cap and are denied by hooks/gh-watch-guard.sh.
#   * Every GitHub read is one-shot `gh api repos/...` (REST bucket), never
#     `gh pr view --json` / `gh run list --json` (GraphQL-backed).
#   * `gh api rate_limit` gates each phase. That endpoint is free — it does not
#     consume quota — so it is safe to call before every poll phase.
#   * Bounded polling: hard tick cap + sleep floor + wall-clock deadline.
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Load deploy-fix library (provides lock_acquire, dispatch_fix_agent, config, etc.)
# shellcheck disable=SC1091
source "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh"

# Single-instance guard - prevent stacking on rapid spawns
source "$HOME/.claude/scripts/lib/once.sh"
REPO="${1:?usage: $0 <owner/repo> <pr_number>}"
claude_once "deploy-monitor-$REPO-${2:-0}" 300 || exit 0
REPO="${1:?usage: $0 <owner/repo> <pr_number>}"
PR="${2:?usage: $0 <owner/repo> <pr_number>}"
SLUG=$(repo_slug_safe "$REPO")
LOG="$LOGS_DIR/monitor-$SLUG-pr$PR.log"
log() { printf '[%s] %s/#%s %s\n' "$(date '+%H:%M:%S')" "$REPO" "$PR" "$*" >> "$LOG"; }
fire() { log "❌ $*"; printf '[%s] %s/#%s ❌ %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$REPO" "$PR" "$*" >> "$LOGS_DIR/fires.log"; }

# ── Rate discipline ────────────────────────────────────────────────────────
# Bounded-poll parameters. Every one is overridable via `config`, but the
# defaults are deliberate:
#   POLL_SLEEP=30  — floor, never below the 25s house minimum. A deploy that
#                    finishes between ticks is still caught on the next tick.
#   RUN_LOOKUP_TICKS=8 / RUN_LOOKUP_SLEEP=15 — a workflow run is registered by
#                    GitHub within ~2min of a merge; 8 x 15s = 2min covers it.
#   TIMEOUT=1800   — unchanged from the old `watcher_timeout_seconds` default,
#                    so the outward behaviour of a slow deploy is the same.
#   With a 30s floor, 1800s of wall clock is 60 ticks, so MAX_TICKS=60 and the
#   deadline bind at the same moment. Whichever trips first, the loop stops:
#   there is no configuration in which this can spin indefinitely.
POLL_SLEEP=$(config deploy_poll_sleep_seconds 30)
[ "$POLL_SLEEP" -lt 25 ] 2>/dev/null && POLL_SLEEP=25
TIMEOUT=$(config watcher_timeout_seconds 1800)
MAX_TICKS=$(config deploy_poll_max_ticks 60)
RUN_LOOKUP_TICKS=$(config deploy_run_lookup_ticks 8)
RUN_LOOKUP_SLEEP=$(config deploy_run_lookup_sleep_seconds 15)
RATE_FLOOR=$(config gh_rate_floor 200)

# rate_ok — pre-flight gate. `gh api rate_limit` is itself quota-free, so this
# costs nothing. Returns 1 when the REST (core) bucket is below the floor.
rate_ok() {
  local rem
  rem=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
  case "$rem" in
    ''|*[!0-9]*) return 0 ;;   # unreadable → do not block the monitor
  esac
  if [ "$rem" -lt "$RATE_FLOOR" ]; then
    log "rate gate: REST core bucket at $rem (floor $RATE_FLOOR) — bailing out, no polling"
    return 1
  fi
  return 0
}

# One-shot REST reads. All of these land in the core (REST) bucket.
api() { gh api -H 'Accept: application/vnd.github+json' "repos/$REPO/$1" 2>/dev/null; }


# Single-flight monitor lock
MONITOR_LOCK="monitor-$SLUG-pr$PR"
lock_acquire "$MONITOR_LOCK" || { log "monitor already running, exit"; exit 0; }
trap 'lock_release "$MONITOR_LOCK"' EXIT

log "monitor starting"

rate_ok || exit 0

sleep 5
# REST pulls/{n}: base.ref, merge_commit_sha, merged. Same three facts the old
# `gh pr view --json baseRefName,mergeCommit,state` returned, off the REST bucket.
PR_INFO=$(api "pulls/$PR")
BASE=$(echo "$PR_INFO" | jq -r '.base.ref // ""')
SHA=$(echo "$PR_INFO" | jq -r '.merge_commit_sha // ""')
if [ "$(echo "$PR_INFO" | jq -r '.merged // false')" = "true" ]; then
  STATE=MERGED
else
  STATE=$(echo "$PR_INFO" | jq -r '(.state // "") | ascii_upcase')
fi

[ "$STATE" != "MERGED" ] && { log "not merged ($STATE) — exit"; exit 0; }
[ "$BASE" != "dev" ] && [ "$BASE" != "main" ] && { log "base=$BASE, skip"; exit 0; }
log "merged to $BASE @ $SHA"

# Find deploy workflow run
PATTERN=$(config deploy_workflow_pattern "deploy|Deploy|build|Build|ECS|cd|CD")
RUNS_PATH="actions/runs?branch=$BASE&head_sha=$SHA&per_page=10"
RUN_ID=""
for _ in $(seq 1 "$RUN_LOOKUP_TICKS"); do
  rate_ok || exit 0
  RUN_ID=$(api "$RUNS_PATH" \
    | jq -r --arg p "$PATTERN" \
        '(.workflow_runs // [])[] | select((.name // "") | test($p)) | .id' 2>/dev/null | head -1)
  [ -n "$RUN_ID" ] && break
  sleep "$RUN_LOOKUP_SLEEP"
done
if [ -z "$RUN_ID" ]; then
  # No name match — fall back to any run for this SHA.
  RUN_ID=$(api "$RUNS_PATH" | jq -r '(.workflow_runs // [])[0].id // ""' 2>/dev/null)
fi
[ "$RUN_ID" = "null" ] && RUN_ID=""
[ -z "$RUN_ID" ] && { log "no run found — exit"; exit 0; }
log "tracking run #$RUN_ID"

# ── Wait for completion: bounded REST polling ─────────────────────────────
# Replaces `gh run watch`, which blocks, polls every 2-5s internally, and has no
# tick cap. Three independent stops: MAX_TICKS, the wall-clock DEADLINE, and the
# rate gate. RC keeps the old contract (0 = success, 1 = anything else).
DEADLINE=$(( $(date +%s) + TIMEOUT ))
CONCLUSION=""
STATUS=""
RC=1
for tick in $(seq 1 "$MAX_TICKS"); do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    log "poll deadline reached after ${TIMEOUT}s (tick $tick) — no verdict on run #$RUN_ID"
    exit 0
  fi
  if ! rate_ok; then
    # Quota floor is an OBSERVABILITY stop, not a deploy verdict. Falling through
    # to the failure path here would dispatch a fixer against a run we never read.
    log "rate floor reached at tick $tick — stopping polling, no verdict on run #$RUN_ID"
    exit 0
  fi
  RUN_JSON=$(api "actions/runs/$RUN_ID")
  STATUS=$(echo "$RUN_JSON" | jq -r '.status // ""')
  CONCLUSION=$(echo "$RUN_JSON" | jq -r '.conclusion // ""')
  [ "$CONCLUSION" = "null" ] && CONCLUSION=""
  log "tick $tick/$MAX_TICKS status=${STATUS:-?} conclusion=${CONCLUSION:-pending}"
  if [ "$STATUS" = "completed" ] || [ -n "$CONCLUSION" ]; then
    break
  fi
  sleep "$POLL_SLEEP"
done
[ "$CONCLUSION" = "success" ] && RC=0
log "conclusion=${CONCLUSION:-unknown} rc=$RC"

if [ "$CONCLUSION" != "success" ]; then
  failed_log=$(gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>/dev/null | tail -120)

  # Transient → rerun, no agent
  if [ "$(config auto_rerun_transients true)" = "true" ] && is_transient "$failed_log"; then
    log "transient detected → gh run rerun"
    gh run rerun "$RUN_ID" --repo "$REPO" --failed >> "$LOG" 2>&1
    notify "Auto-rerun: transient" "$REPO #$PR — workflow rerun on transient failure"
    exit 0
  fi

  # Dedup — same failure tail twice in a row = skip
  if already_seen "$SLUG-deploy" "$failed_log"; then
    log "duplicate failure — already dispatched fixer for this signature, skipping"
    notify "Duplicate failure" "$REPO #$PR same root cause as last run — fixer NOT re-dispatched"
    exit 0
  fi

  fire "deploy #$RUN_ID concluded $CONCLUSION"
  notify "Deploy failed" "$REPO #$PR → $BASE: $CONCLUSION"

  if [ "$(config auto_dispatch_fixer true)" = "true" ]; then
    export DEPLOY_FIX_REPO="$REPO"
    fix_log=$(dispatch_fix_agent "deploy-fixer" "$SLUG-deploy" \
      "REPO=$REPO" "PR=$PR" "BASE=$BASE" "SHA=$SHA" "RUN_ID=$RUN_ID" \
      "SUMMARY=deploy workflow #$RUN_ID concluded $CONCLUSION" \
      "LOGS=$failed_log")
    _dfa_rc=$?
    case $_dfa_rc in
      0) log "fixer dispatched → $fix_log" ;;
      2) log "fixer skipped — already in flight for $SLUG-deploy" ;;
      3) log "fixer skipped — hourly budget exhausted" ;;
      1) log "fixer failed — background process did not start" ;;
      6) log "fixer skipped — global concurrency cap ($(config max_concurrent_fixers 3) active)" ;;
      7) log "fixer skipped — fleet agent already active on $REPO" ;;
      *) log "fixer dispatch failed — exit code $_dfa_rc" ;;
    esac
  else
    log "auto_dispatch_fixer=false — notification only"
  fi
  exit 1
fi

# Health audit
[ "$(config audit_health_after_deploy true)" != "true" ] && { log "audit_health_after_deploy=false — done"; exit 0; }
URL=$(resolve_health_url "$REPO" "$BASE")
[ -z "$URL" ] && { log "no health URL registered for $REPO:$BASE — done"; exit 0; }

sleep 10
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL" 2>/dev/null || echo 000)
if [ "$HTTP" != "200" ]; then
  fire "service $URL → HTTP $HTTP after deploy"
  notify "Service unhealthy" "$REPO $BASE: $URL → HTTP $HTTP"
  if [ "$(config auto_dispatch_fixer true)" = "true" ]; then
    export DEPLOY_FIX_REPO="$REPO"
    dispatch_fix_agent "deploy-fixer" "$SLUG-health" \
      "REPO=$REPO" "PR=$PR" "BASE=$BASE" "SHA=$SHA" "RUN_ID=$RUN_ID" \
      "SUMMARY=service health URL $URL returned HTTP $HTTP" \
      "LOGS=(no workflow logs — health check failure)" >/dev/null
    _dfa_rc=$?
    case $_dfa_rc in
      0) : ;;
      1) log "health fixer failed — background process did not start" ;;
      6) log "health fixer skipped — global concurrency cap ($(config max_concurrent_fixers 3) active)" ;;
      7) log "health fixer skipped — fleet agent already active on $REPO" ;;
      *) log "health fixer dispatch failed — exit code $_dfa_rc" ;;
    esac
  fi
  exit 1
fi
log "health $URL → 200"

# Verify served commit
if [ "$(config verify_served_commit true)" = "true" ]; then
  VERSION_URL=$(resolve_version_url "$REPO" "$BASE")
  if [ -n "$VERSION_URL" ]; then
    served=$(curl -sS --max-time 10 "$VERSION_URL" 2>/dev/null | jq -r '.commit // .sha // .gitSha // ""' 2>/dev/null)
    if [ -n "$served" ] && [ "${served:0:7}" = "${SHA:0:7}" ]; then
      log "served ${served:0:7} matches merge ✓"
    elif [ -n "$served" ]; then
      fire "version mismatch served=${served:0:7} expected=${SHA:0:7}"
      notify "Version mismatch" "$REPO $BASE serving ${served:0:7}, expected ${SHA:0:7}"
    fi
  fi
fi
log "audit complete ✓"
