#!/usr/bin/env bash
# deploy-fix-common.sh — shared helpers for the deploy/build auto-fix subsystem.
# Sourced by hook scripts and the background monitor. Uses ${CLAUDE_PLUGIN_ROOT}
# when invoked from inside the plugin; falls back to inferred paths.

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PLUGIN_ROOT

PREFS_DIR="${HOME}/.claude/plugins/data/ops-ops-marketplace"
PREFS_FILE="$PREFS_DIR/preferences.json"
STATE_DIR="${OPS_DEPLOY_FIX_STATE:-${HOME}/.claude/state/ops-deploy-fix}"
LOGS_DIR="${OPS_DEPLOY_FIX_LOGS:-${HOME}/.claude/logs/ops-deploy-fix}"
mkdir -p "$STATE_DIR" "$LOGS_DIR" 2>/dev/null

# config <key> <default>  — reads CLAUDE_PLUGIN_OPTION_<KEY>, then plugin prefs, then default
config() {
  local key="$1" default="$2"
  local env_var="CLAUDE_PLUGIN_OPTION_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  if [ -n "${!env_var:-}" ]; then echo "${!env_var}"; return; fi
  if [ -f "$PREFS_FILE" ]; then
    local v=$(jq -r --arg k "$key" '.[$k] // .deploy_fix[$k] // empty' "$PREFS_FILE" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != "null" ] && { echo "$v"; return; }
  fi
  echo "$default"
}

is_enabled() {
  [ "$(config deploy_fix_enabled true)" = "true" ] && [ "$(config "$1" true)" = "true" ]
}

repo_slug_safe() { echo "$1" | tr '/' '-'; }

# Single-flight lock per repo+kind. Returns 0 if acquired, 1 if held.
lock_acquire() {
  local id="$1"
  local f="$STATE_DIR/lock-$id"
  if [ -f "$f" ]; then
    local pid=$(cat "$f" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 1  # alive
    fi
    rm -f "$f"  # stale
  fi
  echo $$ > "$f"
  return 0
}
lock_release() { rm -f "$STATE_DIR/lock-$1" 2>/dev/null; }

# Hourly budget per repo. Returns 0 if under cap (and increments), 1 if over.
budget_check_increment() {
  local slug="$1"
  local cap=$(config max_fixes_per_hour 3)
  local hour=$(date +%Y%m%d-%H)
  local f="$STATE_DIR/budget-$slug-$hour"
  local n=$(cat "$f" 2>/dev/null || echo 0)
  if [ "$n" -ge "$cap" ]; then return 1; fi
  echo $((n + 1)) > "$f"
  return 0
}

# Dedup by content hash — same failure tail twice in a row = skip second dispatch.
already_seen() {
  local slug="$1" content="$2"
  local hash=$(printf '%s' "$content" | shasum | awk '{print $1}')
  local f="$STATE_DIR/last-failure-$slug"
  local last=$(cat "$f" 2>/dev/null || echo "")
  if [ "$last" = "$hash" ]; then return 0; fi
  echo "$hash" > "$f"
  return 1
}

# Detect transient failure signatures. Returns 0 (transient) or 1.
is_transient() {
  # Pattern stored in a variable so the regex is one logical token —
  # the previous inline backslash-continuation produced literal '\' chars
  # inside single-quoted alternatives and broke matching under set -e.
  local pat
  pat='ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|TLS handshake timeout|unexpected EOF while reading|Could not resolve host|network is unreachable'
  pat="$pat"'|npm error code E429|npm error 5(0[0-9]|2[0-9])|HTTP(S)?Error:? 429|HTTP(S)?Error:? 5[0-9]{2}'
  pat="$pat"'|The runner has received a shutdown signal|The hosted runner lost communication|The operation was canceled\.|GH001:'
  pat="$pat"'|TooManyRequestsException|ThrottlingException|RequestLimitExceeded|Service Unavailable Exception'
  pat="$pat"'|Apple ID server.*temporarily unavailable|App Store Connect.*timed out|ASC.*5[0-9]{2}'
  pat="$pat"'|Simulator failed to launch|ECR.*throttle'
  printf '%s' "$1" | grep -qE "$pat"
}

notify() {
  local title="$1" msg="$2"
  local channel=$(config notify_channel macos)
  case "$channel" in
    macos)
      command -v terminal-notifier >/dev/null && \
        terminal-notifier -title "$title" -message "$msg" -sender com.apple.Terminal 2>/dev/null
      ;;
    ntfy)
      local topic=$(config ntfy_topic "")
      [ -n "$topic" ] && curl -sS -X POST "https://ntfy.sh/$topic" -H "Title: $title" -d "$msg" >/dev/null 2>&1
      ;;
    discord)
      local hook=$(config discord_default_webhook_url "")
      [ -n "$hook" ] && curl -sS -X POST "$hook" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg c "**$title** — $msg" '{content:$c}')" >/dev/null 2>&1
      ;;
    pushover)
      local user=$(config pushover_user_key "") token=$(config pushover_app_token "")
      [ -n "$user" ] && [ -n "$token" ] && \
        curl -sS https://api.pushover.net/1/messages.json \
          --form-string "token=$token" --form-string "user=$user" \
          --form-string "title=$title" --form-string "message=$msg" >/dev/null 2>&1
      ;;
    none) : ;;
  esac
}

