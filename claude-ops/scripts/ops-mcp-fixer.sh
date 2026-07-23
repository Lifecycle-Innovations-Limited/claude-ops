#!/bin/bash
# ops-mcp-fixer.sh — dispatched by ops-mcp-watchdog.py when an MCP degrades.
# Spawns a headless Claude agent that diagnoses and repairs the degraded MCP(s).
# Only when the fix fails (or the hourly budget is spent) does the owner get an
# INFORMATIVE desktop notification (server name + cause + suggested action) —
# never a vague "N MCP(s) need attention".
#
# Usage: ops-mcp-fixer.sh '<json array of {name,state,detail}>'
# Guards: lock dir (no concurrent runs, stale >30 min reclaimed),
#         max 2 fixer runs per hour (prevents agent loops).
#
# Env:
#   MCP_FIXER_MAX_RUNS_PER_HOUR  default 2
#   MCP_FIXER_MAX_TURNS          default 60

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PAYLOAD="${1:-[]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.claude/state/mcp-watchdog"
LOCK_DIR="$STATE_DIR/fixer.lock"
BUDGET_FILE="$STATE_DIR/fixer-runs.log"
LOG="$STATE_DIR/fixer.log"
MAX_RUNS="${MCP_FIXER_MAX_RUNS_PER_HOUR:-2}"
MAX_TURNS="${MCP_FIXER_MAX_TURNS:-60}"
mkdir -p "$STATE_DIR"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "$(ts) [ops-mcp-fixer] $*" >> "$LOG"; }

notify() { # $1=title $2=message — informative, includes server names
  local t="${1//\"/'}" m="${2//\"/'}"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${m:0:220}\" with title \"${t:0:60}\" sound name \"Glass\"" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "$t" "${m:0:220}" >/dev/null 2>&1
  fi
}

SUMMARY=$(python3 - "$PAYLOAD" <<'PY' 2>/dev/null
import json, sys
try:
    items = json.loads(sys.argv[1])
    print("; ".join(f"{i['name']}: {i['state']}" + (f" ({i.get('detail','')[:40]})" if i.get('detail') else "") for i in items))
except Exception:
    print("unknown MCP degradation")
PY
)
[ -z "$SUMMARY" ] && SUMMARY="unknown MCP degradation"

# ── Lock: no concurrent fixers. Reclaim stale locks (>30 min). ──
if [ -d "$LOCK_DIR" ]; then
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rm -rf "$LOCK_DIR"; log "reclaimed stale lock"
  else
    log "fixer already running — skip ($SUMMARY)"; exit 0
  fi
fi
mkdir "$LOCK_DIR" 2>/dev/null || exit 0
trap 'rm -rf "$LOCK_DIR"' EXIT

# ── Budget: max N runs per hour ──
NOW=$(date +%s)
if [ -f "$BUDGET_FILE" ]; then
  RECENT=$(awk -v now="$NOW" '$1 > now-3600' "$BUDGET_FILE" | wc -l | tr -d ' ')
  if [ "$RECENT" -ge "$MAX_RUNS" ]; then
    log "hourly budget spent ($MAX_RUNS runs) — notifying instead of fixing ($SUMMARY)"
    notify "MCP degraded — fixer budget spent" "$SUMMARY — check /ops:ops-mcp"
    exit 0
  fi
fi
echo "$NOW" >> "$BUDGET_FILE"
tail -20 "$BUDGET_FILE" > "$BUDGET_FILE.tmp" && mv "$BUDGET_FILE.tmp" "$BUDGET_FILE"

CLAUDE_BIN=$(command -v claude || echo "$HOME/.local/bin/claude")
if [ ! -x "$CLAUDE_BIN" ]; then
  log "claude binary not found — notifying instead"
  notify "MCP degraded" "$SUMMARY — claude CLI not found, fix manually"
  exit 1
fi

log "fixer agent starting for: $SUMMARY"

PROMPT="You are the automated MCP fixer on this machine (headless, no user present). The ops-mcp-watchdog reports these degraded MCP server(s): $PAYLOAD

Approach:
1. Read ~/.claude/state/mcp-watchdog/state.json and the last 40 lines of ~/.claude/state/mcp-watchdog/run.log for context.
2. Common causes to check, in order of likelihood:
   - Local gateway MCPs (URLs on 127.0.0.1/localhost): is the backing process/service running? Check launchd (macOS) / systemd (Linux) services and restart only the one you have determined to be the cause. A corrupt npx cache (~/.npm/_npx) is a known cause for npx-launched gateways — clearing only the affected package's cache dir is allowed.
   - Expired OAuth tokens: token caches live in ~/.mcp-auth/mcp-remote-*/ and in the OS keychain under 'Claude Code-credentials' (mcpOAuth). A refresh usually happens automatically on next session start — only intervene if clearly stuck.
   - Config issues: the server's entry in ~/.claude.json (key mcpServers) — headers, URL, wrapper script paths.
3. Fix the root cause. Never restart services speculatively.
4. Verify: re-run python3 $SCRIPT_DIR/ops-mcp-watchdog.py and confirm the affected servers probe healthy.
5. ONLY if it still fails after 2 attempts: send exactly one desktop notification (osascript on macOS, notify-send on Linux) naming each server, the cause, and the concrete manual action (max 200 chars). On success: NO notification.
6. Write a 1-3 line summary of what you did to ~/.claude/state/mcp-watchdog/fixer-last-result.txt

Hard limits: delete nothing outside npx caches, never enter passwords, no browser logins, no outbound messages (mail/chat/SMS)."

"$CLAUDE_BIN" -p "$PROMPT" --dangerously-skip-permissions --max-turns "$MAX_TURNS" >> "$LOG" 2>&1
RC=$?
log "fixer agent done (exit $RC)"

# ── Independent verification (never trust agent claims blindly) ──
sleep 5
STILL_BROKEN=$(python3 - "$PAYLOAD" <<'PY' 2>/dev/null
import json, sys, pathlib
try:
    names = [i["name"] for i in json.loads(sys.argv[1])]
    state = json.loads((pathlib.Path.home() / ".claude/state/mcp-watchdog/state.json").read_text())
    bad = [f"{n}: {state[n]['state']}" for n in names if n in state and state[n].get("state") != "healthy"]
    print("; ".join(bad))
except Exception:
    print("")
PY
)

if [ -n "$STILL_BROKEN" ] && [ "$RC" -ne 0 ]; then
  log "still broken after fixer: $STILL_BROKEN"
  notify "MCP still degraded after auto-fix" "$STILL_BROKEN — check /ops:ops-mcp"
elif [ -n "$STILL_BROKEN" ]; then
  log "fixer finished but state not yet healthy: $STILL_BROKEN (agent may have notified itself)"
else
  log "verified recovered: $SUMMARY"
fi
exit 0
