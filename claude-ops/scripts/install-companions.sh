#!/usr/bin/env bash
# install-companions.sh — install and/or update companions declared in
# plugin-dependencies.json (same repo as ops).
#
# required=true companions are ALWAYS installed when missing and ALWAYS
# updated when updateWithOps is always/if-installed. They are essential to
# named ops commands (see essentialFor in the JSON). Do not prompt-to-skip
# them from /ops:setup — run this script instead.
#
# Usage:
#   bash scripts/install-companions.sh
#   bash scripts/install-companions.sh --update-only
#   bash scripts/install-companions.sh --required-only
#   bash scripts/install-companions.sh --status
#   bash scripts/install-companions.sh --dry-run
#   bash scripts/install-companions.sh --no-external
#
# Env:
#   CLAUDE_PLUGIN_ROOT
#   OPS_SKIP_COMPANIONS=1
#   GSTACK_REPO/DIR/BRANCH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DEPS_JSON="${PLUGIN_ROOT}/plugin-dependencies.json"
PLUGINS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins"

STATUS_ONLY=0
DRY_RUN=0
UPDATE_ONLY=0
REQUIRED_ONLY=0
NO_EXTERNAL=0
for arg in "$@"; do
	case "$arg" in
	--status) STATUS_ONLY=1 ;;
	--dry-run) DRY_RUN=1 ;;
	--update-only) UPDATE_ONLY=1 ;;
	--required-only) REQUIRED_ONLY=1 ;;
	--no-external) NO_EXTERNAL=1 ;;
	-h | --help)
		sed -n '2,28p' "$0"
		exit 0
		;;
	esac
done

if [[ "${OPS_SKIP_COMPANIONS:-0}" == "1" ]]; then
	echo "companions: skipped (OPS_SKIP_COMPANIONS=1)"
	exit 0
fi

if [[ ! -f "$DEPS_JSON" ]]; then
	echo "companions: no plugin-dependencies.json at $DEPS_JSON" >&2
	exit 0
fi

command -v jq >/dev/null 2>&1 || {
	echo "companions: jq required" >&2
	exit 1
}

expand_home() {
	local p="$1"
	p="${p//\$\{HOME\}/$HOME}"
	p="${p//\$HOME/$HOME}"
	printf '%s' "$p"
}

is_installed() {
	local name="$1" find_pat="$2" kind="$3" path_json="$4"
	if [[ -n "$path_json" && "$path_json" != "null" && "$path_json" != "" ]]; then
		local p
		while IFS= read -r p; do
			[[ -z "$p" || "$p" == "null" ]] && continue
			p="$(expand_home "$p")"
			if [[ -e "$p" ]]; then
				return 0
			fi
		done < <(echo "$path_json" | jq -r '.[]? // empty')
	fi
	# Cheap checks first. These answer most companions without touching the
	# filesystem tree, and every check here is an OR branch of the same
	# question, so ordering changes only speed, never the verdict.
	if [[ "$kind" == "skills-clone" ]]; then
		[[ -f "${HOME}/.claude/skills/${name}/SKILL.md" ]] && return 0
		[[ -f "${HOME}/.agents/skills/${name}/SKILL.md" ]] && return 0
	fi
	if [[ -f "$PLUGINS_DIR/installed_plugins.json" ]]; then
		jq -e --arg n "$name" '..|strings?|select(test($n))' "$PLUGINS_DIR/installed_plugins.json" >/dev/null 2>&1 && return 0
	fi
	# cache layout is cache/<marketplace>/<plugin>/<version>, so depth 3 is
	# enough; bounded + first-hit exit keeps this off the multi-second path.
	[[ -n "$(find -L "$PLUGINS_DIR/cache" -maxdepth 3 -type d -name "$name" -print -quit 2>/dev/null)" ]] && return 0

	# Last: the detect.find pattern walk, the only check that costs a tree scan.
	# -L so a symlinked skills/ dir is followed — boxes that keep
	# ~/.claude/skills on another volume symlink it, and without -L find never
	# descends, so every companion there reads as missing and each ops-update
	# retries an install that then fails.
	# Search named roots rather than all of ~/.claude, and stop at the first
	# hit: walking the whole home dir descends the transcript tree under
	# projects/ (tens of thousands of files), measured 6.4s per lookup there
	# vs 0.16s against a named root.
	if [[ -n "$find_pat" ]]; then
		local root
		for root in "$PLUGINS_DIR" "${HOME}/.claude/skills" "${HOME}/.claude/agents" \
			"${HOME}/.agents/skills" "${HOME}/.agents/agents"; do
			[[ -d "$root" ]] || continue
			if [[ -n "$(find -L "$root" -maxdepth 8 -path "$find_pat" -print -quit 2>/dev/null)" ]]; then
				return 0
			fi
		done
	fi
	return 1
}

run_cmd() {
	if [[ "$DRY_RUN" -eq 1 ]]; then
		echo "  [dry-run] $*"
		return 0
	fi
	eval "$@"
}

n_ok=0
n_skip=0
n_fail=0
n_required_missing=0

