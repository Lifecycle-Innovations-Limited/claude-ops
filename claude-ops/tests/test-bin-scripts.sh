#!/usr/bin/env bash
# test-bin-scripts.sh — Validates bin/ scripts
set -euo pipefail

IS_MACOS=false
[[ "$(uname)" == "Darwin" ]] && IS_MACOS=true

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$PLUGIN_ROOT/bin"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

# Collect all bin scripts (skip .mjs and non-executables that are node/python)
script_files=()
while IFS= read -r -d '' f; do
  # Skip .mjs node scripts — they're valid but not bash
  [[ "$f" == *.mjs ]] && continue
  script_files+=("$f")
done < <(find "$BIN_DIR" -maxdepth 1 -type f -print0 2>/dev/null)

if [[ ${#script_files[@]} -eq 0 ]]; then
  echo "FAIL: No scripts found in $BIN_DIR"
  exit 1
fi

echo "Found ${#script_files[@]} bash script(s) in bin/ (excluding .mjs)"
echo ""

for script in "${script_files[@]}"; do
  name=$(basename "$script")
  echo "Checking: bin/$name"

  # 1. Executable bit
  if [[ -x "$script" ]]; then
    ok "is executable"
  else
    err "not executable: $name"
  fi

  # 2. Valid shebang
  shebang=$(head -1 "$script" 2>/dev/null || true)
  if echo "$shebang" | grep -qE "^#!.*(bash|sh|env bash|env sh)"; then
    ok "valid shebang: $shebang"
  else
    err "missing or invalid shebang in $name (got: '$shebang')"
  fi

  # 3. shellcheck (if available)
  if command -v shellcheck &>/dev/null; then
    if shellcheck -S error "$script" 2>/dev/null; then
      ok "shellcheck (errors only) clean"
    else
      err "shellcheck errors in $name (run: shellcheck -S error bin/$name)"
    fi
  else
    echo "  SKIP: shellcheck not installed"
  fi

  # 4. macOS-only tool checks
  if $IS_MACOS; then
    # Verify script doesn't call macOS-only tools without guards
    if grep -qE "(security find-generic-password|pbcopy|osascript|defaults read)" "$script" 2>/dev/null; then
      ok "macOS-only tool usage present (macOS environment)"
    fi
  else
    # On Linux: check that macOS-only tool calls are guarded
    unguarded=false
    while IFS= read -r line; do
      # Skip lines that are comments
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      # Check for macOS-only tools outside of IS_MACOS guards
      if echo "$line" | grep -qE "(security find-generic-password|pbcopy|osascript|defaults read)"; then
        unguarded=true
        break
      fi
    done < "$script"
    if $unguarded; then
      err "unguarded macOS-only tool call in $name (wrap with IS_MACOS guard)"
    else
      ok "no unguarded macOS-only tool calls (Linux safe)"
    fi
  fi

  echo ""
done

# 5. Cross-check: ops-setup-install handles all tools listed in ops-setup-preflight
echo "Cross-check: ops-setup-install vs ops-setup-preflight"
preflight="$BIN_DIR/ops-setup-preflight"
install_script="$BIN_DIR/ops-setup-install"

if [[ -f "$preflight" && -f "$install_script" ]]; then
  # Extract tool names from preflight — lines like: check_tool jq / command -v jq
  preflight_tools=$(grep -oE 'command -v [a-z_-]+' "$preflight" 2>/dev/null | awk '{print $3}' | sort -u || true)
  # Extract tools handled by install script — lines like: jq) / "jq")
  install_tools=$(grep -oE '"?[a-z_-]+"?\)' "$install_script" 2>/dev/null | tr -d '"()' | sort -u || true)

  missing_count=0
  while IFS= read -r tool; do
    [[ -z "$tool" ]] && continue
    if echo "$install_tools" | grep -qx "$tool"; then
      ok "ops-setup-install handles: $tool"
    else
      err "ops-setup-install missing handler for: $tool (found in preflight)"
      missing_count=$((missing_count+1))
    fi
  done <<< "$preflight_tools"

  if [[ -z "$preflight_tools" ]]; then
    echo "  SKIP: could not extract tool list from ops-setup-preflight"
  fi
else
  echo "  SKIP: ops-setup-preflight or ops-setup-install not found"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
