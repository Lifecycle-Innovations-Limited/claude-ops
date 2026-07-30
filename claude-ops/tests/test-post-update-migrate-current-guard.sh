#!/usr/bin/env bash
# Guards refresh_current_directory in bin/ops-post-update-migrate:
#   1. cache-GC bookkeeping (.orphaned_at, .in_use) never rides into current/
#   2. installed_plugins.json is rewritten atomically, keeping its mode
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
	printf 'FAIL: %s\n' "$1" >&2
	exit 1
}

# $1 = label, $2 = "rsync" | "nossync"
run_case() {
	local label="$1" mode="$2"
	local base="$TMP/$label"
	local plugin_root="$base/cache/ops-marketplace/ops/2.0.0"
	local current_dir="$base/cache/ops-marketplace/ops/current"
	local config_dir="$base/config"
	local data_dir="$base/data"
	local installed="$config_dir/plugins/installed_plugins.json"

	mkdir -p "$plugin_root/.claude-plugin" "$plugin_root/bin" "$plugin_root/.in_use" \
		"$current_dir" "$config_dir/plugins" "$data_dir/.migrated" "$base/home"

	printf '{"version":"test"}\n' >"$plugin_root/.claude-plugin/plugin.json"
	printf 'payload\n' >"$plugin_root/bin/marker-file"
	touch "$data_dir/.migrated/vtest"

	# Cache-GC bookkeeping the CLI writes into a version dir it no longer
	# recognises. Aged marker + a dead PID: exactly the state that makes the
	# next sweep delete immediately, with nothing holding the dir open.
	printf '1000000000000\n' >"$plugin_root/.orphaned_at"
	printf '{"pid":999999}\n' >"$plugin_root/.in_use/999999"

	# Pre-existing leak in current/, to prove we clean up as well as prevent.
	printf '1000000000000\n' >"$current_dir/.orphaned_at"

	# A live session that resolved current/ as its plugin root and registered
	# itself there. This registry is what stops the sweeper deleting current/
	# out from under it, so the refresh must not drop it.
	mkdir -p "$current_dir/.in_use"
	printf '{"pid":%s}\n' "$$" >"$current_dir/.in_use/$$"

	cat >"$installed" <<JSON
{
  "plugins": {
    "ops@ops-marketplace": [
      {
        "scope": "user",
        "installPath": "$plugin_root",
        "version": "2.0.0"
      }
    ],
    "other@marketplace": [
      {
        "scope": "user",
        "installPath": "/somewhere/else",
        "version": "1.0.0"
      }
    ]
  }
}
JSON
	chmod 600 "$installed"
	local inode_before
	inode_before="$(stat -c %i "$installed")"

	local path_override="$PATH"
	if [[ "$mode" == "nossync" ]]; then
		# Force the cp -rp fallback branch.
		mkdir -p "$base/bin"
		for exe in bash cp rm mkdir rmdir python3 date dirname find printf \
			sed cat ls chmod stat tr wc grep; do
			src="$(command -v "$exe" || true)"
			[[ -n "$src" ]] && ln -sf "$src" "$base/bin/$exe"
		done
		path_override="$base/bin"
	fi

	HOME="$base/home" \
		CLAUDE_PLUGIN_ROOT="$plugin_root" \
		CLAUDE_CONFIG_DIR="$config_dir" \
		CLAUDE_PLUGIN_DATA_DIR="$data_dir" \
		PATH="$path_override" \
		bash "$ROOT/bin/ops-post-update-migrate"

	# 1. real content copied through
	[[ -f "$current_dir/bin/marker-file" ]] ||
		fail "$label: current/ missing copied payload"

	# 2. GC bookkeeping must not be present in current/
	[[ ! -e "$current_dir/.orphaned_at" ]] ||
		fail "$label: .orphaned_at leaked into current/ — cache GC would delete the live plugin root"
	[[ -f "$current_dir/.in_use/$$" ]] ||
		fail "$label: dropped the live .in_use registration in current/ — the sweeper could then delete it under a running session"
	# rsync excludes .in_use outright. cp -rp has no exclude, so it merges the
	# version dir's dead PIDs in; harmless, the sweeper prunes those itself.
	if [[ "$mode" == "rsync" ]]; then
		[[ ! -e "$current_dir/.in_use/999999" ]] ||
			fail "$label: version dir's stale .in_use PID was copied into current/"
	fi

	# 3. installPath repointed, other plugins untouched, mode preserved
	python3 - "$installed" "$current_dir" <<'PY' || fail "$label: installed_plugins.json assertions failed"
import json, os, stat, sys
path, current = sys.argv[1], sys.argv[2]
with open(path) as f:
    d = json.load(f)
ops = d["plugins"]["ops@ops-marketplace"][0]
assert ops["installPath"] == current, f"installPath={ops['installPath']!r} want {current!r}"
assert ops["version"] == "2.0.0", "unrelated ops fields were dropped"
other = d["plugins"]["other@marketplace"][0]
assert other["installPath"] == "/somewhere/else", "unrelated plugin was rewritten"
mode = stat.S_IMODE(os.stat(path).st_mode)
assert mode == 0o600, f"mode widened to {oct(mode)}"
PY

	# 4. the rewrite swapped a new file in rather than truncating in place.
	#    os.replace() always lands a fresh inode; open(path, "w") reuses it.
	local inode_after
	inode_after="$(stat -c %i "$installed")"
	[[ "$inode_before" != "$inode_after" ]] ||
		fail "$label: installed_plugins.json rewritten in place (inode $inode_after unchanged) — not an atomic replace"

	# 5. no temp file left behind by the atomic rename
	leftovers="$(find "$config_dir/plugins" -maxdepth 1 -name '.installed_plugins.*.tmp' 2>/dev/null | wc -l | tr -d ' ')"
	[[ "$leftovers" == "0" ]] || fail "$label: atomic write left $leftovers temp file(s)"

	printf 'ok: %s\n' "$label"
}

run_case rsync-path rsync
run_case cp-fallback nossync

printf 'PASS: current/ stays free of cache-GC markers; installed_plugins.json rewritten atomically\n'
