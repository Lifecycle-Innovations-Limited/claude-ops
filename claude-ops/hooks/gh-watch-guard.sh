#!/bin/bash
# PreToolUse Bash hook — blocks rate-limit-burning gh patterns.
#
# Allow: exit 0 (no stdout JSON). Deny: emit hookSpecificOutput with permissionDecision deny
# on stdout (same contract as bin/ops-prevent-secret-commit and docs/safety-hooks.md), then exit 0.
# Pairs with the persistent gh-orphan-killer.sh watchdog.
#
# Source of truth: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
# Plugin cache copy (auto-installed via plugin update) is read-only.

emit_pre_tool_deny() {
  python3 -c '
import json, sys
reason = sys.stdin.read().rstrip("\n")
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": reason
  }
}))
'
}

raw="${TOOL_INPUT:-}"
if [ -z "$raw" ]; then
  raw=$(cat) || true
fi
CMD=$(printf '%s' "$raw" | jq -r '(.tool_input.command // .command // empty)' 2>/dev/null || true)
# Collapse newlines so --watch / tight-loop patterns cannot be evaded by splitting lines.
CMD_ONELINE=$(printf '%s' "$CMD" | tr '\n\r' '  ')

# Fast path: not a gh command, exit immediately
case "$CMD" in
    *gh\ *|*gh-*) ;;
    *) exit 0 ;;
esac

# --- Pattern 1: --watch flag on gh pr checks / gh run watch ---
# `gh pr checks <PR> --watch` and `gh run watch` poll every 2-5s.
# 5000 REST/hr ÷ 2s = exhausted in ~3 hours of one process. Sam saw this in production.
if echo "$CMD_ONELINE" | grep -qE 'gh[[:space:]]+pr[[:space:]]+checks[[:space:]]+[^|]*--watch|gh[[:space:]]+run[[:space:]]+watch'; then
    emit_pre_tool_deny <<'EOF'
BLOCKED: `gh ... --watch` polls every 2-5s and exhausts the 5000/hr REST quota.

Use the Monitor tool with an `until` poll loop at ≥25s instead:

  prev=""
  while true; do
    s=$(gh pr view <PR> --repo <REPO> --json mergeStateStatus,statusCheckRollup)
    state=$(echo "$s" | jq -r .mergeStateStatus)
    [ "$state" = "CLEAN" ] || [ "$state" = "UNSTABLE" ] && { echo READY; break; }
    sleep 30
  done

For multi-PR watching prefer GraphQL (separate 5000/hr bucket) — single query, multiple PRs.

Source: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
EOF
    exit 0
fi

# --- Pattern 2: gh polling loops with sleep < 25s ---
# Catches ANY while/until/for loop calling `gh api|pr|run|issue|search` whose smallest
# sleep interval is under 25s — including deploy-watch loops:
#   until [ -n "$(gh run list --workflow=… )" ]; do sleep 15; done
# `gh run list|view` is the same REST drain as `gh pr …`; "waiting for my deploy" is NOT
# an exemption. The minimum sleep is parsed numerically so two-digit evasions (sleep 15,
# sleep 20, sleep 24) are caught — the old single-digit-only regex let these through.
# (2026-05-30: a sleep-15 `gh run list` deploy-watch loop drove REST to 0/5000.)
if echo "$CMD_ONELINE" | grep -qE '(^|[^[:alnum:]_])(while|until|for)([^[:alnum:]_]|$).*gh[[:space:]]+(api|pr|run|issue|search)'; then
    # Extract every `sleep N` interval and take the minimum; a loop with sleep 30 AND
    # sleep 15 is judged by its tightest phase (15).
    MIN_SLEEP=$(echo "$CMD_ONELINE" | grep -oE 'sleep[[:space:]]+[0-9]+' | grep -oE '[0-9]+' | sort -n | head -1)
    # No explicit sleep in a gh loop = unbounded hammer → treat as 0.
    [ -z "$MIN_SLEEP" ] && MIN_SLEEP=0
    if [ "$MIN_SLEEP" -lt 25 ]; then
        emit_pre_tool_deny <<EOF
BLOCKED: gh polling loop with sleep ${MIN_SLEEP}s (< 25s) detected.

The 5000/hr REST quota is shared across this session, background daemons, the overnight
sync cron, and every other gh process. A loop at sleep 15 burns ~240 calls/hr and stacks
with siblings — one such loop drove REST to 0/5000 on 2026-05-30, blocking prod tooling.

This covers deploy-watch loops too: \`until gh run list/view … ; do sleep <25; done\` is
forbidden. Waiting on an Actions deploy is NOT an exemption.

Fix: bump to \`sleep 30\`+ (run_in_background) or use the Monitor tool (handles ≥25s natively).
For multi-PR/run state, prefer ONE GraphQL query (separate 5000/hr bucket).

Source: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
EOF
        exit 0
    fi
fi

exit 0
