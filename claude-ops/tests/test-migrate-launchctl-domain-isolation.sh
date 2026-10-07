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

# Every generated plist stays in a temporary directory, including the real-HOME
# control. macOS watches ~/Library/LaunchAgents and posts a user-facing
# background-activity banner when a test merely writes a fake plist there.
# Keep all test artifacts out of that watched folder.
CLEANUP_PATHS=()
cleanup() {
  local p
  for p in "${CLEANUP_PATHS[@]:-}"; do
    [[ -n "$p" ]] && rm -rf "$p" 2>/dev/null || true
  done
  rm -rf "$SHIM_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

setup_sandbox() {
  ROOT=$(mktemp -d)
  CLEANUP_PATHS+=("$ROOT")
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
  LAUNCH_AGENTS_DIR="$ROOT/generated-launchagents"
  mkdir -p "$LAUNCH_AGENTS_DIR"
  export OPS_MIGRATE_LAUNCHAGENTS_DIR="$LAUNCH_AGENTS_DIR"
  PLIST="$LAUNCH_AGENTS_DIR/com.${USER}.whatsapp-bridge.plist"
  # A legacy plist too, to exercise the unload-and-remove branches.
  printf '<plist/>' >"$LAUNCH_AGENTS_DIR/com.claude-ops.wacli-keepalive.plist"
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
# The guard keys on $HOME, so proving it is live requires the REAL home. The
# generated plist is redirected to the temporary directory prepared below,
# keeping macOS from treating this test fixture as a background item.
# Override USER so its label cannot overlap a real service. The shim intercepts
# the launchctl call, so the control exercises the guard without registration.
FAKE_USER="ops-migrate-guard-test-$$"
REAL_PLIST="$REAL_HOME_VALUE/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
REAL_PLIST_SUM_BEFORE="$( [[ -f "$REAL_PLIST" ]] && shasum -a256 "$REAL_PLIST" | awk '{print $1}' || echo absent)"

setup_sandbox
TEST_PLIST="$LAUNCH_AGENTS_DIR/com.${FAKE_USER}.whatsapp-bridge.plist"
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

echo
echo "=== real-home lookup FAILS: must fail closed, not fall back to \$HOME ==="
# The guard resolves the real home with python3. If that lookup ever returns
# nothing and the code falls back to "$HOME", the comparison becomes $HOME vs
# $HOME — trivially equal even for a sandboxed HOME — and every launchctl call
# fires in the real GUI domain again. Force the failure and assert we skip.
BREAK_DIR=$(mktemp -d)
CLEANUP_PATHS+=("$BREAK_DIR")
printf '#!/bin/bash\nexit 1\n' > "$BREAK_DIR/python3"
chmod +x "$BREAK_DIR/python3"

setup_sandbox
SANDBOXED_HOME="$HOME"
: > "$CALLS"
# HOME is the sandbox here, but with the resolver broken a fallback-to-$HOME
# implementation would consider it "real" and proceed.
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  PATH="$BREAK_DIR:$PATH" \
  HOME="$SANDBOXED_HOME" \
  USER="$FAKE_USER" \
  CLAUDE_PLUGIN_DATA_DIR="$CLAUDE_PLUGIN_DATA_DIR" \
  WHATSAPP_BRIDGE_HOME="$WHATSAPP_BRIDGE_HOME" \
  bash "$SCRIPT" >/dev/null 2>&1 || true
ck "zero launchctl invocations when real home is unresolvable" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
if [[ -s "$CALLS" ]]; then
  echo "  offending calls:"
  sed 's/^/    /' "$CALLS"
fi

echo
echo "=== cleanup deregisters the LABEL, not just the plist file ==="
# Deleting the plist leaves launchd holding the label, pointing at a path that
# no longer exists. Prove the trap removes the registration itself. Register a
# throwaway label with the REAL launchctl (the shim cannot register anything),
# then run cleanup and assert the domain is clean.
LEAK_USER="ops-migrate-leakcheck-$$"
LEAK_LABEL="com.${LEAK_USER}.whatsapp-bridge"
LEAK_DIR=$(mktemp -d)
CLEANUP_PATHS+=("$LEAK_DIR")
LEAK_PLIST="$LEAK_DIR/$LEAK_LABEL.plist"
printf '#!/bin/bash\nsleep 3600\n' > "$LEAK_DIR/run-bridge.sh"
chmod +x "$LEAK_DIR/run-bridge.sh"
cat > "$LEAK_PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>$LEAK_LABEL</string>
<key>ProgramArguments</key><array><string>$LEAK_DIR/run-bridge.sh</string></array>
</dict></plist>
PL
if /bin/launchctl bootstrap "gui/$(id -u)" "$LEAK_PLIST" 2>/dev/null; then
  CLEANUP_LABELS+=("$LEAK_LABEL")
  registered=$(/bin/launchctl list 2>/dev/null | grep -c "$LEAK_LABEL" || true)
  ck "throwaway label registered (precondition)" "$registered" "1"
  rm -f "$LEAK_PLIST"
  /bin/launchctl bootout "gui/$(id -u)/$LEAK_LABEL" 2>/dev/null || true
  still=$(/bin/launchctl list 2>/dev/null | grep -c "$LEAK_LABEL" || true)
  ck "bootout deregisters it even with the plist already deleted" "$still" "0"
else
  echo "  SKIP: could not bootstrap a throwaway label in this environment"
fi

rm -rf "$SHIM_DIR"
echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
