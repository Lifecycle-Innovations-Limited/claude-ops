#!/usr/bin/env bash
# claude-reaper.sh — periodic safety net against the 2026-05-23 incident class.
# Prevents recurrence of: (1) orphaned MCP server trees (ppid=1) from dead Claude
# sessions piling up into a memory hog; (2) stacked duplicate singleton daemons /
# SessionStart scripts compounding into a CPU avalanche; (3) stuck worktree scans.
# Runs via launchd every 5 min — independent of any Claude session being open.
# Conservative: only acts on ppid==1 orphans, true duplicates, and long-stuck scans.

# ── Stacking guard ──────────────────────────────────────────────────────────
# Prevent multiple reaper instances from running concurrently.
if [[ -f "$HOME/.claude/scripts/lib/once.sh" ]]; then
  # shellcheck source=lib/once.sh
  source "$HOME/.claude/scripts/lib/once.sh"
  claude_once "claude-reaper" 60 || exit 0  # one instance max, min 60s between runs
fi

set -uo pipefail
SAFETY="$(cd "$(dirname "$0")" && pwd)/reaper-safety.sh"
[ -r "$SAFETY" ] || exit 2
source "$SAFETY"
POLICY="${OPS_MAC_POLICY:-$HOME/.config/claude-ops/ops-mac-policy.sh}"
[ -r "$POLICY" ] || exit 2
SINGLETON_NAMES=()
ORPHAN_PAT="a^"
STATEFUL_PAT="a^"
source "$POLICY"
if [ -f "$HOME/.claude/.disable-reaper" ] || [ -f "$HOME/.claude/.no-auto-kill-work" ]; then
  exit 0
