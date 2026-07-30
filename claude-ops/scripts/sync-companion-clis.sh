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
	if rsync -a --delete --exclude=".git" "$src/" "$dst/" 2>/dev/null; then
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

sync_grok
sync_cursor
report_codex
