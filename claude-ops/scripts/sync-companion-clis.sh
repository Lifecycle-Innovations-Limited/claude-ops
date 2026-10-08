#!/usr/bin/env bash
# sync-companion-clis.sh — propagate an ops plugin update to the other CLIs on
# this box (Grok, Cursor, Codex, Hermes) and report, per target, what state each
# one is actually in afterwards.
#
# Called as step 10 of bin/ops-update, after the Claude Code plugin itself is
# updated. Safe to run standalone.
#
# Contract (approved skill-parity plan, decision ENG-3):
#   - Every selected target is processed even when an earlier one fails.
#   - A failed target keeps its previous working registration.
#   - Each target gets one record: status (lib/parity/status.json), problem,
#     cause, smallest next step. With --record FILE the records are appended
#     there as JSON lines; ops-update reads them for its summary.
#   - Exit 0 only when every target is clean. Any drift/gap/failure exits 3
#     ("partial"); only-LOCKED exits 6; bad arguments exit 4. ops-update keeps
#     the Claude step it already finished and ends "partial" itself.
#
# Per host:
#   - Grok:   native `grok plugin update ops`, then a byte check of the dir its
#             registry.json names. Update that did not land = APPLY_FAILED.
#   - Cursor: no automatic apply. Its CLI has no add-before-remove route and no
#             state naming the loaded commit, so the old remove+add+prune could
#             lose the working registration. Already byte-identical = MATCH;
#             otherwise UNSUPPORTED_SAFE_APPLY with the operator procedure in
#             docs/skill-parity.md#cursor-operator-procedure.
#   - Codex:  check only — every shipped skill, not just the `ops` link. Fixes
#             go through `claude-ops-installer install --agents codex`.
#   - Hermes: staged copy of hermes-plugin/ plus the skill tree into
#             $HERMES_HOME/plugins/ops (HERMES_HOME differs per machine and is
#             never assumed), with an ownership manifest (.ops-manifest):
#               stage -> validate -> rename-swap -> prune
#             Only manifest-owned, unmodified files are ever replaced or
#             removed. A user file survives; a user file or a locally edited
#             OPS file at a path the release ships is OWNERSHIP_CONFLICT and
#             nothing changes. A symlink to a developer checkout is DEV_SOURCE
#             and is left untouched.
#
# One writer per target root: a mkdir lock under
# ${XDG_STATE_HOME:-~/.local/state}/claude-ops/locks, shared with the installer
# and readable by the parity check (LOCKED).
#
# Usage: sync-companion-clis.sh [--dry-run] [--host grok,cursor,codex,hermes]
#                               [--record FILE] [--print-status-table]

set -uo pipefail

DRY=0
HOSTS="grok,cursor,codex,hermes"
RECORD=""
PRINT_TABLE=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--dry-run) DRY=1; shift ;;
	--host)
		[[ -n "${2:-}" ]] || { echo "sync-companion-clis: --host needs a value" >&2; exit 4; }
		HOSTS="$2"; shift 2 ;;
	--record)
		[[ -n "${2:-}" ]] || { echo "sync-companion-clis: --record needs a value" >&2; exit 4; }
		RECORD="$2"; shift 2 ;;
	--print-status-table) PRINT_TABLE=1; shift ;;
	-h | --help) sed -n '2,/^set -uo pipefail/p' "$0" | sed '$d'; exit 0 ;;
	*) echo "sync-companion-clis: unknown argument '$1'" >&2; exit 4 ;;
	esac
done

