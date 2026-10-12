#!/usr/bin/env bash
# test-parity-docs.sh — every status and every docs link the parity code
# prints must resolve to an anchor in docs/skill-parity.md, and the quickstart
# commands named in the READMEs must exist.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
DOC="$ROOT/docs/skill-parity.md"
pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "=== parity docs ==="
[[ -f "$DOC" ]] && ok "docs/skill-parity.md exists" || err "docs/skill-parity.md missing"

for s in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["statuses"]))' "$ROOT/lib/parity/status.json"); do
  a="status-$(printf '%s' "$s" | tr 'A-Z_' 'a-z-')"
  grep -q "id=\"$a\"" "$DOC" && ok "anchor #$a" || err "no anchor #$a for status $s"
done

files=("$ROOT/lib/parity/check.mjs" "$ROOT/scripts/sync-companion-clis.sh" "$ROOT/bin/ops-update")
[[ -d "$REPO/installer" ]] && files+=("$REPO/installer/src/dispatch.mjs" "$REPO/installer/bin/claude-ops-installer.mjs")
for a in $(grep -hoE 'docs/skill-parity\.md#[a-z0-9-]+' "${files[@]}" | sed 's/.*#//' | sort -u); do
  [[ "$a" == "status-" ]] && continue
  grep -q "id=\"$a\"" "$DOC" && ok "linked anchor #$a exists" || err "code links #$a but the doc has no such anchor"
done

grep -q 'ops-update --check' "$REPO/README.md" && ok "README quickstart names ops-update --check" || err "README quickstart"
grep -q -- '--check)' "$ROOT/bin/ops-update" && ok "ops-update implements --check" || err "ops-update --check missing"
[[ -f "$ROOT/docs/ops-research.md" ]] && ok "research handbook linked from the parity doc exists" || err "docs/ops-research.md missing"
if grep -qE 'Current: \[v[0-9]' "$REPO/README.md"; then
  err "README hardcodes a 'Current: vX' release that drifts from the badge"
else
  ok "README does not hardcode a stale current version"
fi

echo ""
echo "Results: $pass passed, $fail failed"
((fail == 0))
