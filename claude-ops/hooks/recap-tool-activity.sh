#!/bin/sh
# PostToolUse hook: live activity capture — fires on every tool call so the
# tmux recap stays fresh while the agent is actively working (not only at
# end-of-turn pauses).
input=$(cat 2>/dev/null)
[ -z "$input" ] && exit 0

session_id=$(echo "$input" | jq -r '.session_id // ""')
tool=$(echo "$input" | jq -r '.tool_name // ""')
[ -z "$tool" ] && exit 0

case "$tool" in
  Bash)
    cmd=$(echo "$input" | jq -r '.tool_input.command // ""' | head -c 80 | tr '\n' ' ')
    label="$ $cmd"
    ;;
  Edit|Write)
    f=$(echo "$input" | jq -r '.tool_input.file_path // ""')
    label="edit ${f##*/}"
    ;;
  Read)
    f=$(echo "$input" | jq -r '.tool_input.file_path // ""')
    label="read ${f##*/}"
    ;;
  Grep)
    p=$(echo "$input" | jq -r '.tool_input.pattern // ""' | head -c 40)
    label="grep $p"
    ;;
  Glob)
    p=$(echo "$input" | jq -r '.tool_input.pattern // ""' | head -c 40)
    label="glob $p"
    ;;
  Agent|Task)
    desc=$(echo "$input" | jq -r '.tool_input.description // .tool_input.prompt // ""' | head -c 60 | tr '\n' ' ')
    label="agent $desc"
    ;;
  *)
    label="$tool"
    ;;
esac

ts=$(date '+%H:%M:%S')
line="[$ts] $label"

[ -n "$session_id" ] && printf '%s' "$line" > "/tmp/claude-recap-${session_id}"
exit 0
