#!/usr/bin/env bash
# Ownership checks only. Sourcing this file performs no process actions.
# Return success only when absence of a live/managed parent is established.
ops_reaper_identity() {
  local pid="$1" identity tty
  tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d '[:space:]') || return 1
  case "$tty" in '?'|'??'|'-') ;; *) return 1 ;; esac
  identity=$(ps -p "$pid" -o lstart= -o comm= 2>/dev/null) || return 1
  [ -n "$identity" ] || return 1
  printf '%s\n' "$identity"
}

ops_reaper_parent_absent() {
  local ppid="$1" status
  case "$ppid" in ''|*[!0-9]*|0) return 1 ;; esac
  if ps -p "$ppid" -o pid= >/dev/null 2>&1; then
    return 1
  else
    status=$?
    # ps status 1 is no selected process; other errors are unknown ownership.
    [ "$status" = 1 ] || return 1
  fi
  return 0
}

ops_reaper_unmanaged_orphan() {
  local pid="$1" user_jobs system_jobs user_domain gui_domain ppid uid
  case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]') || return 1
  [ "$ppid" = 1 ] || return 1
  # Missing launchd inventory means do not act. PID 1 alone proves nothing.
  user_jobs=$(launchctl list 2>/dev/null) || return 1
  system_jobs=$(launchctl print system 2>/dev/null) || return 1
  uid=$(id -u) || return 1
  user_domain=$(launchctl print "user/$uid" 2>/dev/null) || return 1
  gui_domain=$(launchctl print "gui/$uid" 2>/dev/null) || return 1
  if printf '%s\n' "$user_jobs" | awk -v pid="$pid" '$1 == pid {found=1} END {exit !found}'; then
    return 1
  fi
  if printf '%s\n' "$system_jobs" "$user_domain" "$gui_domain" | awk -v pid="$pid" '$1 == pid || ($1 == "pid" && $2 == "=" && $3 == pid) {found=1} END {exit !found}'; then
    return 1
  fi
  # Recheck parent immediately before the caller's action.
  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]') || return 1
  [ "$ppid" = 1 ]
}
