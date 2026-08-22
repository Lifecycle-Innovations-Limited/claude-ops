#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "$PLUGIN_ROOT/scripts/compact-plugin-discovery.mjs" --check

grep -q 'references/capabilities.json' "$PLUGIN_ROOT/skills/ops/SKILL.md" || {
  echo "FAIL: OPS router does not load the capability index" >&2
  exit 1
}

grep -q '^  - Skill$' "$PLUGIN_ROOT/skills/ops/SKILL.md" || {
  echo "FAIL: OPS router cannot invoke specialist skills" >&2
  exit 1
}

description_chars=$(
  awk '
    FNR <= 25 && /^description:/ {
      sub(/^description:[[:space:]]*/, "")
      total += length($0)
      nextfile
    }
    END { print total + 0 }
  ' "$PLUGIN_ROOT"/skills/*/SKILL.md "$PLUGIN_ROOT"/agents/*.md
)

if (( description_chars > 10000 )); then
  echo "FAIL: always-on discovery descriptions total ${description_chars} chars (budget: 10000)" >&2
  exit 1
fi

# A missing capability index is unrecoverable: the full text lives only there.
# The script must say so and exit non-zero without rewriting any SKILL.md.
missing_index_check() {
  local work index out status
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  cp -R "$PLUGIN_ROOT" "$work/plugin"
  index="$work/plugin/skills/ops/references/capabilities.json"
  rm -f "$index"

  set +e
  out="$(node "$work/plugin/scripts/compact-plugin-discovery.mjs" 2>&1)"
  status=$?
  set -e

  if (( status == 0 )); then
    echo "FAIL: missing capability index did not fail the run" >&2
    exit 1
  fi
  if ! grep -q 'does not exist' <<<"$out"; then
    echo "FAIL: missing capability index did not explain itself: ${out}" >&2
    exit 1
  fi
  if ! diff -q "$PLUGIN_ROOT/skills/ops/SKILL.md" "$work/plugin/skills/ops/SKILL.md" >/dev/null; then
    echo "FAIL: failed run mutated SKILL.md files" >&2
    exit 1
  fi
}

missing_index_check
echo "PASS: missing capability index fails cleanly without rewriting skills"

echo "PASS: always-on discovery descriptions total ${description_chars} chars"
