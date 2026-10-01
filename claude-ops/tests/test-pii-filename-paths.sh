#!/usr/bin/env bash
# Checkout identity is not committed; every repo-relative filename is.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCANNER="${SCANNER_UNDER_TEST:-$PLUGIN_ROOT/tests/test-no-secrets.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ops-filename-paths.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# Synthetic operator identity appears only in the checkout's parent directory.
TERM="fixture-owner"
REPO="$WORK/$TERM/repo.[copy]"
mkdir -p "$REPO/claude-ops/tests" "$REPO/claude-ops/scripts" "$REPO/.github/workflows"
cp "$SCANNER" "$REPO/claude-ops/tests/test-no-secrets.sh"
cp "$PLUGIN_ROOT/tests/known-public-constants.txt" "$REPO/claude-ops/tests/known-public-constants.txt"
printf 'ok\n' > "$REPO/claude-ops/scripts/clean.sh"
git -C "$REPO" init -q
# Fixtures only: never stage or alter the source checkout's index/config.
git -C "$REPO" add -- .
PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" rc=0 out err
  out="$WORK/$label.out"
  err="$WORK/$label.err"
  HOME="$WORK/home" OPS_PII_DENYLIST_FILE=/dev/null \
    OPS_PII_DENYLIST="$TERM" OPS_PII_DENYLIST_REQUIRED=1 \
    bash "$REPO/claude-ops/tests/test-no-secrets.sh" > "$out" 2> "$err" || rc=$?
  if [[ "$rc" == "$expected" ]] && [[ ! -s "$err" ]] &&
     { [[ "$expected" == 0 ]] || { grep -F 'FAIL: operator identity term(s) in tracked filename(s)' "$out" >/dev/null &&
       grep -Fx "    ${3:-}" "$out" >/dev/null; }; }; then
    echo "PASS: $label (exit=$rc, stdout=$(wc -c < "$out" | tr -d ' ') bytes, stderr=0 bytes)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected=$expected, exit=$rc)"
    grep -E '^  FAIL|^Results:' "$out" || true
    FAIL=$((FAIL + 1))
  fi
  if [[ -n "${PII_FILENAME_EVIDENCE_DIR:-}" ]]; then
    mkdir -p "$PII_FILENAME_EVIDENCE_DIR"
    cp "$out" "$err" "$PII_FILENAME_EVIDENCE_DIR/"
  fi
}

printf 'name: clean\n' > "$REPO/.github/workflows/clean.yml"
git -C "$REPO" add -- .github
check checkout-identity 0
: > "$REPO/.github/workflows/clean.yml"
check empty-input 0
printf 'name: "café"\n# Quoted: '\''hello'\'' and "世界"\n' > "$REPO/.github/workflows/clean.yml"
check quoted-multiline 0

# Remove the clean workflow so a checkout-path false positive cannot satisfy
# the negative controls for tests/, scripts/, or the repository root.
git -C "$REPO" rm -q -f --cached -- .github/workflows/clean.yml
rm -f "$REPO/.github/workflows/clean.yml"

# Both the external .github path and tests/ must still refuse real filename PII.
for rel in ".github/workflows/$TERM.yml" "claude-ops/tests/$TERM.txt" \
           "claude-ops/scripts/$TERM.sh" "$TERM.txt"; do
  printf 'ok\n' > "$REPO/$rel"
  git -C "$REPO" add -- "$rel"
  check "identity-${PASS}-${FAIL}" 1 "$rel"
  git -C "$REPO" rm -q -f --cached -- "$rel"
  rm -f "$REPO/$rel"
done

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