# Locate repo on disk via configurable search roots.
locate_repo() {
  local slug="$1" repo_only="${1#*/}"
  local roots="$(config repo_search_roots "$HOME/Projects:$HOME")"
  IFS=':' read -ra arr <<< "$roots"
  for root in "${arr[@]}"; do
    root="${root/#\~/$HOME}"
    [ -d "$root/$repo_only" ] && { echo "$root/$repo_only"; return 0; }
    [ -d "$root/$slug" ] && { echo "$root/$slug"; return 0; }
  done
  return 1
}

# Resolve health URL via layered registry: project → user → plugin example.
resolve_health_url() {
  # Split onto separate `local` lines: bash evaluates each RHS in the parent
  # scope first, so multi-assignment cross-refs (`key="$slug:$base"`) trip
  # set -u with "slug: unbound variable".
  local slug="$1"
  local base="$2"
  local key="$slug:$base"
  local proj=$(locate_repo "$slug" 2>/dev/null)
  if [ -n "$proj" ] && [ -f "$proj/.claude/post-merge-services.json" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].health // ""' "$proj/.claude/post-merge-services.json" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  local user_path="$(config registry_path "$HOME/.claude/config/post-merge-services.json")"
  user_path="${user_path/#\~/$HOME}"
  if [ -f "$user_path" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].health // ""' "$user_path" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  if [ -f "$PLUGIN_ROOT/config/post-merge-services.example.json" ]; then
    jq -r --arg k "$key" '.[$k].health // ""' "$PLUGIN_ROOT/config/post-merge-services.example.json" 2>/dev/null || true
  fi
  # Always succeed. When no registry layer matches, the function's last command
  # is the `[ -f ... ]` test (false → status 1) or a failed jq; either would
  # abort a `set -e` caller doing `URL=$(resolve_health_url ...)`. The empty
  # stdout is the intended "not found" signal — return status must stay 0.
  return 0
}

resolve_version_url() {
  local slug="$1"
  local base="$2"
  local key="$slug:$base"
  local proj=$(locate_repo "$slug" 2>/dev/null)
  if [ -n "$proj" ] && [ -f "$proj/.claude/post-merge-services.json" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].version // ""' "$proj/.claude/post-merge-services.json" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  local user_path="$(config registry_path "$HOME/.claude/config/post-merge-services.json")"
  user_path="${user_path/#\~/$HOME}"
  if [ -f "$user_path" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].version // ""' "$user_path" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  if [ -f "$PLUGIN_ROOT/config/post-merge-services.example.json" ]; then
    jq -r --arg k "$key" '.[$k].version // ""' "$PLUGIN_ROOT/config/post-merge-services.example.json" 2>/dev/null || true
  fi
  # Always succeed — see resolve_health_url above for the rationale.
  return 0
}

