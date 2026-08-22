#!/usr/bin/env bash
# Runtime-first contract tests for bin/ops-speedup.
# Public plugin: no real host paths, secrets, or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/ops-speedup"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label (expected=$expected actual=$actual)"; fi
}

assert_true() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}

assert_false() {
  local label="$1"
  shift
  if "$@"; then fail "$label"; else pass "$label"; fi
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export HOME="$tmpdir"
export NO_COLOR=1
export TERM=dumb

# python3 parses ops-speedup's JSON contract below. The README lists only Claude
# Code and gh as requirements and CI never installs Python, so an unguarded call
# would abort this file under `set -e` and be reported as a speedup regression
# rather than a missing interpreter. Skip the way the sibling suites do.
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "== ops-speedup runtime health tests =="
  echo "  SKIP: python3 unavailable"
  echo "test-ops-speedup.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

echo "== ops-speedup runtime health tests =="
assert_true "bash syntax" bash -n "$BIN"
assert_true "no auto-aggressive default" bash -c "! grep -q 'MODE_CLEAN=true; MODE_DEEP=true; MODE_AGGRESSIVE=true' '$BIN'"
assert_true "has probe_runtime" grep -q 'probe_runtime()' "$BIN"
assert_true "has runtime-first health model" grep -q 'runtime-first' "$BIN"
assert_true "CPU hog kill gated by aggressive" grep -q 'Despite the legacy name, default cleanup only demotes hogs' "$BIN"
assert_true "GPU probe uses ioreg without sudo" grep -q 'ioreg -r -d1 -w0 -c IOGPU' "$BIN"
assert_true "long-lived hog threshold is 3 hours" grep -q 'elapsed >= 10800' "$BIN"

# Drive the shipped process-state classifier through the real binary. A PID that
# appears blocked in only one sample is transient; only the PID blocked in all
# three samples is counted as stuck. Runnable and zombie counts use the latest
# sample, matching the live probe.
cat >"$tmpdir/states-1" <<'EOF'
101 U
202 U
303 R
404 S
EOF
cat >"$tmpdir/states-2" <<'EOF'
101 S
202 U
303 S
404 S
EOF
cat >"$tmpdir/states-3" <<'EOF'
101 R
202 U
303 S
404 Z
505 R
EOF
state_counts=$(bash "$BIN" --classify-process-states \
  "$tmpdir/states-1" "$tmpdir/states-2" "$tmpdir/states-3")
assert_eq "transient U is ignored and persistent U is counted" "5 2 1 1" "$state_counts"

cat >"$tmpdir/states-none-1" <<'EOF'
11 U
12 S
EOF
cat >"$tmpdir/states-none-2" <<'EOF'
11 S
12 U
EOF
cat >"$tmpdir/states-none-3" <<'EOF'
11 R
12 S
EOF
no_stuck=$(bash "$BIN" --classify-process-states \
  "$tmpdir/states-none-1" "$tmpdir/states-none-2" "$tmpdir/states-none-3")
assert_eq "one-frame U states never become stuck" "2 1 0 0" "$no_stuck"

# On macOS, also drive the normal --json probe with a ps shim. This proves the
# public runtime.stuck result uses all three PID/state observations rather than
# only proving the helper in isolation.
if [[ "$(uname -s)" == "Darwin" ]]; then
  real_ps=$(command -v ps)
  mkdir -p "$tmpdir/mock-bin"
  cat >"$tmpdir/mock-bin/ps" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "-Ao pid=,stat=" ]]; then
  count_file="$OPS_SPEEDUP_PS_COUNT"
  count=0
  [[ -f "$count_file" ]] && count=$(cat "$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  case "${OPS_SPEEDUP_PS_SCENARIO}:${count}" in
    transient:1) printf '101 U\n202 S\n' ;;
    transient:2) printf '101 S\n202 U\n' ;;
    transient:3) printf '101 R\n202 S\n' ;;
    persistent:*) printf '101 U\n202 S\n' ;;
    *) exit 3 ;;
  esac
else
  exec "$OPS_SPEEDUP_REAL_PS" "$@"
