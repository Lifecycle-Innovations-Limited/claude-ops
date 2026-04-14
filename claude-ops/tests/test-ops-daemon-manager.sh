#!/usr/bin/env bash
# test-ops-daemon-manager.sh — Unit tests for scripts/ops-daemon-manager.sh
#
# Focus: syntax, argument handling, status JSON shape, and plist path
# extraction. Does NOT touch launchctl (CI runs on Linux).

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANAGER="$PLUGIN_ROOT/scripts/ops-daemon-manager.sh"
DAEMON_SCRIPT="$PLUGIN_ROOT/scripts/ops-daemon.sh"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Testing $MANAGER"
echo ""

# 1. Manager script exists and is executable
if [[ -x "$MANAGER" ]]; then
  ok "manager script is executable"
else
  err "manager script missing or not executable: $MANAGER"
fi

# 2. Bash syntax check
if bash -n "$MANAGER" 2>/dev/null; then
  ok "bash -n syntax check"
else
  err "bash syntax check failed"
fi

# 3. Daemon script has bash version guard
if head -20 "$DAEMON_SCRIPT" | grep -q "BASH_VERSINFO\[0\] < 4"; then
  ok "ops-daemon.sh has bash 4+ guard"
else
  err "ops-daemon.sh is missing bash version guard"
fi

# 4. Daemon script does not use bare `wait` in prefetch_briefing_cache
if grep -Pzo 'prefetch_briefing_cache\(\)[\s\S]*?^\}' "$DAEMON_SCRIPT" 2>/dev/null | grep -qE '^\s*wait\s*$'; then
  err "prefetch_briefing_cache still contains a bare 'wait' — will block on long-lived services"
else
  ok "prefetch_briefing_cache uses targeted wait (no bare 'wait')"
fi

# 5. No hardcoded user paths
if grep -n "/Users/[a-z]" "$MANAGER" >&2; then
  err "manager contains hardcoded /Users/ paths"
else
  ok "no hardcoded /Users/ paths"
fi

# 6. Usage shown with no arguments
set +e
usage_output="$("$MANAGER" 2>&1)"
set -e
if echo "$usage_output" | grep -qi "usage:"; then
  ok "prints usage with no arguments"
else
  err "did not print usage on empty invocation"
fi

# 7. Exit 64 (EX_USAGE) with no arguments
set +e
"$MANAGER" >/dev/null 2>&1
rc=$?
set -e
if [[ "$rc" == "64" ]]; then
  ok "exit 64 (EX_USAGE) on empty invocation"
else
  err "expected exit 64 on empty invocation, got $rc"
fi

# 8. Unknown option exits 64
set +e
"$MANAGER" status --bogus-flag >/dev/null 2>&1
rc=$?
set -e
if [[ "$rc" == "64" ]]; then
  ok "exit 64 on unknown option"
else
  err "expected exit 64 on unknown option, got $rc"
fi

# 9. Status command emits valid JSON (even with no plist installed, in a sandbox)
# Use a temp HOME so we don't depend on the tester's real install.
STATUS_HOME=$(mktemp -d)
STATUS_DATA="$STATUS_HOME/.claude/plugins/data/ops-ops-marketplace"
mkdir -p "$STATUS_DATA/logs" "$STATUS_HOME/Library/LaunchAgents"
set +e
HOME="$STATUS_HOME" OPS_DATA_DIR="$STATUS_DATA" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  "$MANAGER" status > "$STATUS_HOME/status.json" 2>"$STATUS_HOME/status.err"
rc=$?
set -e
if [[ "$rc" == "0" ]] && [[ -s "$STATUS_HOME/status.json" ]]; then
  ok "status subcommand exits 0 with output"
else
  err "status subcommand failed (rc=$rc)"
  cat "$STATUS_HOME/status.err" >&2 || true
fi

# 10. Status output is parseable JSON with expected keys
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "
import json, sys
with open('$STATUS_HOME/status.json') as f:
    d = json.load(f)
required = ['os', 'plugin_root', 'installed', 'running', 'pid', 'plist_path',
            'plist_script_path', 'expected_script_path', 'plist_version_match',
            'health_file', 'health_fresh', 'services_file']
missing = [k for k in required if k not in d]
if missing:
    print('missing keys:', missing, file=sys.stderr)
    sys.exit(1)
" 2>/dev/null; then
    ok "status JSON has all required keys"
  else
    err "status JSON is malformed or missing keys"
  fi
fi

# 11. On a fresh temp HOME, installed=false and plist_version_match=false
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "
import json
d = json.load(open('$STATUS_HOME/status.json'))
assert d['installed'] == False, f'expected installed=false, got {d[\"installed\"]}'
assert d['plist_version_match'] == False, f'expected plist_version_match=false'
" 2>/dev/null; then
    ok "clean-HOME status reports installed=false"
  else
    err "clean-HOME status did not report installed=false"
  fi
fi

# 12. Help flag works
set +e
help_output="$("$MANAGER" --help 2>&1)"
set -e
if echo "$help_output" | grep -qi usage; then
  ok "--help prints usage"
else
  err "--help did not print usage"
fi

# 13. Dry-run flag accepted
set +e
OPS_DATA_DIR="$STATUS_DATA" HOME="$STATUS_HOME" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  "$MANAGER" restart --dry-run >/dev/null 2>&1
rc=$?
set -e
# On non-macOS hosts this will exit 69 (EX_UNAVAILABLE); on macOS it should exit 0
if [[ "$rc" == "0" ]] || [[ "$rc" == "69" ]]; then
  ok "restart --dry-run exits 0 or 69"
else
  err "restart --dry-run unexpected exit $rc"
fi

rm -rf "$STATUS_HOME"

echo ""
echo "Results: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
