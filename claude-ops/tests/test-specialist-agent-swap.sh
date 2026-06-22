#!/usr/bin/env bash
# test-specialist-agent-swap.sh — agent_installed() resolves plugin:agent namespaces
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_HOME=""
pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

cleanup() {
  if [ -n "$TMP_HOME" ] && [ -d "$TMP_HOME" ]; then
    rm -rf "$TMP_HOME"
  fi
}
trap cleanup EXIT

TMP_HOME="$(mktemp -d)"
export HOME="$TMP_HOME"
export PLUGIN_ROOT

. "$PLUGIN_ROOT/scripts/lib/agent-installed.sh"

echo "Checking agent_installed()..."
echo ""

mkdir -p "$TMP_HOME/.claude/agents"
echo '---' > "$TMP_HOME/.claude/agents/code-reviewer.md"

if agent_installed "feature-dev:code-reviewer"; then
  err "bare code-reviewer must not satisfy feature-dev:code-reviewer"
else
  ok "namespaced agent ignores unrelated bare agent file"
fi

mkdir -p "$TMP_HOME/.cursor/plugins/cache/claude-code-plugins/feature-dev/abc123/agents"
echo '---' > "$TMP_HOME/.cursor/plugins/cache/claude-code-plugins/feature-dev/abc123/agents/code-reviewer.md"

if agent_installed "feature-dev:code-reviewer"; then
  ok "feature-dev:code-reviewer found in Cursor plugin cache"
else
  err "feature-dev:code-reviewer not resolved (namespace bug)"
fi

if agent_installed "feature-dev:code-explorer"; then
  err "feature-dev:code-explorer should be missing"
else
  ok "missing plugin agent correctly returns false"
fi

echo '---' > "$TMP_HOME/.claude/agents/triage-agent.md"

if agent_installed "triage-agent"; then
  ok "bare agent name in ~/.claude/agents"
else
  err "bare agent name not found"
fi

if agent_installed "general-purpose"; then
  ok "general-purpose always available"
else
  err "general-purpose should always be available"
fi

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
