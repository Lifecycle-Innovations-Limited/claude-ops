#!/usr/bin/env bash
# Regression guard: ops-post-update-migrate must never mutate the REAL launchd
# domain when it runs against a sandboxed $HOME.
#
# THE BUG THIS PREVENTS (2026-08-20, production incident)
# ------------------------------------------------------
# launchd is a per-USER global namespace and does NOT honour $HOME. The sentinel
# test sandboxes HOME with mktemp -d, but the migration's plist label is built
# from the REAL ${USER}, and `launchctl unload/load` therefore acted on the real
# gui/<uid> domain. Running the test suite re-pointed the live
# com.<user>.whatsapp-bridge job at a 12-byte `#!/bin/bash` stub inside
# /var/folders, SIGTERMed the production WhatsApp bridge, and left it dead:
#
#   launchd: booting out service: caller = launchctl<-bash<-bash...
#   launchctl list com.<user>.whatsapp-bridge
#     "Program" = "/var/folders/.../T/tmp.XXXX/bridge/run-bridge.sh"
#
# HOW THIS TEST WORKS
# -------------------
# It does NOT call launchctl for real. It shims `launchctl` onto $PATH so any
# invocation is recorded to a file, then asserts the recording is empty for a
# sandboxed HOME and non-empty for a real-HOME run. That keeps the guard honest
# (it observes the actual syscall surface) without touching the machine.
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

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SKIP: launchd domain isolation is macOS-only"
  exit 0
fi

# --- shim launchctl so nothing real is ever touched -------------------------
SHIM_DIR=$(mktemp -d)
CALLS="$SHIM_DIR/launchctl-calls.txt"
: > "$CALLS"
cat > "$SHIM_DIR/launchctl" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$CALLS"
exit 0
SHIM
chmod +x "$SHIM_DIR/launchctl"
export PATH="$SHIM_DIR:$PATH"

setup_sandbox() {
  ROOT=$(mktemp -d)
  export HOME="$ROOT/home"
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
  # wrapper present, so the migration takes the branch that loads a LaunchAgent
  printf '#!/bin/bash\n' >"$WHATSAPP_BRIDGE_HOME/run-bridge.sh"
  chmod +x "$WHATSAPP_BRIDGE_HOME/run-bridge.sh"
  PLIST="$HOME/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
  # a legacy plist too, to exercise the unload-and-remove branches
  printf '<plist/>' >"$HOME/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist"
}

run() { CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$SCRIPT" >/dev/null 2>&1 || true; }

REAL_HOME_VALUE="$(python3 -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')"

echo "=== sandboxed HOME must not touch the real launchd domain ==="
setup_sandbox
: > "$CALLS"
run
n_calls=$(wc -l < "$CALLS" | tr -d ' ')
ck "zero launchctl invocations" "$n_calls" "0"
ck "plist still written (file work not skipped)" "$([[ -f $PLIST ]] && echo yes || echo no)" "yes"
if [[ -s "$CALLS" ]]; then
  echo "  offending calls:"
  sed 's/^/    /' "$CALLS"
fi

echo
echo "=== the guard must not be dead code: real HOME still loads ==="
# The guard keys on $HOME, so proving it is live requires the REAL home. That
# makes the migration's destination path real too:
#   $HOME/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist
# With the real $USER that is the LIVE production plist, and this test would
# overwrite it with sandbox paths — reintroducing, from the guard itself, the
# exact corruption the guard exists to prevent.
#
# Override USER instead. The destination becomes a bogus label that launchd has
# never heard of, so the file is inert, while $HOME stays real and the guard's
# condition is genuinely exercised. The shim still intercepts the launchctl call.
FAKE_USER="ops-migrate-guard-test-$$"
REAL_PLIST="$REAL_HOME_VALUE/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
REAL_PLIST_SUM_BEFORE="$( [[ -f "$REAL_PLIST" ]] && shasum -a256 "$REAL_PLIST" | awk '{print $1}' || echo absent)"
TEST_PLIST="$REAL_HOME_VALUE/Library/LaunchAgents/com.${FAKE_USER}.whatsapp-bridge.plist"

setup_sandbox
: > "$CALLS"
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  HOME="$REAL_HOME_VALUE" \
  USER="$FAKE_USER" \
  CLAUDE_PLUGIN_DATA_DIR="$CLAUDE_PLUGIN_DATA_DIR" \
  WHATSAPP_BRIDGE_HOME="$WHATSAPP_BRIDGE_HOME" \
  bash "$SCRIPT" >/dev/null 2>&1 || true
rm -f "$TEST_PLIST"
n_real=$(wc -l < "$CALLS" | tr -d ' ')
if [[ "$n_real" -gt 0 ]]; then
  echo "  PASS: real HOME still invokes launchctl ($n_real call(s)) — guard is live, not dead code"
  PASS=$((PASS + 1))
else
  echo "  FAIL: real HOME made zero launchctl calls — the guard is unconditionally off"
  FAIL=$((FAIL + 1))
fi

# The whole point of this suite is that running it never damages the machine.
# Assert that, do not assume it.
REAL_PLIST_SUM_AFTER="$( [[ -f "$REAL_PLIST" ]] && shasum -a256 "$REAL_PLIST" | awk '{print $1}' || echo absent)"
ck "live production plist untouched by this test" "$REAL_PLIST_SUM_AFTER" "$REAL_PLIST_SUM_BEFORE"
ck "no stray test plist left behind" "$([[ -f $TEST_PLIST ]] && echo yes || echo no)" "no"

echo
echo "=== explicit opt-out env var also suppresses ==="
setup_sandbox
: > "$CALLS"
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  HOME="$REAL_HOME_VALUE" \
  USER="$FAKE_USER" \
  OPS_MIGRATE_NO_LAUNCHCTL=1 \
  CLAUDE_PLUGIN_DATA_DIR="$CLAUDE_PLUGIN_DATA_DIR" \
  WHATSAPP_BRIDGE_HOME="$WHATSAPP_BRIDGE_HOME" \
  bash "$SCRIPT" >/dev/null 2>&1 || true
rm -f "$TEST_PLIST"
ck "zero launchctl invocations with OPS_MIGRATE_NO_LAUNCHCTL=1" "$(wc -l < "$CALLS" | tr -d ' ')" "0"

rm -rf "$SHIM_DIR"
echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