fi
SH
  chmod +x "$tmpdir/mock-bin/ps"

  run_state_scenario() {
    local scenario="$1"
    local output count_file="$tmpdir/ps-${scenario}.count"
    rm -f "$count_file"
    output=$(PATH="$tmpdir/mock-bin:$PATH" \
      OPS_SPEEDUP_REAL_PS="$real_ps" \
      OPS_SPEEDUP_PS_SCENARIO="$scenario" \
      OPS_SPEEDUP_PS_COUNT="$count_file" \
      bash "$BIN" --json)
    python3 - "$output" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["runtime"]["stuck"])
PY
  }

  assert_eq "real JSON probe ignores transient U states" "0" "$(run_state_scenario transient)"
  assert_eq "real JSON probe counts a persistent U PID" "1" "$(run_state_scenario persistent)"
fi

json_out=$(bash "$BIN" --json)
python3 - "$json_out" <<'PY'
import json, sys
raw = sys.argv[1]
data = json.loads(raw)
required = [
    "runtime", "gpu", "health", "cpu_hogs", "power_hogs",
    "long_lived_hogs_detail", "memory", "network", "startup", "reclaimable_mb"
]
for key in required:
    if key not in data:
        print(f"missing:{key}")
        raise SystemExit(1)
health = data["health"]
runtime = data["runtime"]
gpu = data["gpu"]
for key in ("score", "model", "disk_reclaimable_penalty", "launch_agent_count_penalty", "factors"):
    if key not in health:
        print(f"missing:health.{key}")
        raise SystemExit(1)
for key in (
    "cpu_idle_pct", "load1", "running", "stuck", "zombies",
    "tcp_close_wait", "tcp_time_wait", "long_lived_hogs"
):
    if key not in runtime:
        print(f"missing:runtime.{key}")
        raise SystemExit(1)
for key in ("device_util_pct", "renderer_util_pct", "tiler_util_pct", "mem_in_use_mb", "mem_allocated_mb"):
    if key not in gpu:
        print(f"missing:gpu.{key}")
        raise SystemExit(1)
if health["model"] != "runtime-first":
    print(f"bad-model:{health['model']}")
    raise SystemExit(1)
if health["disk_reclaimable_penalty"] is not False:
    print("disk-penalty-enabled")
    raise SystemExit(1)
if health["launch_agent_count_penalty"] is not False:
    print("launch-agent-penalty-enabled")
    raise SystemExit(1)
if not (0 <= int(health["score"]) <= 100):
    print(f"bad-score:{health['score']}")
    raise SystemExit(1)
print("json-contract-ok")
PY
assert_eq "JSON runtime contract" "json-contract-ok" "$(python3 - "$json_out" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
print("json-contract-ok")
PY
)"

# Portability: macOS ships bash 3.2 as /bin/bash, and `#!/usr/bin/env bash`
# resolves to it whenever /usr/bin precedes a newer bash on PATH — which is the
# default for login shells, launchd, and cron. `declare -g` does not exist in
# 3.2, so using it to publish probe results silently left every RUNTIME_/MEM_/
# NET_/DISK_/STARTUP_/GPU_ variable unset and scored a perfect 100 from no data.
# Keep the assignments portable; the loops below redirect stderr, so a 4-only
# builtin fails invisibly rather than erroring out.
assert_true "no bash-4-only declare -g" bash -c "! grep -q 'declare -g' '$BIN'"

# The probe read-back must actually populate globals. Process count is the
# cheapest environment-independent witness: any live host has processes, so a
# zero here means the probe variables never made it back into scope.
assert_eq "probe vars reach global scope" "populated" "$(python3 - "$json_out" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
procs = int(data["runtime"].get("processes") or 0)
print("populated" if procs > 0 else f"empty:processes={procs}")
PY
)"

# Run the same contract under the host's /bin/bash when that is a 3.x build.
# Without this the suite only ever exercises the newer bash on PATH and cannot
# catch a 4-only builtin regressing the macOS default interpreter.
legacy_bash_version=$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || echo "")
if [ "$legacy_bash_version" = "3" ]; then
  assert_eq "populates probe vars under /bin/bash 3.x" "populated" "$(python3 - "$(/bin/bash "$BIN" --json)" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
procs = int(data["runtime"].get("processes") or 0)
print("populated" if procs > 0 else f"empty:processes={procs}")
PY
)"
else
  pass "populates probe vars under /bin/bash 3.x (skipped: /bin/bash is ${legacy_bash_version:-unknown}.x)"
fi

