#!/usr/bin/env bash
# Contract tests for bin/ops-pretool-skill-update — the PreToolUse(Skill) hook
# that notices a newer published version and, in "auto" mode, upgrades in the
# background.
#
# The hook fires on every Skill call, so the properties that matter are mostly
# about what it must NOT do: never block the skill, never fire for another
# plugin's skill, never start a second updater while one is running, and never
# run at all when switched off.
#
# ops-update-check is stubbed via PATH-independent plugin-root layout: the
# fixture is a fake plugin root, so no real install is touched.
# Public plugin: no real host paths or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "== skill update gate =="

if ! command -v jq >/dev/null 2>&1; then
  echo "  SKIP: jq is required"
  echo "test-skill-update-gate.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Fixture: a plugin root holding the real hook, a stub ops-update-check that
# exits with $1, a stub ops-update that just records that it ran, and one
# skill directory named "ops-status".
make_root() {
  local base="$1" check_exit="$2"
  local root="$base/plugin"
  mkdir -p "$root/bin" "$root/skills/ops-status" "$root/scripts/lib"
  cp "$ROOT/bin/ops-pretool-skill-update" "$root/bin/"
  cat >"$root/bin/ops-update-check" <<EOF
#!/usr/bin/env bash
mkdir -p "\$CLAUDE_CONFIG_DIR/state/ops-update"
printf '{"installed":"1.0.0","published":"2.0.0"}\n' \
  >"\$CLAUDE_CONFIG_DIR/state/ops-update/update-available.json"
exit $check_exit
EOF
  cat >"$root/bin/ops-update" <<'EOF'
#!/usr/bin/env bash
touch "$CLAUDE_CONFIG_DIR/updater-ran"
EOF
  chmod +x "$root/bin/ops-update-check" "$root/bin/ops-update"
  echo "$root"
}

# Run the hook with skill name $2 and mode $3 against fixture root $1.
# Echoes stdout; the caller inspects it and the fixture's side effects.
run_hook() {
  local root="$1" skill="$2" mode="$3"
  printf '{"tool_input":{"skill":"%s"}}' "$skill" |
    CLAUDE_PLUGIN_ROOT="$root" \
      CLAUDE_CONFIG_DIR="$(dirname "$root")/cfg" \
      HOME="$(dirname "$root")/cfg" \
      OPS_AUTO_UPDATE="$mode" \
      bash "$root/bin/ops-pretool-skill-update" 2>/dev/null
}

# ── 1. auto mode: update available → updater starts, session is told ───────
base="$tmpdir/auto"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "ops-status" auto)
# The updater is detached, so give it a moment to touch its marker.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -f "$base/cfg/updater-ran" ] && break
  sleep 0.2
done
if [ -f "$base/cfg/updater-ran" ]; then
  pass "auto mode starts the updater"
else
  fail "auto mode did not start the updater"
fi
if printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | test("2.0.0")' >/dev/null 2>&1; then
  pass "auto mode reports the new version to the session"
else
  fail "auto mode did not report the new version (got: ${out:-<empty>})"
fi

# ── 2. notify mode: tells, never upgrades ─────────────────────────────────
base="$tmpdir/notify"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "ops-status" notify)
sleep 0.4
if [ ! -f "$base/cfg/updater-ran" ]; then
  pass "notify mode leaves the install alone"
else
  fail "notify mode ran the updater"
fi
if printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | test("ops-update")' >/dev/null 2>&1; then
  pass "notify mode points at /ops:ops-update"
else
  fail "notify mode said nothing useful (got: ${out:-<empty>})"
fi

# ── 3. off: does nothing at all, even with an update waiting ──────────────
base="$tmpdir/off"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "ops-status" off)
sleep 0.4
if [ ! -f "$base/cfg/updater-ran" ] && [ -z "$out" ]; then
  pass "off mode is silent and inert"
else
  fail "off mode was not inert (output: ${out:-<empty>})"
fi

# ── 4. already current (exit 0) → nothing happens ─────────────────────────
base="$tmpdir/current"; mkdir -p "$base/cfg"
root=$(make_root "$base" 0)
out=$(run_hook "$root" "ops-status" auto)
sleep 0.4
if [ ! -f "$base/cfg/updater-ran" ] && [ -z "$out" ]; then
  pass "no update available → no upgrade, no noise"
else
  fail "acted despite being current (output: ${out:-<empty>})"
fi

# ── 5. another plugin's skill → not our business ──────────────────────────
base="$tmpdir/foreign"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "some-other-plugin-skill" auto)
sleep 0.4
if [ ! -f "$base/cfg/updater-ran" ] && [ -z "$out" ]; then
  pass "a non-ops skill does not trigger a self-update"
else
  fail "fired for a foreign skill (output: ${out:-<empty>})"
fi

# ── 6. plugin-qualified skill name ("ops:ops-status") still matches ───────
base="$tmpdir/qualified"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "ops:ops-status" auto)
if printf '%s' "$out" | jq -e '.hookSpecificOutput' >/dev/null 2>&1; then
  pass "plugin-qualified skill names match"
else
  fail "plugin-qualified skill name was ignored (got: ${out:-<empty>})"
fi

# ── 7. lock held → no second updater ──────────────────────────────────────
base="$tmpdir/locked"; mkdir -p "$base/cfg/state/ops-update/.auto-update.lock"
root=$(make_root "$base" 3)
out=$(run_hook "$root" "ops-status" auto)
sleep 0.4
if [ ! -f "$base/cfg/updater-ran" ]; then
  pass "a held lock prevents a concurrent updater"
else
  fail "started a second updater while the lock was held"
fi

# ── 8. a broken update-check must not break the skill call ────────────────
base="$tmpdir/broken"; mkdir -p "$base/cfg"
root=$(make_root "$base" 3)
printf '#!/usr/bin/env bash\nexit 9\n' >"$root/bin/ops-update-check"
chmod +x "$root/bin/ops-update-check"
if run_hook "$root" "ops-status" auto >/dev/null 2>&1; then
  pass "hook exits 0 when the version check fails"
else
  fail "hook returned non-zero — that would surface on every Skill call"
fi

echo "test-skill-update-gate.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
