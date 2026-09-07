#!/usr/bin/env bash
# Keep the installed Node twin of the outbound guard current with the repo copy.
#
# outbound_guard.py documents that the Node side "lives at ../outbound-guard.mjs
# (and, when installed, at ~/.claude/mcp-proxy/outbound-guard.mjs)" and that it
# "reads and writes this same file with the same rules". Nothing enforced that:
# there was no install step and no refresh step, so a machine either had no
# installed copy at all, or — worse — had one copied in once and never touched
# again. Every later change to outbound-guard.mjs (a new field on the state file,
# a rule change) would silently NOT reach the installed copy, so the two
# "identical" implementations the README promises would drift onto different
# schemas without either side failing loudly.
#
# This script makes the installed copy a straight, idempotent mirror of the repo
# source. It only ever OVERWRITES the installed file with the current repo
# content — there is no partial-merge logic to drift, so re-running it is always
# safe and always converges to whatever ships in this checkout.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/outbound-guard.mjs"
DEST_DIR="${HOME}/.claude/mcp-proxy"
DEST="$DEST_DIR/outbound-guard.mjs"

if [ ! -f "$SRC" ]; then
  echo "sync-installed-copy: source missing at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
# Copy-then-rename: never leaves a half-written file at $DEST for a proxy
# process to read mid-write.
tmp="$DEST.tmp.$$"
cp "$SRC" "$tmp"
mv "$tmp" "$DEST"

echo "outbound-guard: synced installed copy -> $DEST"