# ── shared status table (must equal lib/parity/status.json; tested) ────────
ALL_STATUSES="MATCH EXCEPTION NOT_CONFIGURED APPLIED DRIFT DEV_SOURCE MISSING_REQUIRED MISSING_REFERENCE UNREADABLE STALE_SOURCE STALE_SCAN AMBIGUOUS_CONSUMER NOT_CHECKED MISSING_COMMAND UNSUPPORTED_SAFE_APPLY OWNERSHIP_CONFLICT APPLY_FAILED LOCKED"
status_class() {
	case "$1" in
	MATCH | EXCEPTION | NOT_CONFIGURED | APPLIED) echo clean ;;
	DRIFT | DEV_SOURCE) echo drift ;;
	MISSING_REQUIRED | MISSING_REFERENCE | UNREADABLE | STALE_SOURCE | STALE_SCAN | AMBIGUOUS_CONSUMER | NOT_CHECKED | MISSING_COMMAND | UNSUPPORTED_SAFE_APPLY) echo gap ;;
	OWNERSHIP_CONFLICT | APPLY_FAILED) echo partial ;;
	LOCKED) echo locked ;;
	*) echo unknown ;;
	esac
}
exit_code_for() {
	case "$1" in
	clean) echo 0 ;; drift) echo 1 ;; gap) echo 2 ;; partial) echo 3 ;;
	usage) echo 4 ;; environment) echo 5 ;; locked) echo 6 ;;
	esac
}
if [[ "$PRINT_TABLE" -eq 1 ]]; then
	for s in $ALL_STATUSES; do echo "status $s $(status_class "$s")"; done
	for c in clean drift gap partial usage environment locked; do echo "exit $c $(exit_code_for "$c")"; done
	exit 0
fi

for h in ${HOSTS//,/ }; do
	case "$h" in grok | cursor | codex | hermes) ;; *)
		echo "sync-companion-clis: unknown host '$h' (known: grok,cursor,codex,hermes)" >&2
		exit 4
		;;
	esac
done
selected() { [[ ",$HOSTS," == *",$1,"* ]]; }

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
say() { printf '  %s\n' "$*"; }

# scripts/ -> the plugin root. pwd -P, not pwd: ops-update runs this out of a
# versioned cache directory that is often reached through a `current` symlink,
# and a logical path would resolve hermes-plugin/ to whatever `current` pointed
# at when the shell started rather than to this script's own version.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHECK_MJS="$PLUGIN_ROOT/lib/parity/check.mjs"
DOCS="docs/skill-parity.md"

N_BAD=0
N_LOCKED=0
N_TOTAL=0

json_str() {
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\n'/ }"
	s="${s//$'\t'/ }"
	s="${s//$'\r'/ }"
	printf '"%s"' "$s"
}

# record <target> <STATUS> <detail> [cause] [next]
record() {
	local target="$1" status="$2" detail="$3" cause="${4:-}" next="${5:-}"
	local cls anchor
	cls="$(status_class "$status")"
	anchor="$DOCS#status-$(printf '%s' "$status" | tr 'A-Z_' 'a-z-')"
	N_TOTAL=$((N_TOTAL + 1))
	case "$cls" in
	clean) printf '  %s✓%s %-7s %-22s %s\n' "$c_grn" "$c_rst" "$target" "$status" "$detail" ;;
	locked)
		N_LOCKED=$((N_LOCKED + 1))
		printf '  %s!%s %-7s %-22s %s\n' "$c_ylw" "$c_rst" "$target" "$status" "$detail"
		;;
	*)
		N_BAD=$((N_BAD + 1))
		printf '  %s!%s %-7s %-22s %s\n' "$c_ylw" "$c_rst" "$target" "$status" "$detail"
		;;
	esac
	if [[ "$cls" != "clean" ]]; then
		[[ -n "$cause" ]] && say "          cause: $cause"
		[[ -n "$next" ]] && say "          next:  $next"
		say "          docs:  $anchor"
	fi
	if [[ -n "$RECORD" ]]; then
		printf '{"target":%s,"status":%s,"class":%s,"detail":%s,"cause":%s,"next":%s,"docs":%s}\n' \
			"$(json_str "$target")" "$(json_str "$status")" "$(json_str "$cls")" \
			"$(json_str "$detail")" "$(json_str "${cause:-unknown}")" \
			"$(json_str "$next")" "$(json_str "$anchor")" >>"$RECORD"
	fi
}