fi
LOG="${HOME}/.claude/claude-reaper.log"
log(){ printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# etime ([[dd-]hh:]mm:ss) → seconds. Robust: always returns non-negative int.
age_secs(){
  local pid=${1:-0}
  local etime
  etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d '[:space:]')
  [ -z "$etime" ] && { echo 0; return 0; }
  local d=0 h=0 m=0 s=0
  if [[ $etime == *-* ]]; then
    d=${etime%%-*}
    etime=${etime#*-}
  fi
  IFS=: read -r a b c <<<"$etime" 2>/dev/null || true
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c
  elif [ -n "${b:-}" ]; then m=$a; s=$b
  else s=${a:-0}
  fi
  echo $(( 10#${d:-0} * 86400 + 10#${h:-0} * 3600 + 10#${m:-0} * 60 + 10#${s:-0} ))
}

# --- (1) Reap orphaned MCP/tool server trees (ppid==1) — never the whatsapp-bridge ---
# ORPHAN_PAT is an explicit operator allowlist from local policy.
for pid in $(pgrep -f "$ORPHAN_PAT" 2>/dev/null); do
  identity=$(ops_reaper_identity "$pid") || continue
  ps -o command= -p "$pid" 2>/dev/null | grep -q 'whatsapp-bridge' && continue
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ "$ppid" = "1" ] || continue                  # live servers have a session parent
  [ "$(age_secs "$pid")" -gt 300 ] || continue   # grace for just-spawned
  ops_reaper_unmanaged_orphan "$pid" || continue
  [ "$(ops_reaper_identity "$pid")" = "$identity" ] || continue
  pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null && log "reaped orphan MCP pid=$pid"
done

# --- (2) Observe apparent duplicates; PID ordering is not ownership. ---
# Instance/profile, wrapper-child and active-task ownership belong to the
# dedicated process policy. Do not introduce a competing blind singleton killer.
for name in ${SINGLETON_NAMES[@]+"${SINGLETON_NAMES[@]}"}; do
  pids=$(pgrep -f "$name" 2>/dev/null | sort -n)
  [ "$(printf '%s\n' "$pids" | grep -c .)" -gt 1 ] || continue
  log "observed multiple $name processes; ownership policy required, none killed"
done

# --- (3) Observe old scans; age and command do not establish ownership. ---
for pid in $(pgrep -f 'find [^ ]*\.worktrees|lsof -a -d cwd' 2>/dev/null); do
  [ "$(age_secs "$pid")" -gt 300 ] && log "observed old scan pid=$pid; ownership unknown, no action"
done

# --- (4) Reap MCP children whose claude parent has died (not ppid==1, but parent gone) ---
# STATEFUL_PAT is an explicit operator allowlist from local policy.
for pid in $(pgrep -f "$STATEFUL_PAT" 2>/dev/null); do
  identity=$(ops_reaper_identity "$pid") || continue
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$ppid" ] && continue
  # Any live parent owns its child, including non-Claude wrappers.
  if [ "$ppid" = 1 ]; then
    ops_reaper_unmanaged_orphan "$pid" || continue
  else
    ops_reaper_parent_absent "$ppid" || continue
  fi
  [ "$(age_secs "$pid")" -gt 300 ] || continue
  # Recheck ownership after the age probe; unknown state means no action.
  current_ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ "$current_ppid" = "$ppid" ] || continue
  if [ "$ppid" = 1 ]; then
    ops_reaper_unmanaged_orphan "$pid" || continue
  else
    ops_reaper_parent_absent "$ppid" || continue
  fi
  [ "$(ops_reaper_identity "$pid")" = "$identity" ] || continue
  pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null \
    && log "reaped abandoned MCP pid=$pid (ex-parent=$ppid)"
done

# --- (5) Idle-session lifecycle: native Claude daemon owns it. ---
# Do not query, stop, or respawn sessions here.

# --- (6) bg-spare prewarm pool: native daemon owned ---
# Culling the native daemon's --bg-spare prewarm pool fights its lifecycle: it
# refills spares in <60s, and killing one mid-claim SIGTERMs the worker being
# promoted into a real session → `worker crashed (exit 143) — respawning` loops in
# `claude agents`. Let native Claude Code manage its own prewarm pool. Do NOT
# re-add a bg-spare killer here or as a launchd job.


# --- (7) Observe broad old rg scans; their live owner may still need them. ---
# No process action is authorized by a command-pattern/elapsed-time match.
pgrep -f 'rg.*--files' 2>/dev/null | while read -r pid; do
  [ "$(age_secs "$pid")" -gt 120 ] || continue
  cmd=$(ps -o args= -p "$pid" 2>/dev/null || true)
  echo "$cmd" | grep -qE '(^|[[:space:]])/(home|mnt|Users|private|var|)([[:space:]]|$)|--follow[[:space:]]+/' || continue
  log "observed broad old rg scan pid=$pid; ownership unknown, no action"
done

# --- (8) Cap runaway background-task output files ---
# A background task output in the per-user temporary task tree grew to 98GB
# (self-referential echo loop) and filled the disk to 100%. Sweep: any task
# *.output >2GB with no open writer and idle >30min gets truncated in place
# (truncate, not delete — a late writer reopening by path still works).
find "${REAPER_TASK_ROOT:-/private/tmp/claude-$(id -u)}" -type f -name '*.output' -size +2G -mmin +30 2>/dev/null | while read -r f; do
  lsof "$f" >/dev/null 2>&1 && continue
  sz=$(du -m "$f" 2>/dev/null | cut -f1)
  : > "$f" && log "truncated runaway task output ${sz}MB: $f"
done

# --- (9) Observe old authentication processes; never infer permission to stop. ---
# PID 1 and elapsed time do not prove an unmanaged, noninteractive orphan.
# Authentication/account lifecycle belongs to its owner, not this broad scan.
if ! pgrep -f 'rotate\.mjs|force-rotate' >/dev/null 2>&1; then
  ROTLOCK="$HOME/.claude/scripts/account-rotation/.rotating"
  rot_live=0
  if [ -f "$ROTLOCK" ]; then
    lp=$(tail -1 "$ROTLOCK" 2>/dev/null | tr -d '[:space:]')
    [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null && rot_live=1
  fi
  if [ "$rot_live" = 0 ]; then
    for pid in $(pgrep -f 'auth login --email' 2>/dev/null); do
      [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "1" ] || continue
      [ "$(age_secs "$pid")" -gt 900 ] || continue
      rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
      log "observed old auth-login pid=$pid rss=${rss}KB; ownership unknown, no action"
    done
  fi
fi
exit 0
