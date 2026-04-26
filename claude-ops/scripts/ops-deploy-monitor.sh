#!/usr/bin/env bash
# ops-deploy-monitor.sh <owner/repo> <pr_number>
#
# Spawned by ops-deploy-fix-merge-trigger after a PR merges. Watches the deploy
# workflow, audits service health, dispatches Haiku fixer on failure.
# Single-flight via lock; budget-capped per repo per hour; transient detection.
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
. "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh"

REPO="${1:?usage: $0 <owner/repo> <pr_number>}"
PR="${2:?usage: $0 <owner/repo> <pr_number>}"
SLUG=$(repo_slug_safe "$REPO")
LOG="$LOGS_DIR/monitor-$SLUG-pr$PR.log"
log() { printf '[%s] %s/#%s %s\n' "$(date '+%H:%M:%S')" "$REPO" "$PR" "$*" >> "$LOG"; }
fire() { log "❌ $*"; printf '[%s] %s/#%s ❌ %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$REPO" "$PR" "$*" >> "$LOGS_DIR/fires.log"; }

# Single-flight monitor lock
MONITOR_LOCK="monitor-$SLUG-pr$PR"
lock_acquire "$MONITOR_LOCK" || { log "monitor already running, exit"; exit 0; }
trap 'lock_release "$MONITOR_LOCK"' EXIT

log "monitor starting"

sleep 5
PR_INFO=$(gh pr view "$PR" --repo "$REPO" --json baseRefName,mergeCommit,state 2>/dev/null)
BASE=$(echo "$PR_INFO" | jq -r '.baseRefName // ""')
SHA=$(echo "$PR_INFO" | jq -r '.mergeCommit.oid // ""')
STATE=$(echo "$PR_INFO" | jq -r '.state // ""')

[ "$STATE" != "MERGED" ] && { log "not merged ($STATE) — exit"; exit 0; }
[ "$BASE" != "dev" ] && [ "$BASE" != "main" ] && { log "base=$BASE, skip"; exit 0; }
log "merged to $BASE @ $SHA"

# Find deploy workflow run
PATTERN=$(config deploy_workflow_pattern "deploy|Deploy|build|Build|ECS|cd|CD")
RUN_ID=""
for i in $(seq 1 12); do
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BASE" --limit 5 \
    --json databaseId,headSha,name --jq \
    ".[] | select(.headSha==\"$SHA\" and (.name | test(\"$PATTERN\"))) | .databaseId" 2>/dev/null | head -1)
  [ -n "$RUN_ID" ] && break
  sleep 15
done
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BASE" --limit 5 \
    --json databaseId,headSha --jq ".[] | select(.headSha==\"$SHA\") | .databaseId" 2>/dev/null | head -1)
fi
[ -z "$RUN_ID" ] && { log "no run found — exit"; exit 0; }
log "tracking run #$RUN_ID"

# Wait for completion (configurable timeout)
TIMEOUT=$(config watcher_timeout_seconds 1800)
gh run watch "$RUN_ID" --repo "$REPO" --exit-status >> "$LOG" 2>&1 &
WATCH_PID=$!
( sleep "$TIMEOUT"; kill -9 $WATCH_PID 2>/dev/null ) &
TIMEOUT_PID=$!
wait $WATCH_PID; RC=$?
kill -9 $TIMEOUT_PID 2>/dev/null

CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq .conclusion 2>/dev/null)
log "conclusion=$CONCLUSION rc=$RC"

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
    fix_log=$(dispatch_fix_agent "deploy-fix.md" "$SLUG-deploy" \
      "REPO=$REPO" "PR=$PR" "BASE=$BASE" "SHA=$SHA" "RUN_ID=$RUN_ID" \
      "SUMMARY=deploy workflow #$RUN_ID concluded $CONCLUSION" \
      "LOGS=$failed_log")
    case $? in
      0) log "fixer dispatched → $fix_log" ;;
      2) log "fixer skipped — already in flight for $SLUG-deploy" ;;
      3) log "fixer skipped — hourly budget exhausted" ;;
      *) log "fixer dispatch failed — exit code $?" ;;
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
    dispatch_fix_agent "deploy-fix.md" "$SLUG-health" \
      "REPO=$REPO" "PR=$PR" "BASE=$BASE" "SHA=$SHA" "RUN_ID=$RUN_ID" \
      "SUMMARY=service health URL $URL returned HTTP $HTTP" \
      "LOGS=(no workflow logs — health check failure)" >/dev/null
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
