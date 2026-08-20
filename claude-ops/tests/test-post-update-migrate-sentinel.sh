#!/usr/bin/env bash
# Regression guard for the ops-post-update-migrate sentinel.
#
# The per-version sentinel ($DATA_DIR/.migrated/v<VERSION>) is stamped even when
# a migration only partially succeeds, and SessionStart exits early once it
# exists. A migration that SKIPS recoverable work therefore makes that skip
# permanent for the whole version unless it defers the stamp.
#
# Concretely: the whatsapp-bridge LaunchAgent install is skipped when
# run-bridge.sh is absent (installing an unsupervised bare-binary agent is what
# gets a WhatsApp account banned). Without the defer flag, a bridge dir that
# gains run-bridge.sh later would never get its LaunchAgent.
#
# Verified to FAIL against the pre-fix script before being trusted.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${1:-$TESTS_DIR/../bin/ops-post-update-migrate}"

PASS=0
FAIL=0

ck() {
  if [[ "$2" == "$3" ]]; then
    echo "  PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (want '$3', got '$2')"
    FAIL=$((FAIL + 1))
  fi
}

setup() {
  ROOT=$(mktemp -d)
  export HOME="$ROOT/home"
  # $USER feeds the plist label AND the launchd label. Leaving the real value
  # here means a sandboxed run still names the operator's live service, which is
  # how tests/test-migrate-launchctl-domain-isolation.sh's incident happened.
  # Keep the label fake so nothing this test writes can ever collide with a real
  # one, even if a future migration resolves paths differently.
  export USER="ops-migrate-sentinel-test-$$"
  mkdir -p "$HOME/Library/LaunchAgents"
  PLUGIN_ROOT="$ROOT/plugin"
  mkdir -p "$PLUGIN_ROOT/.claude-plugin" "$PLUGIN_ROOT/assets/launchagents"
  echo '{"version":"9.9.9-test"}' >"$PLUGIN_ROOT/.claude-plugin/plugin.json"
  cat >"$PLUGIN_ROOT/assets/launchagents/com.claude-ops.whatsapp-bridge.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.__USER__.whatsapp-bridge</string>
<key>ProgramArguments</key><array><string>__BRIDGE_WORKING_DIR__/run-bridge.sh</string></array>
</dict></plist>
PL
  export CLAUDE_PLUGIN_DATA_DIR="$ROOT/data"
  mkdir -p "$CLAUDE_PLUGIN_DATA_DIR"
  export WHATSAPP_BRIDGE_HOME="$ROOT/bridge"
  mkdir -p "$WHATSAPP_BRIDGE_HOME/logs"
  SENTINEL="$CLAUDE_PLUGIN_DATA_DIR/.migrated/v9.9.9-test"
  PLIST="$HOME/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
}

make_wrapper() {
  printf '#!/bin/bash\n' >"$WHATSAPP_BRIDGE_HOME/run-bridge.sh"
  chmod +x "$WHATSAPP_BRIDGE_HOME/run-bridge.sh"
}

run() { CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$SCRIPT" >/dev/null 2>&1 || true; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SKIP: LaunchAgent migration is macOS-only"
  exit 0
fi

echo "=== run-bridge.sh missing: skip must not be sticky ==="
setup
run
ck "plist not installed" "$([[ -f $PLIST ]] && echo yes || echo no)" "no"
ck "sentinel not stamped" "$([[ -f $SENTINEL ]] && echo yes || echo no)" "no"

echo
echo "=== wrapper appears later: next run installs ==="
make_wrapper
run
ck "plist installed on retry" "$([[ -f $PLIST ]] && echo yes || echo no)" "yes"
ck "sentinel stamped on retry" "$([[ -f $SENTINEL ]] && echo yes || echo no)" "yes"
if [[ -f "$PLIST" ]]; then
  if grep -q "run-bridge.sh" "$PLIST"; then
    echo "  PASS: plist supervises run-bridge.sh"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: plist does not reference run-bridge.sh"
    FAIL=$((FAIL + 1))
  fi
fi

echo
echo "=== wrapper present from the start ==="
setup
make_wrapper
run
ck "plist installed" "$([[ -f $PLIST ]] && echo yes || echo no)" "yes"
ck "sentinel stamped" "$([[ -f $SENTINEL ]] && echo yes || echo no)" "yes"

echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
