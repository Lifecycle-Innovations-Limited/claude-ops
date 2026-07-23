#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PLUGIN_ROOT="$TMP/cache/2.38.4"
CONFIG_DIR="$TMP/config"
DATA_DIR="$TMP/data"
BIN_DIR="$TMP/bin"
RSYNC_LOG="$TMP/rsync.log"
SCRIPT="$PLUGIN_ROOT/bin/ops-post-update-migrate"

mkdir -p "$TMP/home" "$PLUGIN_ROOT/.claude-plugin" "$PLUGIN_ROOT/bin" "$CONFIG_DIR/plugins" "$DATA_DIR/.migrated" "$BIN_DIR"
printf '{"version":"test"}\n' > "$PLUGIN_ROOT/.claude-plugin/plugin.json"
touch "$DATA_DIR/.migrated/vtest"
cp "$ROOT/bin/ops-post-update-migrate" "$SCRIPT"

cat > "$BIN_DIR/rsync" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$RSYNC_LOG"
sleep 2
EOF
chmod +x "$BIN_DIR/rsync"

run_migrate() {
  HOME="$TMP/home" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  CLAUDE_CONFIG_DIR="$CONFIG_DIR" \
  CLAUDE_PLUGIN_DATA_DIR="$DATA_DIR" \
  RSYNC_LOG="$RSYNC_LOG" \
  PATH="$BIN_DIR:$PATH" \
    bash "$SCRIPT"
}

run_migrate &
first=$!
run_migrate &
second=$!
wait "$first" "$second"

count="$(wc -l < "$RSYNC_LOG" | tr -d ' ')"
if [[ "$count" != "1" ]]; then
  printf 'FAIL: expected one cache refresh, got %s\n' "$count" >&2
  exit 1
fi

printf 'PASS: concurrent migrations share one refresh\n'

: > "$RSYNC_LOG"
rm "$DATA_DIR/.migrated/vtest"
run_migrate

count="$(wc -l < "$RSYNC_LOG" | tr -d ' ')"
if [[ "$count" != "1" ]]; then
  printf 'FAIL: expected one first-run refresh, got %s\n' "$count" >&2
  exit 1
fi

printf 'PASS: first-time migration refreshes once\n'

if pgrep -f "^bash $SCRIPT$" >/dev/null; then
  printf 'FAIL: migration left a watchdog process running\n' >&2
  exit 1
fi

printf 'PASS: migration leaves no watchdog process\n'
