#!/usr/bin/env bash
# Runs every outbound-guard suite and fails if any of them fail.
#
# run-all.sh invokes each suite with `bash`, so the Python suites here cannot be
# listed there directly. This wrapper is the single entry it registers instead, which
# also means a new guard suite only has to be added here.
#
# The suites share one approval store at a fixed path, so they must not run
# concurrently: credit left by one would change the verdict of the next. Sequential
# is deliberate, not an oversight.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# Two of the suites predate CI and default to the hook installed under ~/.claude, which
# does not exist on a runner: python3 on a missing file exits 2, so every case reads as
# blocked and even `plain ls` fails. A suite living in the repo should test the repo, so
# point all four at the checked-in copy. An explicit OUTBOUND_HOOK still wins, which is
# how you test the installed hook on a machine that has one.
export OUTBOUND_HOOK="${OUTBOUND_HOOK:-$HERE/../../scripts/outbound-guard/block-outbound-comms.py}"
if [ ! -f "$OUTBOUND_HOOK" ]; then
  echo "outbound-guard: hook not found at $OUTBOUND_HOOK"
  exit 1
fi

fail=0

for suite in \
  "$HERE/test-shared-guard.sh" \
  "$HERE/test-hook-matrix.py" \
  "$HERE/test-false-positives.py" \
  "$HERE/test-broken-alias.py"; do

  name="$(basename "$suite")"
  if [ ! -f "$suite" ]; then
    echo "[ FAIL ] $name (missing)"
    fail=1
    continue
  fi

  echo "--- $name"
  case "$suite" in
    *.py) python3 "$suite" ;;
    *) bash "$suite" ;;
  esac

  if [ $? -eq 0 ]; then
    echo "[ PASS ] $name"
  else
    echo "[ FAIL ] $name"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "outbound-guard: at least one suite failed"
  exit 1
fi
echo "outbound-guard: all suites passed"
