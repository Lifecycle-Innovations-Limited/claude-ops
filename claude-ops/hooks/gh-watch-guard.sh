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

# Fast path: not a gh command AND not a direct api.github.com call, exit immediately.
# (curl/wget poll loops hit api.github.com/graphql with no `gh` token — they must still
#  reach Patterns 2-3 below, so don't short-circuit them out.)
case "$CMD" in
    *gh\ *|*gh-*|*api.github.com*) ;;
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

# Shared exemption: a loop that ONLY ever touches `rate_limit` is quota-exempt
# (the /rate_limit endpoint does not consume quota) and is the legitimate way a
# release waiter blocks until the bucket recovers. If the loop's only GitHub touch
# is rate_limit, allow it. We approximate "only rate_limit" as: the command mentions
# rate_limit AND does NOT also contain a quota-spending gh/api verb
# (pr/run/issue/search/graphql/repos/commits/...).
loop_is_rate_limit_only() {
    echo "$CMD_ONELINE" | grep -q 'rate_limit' || return 1
    # If it ALSO spends quota (merge/list/view/graphql/etc), it is NOT exempt.
    if echo "$CMD_ONELINE" | grep -qE 'gh[[:space:]]+(pr|run|issue|search)[[:space:]]|graphql|/(repos|commits|pulls|issues|actions|search)/|pullRequest|mergePullRequest'; then
        return 1
    fi
    # `gh api` spends quota unless every invocation targets /rate_limit.
    if echo "$CMD_ONELINE" | grep -qE 'gh[[:space:]]+api'; then
        if echo "$CMD_ONELINE" | grep -oE 'gh[[:space:]]+api[^;|&)]+' | grep -qvE '(rate_limit|/rate_limit)'; then
            return 1
        fi
    fi
    return 0
}

# --- Pattern 2: gh polling loops at ANY sleep interval ---
# Catches ANY while/until/for/seq loop calling `gh api|pr|run|issue|search` regardless
# of sleep length. Previously only sleep < 25s was blocked, but on 2026-06-11 a
# `for i in $(seq 1 20); do sleep 45; curl … ; gh pr merge … ; done` merge-watcher
# evaded with sleep 45 (≥25) and pinned REST to 0 for hours. The interval doesn't
# matter — a long-lived gh loop is a leak; use the Monitor tool or a single
# run_in_background `until` instead. Only a rate_limit-only loop is exempt.
if echo "$CMD_ONELINE" | grep -qE '(^|[^[:alnum:]_])(while|until|for|seq)([^[:alnum:]_]|$).*gh[[:space:]]+(api|pr|run|issue|search)'; then
    if ! loop_is_rate_limit_only; then
        emit_pre_tool_deny <<'EOF'
BLOCKED: gh polling loop detected (for/while/until + gh api|pr|run|issue|search).

The 5000/hr REST quota is shared across this session, background daemons, the overnight
sync cron, and every other gh process. A long-lived gh loop — at ANY sleep interval —
stacks with siblings and drains the bucket. On 2026-06-11 a `seq … sleep 45 … gh pr merge`
merge-watcher ran for hours and pinned REST to 0, blocking releases. A bigger sleep does
NOT make it safe; the loop itself is the leak.

Fix:
  • For ONE condition (PR merged / CI green): a single `until … ; do sleep 30; done` run
    via run_in_background (NOT looped in the foreground), or the Monitor tool.
  • For multiple PRs/runs: ONE GraphQL query (separate 5000/hr bucket) listing them all.
  • To block until quota recovers: poll `/rate_limit` only (quota-exempt).

Source: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
EOF
        exit 0
    fi
fi

# --- Pattern 3: curl/wget poll loops hitting api.github.com ---
# The class the `gh`-only guard above can never see: a `for`/`while`/`until`/`seq`
# loop with a `sleep` that calls api.github.com (REST or /graphql) directly via curl
# or wget. On 2026-06-11 an `until s=$(curl -sS … api.github.com/graphql … pullRequest …);
# … do sleep 60; done` merge-watcher evaded BOTH prior patterns (no `gh`, sleep 60)
# and helped pin the shared quota to 0. Block any such loop at ANY sleep interval.
# Exempt: a loop whose only api.github.com touch is /rate_limit (quota-exempt).
if echo "$CMD_ONELINE" | grep -qE '(^|[^[:alnum:]_])(while|until|for|seq)([^[:alnum:]_]|$)' \
   && echo "$CMD_ONELINE" | grep -q 'api.github.com' \
   && echo "$CMD_ONELINE" | grep -qE '(^|[^[:alnum:]_])sleep([^[:alnum:]_]|$)'; then
    # If every api.github.com reference is the rate_limit endpoint, allow it.
    if echo "$CMD_ONELINE" | grep -qE 'api\.github\.com/rate_limit' \
       && ! echo "$CMD_ONELINE" | grep -qE 'api\.github\.com/(graphql|repos|commits|pulls|issues|actions|search)|pullRequest|mergePullRequest'; then
        :   # rate_limit-only waiter — legitimate, allow.
    else
        emit_pre_tool_deny <<'EOF'
BLOCKED: curl/wget poll loop hitting api.github.com detected.

A `for`/`while`/`until` loop with `sleep` that calls api.github.com (REST or /graphql)
directly is the same shared-quota drain as `gh` — and at ANY sleep interval. On 2026-06-11
an `until s=$(curl … api.github.com/graphql … pullRequest …); … do sleep 60; done`
merge-watcher evaded the gh-only guard (no `gh` token, sleep 60) and pinned the shared
REST/GraphQL quota to 0 for hours, blocking releases.

Fix:
  • For ONE condition: a single `until … ; do sleep 30; done` via run_in_background, or
    the Monitor tool — NOT a foreground loop left running for hours.
  • For multiple PRs/runs: ONE GraphQL query (separate 5000/hr bucket) covering them all.
  • To block until quota recovers: poll `api.github.com/rate_limit` only (quota-exempt).

Source: ~/Projects/claude-ops/claude-ops/hooks/gh-watch-guard.sh
EOF
        exit 0
    fi
fi

exit 0