# ── locks (same key function as lib/parity/check.mjs lockKey) ─────────────
LOCK_BASE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-ops/locks"
HELD_LOCKS=""
LOCK_HOLDER=""
lock_key() { printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'; }
lock_path() { printf '%s/%s.lock' "$LOCK_BASE" "$(lock_key "$1")"; }
lock_acquire() {
	local d pid
	d="$(lock_path "$1")"
	mkdir -p "$LOCK_BASE" 2>/dev/null || return 2
	if mkdir "$d" 2>/dev/null; then
		echo $$ >"$d/pid"
		HELD_LOCKS="$HELD_LOCKS $d"
		return 0
	fi
	pid="$(cat "$d/pid" 2>/dev/null || true)"
	if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
		rm -rf "$d"
		if mkdir "$d" 2>/dev/null; then
			echo $$ >"$d/pid"
			HELD_LOCKS="$HELD_LOCKS $d"
			return 0
		fi
	fi
	LOCK_HOLDER="${pid:-unknown}"
	return 1
}
lock_release() {
	local d
	d="$(lock_path "$1")"
	rm -rf "$d"
	HELD_LOCKS="${HELD_LOCKS// $d/}"
}
release_all() {
	local d
	for d in $HELD_LOCKS; do rm -rf "$d"; done
}
trap release_all EXIT

# ── hashing ────────────────────────────────────────────────────────────────
# openssl first: perl's shasum can take seconds to start on macOS.
if command -v openssl >/dev/null 2>&1 && printf x | openssl dgst -sha256 -r >/dev/null 2>&1; then
	SHA_CMD="openssl dgst -sha256 -r"
elif command -v shasum >/dev/null 2>&1; then
	SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
	SHA_CMD="sha256sum"
else
	SHA_CMD=""
fi
# list_files <dir> -> relative file paths, sorted, excluding what the parity
# check excludes (.git, __pycache__, .ops-manifest).
list_files() {
	(cd "$1" && find . \( -name __pycache__ -o -name .git \) -prune -o \
		\( -type f -o -type l \) ! -name .ops-manifest -print 2>/dev/null) |
		sed 's|^\./||' | LC_ALL=C sort
}
# hash_files <dir> <listfile> -> "hash  rel" lines in list order
hash_files() {
	[[ -s "$2" ]] || return 0
	(cd "$1" && tr '\n' '\0' <"$2" | xargs -0 $SHA_CMD) | sed 's/^\([0-9a-f]*\) [ *]/\1  /'
}

# ── node-backed read-only check of one host ───────────────────────────────
# Prints: status<TAB>root<TAB>problem<TAB>cause<TAB>next
node_check() {
	command -v node >/dev/null 2>&1 || return 1
	[[ -f "$CHECK_MJS" ]] || return 1
	OPS_CHECK_MJS="$CHECK_MJS" OPS_CHECK_SOURCE="$PLUGIN_ROOT" OPS_CHECK_HOST="$1" \
		node --input-type=module -e '
const { checkTargets } = await import(process.env.OPS_CHECK_MJS);
const h = process.env.OPS_CHECK_HOST;
const r = checkTargets({ source: process.env.OPS_CHECK_SOURCE, hosts: [h] });
const x = r.records.find((q) => q.target === h) || r.records[0];
const e = x.error || {};
const clean = (s) => String(s || "").replace(/[\t\n]/g, " ");
console.log([x.status, x.observed?.path || x.observed?.probe || "", e.problem, e.cause, e.next].map(clean).join("\t"));
' 2>/dev/null
}
split_check() {
	IFS=$'\t' read -r CK_STATUS CK_ROOT CK_PROBLEM CK_CAUSE CK_NEXT <<<"$1"
}

# ── Grok ───────────────────────────────────────────────────────────────────
sync_grok() {
	command -v grok >/dev/null 2>&1 || {
		record grok NOT_CONFIGURED "grok CLI not found"
		return 0
	}
	local res=""
	res="$(node_check grok)" || res=""
	if [[ -n "$res" ]]; then
		split_check "$res"
		case "$CK_STATUS" in
		NOT_CONFIGURED | MISSING_REQUIRED | AMBIGUOUS_CONSUMER | UNREADABLE | LOCKED)
			record grok "$CK_STATUS" "${CK_PROBLEM:-ops plugin not installed}" "$CK_CAUSE" "$CK_NEXT"
			return 0
			;;
		esac
	elif ! compgen -G "$HOME/.grok/installed-plugins/claude-ops-*" >/dev/null 2>&1; then
		record grok NOT_CONFIGURED "ops plugin not installed"
		return 0
	fi
	if [[ "$DRY" -eq 1 ]]; then
		say "${c_dim}[dry-run] grok plugin update ops, then byte-check the registry's plugin dir${c_rst}"
		return 0
	fi
	local root="${CK_ROOT:-$HOME/.grok/installed-plugins}" out
	if ! lock_acquire "$root"; then
		record grok LOCKED "another OPS run is applying" "lock held by pid $LOCK_HOLDER" "rerun when it finishes"
		return 0
	fi
	if ! out="$(grok plugin update ops 2>&1)"; then
		lock_release "$root"
		record grok APPLY_FAILED "grok plugin update failed" "$out" "run \`grok plugin update ops\` by hand and read its error"
		return 0
	fi
	lock_release "$root"
	res="$(node_check grok)" || {
		record grok MISSING_COMMAND "update ran but node is not available to verify it" "node not on PATH" "install Node >= 18, then run \`ops-update --check\`"
		return 0
	}
	split_check "$res"
	if [[ "$CK_STATUS" == "MATCH" ]]; then
		record grok APPLIED "grok plugin update verified byte-identical"
	else
		record grok APPLY_FAILED "native update ran but the loaded dir is $CK_STATUS" "${CK_PROBLEM}" "${CK_NEXT}"
	fi
}

