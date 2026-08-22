#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/macos/run-pressure-monitor-if-needed"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
calls="$tmpdir/calls"
monitor="$tmpdir/monitor"

cat >"$monitor" <<SH
#!/usr/bin/env bash
printf 'called\n' >>"$calls"
SH
chmod +x "$monitor"

assert_calls() {
  local label="$1" expected="$2"
  local actual=0
  [[ -f "$calls" ]] && actual=$(wc -l <"$calls" | tr -d ' ')
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label (expected=$expected actual=$actual)" >&2
    exit 1
  fi
  echo "PASS: $label"
}

bash -n "$RUNNER"
"$RUNNER" 37 10 18 "$monitor"
assert_calls "one high load sample does not call the monitor" 0
"$RUNNER" 10 37 18 "$monitor"
assert_calls "high load5 alone does not call the monitor" 0
"$RUNNER" 37 37 18 "$monitor"
assert_calls "sustained high load calls the monitor once" 1
"$RUNNER" 37 37 18 "$tmpdir/missing"
assert_calls "missing monitor is ignored" 1
