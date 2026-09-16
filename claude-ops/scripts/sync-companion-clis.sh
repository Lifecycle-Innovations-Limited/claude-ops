#!/usr/bin/env bash
# sync-companion-clis.sh — propagate an ops plugin update to other CLIs on this
# box that support it, so a single `ops-update` run keeps every CLI current
# with no stale old-version copies left behind.
#
# Called as the last step of bin/ops-update, after the Claude Code plugin
# itself is updated. Safe to also run standalone.
#
# Coverage:
#   - Grok:   has a native `grok plugin update <name>` that updates the
#             installed plugin directory in place. We just call it.
#   - Cursor: has NO native command to refresh a plugin's materialized content
#             cache (only `cursor-agent plugin marketplace add/remove/update`).
#             `marketplace update` reports success but does NOT actually
#             re-fetch the underlying git clone — confirmed by testing: after
#             a new commit landed on origin/main, `update` left the clone
#             pinned to the old commit hash, while `remove` + `add` fetched
#             the new one immediately. So we always remove+add (never rely on
#             `update`), then rsync the resolved commit's plugin dir from the
#             catalogue clone into Cursor's content cache ourselves, and prune
#             any other commit-hash directories left over from prior versions.
#   - Codex:  needs nothing here. Its ops-* skills are symlinks straight into
#             Claude Code's own cache/.../ops/current/ directory, which
#             ops-post-update-migrate already keeps current.
#   - Hermes: added 2026-09-16. Hermes was the one harness with a real ops
#             plugin in this repo (hermes-plugin/) and NO path here, so
#             `ops-update` — including the auto-update that #986 now fires on
#             any skill call — left every Hermes install pinned at whatever
#             version it was first installed with, silently and forever.
#             Hermes plugins are per-home, so the target is
#             $HERMES_HOME/plugins/ops (default ~/.hermes), and HERMES_HOME
#             genuinely differs per machine, so it is never assumed.
#
# Every step below is best-effort and non-fatal: a CLI that isn't installed,
# or whose update fails, is logged and skipped — this must never block or
# fail the Claude Code upgrade it's called from.
#
# Usage: sync-companion-clis.sh [--dry-run]

set -uo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