# ── Cursor ─────────────────────────────────────────────────────────────────
sync_cursor() {
	command -v cursor-agent >/dev/null 2>&1 || {
		record cursor NOT_CONFIGURED "cursor-agent CLI not found"
		return 0
	}
	local res=""
	res="$(node_check cursor)" || res=""
	if [[ -n "$res" ]]; then
		split_check "$res"
		case "$CK_STATUS" in
		MATCH) record cursor MATCH "already byte-identical to this release; nothing to apply" ;;
		NOT_CONFIGURED | MISSING_REQUIRED | LOCKED) record cursor "$CK_STATUS" "${CK_PROBLEM:-no ops cache}" "$CK_CAUSE" "$CK_NEXT" ;;
		*) record cursor UNSUPPORTED_SAFE_APPLY "not updated automatically (check: $CK_STATUS)" \
			"no proven add-before-remove route; ${CK_PROBLEM}" \
			"follow $DOCS#cursor-operator-procedure; the previous registration was kept" ;;
		esac
		return 0
	fi
	[[ -d "$HOME/.cursor/plugins/cache/ops-marketplace/ops" ]] || {
		record cursor NOT_CONFIGURED "no ops cache under ~/.cursor/plugins"
		return 0
	}
	record cursor UNSUPPORTED_SAFE_APPLY "not updated automatically and not verified" "node not available for the byte check" \
		"follow $DOCS#cursor-operator-procedure; the previous registration was kept"
}

# ── Codex ──────────────────────────────────────────────────────────────────
report_codex() {
	local res=""
	res="$(node_check codex)" || res=""
	if [[ -n "$res" ]]; then
		split_check "$res"
		record codex "$CK_STATUS" "${CK_PROBLEM:-every shipped skill checked}" "$CK_CAUSE" "$CK_NEXT"
		return 0
	fi
	if [[ -d "$HOME/.codex/skills" ]] && [[ -e "$HOME/.codex/skills/ops" ]]; then
		record codex MISSING_COMMAND "cannot check every codex skill without node" "node not on PATH" "install Node >= 18, then run \`ops-update --check\`"
	else
		record codex NOT_CONFIGURED "no ops skills under ~/.codex/skills"
	fi
}

# ── Hermes ─────────────────────────────────────────────────────────────────
hermes_not_configured() {
	local res=""
	res="$(node_check hermes)" || res=""
	if [[ -n "$res" ]]; then
		split_check "$res"
		if [[ "$CK_STATUS" == "MISSING_REQUIRED" ]]; then
			record hermes MISSING_REQUIRED "$1" "$CK_CAUSE" "$CK_NEXT"
			return 0
		fi
	fi
	record hermes NOT_CONFIGURED "$1"
}

