#!/usr/bin/env bash
# run-all.sh — Runs all claude-ops test suites and reports pass/fail
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"

total_pass=0
total_fail=0
failed_suites=()

run_suite() {
  local script="$1"
  local name
  name=$(basename "$script")

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Suite: $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if bash "$script"; then
    echo "[ PASS ] $name"
    total_pass=$((total_pass+1))
  else
    echo "[ FAIL ] $name"
    total_fail=$((total_fail+1))
    failed_suites+=("$name")
  fi
  echo ""
}

echo ""
echo "claude-ops Test Suite"
echo "Running from: $TESTS_DIR"
echo ""

run_suite "$TESTS_DIR/test-skills-lint.sh"
run_suite "$TESTS_DIR/test-bin-scripts.sh"
run_suite "$TESTS_DIR/test-hooks.sh"
run_suite "$TESTS_DIR/test-template.sh"
run_suite "$TESTS_DIR/test-claude-md.sh"
run_suite "$TESTS_DIR/test-no-secrets.sh"
run_suite "$TESTS_DIR/test-agent-teams.sh"
run_suite "$TESTS_DIR/test-ops-daemon-manager.sh"
run_suite "$TESTS_DIR/test-ops-package.sh"
run_suite "$TESTS_DIR/test-safety-hooks.sh"
run_suite "$TESTS_DIR/test-deploy-fix-hooks.sh"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Suites passed: $total_pass"
echo "  Suites failed: $total_fail"

if (( total_fail > 0 )); then
  echo ""
  echo "Failed suites:"
  for s in "${failed_suites[@]}"; do
    echo "  - $s"
  done
  echo ""
  exit 1
fi

echo ""
echo "All suites passed."
exit 0
