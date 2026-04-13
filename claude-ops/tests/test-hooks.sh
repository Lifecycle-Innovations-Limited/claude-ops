#!/usr/bin/env bash
# test-hooks.sh — Validates hooks/hooks.json
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_FILE="$PLUGIN_ROOT/hooks/hooks.json"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: hooks/hooks.json"
echo ""

# 1. File exists
if [[ ! -f "$HOOKS_FILE" ]]; then
  echo "FAIL: hooks/hooks.json not found"
  exit 1
fi
ok "hooks.json exists"

# 2. Valid JSON
if command -v jq &>/dev/null; then
  if jq empty "$HOOKS_FILE" 2>/dev/null; then
    ok "valid JSON (jq)"
  else
    err "invalid JSON in hooks.json"
    exit 1
  fi
elif command -v python3 &>/dev/null; then
  if python3 -c "import json,sys; json.load(open('$HOOKS_FILE'))" 2>/dev/null; then
    ok "valid JSON (python3)"
  else
    err "invalid JSON in hooks.json"
    exit 1
  fi
else
  echo "  SKIP: neither jq nor python3 available for JSON validation"
fi

# 3. All referenced scripts exist
echo ""
echo "Checking referenced scripts..."

# Extract all command values from hooks.json
if command -v jq &>/dev/null; then
  commands=$(jq -r '.. | objects | .command? // empty' "$HOOKS_FILE" 2>/dev/null || true)
else
  # Fallback: grep for "command": lines
  commands=$(grep '"command"' "$HOOKS_FILE" | sed 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/' || true)
fi

while IFS= read -r cmd; do
  [[ -z "$cmd" ]] && continue

  # Extract the script path — first word after 'bash ' or the first token if executable
  # Handle: "bash ${CLAUDE_PLUGIN_ROOT}/bin/foo", "${CLAUDE_PLUGIN_ROOT}/bin/foo"
  script_ref=$(echo "$cmd" | grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^ ]+' | head -1 || true)

  if [[ -n "$script_ref" ]]; then
    # Resolve placeholder
    resolved="${script_ref/\$\{CLAUDE_PLUGIN_ROOT\}/$PLUGIN_ROOT}"
    # Strip any trailing shell tokens like 2>/dev/null
    resolved=$(echo "$resolved" | awk '{print $1}')
    if [[ -f "$resolved" ]]; then
      ok "referenced script exists: ${resolved#$PLUGIN_ROOT/}"
    else
      err "referenced script missing: ${resolved#$PLUGIN_ROOT/}"
    fi
  else
    ok "command has no CLAUDE_PLUGIN_ROOT path reference (skipping path check): $cmd"
  fi
done <<< "$commands"

# 4. Hook types are valid
echo ""
echo "Checking hook types..."

if command -v jq &>/dev/null; then
  types=$(jq -r '.. | objects | .type? // empty' "$HOOKS_FILE" 2>/dev/null | sort -u || true)
  valid_types=("command")
  while IFS= read -r htype; do
    [[ -z "$htype" ]] && continue
    valid=false
    for vt in "${valid_types[@]}"; do
      [[ "$htype" == "$vt" ]] && valid=true && break
    done
    if $valid; then
      ok "hook type is valid: $htype"
    else
      err "invalid hook type: $htype (expected: command)"
    fi
  done <<< "$types"
else
  echo "  SKIP: jq not available for hook type validation"
fi

# 5. Top-level hook events are valid Claude Code hook events
echo ""
echo "Checking hook event names..."

valid_events=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStop" "Notification")

if command -v jq &>/dev/null; then
  events=$(jq -r '.hooks | keys[]' "$HOOKS_FILE" 2>/dev/null || true)
  while IFS= read -r event; do
    [[ -z "$event" ]] && continue
    valid=false
    for ve in "${valid_events[@]}"; do
      [[ "$event" == "$ve" ]] && valid=true && break
    done
    if $valid; then
      ok "hook event is valid: $event"
    else
      err "unrecognized hook event: $event"
    fi
  done <<< "$events"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