while IFS= read -r row; do
	name="$(echo "$row" | jq -r '.name')"
	kind="$(echo "$row" | jq -r '.kind // "claude-plugin"')"
	mkt="$(echo "$row" | jq -r '.marketplaceId // empty')"
	mkt_add="$(echo "$row" | jq -r '.marketplaceAdd // empty')"
	install_cli="$(echo "$row" | jq -r '.installCli // empty')"
	update_cli="$(echo "$row" | jq -r '.updateCli // empty')"
	install_script="$(echo "$row" | jq -r '.installScript // empty')"
	same_mp="$(echo "$row" | jq -r '.sameMarketplaceAsOps // false')"
	update_mode="$(echo "$row" | jq -r '.updateWithOps // "never"')"
	find_pat="$(echo "$row" | jq -r '.detect.find // empty')"
	path_json="$(echo "$row" | jq -c '.detect.pathExists // empty')"
	co_default="$(echo "$row" | jq -r '.coInstallDefault // false')"
	required="$(echo "$row" | jq -r '.required // false')"
	essential="$(echo "$row" | jq -r '.essentialFor // [] | join(", ")')"

	if [[ "$REQUIRED_ONLY" -eq 1 && "$required" != "true" ]]; then
		echo "skip $name (not required, --required-only)"
		n_skip=$((n_skip + 1))
		continue
	fi

	if [[ "$NO_EXTERNAL" -eq 1 && "$same_mp" != "true" && "$kind" != "skills-clone" && "$required" != "true" ]]; then
		echo "skip $name (external marketplace, --no-external)"
		n_skip=$((n_skip + 1))
		continue
	fi

	installed=0
	if is_installed "$name" "$find_pat" "$kind" "$path_json"; then
		installed=1
	fi

	if [[ "$STATUS_ONLY" -eq 1 ]]; then
		if [[ "$installed" -eq 1 ]]; then
			echo "$name: installed${required:+ (required)}"
		else
			if [[ "$required" == "true" ]]; then
				echo "$name: MISSING (required — essential for: ${essential:-see plugin-dependencies.json})"
				n_required_missing=$((n_required_missing + 1))
			else
				echo "$name: missing"
			fi
		fi
		continue
	fi

	if [[ "$update_mode" == "never" && "$required" != "true" ]]; then
		echo "skip $name (updateWithOps=never)"
		n_skip=$((n_skip + 1))
		continue
	fi

	if [[ "$installed" -eq 0 ]]; then
		if [[ "$required" != "true" && "$UPDATE_ONLY" -eq 1 ]]; then
			echo "skip $name (not installed, --update-only)"
			n_skip=$((n_skip + 1))
			continue
		fi
		if [[ "$required" != "true" && "$co_default" != "true" && "$update_mode" != "always" ]]; then
			echo "skip $name (not installed, coInstallDefault=false)"
			n_skip=$((n_skip + 1))
			continue
		fi

		echo "install $name …${required:+ [required]}${essential:+ — $essential}"
		if [[ -n "$install_script" && -f "$PLUGIN_ROOT/$install_script" ]]; then
			if run_cmd "bash \"$PLUGIN_ROOT/$install_script\""; then
				echo "ok: $name (script)"
				n_ok=$((n_ok + 1))
				continue
			fi
			if [[ "$required" == "true" ]]; then
				echo "fail: $name required install script failed" >&2
				n_fail=$((n_fail + 1))
				continue
			fi
		fi
		if [[ -n "$mkt_add" ]]; then
			run_cmd "claude plugin marketplace add \"$mkt_add\" >/dev/null 2>&1 || true"
		fi
		if [[ -n "$install_cli" ]]; then
			if run_cmd "$install_cli >/dev/null 2>&1"; then
				echo "ok: $name (install)"
				n_ok=$((n_ok + 1))
			else
				echo "fail: $name install" >&2
				n_fail=$((n_fail + 1))
			fi
		else
			echo "fail: $name no installCli/installScript" >&2
			n_fail=$((n_fail + 1))
		fi
		continue
	fi

	if [[ "$update_mode" == "never" ]]; then
		echo "skip $name update (updateWithOps=never, already installed)"
		n_skip=$((n_skip + 1))
		continue
	fi

	echo "update $name …"
	if [[ -n "$install_script" && -f "$PLUGIN_ROOT/$install_script" && ("$kind" == "skills-clone" || -z "$update_cli") ]]; then
		if run_cmd "bash \"$PLUGIN_ROOT/$install_script\" --update 2>/dev/null || bash \"$PLUGIN_ROOT/$install_script\""; then
			echo "ok: $name (script)"
			n_ok=$((n_ok + 1))
		else
			echo "warn: $name script update non-zero (non-fatal)" >&2
			n_fail=$((n_fail + 1))
		fi
		continue
	fi
	if [[ "$same_mp" != "true" && -n "$mkt" ]]; then
		run_cmd "claude plugin marketplace update \"$mkt\" >/dev/null 2>&1 || true"
	fi
	if [[ -n "$update_cli" ]]; then
		if run_cmd "$update_cli >/dev/null 2>&1"; then
			echo "ok: $name (update)"
			n_ok=$((n_ok + 1))
		else
			if [[ -n "$install_cli" ]] && run_cmd "$install_cli >/dev/null 2>&1"; then
				echo "ok: $name (reinstall fallback)"
				n_ok=$((n_ok + 1))
			else
				echo "warn: $name update non-zero (non-fatal)" >&2
				n_fail=$((n_fail + 1))
			fi
		fi
	else
		echo "skip $name (no updateCli)"
		n_skip=$((n_skip + 1))
	fi
done < <(jq -c '.companions[]' "$DEPS_JSON")

if [[ "$STATUS_ONLY" -eq 1 ]]; then
	if [[ "$n_required_missing" -gt 0 ]]; then
		echo "companions: ${n_required_missing} required missing" >&2
		exit 1
	fi
	exit 0
fi

echo "companions: ok=$n_ok skip=$n_skip fail=$n_fail"
exit 0
