#!/bin/sh
# Stop hook: capture a one-line recap of the last assistant turn into
# /tmp/claude-recap-${session_id}. Read by the recap daemon to assemble the
# multi-session digest displayed in the tmux marquee.
input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // ""')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')
[ -z "$session_id" ] && exit 0
[ -z "$transcript" ] || [ ! -f "$transcript" ] && exit 0

# Walk transcript bottom-up looking for the most recent assistant turn that has
# actual text content (not just tool_use blocks). Linux: tac; macOS BSD: tail -r.
if command -v tac >/dev/null 2>&1; then
  _transcript_rev_lines() { tac "$1" 2>/dev/null; }
else
  _transcript_rev_lines() { tail -r "$1" 2>/dev/null; }
fi
last_text=$(_transcript_rev_lines "$transcript" | awk '
  /"type":"assistant"/ { print; if (++n >= 30) exit }
' | while IFS= read -r line; do
  t=$(printf '%s' "$line" | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')
  if [ -n "$t" ]; then
    printf '%s' "$t"
    break
  fi
done)

if [ -z "$last_text" ]; then
  : > "/tmp/claude-recap-${session_id}"
  exit 0
fi

# Strip ANSI, markdown bullets, code fences; keep first 240 chars.
clean=$(printf '%s' "$last_text" \
  | sed -E 's/\x1B\[[0-9;]*[a-zA-Z]//g' \
  | sed -E 's/^[ *#>`-]+//; s/`//g' \
  | head -c 240)

printf '%s' "$clean" > "/tmp/claude-recap-${session_id}"
exit 0
