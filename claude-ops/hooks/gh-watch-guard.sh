#!/bin/bash
# PreToolUse Bash hook — blocks rate-limit-burning gh patterns.
#
# Reads Claude Code hook stdin, exits 0 (allow) or 2 (block + stderr).
# Pairs with the persistent gh-orphan-killer.sh watchdog.
#
# Source of truth: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
# Plugin cache copy (auto-installed via plugin update) is read-only.

raw="${TOOL_INPUT:-}"
if [ -z "$raw" ]; then
  raw=$(cat) || true
fi
CMD=$(printf '%s' "$raw" | jq -r '(.tool_input.command // .command // empty)' 2>/dev/null || true)

# Fast path: not a gh command, exit immediately
case "$CMD" in
    *gh\ *|*gh-*) ;;
    *) exit 0 ;;
esac

# --- Pattern 1: --watch flag on gh pr checks / gh run watch ---
# `gh pr checks <PR> --watch` and `gh run watch` poll every 2-5s.
# 5000 REST/hr ÷ 2s = exhausted in ~3 hours of one process. Sam saw this in production.
if echo "$CMD" | grep -qE 'gh[[:space:]]+pr[[:space:]]+checks[[:space:]]+[^|]*--watch|gh[[:space:]]+run[[:space:]]+watch'; then
    cat >&2 <<'EOF'
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
    exit 2
fi

# --- Pattern 2: tight gh loops (single-digit sleep = under 10s) ---
# Catches: `while true; do gh ...; sleep 5; done` style polls (not sleep 10+).
if echo "$CMD" | grep -qE '(while|until|for).*gh[[:space:]]+(api|pr|run|issue)' && \
   echo "$CMD" | grep -qE 'sleep[[:space:]]+[0-9]([[:space:];]|$)'; then
    cat >&2 <<'EOF'
BLOCKED: tight gh polling loop (sleep < 10s) detected.

The 5000/hr REST quota is shared across this session, background daemons, the overnight
sync cron, and any other gh process. A loop at sleep 5 burns 720 calls/hr — easy to OOM-cache.

Bump to `sleep 30` (or use Monitor tool — handles ≥25s naturally).
EOF
    exit 2
fi

exit 0
