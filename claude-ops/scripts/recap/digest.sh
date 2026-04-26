#!/bin/sh
# AI-generated rolling digest: summarizes the last 10 digests + current session recaps
# + recent shell activity into one unified ticker line. 20s throttle (bypassable via
# THROTTLE_OVERRIDE=1 — daemon.sh sets this).

set -e
DIGEST=/tmp/claude-recap-digest
LOG=/tmp/claude-recap-digest.log
LOCK=/tmp/claude-recap-digest.lock
THROTTLE=20

# Throttle by file age unless explicitly overridden
if [ -z "$THROTTLE_OVERRIDE" ] && [ -f "$DIGEST" ]; then
  age=$(($(date +%s) - $(stat -f %m "$DIGEST" 2>/dev/null || stat -c %Y "$DIGEST" 2>/dev/null || echo 0)))
  [ "$age" -lt "$THROTTLE" ] && exit 0
fi

# Single-flight lock
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

now=$(date +%s)

# Block A: current per-session recaps (newest first, max 8, drop stale >2h)
sessions=""
for f in $(ls -t /tmp/claude-recap-* 2>/dev/null | grep -v -- '-digest$' | grep -v -- '-digest\.log$' | grep -v -- '-latest$' | grep -v -- '-pinned$' | head -8); do
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  age=$((now - mtime))
  [ "$age" -gt 7200 ] && continue
  base=$(basename "$f")
  sid=${base#claude-recap-}
  short=${sid#"${sid%????}"}
  if [ "$age" -lt 60 ]; then a="${age}s"; elif [ "$age" -lt 3600 ]; then a="$((age/60))m"; else a="$((age/3600))h"; fi
  body=$(LC_ALL=C tr -d '\n\r' < "$f" | head -c 400)
  [ -z "$body" ] && continue
  sessions="${sessions}- [${short}] (${a} ago): ${body}
"
done

# Block B: last 10 prior digests (chronological)
history=""
if [ -f "$LOG" ]; then
  history=$(tail -n 10 "$LOG" 2>/dev/null)
fi

# Block C: recent non-Claude zsh shell activity (last 15 cmds across live shells)
shell_activity=""
for sf in $(ls -t /tmp/zsh-activity-*.log 2>/dev/null | head -6); do
  smtime=$(stat -f %m "$sf" 2>/dev/null || stat -c %Y "$sf" 2>/dev/null || echo 0)
  [ $((now - smtime)) -gt 1800 ] && continue
  spid=$(basename "$sf" | sed 's/zsh-activity-\(.*\)\.log/\1/')
  recent=$(tail -n 15 "$sf" 2>/dev/null)
  [ -n "$recent" ] && shell_activity="${shell_activity}-- shell $spid:
${recent}
"
done

[ -z "$sessions" ] && [ -z "$history" ] && [ -z "$shell_activity" ] && exit 0

prompt="You are a newsroom ticker compressing the activity of multiple parallel Claude Code coding sessions AND the user's interactive shell sessions into ONE rolling headline.

PRIOR HEADLINES (oldest → newest, each line a previous digest):
${history:-(none)}

CURRENT CLAUDE SESSION ACTIVITY (latest one-line per active session):
${sessions:-(none)}

USER SHELL ACTIVITY (raw recent commands across non-Claude zsh sessions, format: HH:MM:SS|cwd|command):
${shell_activity:-(none)}

Produce ONE single line (max 240 chars) describing the CURRENT state of work, weighted heavily toward the most-recent activity (last 1-2 headlines + current session activity + last few shell commands). DROP themes from older headlines that are no longer mentioned in current activity — assume they are resolved or no longer relevant. Only carry forward an older theme if there is concrete evidence in the current activity that it is still in flight. Translate raw shell commands into plain English (e.g., 'ssh into bastion', 'inspecting prod logs', 'running tests'). Plain English ticker style. No bullets, no quotes, no preface, no markdown."

result=$(printf '%s' "$prompt" | claude -p --model haiku --no-session-persistence --output-format text 2>/dev/null | head -c 260 | LC_ALL=C tr '\n' ' ')

if [ -n "$result" ]; then
  printf '%s' "$result" > "$DIGEST"
  printf '[%s] %s\n' "$(date '+%H:%M')" "$result" >> "$LOG"
  tail -n 50 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi
exit 0
