#!/usr/bin/env bash
# test-unread-filter-guard.sh — proves unread-filter-guard.py blocks the
# forbidden unread-as-triage-filter shapes and allows normal inbox scans.
#
# Standing rule (2026-09-17): unread is never a filter.
set -euo pipefail

GUARD="${HERMES_HOME:-$HOME/.hermes}/agent-hooks/unread-filter-guard.py"

if [ ! -f "$GUARD" ]; then
  echo "SKIP: $GUARD not present on this box"
  exit 0
fi

fail=0

assert_blocked() {
  local desc="$1" payload="$2"
  local out
  out=$(printf '%s' "$payload" | python3 "$GUARD")
  if [[ "$out" == *'"action": "block"'* ]] || [[ "$out" == *'"action":"block"'* ]]; then
    echo "PASS (blocked): $desc"
  else
    echo "FAIL (should have blocked): $desc -- got: $out"
    fail=1
  fi
}

assert_allowed() {
  local desc="$1" payload="$2"
  local out
  out=$(printf '%s' "$payload" | python3 "$GUARD")
  if [ -z "$out" ]; then
    echo "PASS (allowed): $desc"
  else
    echo "FAIL (should have allowed): $desc -- got: $out"
    fail=1
  fi
}

assert_blocked "whatsapp_unread tool call" \
  '{"hook_event_name":"pre_tool_call","tool_name":"whatsapp_unread","tool_input":{}}'

assert_blocked "conversations_unreads tool call" \
  '{"hook_event_name":"pre_tool_call","tool_name":"mcp__slack__conversations_unreads","tool_input":{}}'

assert_blocked "gmail is:unread filter in terminal" \
  '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"gog gmail search -a x -p \"in:inbox is:unread\""}}'

assert_blocked "unread_count comparison in terminal" \
  '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"python3 -c \"if unread_count > 0: print(1)\""}}'

assert_allowed "plain in:inbox gmail search" \
  '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"gog gmail search -a x -p \"in:inbox\""}}'

assert_allowed "unrelated tool" \
  '{"hook_event_name":"pre_tool_call","tool_name":"read_file","tool_input":{"path":"/tmp/x"}}'

assert_allowed "whatsapp_find (correct triage tool)" \
  '{"hook_event_name":"pre_tool_call","tool_name":"whatsapp_find","tool_input":{}}'

exit $fail