dispatch_fix_agent() {
  # $1 = agent name (resolved via `claude --agent <name>` against agents/<name>.md),
  # $2 = lock_id, $3.. = context KEY=VAL pairs that become "KEY: VAL" lines in the brief.
  # Legacy callers passed prompt template paths like "build-fix.md" / "deploy-fix.md";
  # those are remapped to the new agent names so the contract change is transparent.
  #
  # Return codes:
  #   0  dispatched successfully
  #   2  single-flight lock already held (same repo+kind already in flight)
  #   3  hourly budget exhausted for this repo
  #   4  agent definition file not found (misconfiguration)
  #   5  `claude` binary not on PATH
  #   6  global concurrency cap reached (max_concurrent_fixers)
  #   7  fleet agent already active on this repo (respect_fleet_claims)
  local agent_name="$1"
  local lock_id="$2"
  shift 2
  if ! lock_acquire "$lock_id"; then
    return 2  # already in flight
  fi
  local slug="${lock_id%%:*}"

  # --- Global concurrency cap (rc=6) ---
  local _active_dir="$STATE_DIR/active"
  mkdir -p "$_active_dir"
  # Prune stale pidfiles whose process is no longer alive (or invalid/empty).
  for _pf in "$_active_dir"/*.pid; do
    [ -f "$_pf" ] || continue
    local _ppid
    _ppid=$(tr -d '[:space:]' < "$_pf" 2>/dev/null || true)
    if [ -z "$_ppid" ] || ! kill -0 "$_ppid" 2>/dev/null; then
      rm -f "$_pf"
    fi
  done
  local _live_count
  _live_count=$(find "$_active_dir" -maxdepth 1 -name '*.pid' 2>/dev/null | wc -l | tr -d ' ')
  local _max_concurrent
  _max_concurrent=$(config max_concurrent_fixers 3)
  if [ "$_live_count" -ge "$_max_concurrent" ]; then
    notify "Fixer concurrency cap" "global cap of $_max_concurrent reached — skipping dispatch for $slug"
    lock_release "$lock_id"
    return 6
  fi
  local _lock_safe _pidfile
  _lock_safe=$(printf '%s' "$lock_id" | tr '/: ' '---')
  _pidfile="$_active_dir/${_lock_safe}-$$.pid"
  echo $$ > "$_pidfile"

  # --- Fleet-claim dedup (rc=7) ---
  local _fleet_file="$HOME/.claude/state/fleet-tui.json"
  if [ "$(config respect_fleet_claims true)" = "true" ] && [ -f "$_fleet_file" ]; then
    if ! command -v jq >/dev/null 2>&1; then
      notify "Fleet dedup blocked" "fleet-tui.json present but jq missing — skipping dispatch for $slug"
      rm -f "$_pidfile"
      lock_release "$lock_id"
      return 7
    fi
    local _fix_repo="${DEPLOY_FIX_REPO:-}"
    local _repo_bare="${_fix_repo#*/}"
    local _fleet_active
    _fleet_active=$(jq -r --arg full "$_fix_repo" --arg bare "$_repo_bare" '
      .agents // [] |
      map(select(
        (.status | ascii_downcase | test("^(running|in_progress|working|active)$")) and
        (.repo == $full or .repo == $bare)
      )) | length
    ' "$_fleet_file" 2>/dev/null || echo "0")
    if [ "${_fleet_active:-0}" -gt 0 ] 2>/dev/null; then
      notify "Fleet agent active" "fleet agent already working on $_fix_repo — deploy-fixer skipped"
      rm -f "$_pidfile"
      lock_release "$lock_id"
      return 7
    fi
  fi

  # Legacy → new contract mapping.
  agent_name="${agent_name%.md}"
  case "$agent_name" in
    build-fix) agent_name="build-fixer" ;;
    deploy-fix) agent_name="deploy-fixer" ;;
  esac

  # If the agent file is absent, treat as misconfiguration: release the lock
  # and surface rc=4 so callers can fall back to manual notification.
  if [ ! -f "$PLUGIN_ROOT/agents/$agent_name.md" ]; then
    rm -f "$_pidfile"
    lock_release "$lock_id"
    return 4
  fi

  # Build the brief from KEY=VAL pairs. One pair per line so downstream parsers
  # (and the test mock) can match on `REPO: owner/repo` etc.
  local brief="Context for this fix:"
  local kv k v
  local _census_branch="deploy-fix"
  local _census_repo_kv=""
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    case "$k" in
      BRANCH) _census_branch="$v" ;;
      BASE) _census_branch="$v" ;;
      REPO) _census_repo_kv="$v" ;;
    esac
    brief="$brief"$'\n'"$k: $v"
  done

  local fix_log="$LOGS_DIR/fix-${lock_id}-$(date +%s).log"
  local danger_flag="--permission-mode acceptEdits"
  [ "$(config allow_dangerous false)" = "true" ] && danger_flag="--dangerously-skip-permissions"

  command -v claude >/dev/null || { rm -f "$_pidfile"; lock_release "$lock_id"; return 5; }

  if ! budget_check_increment "$slug"; then
    notify "Auto-fix budget exhausted" "$slug hit hourly cap — manual intervention needed"
    rm -f "$_pidfile"
    lock_release "$lock_id"
    return 3
  fi

  # Capture invoker path so the nohup subshell can source it without relying
  # on $PLUGIN_ROOT being exported (it may not be in all caller environments).
  local _invoker="$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"

  local _fix_repo_for_sidecar="${DEPLOY_FIX_REPO:-}"
  [ -z "$_fix_repo_for_sidecar" ] && _fix_repo_for_sidecar="${_census_repo_kv:-unknown}"
  local _epoch
  _epoch=$(date +%s)
  local _sidecar_dir="$HOME/.claude/state"
  local _sidecar_file="$_sidecar_dir/deploy-fix-active.jsonl"
  local _census_id="${_lock_safe}-${_epoch}"
  local _register_census
  _register_census=$(config register_in_fleet_census true)

  nohup bash -c "
    _census_done=0
    _on_exit() {
      rm -f '$_pidfile'
      rm -f '$STATE_DIR/lock-$lock_id'
      if [ '$_register_census' = 'true' ] && [ \"\$_census_done\" = 0 ]; then
        _census_done=1
        _ended_iso=\$(date -u +%FT%TZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
        printf '%s\n' \"\$(jq -nc \
          --arg id '$_census_id' \
          --arg repo '$_fix_repo_for_sidecar' \
          --arg branch '$_census_branch' \
          --arg ended \"\$_ended_iso\" \
          '{id:\$id,name:\"deploy-fix:\"+\$repo,status:\"done\",repo:\$repo,branch:\$branch,source:\"deploy-fix\",ended:\$ended}' \
          2>/dev/null || true)\" >> '$_sidecar_file' 2>/dev/null || true
      fi
    }
    trap _on_exit EXIT
    . '$_invoker'
    printf '%s' \"\$1\" | claude_invoke -p --agent $agent_name $danger_flag --no-session-persistence > '$fix_log' 2>&1
  " _ "$brief" </dev/null >/dev/null 2>&1 &
  local _bg_pid=$!
  disown 2>/dev/null || true

  if [ -z "$_bg_pid" ] || ! kill -0 "$_bg_pid" 2>/dev/null; then
    local _hour _budget_f _bn
    _hour=$(date +%Y%m%d-%H)
    _budget_f="$STATE_DIR/budget-$slug-$_hour"
    _bn=$(cat "$_budget_f" 2>/dev/null || echo 0)
    if [ "$_bn" -gt 0 ] 2>/dev/null; then
      echo $((_bn - 1)) > "$_budget_f"
    fi
    rm -f "$_pidfile"
    lock_release "$lock_id"
    return 1
  fi

  echo "$_bg_pid" > "$_pidfile"

  if [ "$_register_census" = "true" ] && command -v jq >/dev/null 2>&1; then
    local _started_iso
    _started_iso=$(date -u +%FT%TZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
    mkdir -p "$_sidecar_dir"
    touch "$_sidecar_file"
    jq -nc \
      --arg id "$_census_id" \
      --arg repo "$_fix_repo_for_sidecar" \
      --arg branch "$_census_branch" \
      --argjson pid "$_bg_pid" \
      --arg started "$_started_iso" \
      '{id:$id,name:("deploy-fix:"+$repo),status:"running",repo:$repo,branch:$branch,source:"deploy-fix",pid:$pid,started:$started}' \
      >> "$_sidecar_file" 2>/dev/null || true
  fi

  echo "$fix_log"
  return 0
}
