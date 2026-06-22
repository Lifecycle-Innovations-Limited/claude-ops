#!/usr/bin/env bash
# agent-installed.sh — resolve whether a subagent_type is installed (ops hook + tests).
# Supports bare names (triage-agent) and namespaced plugin agents (feature-dev:code-reviewer).

agent_installed() {
  local name="$1"
  local plugin="" agent="$name"

  if [[ "$name" == *:* ]]; then
    plugin="${name%%:*}"
    agent="${name#*:}"
  fi

  [ -f "${HOME}/.claude/agents/${name}.md" ] && return 0
  if [ -z "$plugin" ]; then
    [ -f "${HOME}/.claude/agents/${agent}.md" ] && return 0
  fi
  if [ -n "${PLUGIN_ROOT:-}" ]; then
    [ -f "$PLUGIN_ROOT/agents/${name}.md" ] && return 0
    if [ -z "$plugin" ]; then
      [ -f "$PLUGIN_ROOT/agents/${agent}.md" ] && return 0
    fi
  fi

  case "$name" in
    general-purpose|statusline-setup) return 0 ;;
  esac

  for cache_root in "${HOME}/.claude/plugins/cache" "${HOME}/.cursor/plugins/cache"; do
    [ -d "$cache_root" ] || continue

    if [ -n "$plugin" ]; then
      local f
      for f in \
        "$cache_root"/*/"$plugin"/*/agents/"$agent".md \
        "$cache_root"/*/*/"$plugin"/*/agents/"$agent".md \
        "$cache_root"/*/"$plugin"/agents/"$agent".md; do
        [ -f "$f" ] && return 0
      done
      continue
    fi

    local d
    for d in "$cache_root"/*/agents "$cache_root"/*/*/agents; do
      [ -f "$d/${name}.md" ] && return 0
      [ -f "$d/${agent}.md" ] && return 0
    done
  done

  return 1
}