sync_hermes() {
	local hermes_home="${HERMES_HOME:-$HOME/.hermes}"
	local src="$PLUGIN_ROOT/hermes-plugin"
	local dst="$hermes_home/plugins/ops"
	# Staging lives outside plugins/ so Hermes never sees a half-built plugin
	# dir, and on the same filesystem so the swap is a rename.
	local work="$hermes_home/.ops-sync"

	[[ -d "$hermes_home/plugins" ]] || {
		hermes_not_configured "no $hermes_home/plugins"
		return 0
	}
	[[ -d "$src" && -d "$PLUGIN_ROOT/skills" ]] || {
		record hermes MISSING_REFERENCE "no hermes-plugin/ or skills/ in $PLUGIN_ROOT" "this plugin root ships no Hermes plugin" "reinstall the release; the Hermes install was left untouched"
		return 0
	}

	# A rename-swap interrupted between its two renames leaves no dst and a
	# previous copy in the work dir: put it back before anything else.
	if [[ ! -e "$dst" && ! -L "$dst" ]]; then
		local prev
		prev="$(ls -1d "$work"/prev.* 2>/dev/null | LC_ALL=C sort | tail -1)"
		if [[ -n "$prev" && "$DRY" -eq 0 ]]; then
			mv "$prev" "$dst" && say "hermes: restored the previous registration left by an interrupted swap"
		fi
	fi

	if [[ -L "$dst" ]]; then
		local real srcreal top sha
		real="$(cd -P "$dst" 2>/dev/null && pwd)"
		srcreal="$(cd -P "$src" && pwd)"
		if [[ -z "$real" ]]; then
			record hermes UNREADABLE "broken symlink at $dst" "link target is gone" "repoint or remove the link yourself"
		elif [[ "$real" == "$srcreal" ]]; then
			record hermes MATCH "symlink to this release's hermes-plugin/"
		else
			top=""
			[[ -e "$real/.git" ]] && top="$real"
			[[ -z "$top" && -e "$real/../.git" ]] && top="$real/.."
			[[ -z "$top" && -e "$real/../../.git" ]] && top="$real/../.."
			if [[ -n "$top" ]]; then
				sha="$(git -C "$top" rev-parse HEAD 2>/dev/null || echo unknown)"
				record hermes DEV_SOURCE "symlink to a developer checkout, left untouched: $real @ ${sha:0:12}" \
					"symlink into a git checkout that is not this release" \
					"intended for development; to move to the release see $DOCS#migration-and-rollback"
			else
				record hermes DRIFT "symlink to another directory: $real" "not this release's hermes-plugin/" "see $DOCS#migration-and-rollback"
			fi
		fi
		return 0
	fi
	if [[ -e "$dst" && ! -d "$dst" ]]; then
		record hermes OWNERSHIP_CONFLICT "$dst is a file, not a plugin dir; left untouched" "not created by OPS" "move it aside yourself, then rerun"
		return 0
	fi
	[[ -n "$SHA_CMD" ]] || {
		record hermes MISSING_COMMAND "no sha256 tool (shasum or sha256sum)" "cannot verify ownership" "install coreutils or perl shasum"
		return 0
	}
	if [[ "$DRY" -eq 1 ]]; then
		say "${c_dim}[dry-run] hermes: stage $src + skills/ -> $dst (manifest-owned files only)${c_rst}"
		return 0
	fi
	if ! lock_acquire "$dst"; then
		if [[ $? -eq 2 ]]; then
			record hermes APPLY_FAILED "cannot create the lock dir" "$LOCK_BASE not writable" "fix permissions on $LOCK_BASE"
		else
			record hermes LOCKED "another OPS run is applying" "lock held by pid $LOCK_HOLDER" "rerun when it finishes"
		fi
		return 0
	fi
	hermes_apply "$src" "$dst" "$work"
	lock_release "$dst"
}