# Score contract: disk reclaimable size must not lower health, and launch-agent
# count must not either. Inject a synthetic runtime that is healthy except for
# large reclaimable numbers and many launch agents.
python3 - "$BIN" <<'PY'
import re, pathlib, sys
src = pathlib.Path(sys.argv[1]).read_text()
# Public-safe synthetic harness: only unit-test helpers, no host-specific data.
helpers = '''
is_number() { [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; }
value_lt() { is_number "${1:-}" || return 1; awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }
value_ge() { is_number "${1:-}" || return 1; awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
'''
# Extract compute_health_score body from the live script.
m = re.search(r'compute_health_score\(\) \{.*?\n\}', src, re.S)
assert m, 'compute_health_score missing'
fn = m.group(0)
path = pathlib.Path(__import__('os').environ['HOME']) / 'ops-speedup-health-unit.sh'
path.write_text(helpers + '\n' + fn + '''
RUNTIME_cpu_idle_pct=80
RUNTIME_running=1
RUNTIME_stuck=0
RUNTIME_zombies=0
RUNTIME_long_lived_hogs=0
MEM_pressure_pct=88
MEM_swap_mb=0
GPU_gpu_device_util_pct=10
NET_dns_ms=5
RUNTIME_tcp_close_wait=0
RUNTIME_tcp_time_wait=0
DISK_USED_PCT=1
STARTUP_failed_units=0
STARTUP_launch_agents=999
DISK_caches=50000
compute_health_score
echo "$HEALTH_SCORE"
''')
print(path)
PY
score=$(bash "$HOME/ops-speedup-health-unit.sh")
assert_eq "healthy runtime scores 100 even with huge caches and launch-agent count" "100" "$score"

python3 - "$BIN" <<'PY'
from pathlib import Path
import re, sys
src = Path(sys.argv[1]).read_text()
helpers = '''
is_number() { [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; }
value_lt() { is_number "${1:-}" || return 1; awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }
value_ge() { is_number "${1:-}" || return 1; awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
'''
fn = re.search(r'compute_health_score\(\) \{.*?\n\}', src, re.S).group(0)
Path(__import__('os').environ['HOME']).joinpath('ops-speedup-health-unit-pressure.sh').write_text(helpers + '\n' + fn + '''
RUNTIME_cpu_idle_pct=10
RUNTIME_running=40
RUNTIME_stuck=2
RUNTIME_zombies=0
RUNTIME_long_lived_hogs=1
MEM_pressure_pct=88
MEM_swap_mb=0
GPU_gpu_device_util_pct=10
NET_dns_ms=5
RUNTIME_tcp_close_wait=0
RUNTIME_tcp_time_wait=0
DISK_USED_PCT=1
STARTUP_failed_units=0
compute_health_score
echo "$HEALTH_SCORE"
printf '%s\n' "${HEALTH_FACTORS[@]}"
''')
PY
pressure_out=$(bash "$HOME/ops-speedup-health-unit-pressure.sh")
pressure_score=$(echo "$pressure_out" | head -1)
assert_true "pressure runtime is below 80" bash -c "[ \"$pressure_score\" -lt 80 ]"
assert_true "pressure factors include cpu idle" bash -c "echo \"$pressure_out\" | grep -q cpu-idle-under-20"


# Linux top %Cpu line must yield numeric us/sy/id fields (CI is Ubuntu).
sample='%Cpu(s):  5.9 us,  2.0 sy,  0.0 ni, 91.5 id,  0.6 wa,  0.0 hi,  0.0 si,  0.0 st'
parsed_user=$(echo "$sample" | grep -oE '[0-9]+([.][0-9]+)?[[:space:]]*(us|user)' | head -1 | grep -oE '[0-9]+([.][0-9]+)?' || true)
parsed_sys=$(echo "$sample" | grep -oE '[0-9]+([.][0-9]+)?[[:space:]]*(sy|system)' | head -1 | grep -oE '[0-9]+([.][0-9]+)?' || true)
parsed_idle=$(echo "$sample" | grep -oE '[0-9]+([.][0-9]+)?[[:space:]]*(id|idle)' | head -1 | grep -oE '[0-9]+([.][0-9]+)?' || true)
assert_eq "linux cpu parse user" "5.9" "$parsed_user"
assert_eq "linux cpu parse sys" "2.0" "$parsed_sys"
assert_eq "linux cpu parse idle" "91.5" "$parsed_idle"
assert_true "bin uses robust linux cpu parse" grep -q 'grep -oE .*(us|user)' "$BIN"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
