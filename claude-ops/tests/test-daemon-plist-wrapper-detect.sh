#!/opt/homebrew/bin/bash
# Focused test for _is_data_dir_wrapper from ops-daemon-manager.sh.
set -uo pipefail

MGR="$1"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/data" "$T/plugin/scripts"
: > "$T/plugin/scripts/ops-daemon.sh"
printf '#!/bin/sh\n' > "$T/data/bin-wrapper.sh"; chmod 755 "$T/data/bin-wrapper.sh"
printf '#!/bin/sh\n' > "$T/data/not-exec.sh";    chmod 644 "$T/data/not-exec.sh"

# Pull only the helper out of the manager, so we test it without running the CLI.
sed -n '/^_is_data_dir_wrapper()/,/^}/p' "$MGR" > "$T/fn.sh"
if [[ ! -s "$T/fn.sh" ]]; then
  echo "FAIL: could not extract _is_data_dir_wrapper from $MGR"
  exit 1
fi
echo "--- extracted helper ---"
cat "$T/fn.sh"
echo "--- results ---"

export CLAUDE_PLUGIN_DATA_DIR="$T/data"
# shellcheck source=/dev/null
source "$T/fn.sh"

fails=0
check() {
  local desc="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    printf 'PASS  %-46s got=%s\n' "$desc" "$got"
  else
    printf 'FAIL  %-46s want=%s got=%s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}

run() { _is_data_dir_wrapper "$1" && echo true || echo false; }

check "exec wrapper inside data dir"      true  "$(run "$T/data/bin-wrapper.sh")"
check "non-exec file inside data dir"     false "$(run "$T/data/not-exec.sh")"
check "plugin script outside data dir"    false "$(run "$T/plugin/scripts/ops-daemon.sh")"
check "empty path"                        false "$(run "")"
check "missing file inside data dir"      false "$(run "$T/data/absent.sh")"
check "data-dir prefix lookalike sibling" false "$(run "${T}/data-evil/bin.sh")"

# The real caller runs under set -u; prove the helper survives it.
set -u
if _is_data_dir_wrapper "$T/data/bin-wrapper.sh"; then
  echo "PASS  survives set -u                            got=exit0"
else
  echo "FAIL  survives set -u"
  fails=$((fails + 1))
fi

echo "--- $fails failure(s) ---"
exit $(( fails > 0 ? 1 : 0 ))
