#!/usr/bin/env bash
# test-companion-cli-sync.sh — coverage for scripts/sync-companion-clis.sh.
#
# WHY THIS FILE EXISTS
#
# PR #986 made `ops-update` fire automatically on any skill call. That made
# `sync-companion-clis.sh` an automatic path for the first time — it used to
# only run when somebody typed the update command — and it had NO tests at all.
# A regression in it (a renamed plugin id, a drifted marketplace slug, a home
# that is not where we guessed) would have silently stopped propagating updates
# to every non-Claude harness, with the update itself still reporting success.
#
# Hermes is the case that was actually broken: it has a real ops plugin in this
# repo (hermes-plugin/) and the sync script had no Hermes path, so every Hermes
# install stayed pinned at whatever version it was first installed with.
#
# WHAT IS ASSERTED
#
#   - a harness that is not installed is skipped, never a failure
#   - a Hermes install with a real plugin directory is refreshed in place
#   - the version actually lands (not just "rsync returned 0"). This is the
#     load-bearing case and it went RED before the fix: both plugin.yaml files
#     are the same LENGTH (a bump from x.y.19 to x.y.20 does not change size)
#     and are written in the same second, so rsync's default size+mtime quick
#     check skipped the file and still exited 0. Asserting the exit code would
#     have passed; asserting the version on disk is what caught it.
#   - a file dropped upstream is removed from the target, so stale code cannot
#     keep being loaded
#   - __pycache__ is NOT copied — a stale .pyc beside a newer .py is exactly
#     how an "updated" plugin keeps running old code
#   - a Hermes install that is a SYMLINK to a live checkout is left untouched
#   - HERMES_HOME is honoured, because it genuinely differs per machine
#   - the script exits 0 even when a harness is broken: it is called from the
#     middle of an upgrade and must never fail the upgrade it is part of
#
# NOTE: every path here is under a throwaway HOME. The suite must never read or
# write the real ~/.hermes, and no real personal value appears in this file.

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT="$PLUGIN_ROOT/scripts/sync-companion-clis.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
err() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

echo "=== companion CLI sync ==="

if [[ ! -f "$SCRIPT" ]]; then
  err "sync script present" "missing $SCRIPT"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

command -v rsync >/dev/null 2>&1 || {
  echo "  SKIP: rsync not available — the Hermes path cannot be exercised"
  echo "Results: $PASS passed, $FAIL failed"
  exit 0
}

WORK="$(mktemp -d -t ops-companion-sync.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# A fake plugin root holding a fake hermes-plugin/, so the test never depends on
# the real one's current contents.
FAKE_ROOT="$WORK/plugin"
mkdir -p "$FAKE_ROOT/scripts" "$FAKE_ROOT/hermes-plugin/__pycache__"
cp "$SCRIPT" "$FAKE_ROOT/scripts/sync-companion-clis.sh"
chmod +x "$FAKE_ROOT/scripts/sync-companion-clis.sh"
printf 'name: ops\nversion: "9.9.9"\n' > "$FAKE_ROOT/hermes-plugin/plugin.yaml"
printf 'new\n'                        > "$FAKE_ROOT/hermes-plugin/__init__.py"
printf 'stale bytecode\n'             > "$FAKE_ROOT/hermes-plugin/__pycache__/old.pyc"

# Run with a throwaway HOME and no companion CLIs on PATH, so only the Hermes
# branch does any work and the others take their not-installed path.
run_sync() {
  local home="$1" hermes_home="${2:-}"
  if [[ -n "$hermes_home" ]]; then
    env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$home" HERMES_HOME="$hermes_home" \
      bash "$FAKE_ROOT/scripts/sync-companion-clis.sh" 2>&1
  else
    env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$home" \
      bash "$FAKE_ROOT/scripts/sync-companion-clis.sh" 2>&1
  fi
}

# --- 1. Nothing installed: skipped, never a failure ---------------------------
HOME1="$WORK/home-empty"
mkdir -p "$HOME1"
out="$(run_sync "$HOME1")"; rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "hermes: no .*plugins (skipped)"; then
  ok "a harness that is not installed is skipped, exit 0"
else
  err "a harness that is not installed is skipped, exit 0" \
      "rc=$rc: $(printf '%s' "$out" | tr '\n' ' ')"
fi

# --- 2. A real Hermes plugin dir is refreshed in place ------------------------
HOME2="$WORK/home-hermes"
mkdir -p "$HOME2/.hermes/plugins/ops"
printf 'name: ops\nversion: "1.0.0"\n' > "$HOME2/.hermes/plugins/ops/plugin.yaml"
# A file that no longer exists upstream. It must not survive the sync.
printf 'removed upstream\n' > "$HOME2/.hermes/plugins/ops/gone.py"
out="$(run_sync "$HOME2")"; rc=$?
got="$(grep -m1 version "$HOME2/.hermes/plugins/ops/plugin.yaml" 2>/dev/null)"
if [[ $rc -eq 0 ]] && printf '%s' "$got" | grep -q '9\.9\.9'; then
  ok "an installed Hermes ops plugin is refreshed to the new version"
else
  err "an installed Hermes ops plugin is refreshed to the new version" \
      "rc=$rc, plugin.yaml now: $got"
