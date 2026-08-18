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

echo "PASS: always-on discovery descriptions total ${description_chars} chars"
