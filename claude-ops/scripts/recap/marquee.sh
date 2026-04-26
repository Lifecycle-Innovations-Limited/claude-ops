#!/bin/sh
# Tmux marquee: scrolls AI digest, NEVER swaps content mid-scroll.
# Holds the same "pinned" copy for one full scroll cycle so the user can read
# the entire message before it refreshes with new digest content.

DIGEST=/tmp/claude-recap-digest
PINNED=/tmp/claude-recap-pinned

if [ ! -f "$PINNED" ] && [ -f "$DIGEST" ]; then
  cp "$DIGEST" "$PINNED" 2>/dev/null
fi

[ ! -f "$PINNED" ] && exit 0
msg=$(tr -d '\n\r' < "$PINNED")
[ -z "$msg" ] && exit 0

width=$(tmux display -p '#{client_width}' 2>/dev/null || echo 80)
viewport=$((width - 6))
[ "$viewport" -lt 20 ] && viewport=20

msg_len=${#msg}

speed=6
hold_start=1
hold_end=1
if [ "$msg_len" -le "$viewport" ]; then
  scroll_steps=0
else
  scroll_steps=$(( (msg_len - viewport + speed - 1) / speed ))
fi
total=$((hold_start + scroll_steps + hold_end))
[ "$total" -lt 2 ] && total=2

now=$(date +%s)
pinned_mtime=$(stat -c %Y "$PINNED" 2>/dev/null || stat -f %m "$PINNED" 2>/dev/null || echo "$now")
elapsed=$((now - pinned_mtime))

if [ "$elapsed" -ge "$total" ] && [ -f "$DIGEST" ]; then
  digest_mtime=$(stat -c %Y "$DIGEST" 2>/dev/null || stat -f %m "$DIGEST" 2>/dev/null || echo 0)
  if [ "$digest_mtime" -gt "$pinned_mtime" ]; then
    cp "$DIGEST" "$PINNED" 2>/dev/null
    touch "$PINNED"
    msg=$(tr -d '\n\r' < "$PINNED")
    msg_len=${#msg}
    if [ "$msg_len" -le "$viewport" ]; then
      scroll_steps=0
    else
      scroll_steps=$(( (msg_len - viewport + speed - 1) / speed ))
    fi
    total=$((hold_start + scroll_steps + hold_end))
    [ "$total" -lt 2 ] && total=2
    elapsed=0
  fi
fi

phase=$((elapsed % total))

if [ "$msg_len" -le "$viewport" ]; then
  printf '%s' "$msg"
  exit 0
fi

if [ "$phase" -lt "$hold_start" ]; then
  offset=0
elif [ "$phase" -lt $((hold_start + scroll_steps)) ]; then
  offset=$(( (phase - hold_start) * speed ))
  [ "$offset" -gt $((msg_len - viewport)) ] && offset=$((msg_len - viewport))
else
  offset=$((msg_len - viewport))
fi

printf '%s' "$msg" | awk -v o="$offset" -v w="$viewport" '{print substr($0, o+1, w)}'
