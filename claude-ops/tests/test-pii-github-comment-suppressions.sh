#!/usr/bin/env bash
# Regression controls for immutable third-party PR comments in the daily audit.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCAN="$PLUGIN_ROOT/bin/ops-pii-scan"

PASS=0
FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t ops-pii-github-comments.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"

# GitHub review comments are authored by third-party bots. GitHub does not let
# this repository edit them. The fake keeps this test offline while exercising
# the script's real --github collector.
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *pulls/comments*)
    # Mimic the production jq selector. It makes the test prove that the scan
    # passes the exact exclusions to GitHub's PR-comment collector.
    grep -Ev $'^pr comment (3331297829|3369283005|3369283007|3143781055)\t' "$GH_PR_COMMENTS" || true
    ;;
esac
EOF
chmod +x "$WORK/bin/gh"

run_scan() {
  PATH="$WORK/bin:$PATH" HOME="$WORK/home" OPS_PII_DENYLIST= \
    OPS_PII_DENYLIST_FILE=/dev/null GH_PR_COMMENTS="$1" \
    bash "$SCAN" --github example-org/example-repo 2>&1
}

# Keep the forbidden identity out of this public test file. The production
# digest sees the composed value exactly as it would in the real comment.
part_one="heart"
part_two="feldt"
printf 'pr comment 3143781055\tresolved: %s%s reference replaced\n' \
  "$part_one" "$part_two" > "$WORK/ignored.txt"
out=""
if out=$(run_scan "$WORK/ignored.txt"); then rc=0; else rc=$?; fi
if [[ $rc -eq 0 ]] && ! grep -q '3143781055' <<<"$out"; then
  ok "the one immutable, reviewed comment is excluded"
else
  bad "the one immutable, reviewed comment is excluded" "rc=$rc: $out"
fi

printf 'pr comment 9999999999\tresolved: %s%s reference replaced\n' \
  "$part_one" "$part_two" > "$WORK/unignored.txt"
out=""
if out=$(run_scan "$WORK/unignored.txt"); then rc=0; else rc=$?; fi
if [[ $rc -ne 0 ]] && grep -q 'operator-identity' <<<"$out"; then
  ok "the same text from any other comment remains blocked"
else
  bad "the same text from any other comment remains blocked" "rc=$rc: $out"
fi

echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
