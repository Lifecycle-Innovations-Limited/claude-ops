#!/opt/homebrew/bin/bash
# End-to-end: run the real `ensure-current` against a fake HOME and assert it
# leaves a data-dir wrapper plist untouched, but still repairs a genuinely
# stale plugin-version path.
set -uo pipefail

MGR="$1"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

FAKE_HOME="$T/home"
DATA="$FAKE_HOME/.claude/plugins/data/ops-ops-marketplace"
NEWROOT="$FAKE_HOME/.claude/plugins/cache/ops-marketplace/ops/9.9.9"
OLDROOT="$FAKE_HOME/.claude/plugins/cache/ops-marketplace/ops/1.0.0"
AGENTS="$FAKE_HOME/Library/LaunchAgents"
PLIST="$AGENTS/com.claude-ops.daemon.plist"

mkdir -p "$DATA/bin" "$NEWROOT/scripts" "$OLDROOT/scripts" "$AGENTS"
printf '#!/bin/sh\n' > "$DATA/bin/ops-daemon.sh";       chmod 755 "$DATA/bin/ops-daemon.sh"
printf '#!/bin/sh\n' > "$NEWROOT/scripts/ops-daemon.sh"; chmod 755 "$NEWROOT/scripts/ops-daemon.sh"
printf '#!/bin/sh\n' > "$OLDROOT/scripts/ops-daemon.sh"; chmod 755 "$OLDROOT/scripts/ops-daemon.sh"
# The manager needs its own plist template to be able to rewrite.
cp "$(dirname "$MGR")/com.claude-ops.daemon.plist" "$NEWROOT/scripts/" 2>/dev/null || true

write_plist() {
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.claude-ops.daemon</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/bash</string>
		<string>$1</string>
	</array>
</dict>
</plist>
PLISTEOF
}

plist_target() {
  /usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" "$PLIST" 2>/dev/null
}

fails=0
check() {
  local desc="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    printf 'PASS  %s\n' "$desc"
  else
    printf 'FAIL  %s\n        want=%s\n         got=%s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}

# ── Case 1: plist points at the data-dir wrapper. Must be left alone. ────────
write_plist "$DATA/bin/ops-daemon.sh"
before="$(plist_target)"
HOME="$FAKE_HOME" CLAUDE_PLUGIN_DATA_DIR="$DATA" \
  /opt/homebrew/bin/bash "$MGR" ensure-current --plugin-root "$NEWROOT" --dry-run >"$T/out1" 2>&1
rc1=$?
after="$(plist_target)"
check "wrapper plist unchanged by ensure-current" "$before" "$after"
check "ensure-current exits 0 on wrapper"          "0"       "$rc1"
if grep -q "leaving it in place" "$T/out1"; then
  echo "PASS  logged the deliberate-override decision"
else
  echo "FAIL  expected 'leaving it in place' in output; got:"
  sed 's/^/        /' "$T/out1"
  fails=$((fails + 1))
fi

# ── Case 2: plist points at an OLD plugin version. Must still be repaired. ──
write_plist "$OLDROOT/scripts/ops-daemon.sh"
HOME="$FAKE_HOME" CLAUDE_PLUGIN_DATA_DIR="$DATA" \
  /opt/homebrew/bin/bash "$MGR" ensure-current --plugin-root "$NEWROOT" --dry-run >"$T/out2" 2>&1
if grep -q "stale version" "$T/out2"; then
  echo "PASS  genuine stale-version drift still detected"
else
  echo "FAIL  expected 'stale version' for old plugin path; got:"
  sed 's/^/        /' "$T/out2"
  fails=$((fails + 1))
fi

echo "--- $fails failure(s) ---"
exit $(( fails > 0 ? 1 : 0 ))