c_grn=$'\033[1;32m'
c_ylw=$'\033[1;33m'
c_dim=$'\033[2m'
c_rst=$'\033[0m'
[[ -t 1 ]] || {
	c_grn=""
	c_ylw=""
	c_dim=""
	c_rst=""
}
ok() { printf '  %s✓%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_ylw" "$c_rst" "$*"; }
say() { printf '  %s\n' "$*"; }

MARKETPLACE_GIT_URL="https://github.com/Lifecycle-Innovations-Limited/claude-ops"

# scripts/ -> the plugin root. pwd -P, not pwd: ops-update runs this out of a
# versioned cache directory that is often reached through a `current` symlink,
# and a logical path would resolve hermes-plugin/ to whatever `current` pointed
# at when the shell started rather than to this script's own version.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# ── Grok ─────────────────────────────────────────────────────────────────
sync_grok() {
	command -v grok >/dev/null 2>&1 || {
		say "${c_dim}grok CLI not found (skipped)${c_rst}"
		return 0
	}
	compgen -G "$HOME/.grok/installed-plugins/claude-ops-*" >/dev/null 2>&1 ||
		{
			say "${c_dim}grok: ops plugin not installed (skipped)${c_rst}"
			return 0
		}

	if [[ "$DRY" -eq 1 ]]; then
		say "${c_dim}[dry-run] grok plugin update ops${c_rst}"
		return 0
	fi

	local out
	if out="$(grok plugin update ops 2>&1)"; then
		ok "grok: $out"
	else
		warn "grok: plugin update failed (non-fatal): $out"
	fi
}

# ── Cursor ───────────────────────────────────────────────────────────────
sync_cursor() {
	command -v cursor-agent >/dev/null 2>&1 || {
		say "${c_dim}cursor-agent CLI not found (skipped)${c_rst}"
		return 0
	}

	local mp_clone_root="$HOME/.cursor/plugins/marketplaces/github.com/lifecycle-innovations-limited/claude-ops"
	local cache_root="$HOME/.cursor/plugins/cache/ops-marketplace/ops"
	[[ -d "$HOME/.cursor/plugins" ]] || {
		say "${c_dim}cursor: no ~/.cursor/plugins (skipped)${c_rst}"
		return 0
	}

	if [[ "$DRY" -eq 1 ]]; then
		say "${c_dim}[dry-run] cursor-agent plugin marketplace remove/add ops-marketplace (update is a no-op, proven stale)${c_rst}"
		say "${c_dim}[dry-run] rsync resolved commit dir -> $cache_root/<hash>, prune old hashes${c_rst}"
		return 0
	fi

	# `marketplace update` is a proven no-op against the underlying clone —
	# always force a fresh fetch via remove+add instead.
	cursor-agent plugin marketplace remove ops-marketplace >/dev/null 2>&1 || true
	local out
	if ! out="$(cursor-agent plugin marketplace add "$MARKETPLACE_GIT_URL" 2>&1)"; then
		warn "cursor: marketplace re-add failed (non-fatal): $out"
		return 0
	fi
	ok "cursor: catalogue re-added ($out)"

	[[ -d "$mp_clone_root" ]] || {
		warn "cursor: no catalogue clone at $mp_clone_root (non-fatal)"
		return 0
	}
	local clone_dir hash src dst
	clone_dir="$(find "$mp_clone_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"
	[[ -n "$clone_dir" ]] || {
		warn "cursor: no commit dir found under $mp_clone_root (non-fatal)"
		return 0
	}
	hash="$(basename "$clone_dir")"
	src="$clone_dir/claude-ops"
	[[ -d "$src" ]] || {
		warn "cursor: expected plugin source $src missing (non-fatal)"
		return 0
	}

	mkdir -p "$cache_root"
	dst="$cache_root/$hash"
	mkdir -p "$dst"
	# --checksum for the same reason as the Hermes sync below: rsync's default
	# size+mtime quick check silently skips a same-size file written in the
	# same second, and exits 0 while doing it. Cursor's cache is keyed by
	# commit hash so this bites less often, but a same-size edit between two
	# commits would still land as a no-op that reports success.
	if rsync -a --delete --checksum --exclude=".git" "$src/" "$dst/" 2>/dev/null; then
		ok "cursor: content cache synced -> $hash"
	else
		warn "cursor: rsync to $dst failed (non-fatal)"
		return 0
	fi

	local pruned=0
	for d in "$cache_root"/*/; do
		[[ -d "$d" ]] || continue
		local v
		v="$(basename "$d")"
		[[ "$v" == "$hash" ]] && continue
		rm -rf "$d"
		ok "cursor: pruned old cache $v"
		pruned=$((pruned + 1))
	done
	[[ "$pruned" -eq 0 ]] && say "${c_dim}cursor: no old cache versions to prune${c_rst}"
}

# ── Codex ────────────────────────────────────────────────────────────────
# No-op by design: ~/.codex/skills/ops* are symlinks into Claude Code's own
# cache/.../ops/current/, already kept fresh by ops-post-update-migrate.
report_codex() {
	local link="$HOME/.codex/skills/ops"
	if [[ -L "$link" ]]; then
		say "${c_dim}codex: ops symlinked into Claude Code's current/ (no action needed)${c_rst}"
	else
		say "${c_dim}codex: no ops skill symlink found (nothing to do)${c_rst}"
	fi
}

# ── Hermes ───────────────────────────────────────────────────────────────
# Hermes has no plugin-manager command to call, so this copies the freshly
# updated hermes-plugin/ out of THIS script's own plugin root. That root is
# already the new version: ops-update swaps the cache and then runs the new
# copy of this script, so $PLUGIN_ROOT/hermes-plugin is what we just installed.
sync_hermes() {
	local hermes_home="${HERMES_HOME:-$HOME/.hermes}"
	local src="$PLUGIN_ROOT/hermes-plugin"
	local dst="$hermes_home/plugins/ops"

	[[ -d "$hermes_home/plugins" ]] || {
		say "${c_dim}hermes: no $hermes_home/plugins (skipped)${c_rst}"
		return 0
	}
	[[ -d "$src" ]] || {
		warn "hermes: no hermes-plugin/ in $PLUGIN_ROOT (skipped)"
		return 0
	}

	# A SYMLINK is a developer pointing Hermes at a live checkout. rsyncing
	# over it would either clobber their working tree or replace the link with
	# a stale copy — and in both cases they would stop getting their own edits.
	# Same reasoning as Codex: something else already keeps it current.
	if [[ -L "$dst" ]]; then
		say "${c_dim}hermes: ops is a symlink to a live checkout (no action needed)${c_rst}"
		return 0
	fi

	if [[ "$DRY" -eq 1 ]]; then
		say "${c_dim}[dry-run] rsync $src/ -> $dst/${c_rst}"
		return 0
	fi

	mkdir -p "$dst" 2>/dev/null || {
		warn "hermes: cannot create $dst (skipped)"
		return 0
	}
	# --delete so a file dropped upstream does not linger and keep being
	# loaded. __pycache__ is excluded: it is build output, and a stale .pyc
	# next to a newer .py is exactly how an "updated" plugin runs old code.
	#
	# --checksum is NOT optional here, and this is not paranoia. rsync's
	# default quick check is size + mtime, and macOS ships openrsync, which
	# applies it strictly: a file whose size is unchanged and whose mtime lands
	# in the same second is skipped, and rsync still exits 0. A version bump
	# from x.y.19 to x.y.20 is byte-identical in LENGTH, so the single most
	# likely real-world change to plugin.yaml is exactly the one the quick
	# check cannot see — the sync would report success and copy nothing.
	# Proven against /usr/bin/rsync (openrsync protocol 29). These directories
	# are a handful of small files, so hashing them costs nothing.
	if rsync -a --delete --checksum --exclude '__pycache__' "$src/" "$dst/" 2>/dev/null; then
		local v
		v="$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' \
			"$dst/plugin.yaml" 2>/dev/null | head -1)"
		ok "hermes: ops plugin synced${v:+ (v$v)}"
	else
		warn "hermes: rsync into $dst failed (skipped)"
	fi
}

sync_grok
sync_cursor
report_codex
sync_hermes