fi

if [[ ! -e "$HOME2/.hermes/plugins/ops/gone.py" ]]; then
  ok "a file dropped upstream is removed from the target"
else
  err "a file dropped upstream is removed from the target" \
      "gone.py survived the sync, so stale code stays loadable"
fi

if [[ ! -e "$HOME2/.hermes/plugins/ops/__pycache__/old.pyc" ]]; then
  ok "__pycache__ is not copied into the target"
else
  err "__pycache__ is not copied into the target" \
      "a stale .pyc beside a newer .py makes an updated plugin run old code"
fi

if printf '%s' "$out" | grep -q "hermes: ops plugin synced"; then
  ok "the sync reports what it did"
else
  err "the sync reports what it did" "$(printf '%s' "$out" | tr '\n' ' ')"
fi

# --- 3. A symlinked install is left alone -------------------------------------
# This is a developer pointing Hermes at their own checkout. Overwriting it
# would either clobber their working tree or replace the link with a stale copy.
HOME3="$WORK/home-symlink"
mkdir -p "$HOME3/.hermes/plugins" "$WORK/live-checkout"
printf 'name: ops\nversion: "0.0.1-local"\n' > "$WORK/live-checkout/plugin.yaml"
ln -s "$WORK/live-checkout" "$HOME3/.hermes/plugins/ops"
out="$(run_sync "$HOME3")"; rc=$?
still_link=0
[[ -L "$HOME3/.hermes/plugins/ops" ]] && still_link=1
local_intact="$(grep -m1 version "$WORK/live-checkout/plugin.yaml" 2>/dev/null)"
if [[ $rc -eq 0 && $still_link -eq 1 ]] && printf '%s' "$local_intact" | grep -q '0\.0\.1-local'; then
  ok "a symlinked Hermes install is not clobbered"
else
  err "a symlinked Hermes install is not clobbered" \
      "rc=$rc, still_link=$still_link, live checkout now: $local_intact"
fi

# --- 4. HERMES_HOME is honoured -----------------------------------------------
# The default is ~/.hermes, but it is genuinely different on other machines, so
# guessing it would silently sync the wrong install — or none.
HOME4="$WORK/home-nondefault"
ALT="$WORK/hermes-primary"
mkdir -p "$HOME4" "$ALT/plugins/ops"
printf 'name: ops\nversion: "1.0.0"\n' > "$ALT/plugins/ops/plugin.yaml"
out="$(run_sync "$HOME4" "$ALT")"; rc=$?
got4="$(grep -m1 version "$ALT/plugins/ops/plugin.yaml" 2>/dev/null)"
if [[ $rc -eq 0 ]] && printf '%s' "$got4" | grep -q '9\.9\.9'; then
  ok "HERMES_HOME is honoured instead of assuming ~/.hermes"
else
  err "HERMES_HOME is honoured instead of assuming ~/.hermes" \
      "rc=$rc, plugin.yaml at HERMES_HOME now: $got4"
fi

# --- 5. --dry-run changes nothing ---------------------------------------------
HOME5="$WORK/home-dry"
mkdir -p "$HOME5/.hermes/plugins/ops"
printf 'name: ops\nversion: "1.0.0"\n' > "$HOME5/.hermes/plugins/ops/plugin.yaml"
env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME5" \
  bash "$FAKE_ROOT/scripts/sync-companion-clis.sh" --dry-run >/dev/null 2>&1
got5="$(grep -m1 version "$HOME5/.hermes/plugins/ops/plugin.yaml" 2>/dev/null)"
if printf '%s' "$got5" | grep -q '1\.0\.0'; then
  ok "--dry-run leaves the target untouched"
else
  err "--dry-run leaves the target untouched" "plugin.yaml now: $got5"
fi

# --- 6. A broken target never fails the upgrade -------------------------------
# This script runs in the middle of ops-update. If it can exit non-zero it can
# abort an upgrade that has already swapped files, which is far worse than a
# companion staying one version behind.
HOME6="$WORK/home-broken"
mkdir -p "$HOME6/.hermes/plugins"
# A plain FILE where the plugin directory should be: mkdir -p will fail on it.
printf 'not a directory\n' > "$HOME6/.hermes/plugins/ops"
out="$(run_sync "$HOME6")"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "a broken companion target still exits 0"
else
  err "a broken companion target still exits 0" \
      "rc=$rc — this can abort a half-applied upgrade"
fi

# --- 7. The missing-source case is reported, not silently skipped -------------
NOSRC="$WORK/plugin-nosrc"
mkdir -p "$NOSRC/scripts"
cp "$SCRIPT" "$NOSRC/scripts/sync-companion-clis.sh"
HOME7="$WORK/home-nosrc"
mkdir -p "$HOME7/.hermes/plugins/ops"
out="$(env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME7" \
  bash "$NOSRC/scripts/sync-companion-clis.sh" 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "hermes: no hermes-plugin/"; then
  ok "a missing hermes-plugin/ source is reported, not silently skipped"
else
  err "a missing hermes-plugin/ source is reported, not silently skipped" \
      "rc=$rc: $(printf '%s' "$out" | tr '\n' ' ')"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
