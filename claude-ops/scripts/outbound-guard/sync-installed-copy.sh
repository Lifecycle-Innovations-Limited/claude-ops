#!/usr/bin/env bash
# Keep the installed Node twin of the outbound guard current with the repo copy.
#
# outbound_guard.py documents that the Node side "lives at ../outbound-guard.mjs
# (and, when installed, at ~/.claude/mcp-proxy/outbound-guard.mjs)" and that it
# "reads and writes this same file with the same rules". Nothing enforced that,
# so a machine either had no installed copy at all or had one copied in once and
# never touched again, drifting onto a different schema without either side
# failing loudly. This script is the refresh step.
#
# It used to be an unconditional overwrite, and that was the real defect: a
# security guard was replaced, on every single SessionStart, by whatever bytes
# happened to sit in the checkout, with no check that those bytes were newer or
# even compatible. On a machine whose installed copy was the current
# reservation-schema guard and whose checkout still carried the old count-schema
# one, this silently DOWNGRADED the guard. It fails closed, so nothing leaks,
# but the two-phase commit for MCP-proxy-routed sends stops working and Sam's
# approvals are never redeemed. Nothing said a word, because setup.sh called
# this with `|| true` and stderr on /dev/null.
#
# So: the sync is now a guarded, one-directional upgrade.
#   * Both files carry a `// outbound-guard-schema: <id>` marker.
#   * An installed copy whose schema cannot be placed is REFUSED, loudly, on
#     stderr, with a non-zero exit. A file we do not understand is never
#     something to overwrite on a hunch.
#   * An installed copy NEWER than the source is refused too. Sync forward only.
#   * Equal schemas, or a known-legacy installed copy, sync normally.
#   * Override for a deliberate repair: --force / OUTBOUND_GUARD_SYNC_FORCE=1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/outbound-guard.mjs"
DEST_DIR="${HOME}/.claude/mcp-proxy"
DEST="$DEST_DIR/outbound-guard.mjs"

FORCE="${OUTBOUND_GUARD_SYNC_FORCE:-0}"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "sync-installed-copy: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

if [ ! -f "$SRC" ]; then
  echo "sync-installed-copy: source missing at $SRC" >&2
  exit 1
fi

# Schema of a guard file. The marker is authoritative. Unmarked files predate the
# marker, so fall back to recognising them by the one thing that defines their
# contract with outbound_guard.py: whether they delegate the decision, or keep
# their own copy of the count/spent store.
detect_schema() {
  local f="$1" m
  m="$(sed -n 's|^[[:space:]]*//[[:space:]]*outbound-guard-schema:[[:space:]]*\([A-Za-z0-9._-]\{1,\}\).*$|\1|p' "$f" | head -1)"
  if [ -n "$m" ]; then printf '%s\n' "$m"; return 0; fi
  if grep -q 'claimReservation' "$f" && grep -q 'OUTBOUND_GUARD_PY\|outbound_guard\.py' "$f"; then
    printf 'reservation-unversioned\n'; return 0
  fi
  if grep -q 'd\.remaining\|remaining = Number' "$f" && grep -q 'SPENT_WINDOW_SEC' "$f"; then
    printf 'count-legacy\n'; return 0
  fi
  printf 'unknown\n'
}

# Rank orders the known schemas so the sync can only ever move forward. An
# unknown schema has no rank on purpose: it is refused, not compared. Versioned
# reservation schemas rank by their own number, so a future reservation-v3 on
# disk is recognised as NEWER by a v2 checkout rather than mistaken for garbage.
schema_rank() {
  case "$1" in
    count-legacy) printf '1\n' ;;
    reservation-unversioned) printf '2\n' ;;
    reservation-v[0-9]*) printf '%s\n' "$(( 100 + ${1#reservation-v} ))" ;;
    *) printf '0\n' ;;
  esac
}

SRC_SCHEMA="$(detect_schema "$SRC")"
SRC_RANK="$(schema_rank "$SRC_SCHEMA")"
if [ "$SRC_RANK" = "0" ]; then
  echo "sync-installed-copy: REFUSED — repo source $SRC has an unrecognised schema ('$SRC_SCHEMA')." >&2
  echo "  Add a '// outbound-guard-schema: <id>' marker and give it a rank in schema_rank()." >&2
  exit 3
fi

if [ -f "$DEST" ]; then
  DEST_SCHEMA="$(detect_schema "$DEST")"
  DEST_RANK="$(schema_rank "$DEST_SCHEMA")"

  if [ "$DEST_RANK" = "0" ] && [ "$FORCE" != "1" ]; then
    echo "sync-installed-copy: REFUSED — installed copy has an unrecognised schema." >&2
    echo "  installed: $DEST (schema '$DEST_SCHEMA')" >&2
    echo "  source:    $SRC (schema '$SRC_SCHEMA')" >&2
    echo "  Overwriting a guard this script cannot identify risks downgrading a" >&2
    echo "  security gate. Inspect the installed file. If replacing it is correct," >&2
    echo "  re-run with --force (or OUTBOUND_GUARD_SYNC_FORCE=1)." >&2
    exit 4
  fi

  if [ "$DEST_RANK" -gt "$SRC_RANK" ] && [ "$FORCE" != "1" ]; then
    echo "sync-installed-copy: REFUSED — installed copy is newer than the source." >&2
    echo "  installed: $DEST (schema '$DEST_SCHEMA')" >&2
    echo "  source:    $SRC (schema '$SRC_SCHEMA')" >&2
    echo "  Syncing would DOWNGRADE the outbound guard. Update the checkout" >&2
    echo "  instead; use --force only to deliberately roll back." >&2
    exit 5
  fi

  if cmp -s "$SRC" "$DEST"; then
    echo "outbound-guard: installed copy already current ($DEST_SCHEMA)"
    exit 0
  fi
fi

mkdir -p "$DEST_DIR"
# Copy-then-rename: never leaves a half-written file at $DEST for a proxy
# process to read mid-write. The trap matters — 304 leaked .tmp.<pid> files on
# one machine were the first visible symptom of this script failing in the dark.
tmp="$DEST.tmp.$$"
trap 'rm -f "$tmp"' EXIT
cp "$SRC" "$tmp"
mv "$tmp" "$DEST"

echo "outbound-guard: synced installed copy -> $DEST ($SRC_SCHEMA)"