hermes_apply() {
	local src="$1" dst="$2" work="$3"
	# Hash lists live in the system temp dir: a run that turns out to be a
	# no-op must not touch anything under HERMES_HOME.
	local t
	t="$(mktemp -d "${TMPDIR:-/tmp}/ops-hermes-sync.XXXXXX")" || {
		record hermes APPLY_FAILED "cannot create a temp dir in $work" "unknown" "check free space and permissions"
		return 0
	}
	# Expected tree: hermes-plugin/ files at the root + the skill tree under skills/.
	local exp="$t/expected" plist="$t/plist" slist="$t/slist"
	list_files "$src" >"$plist"
	list_files "$PLUGIN_ROOT/skills" >"$slist"
	{
		hash_files "$src" "$plist"
		hash_files "$PLUGIN_ROOT/skills" "$slist" | sed 's/^\([0-9a-f]*\)  /\1  skills\//'
	} | LC_ALL=C sort -k2 >"$exp"

	local version
	version="$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$src/plugin.yaml" 2>/dev/null | head -1)"

	local cur="$t/current" cls="$t/classified" keep="$t/keep"
	local conflicts="" prune=0 kept=0 legacy=0
	: >"$keep"
	if [[ -d "$dst" ]]; then
		local clist="$t/clist" old="$dst/.ops-manifest"
		list_files "$dst" >"$clist"
		hash_files "$dst" "$clist" | LC_ALL=C sort -k2 >"$cur"
		# Idempotent: already exactly the release and its manifest -> no writes.
		if [[ -f "$old" ]] && cmp -s "$old" "$exp" &&
			[[ -z "$(LC_ALL=C comm -23 <(LC_ALL=C sort "$exp") <(LC_ALL=C sort "$cur"))" ]]; then
			rm -rf "$t"
			record hermes MATCH "already current${version:+ (v$version)}; no writes"
			return 0
		fi
		[[ -f "$old" ]] || {
			legacy=1
			old=/dev/null
		}
		# Classify every file now in dst ("hash  path" lines, path from col 67):
		#   release path, same bytes as release ......... nothing to do
		#   release path, pre-manifest install ........... adopt (legacy)
		#   release path, unmodified manifest-owned ...... replace
		#   release path, edited or not in manifest ...... C (conflict)
		#   not shipped, unmodified manifest-owned ....... P (prune)
		#   not shipped, anything else ................... K (keep: user file)
		awk -v legacy="$legacy" '
			FNR == 1 { f++ }
			{ h = substr($0, 1, 64); p = substr($0, 67) }
			f == 1 { newh[p] = h; next }
			f == 2 { oldh[p] = h; next }
			(p in newh) {
				if (h == newh[p] || legacy == 1) next
				if ((p in oldh) && h == oldh[p]) next
				print "C " p ((p in oldh) ? " (edited)" : " (user file)")
				next
			}
			{ if ((p in oldh) && h == oldh[p]) print "P " p; else print "K " p }
		' "$exp" "$old" "$cur" >"$cls"
		# awk sees an empty manifest as no file at all: keep the file counter honest.
		if [[ ! -s "$old" ]]; then
			awk -v legacy=1 '
				FNR == 1 { f++ }
				{ h = substr($0, 1, 64); p = substr($0, 67) }
				f == 1 { newh[p] = h; next }
				(p in newh) { next }
				{ print "K " p }
			' "$exp" "$cur" >"$cls"
		fi
		conflicts="$(grep '^C ' "$cls" | cut -c3- | head -5 | tr '\n' ';')"
		grep '^K ' "$cls" | cut -c3- >"$keep"
		kept="$(wc -l <"$keep" | tr -d ' ')"
		prune="$(grep -c '^P ' "$cls")"
	fi
	if [[ -n "$conflicts" ]]; then
		rm -rf "$t"
		record hermes OWNERSHIP_CONFLICT "not applied; files OPS does not own sit at release paths: ${conflicts}" \
			"a local edit or user file at a path the release ships" \
			"move your edits to a local overlay outside $dst (or delete them), then rerun; nothing was changed"
		return 0
	fi

	# Stage, validate, swap.
	mkdir -p "$work" 2>/dev/null || {
		rm -rf "$t"
		record hermes APPLY_FAILED "cannot create $work" "permission denied or not a dir" "fix permissions on $(dirname "$work")"
		return 0
	}
	rm -rf "$work"/stage.* 2>/dev/null
	local stage
	stage="$(mktemp -d "$work/stage.XXXXXX")" || {
		rm -rf "$t"
		record hermes APPLY_FAILED "cannot create a staging dir" "unknown" "check free space and permissions"
		return 0
	}
	if ! rsync -a --exclude '__pycache__' --exclude '.git' --exclude '.ops-manifest' "$src/" "$stage/" 2>/dev/null ||
		! rsync -a --exclude '__pycache__' --exclude '.git' --exclude '.ops-manifest' "$PLUGIN_ROOT/skills/" "$stage/skills/" 2>/dev/null; then
		rm -rf "$stage" "$t"
		record hermes APPLY_FAILED "copy into the staging dir failed" "rsync error" "check free space, then rerun"
		return 0
	fi
	if [[ -s "$keep" ]]; then
		while IFS= read -r rel; do
			mkdir -p "$stage/$(dirname "$rel")" && cp -pP "$dst/$rel" "$stage/$rel"
		done <"$keep"
	fi
	cp "$exp" "$stage/.ops-manifest"
	# Validate every release file landed with the expected bytes.
	local got="$t/got" elist="$t/elist"
	cut -c67- "$exp" >"$elist"
	hash_files "$stage" "$elist" | LC_ALL=C sort -k2 >"$got"
	if ! cmp -s "$got" "$exp"; then
		rm -rf "$stage" "$t"
		record hermes APPLY_FAILED "staged copy did not validate; previous registration kept" "byte mismatch after copy" "rerun; if it repeats, check the disk"
		return 0
	fi
	if [[ "${OPS_SYNC_FAULT:-}" == "before-swap" ]]; then
		rm -rf "$stage" "$t"
		record hermes APPLY_FAILED "interrupted before the swap (fault injection); previous registration kept" "OPS_SYNC_FAULT=before-swap" "rerun"
		return 0
	fi
	local prev="$work/prev.$$"
	if [[ -d "$dst" ]]; then
		if ! mv "$dst" "$prev"; then
			rm -rf "$stage" "$t"
			record hermes APPLY_FAILED "could not move the old plugin aside; it is unchanged" "rename failed" "check permissions on $(dirname "$dst")"
			return 0
		fi
		if [[ "${OPS_SYNC_FAULT:-}" == "mid-swap" ]]; then
			rm -rf "$t"
			record hermes APPLY_FAILED "interrupted mid-swap (fault injection); the next run restores the previous registration" "OPS_SYNC_FAULT=mid-swap" "rerun"
			return 0
		fi
	fi
	if ! mv "$stage" "$dst"; then
		[[ -d "$prev" ]] && mv "$prev" "$dst"
		rm -rf "$stage" "$t"
		record hermes APPLY_FAILED "could not move the staged plugin into place; previous registration restored" "rename failed" "check permissions on $(dirname "$dst")"
		return 0
	fi
	rm -rf "$prev" "$t"
	local n
	n="$(wc -l <"$exp" | tr -d ' ')"
	local note=""
	[[ "$kept" -gt 0 ]] && note="$note, $kept user file(s) kept"
	[[ "$prune" -gt 0 ]] && note="$note, $prune old OPS file(s) pruned"
	[[ "$legacy" -eq 1 ]] && note="$note, adopted a pre-manifest install"
	record hermes APPLIED "synced${version:+ v$version}: $n files$note"
}

selected grok && sync_grok
selected cursor && sync_cursor
selected codex && report_codex
selected hermes && sync_hermes

if [[ "$DRY" -eq 1 ]]; then
	say "${c_dim}[dry-run] nothing changed${c_rst}"
	exit 0
fi
if [[ "$N_BAD" -gt 0 ]]; then
	say "companion sync: partial — $N_BAD of $N_TOTAL target(s) need attention (exit 3). See $DOCS"
	exit "$(exit_code_for partial)"
fi
if [[ "$N_LOCKED" -gt 0 ]]; then
	say "companion sync: locked — $N_LOCKED target(s) busy (exit 6); rerun when the other run finishes"
	exit "$(exit_code_for locked)"
fi
say "companion sync: clean ($N_TOTAL target(s))"
exit 0
