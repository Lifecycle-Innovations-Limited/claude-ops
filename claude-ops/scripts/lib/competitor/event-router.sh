#!/usr/bin/env bash
# event-router.sh — Severity-tiered event routing for competitor intel v2.3
#
# Source this file to get the `route_event` function.
# Usage: echo "$jsonl_event" | route_event
#
# Routes:
#   high → events.jsonl + queue/immediate.jsonl
#   med  → events.jsonl + queue/daily.jsonl
#   low  → events.jsonl only
#
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"

_router_log() {
  local log_file="$DATA_DIR/logs/competitor-router.log"
  mkdir -p "$DATA_DIR/logs" 2>/dev/null || true
  printf '%s [event-router] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log_file" 2>/dev/null || true
}

route_event() {
  # Reads one JSONL event from stdin, routes by severity.
  local event
  event=$(cat)

  [[ -z "$event" ]] && return 0

  # Validate it's parseable JSON
  if ! printf '%s' "$event" | jq -e '.' >/dev/null 2>&1; then
    _router_log "WARN: skipping non-JSON input: ${event:0:120}"
    return 0
  fi

  local severity
  severity=$(printf '%s' "$event" | jq -r '.severity // "low"' 2>/dev/null || echo "low")

  # Ensure state dirs exist
  local state_dir="$DATA_DIR/competitor_state"
  local queue_dir="$state_dir/queue"
  mkdir -p "$queue_dir"

  # Always append to audit log
  printf '%s\n' "$event" >> "$state_dir/events.jsonl"

  case "$severity" in
    high)
      printf '%s\n' "$event" >> "$queue_dir/immediate.jsonl"
      _router_log "HIGH routed → queue/immediate.jsonl (competitor=$(printf '%s' "$event" | jq -r '.competitor // "?"' 2>/dev/null))"
      ;;
    med)
      printf '%s\n' "$event" >> "$queue_dir/daily.jsonl"
      _router_log "MED routed → queue/daily.jsonl (competitor=$(printf '%s' "$event" | jq -r '.competitor // "?"' 2>/dev/null))"
      ;;
    low)
      _router_log "LOW state-only (competitor=$(printf '%s' "$event" | jq -r '.competitor // "?"' 2>/dev/null))"
      ;;
    *)
      _router_log "WARN: unknown severity '$severity' — treating as low"
      ;;
  esac

  return 0
}
