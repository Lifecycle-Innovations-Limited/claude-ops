#!/usr/bin/env bash
# test-ops-release-changelog-heading.sh — ops-release must not add a second
# "### Changed" heading to --notes that already carry one of their own.
# A redundant heading ships an empty section into the GitHub release notes.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="$PLUGIN_ROOT/bin/ops-release"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: bin/ops-release changelog heading guard"
echo ""

if [[ ! -f "$RELEASE" ]]; then
  echo "FAIL: bin/ops-release not found"
  exit 1
fi
ok "bin/ops-release exists"

if bash -n "$RELEASE" 2>/dev/null; then
  ok "bin/ops-release parses"
else
  err "bin/ops-release has a syntax error"
fi

# Lift the real heading block out of the script so the test exercises shipped
# code rather than a copy that can drift away from it.
BLOCK="$(awk '/^notes_has_heading=0$/{f=1} f{print; if ($0 == "fi") { n++; if (n == 2) exit }}' "$RELEASE")"
if [[ -z "$BLOCK" ]]; then
  err "heading guard block not found in bin/ops-release"
  echo ""
  echo "---"
  echo "Results: $pass passed, $((fail+1)) failed"
  exit 1
fi
ok "heading guard block found"

render() {
  local notes="$1" ai_used="$2"
  local NEW=9.9.9 REL_DATE=2026-01-01 changelog_section
  eval "$BLOCK"
  printf '%s' "$changelog_section"
}

count_changed() {
  printf '%s\n' "$1" | grep -c '^### Changed$' || true
}

# 1. --notes with their own "### Fixed" must stay untouched.
out="$(render "$(printf '### Fixed\n- something')" 0)"
if [[ "$(count_changed "$out")" == "0" ]]; then
  ok "notes with '### Fixed' get no extra '### Changed'"
else
  err "an empty '### Changed' was prepended to notes that already had a heading"
fi

# 2. --notes with their own "### Added" likewise.
out="$(render "$(printf '### Added\n- something')" 0)"
if [[ "$(count_changed "$out")" == "0" ]]; then
  ok "notes with '### Added' get no extra '### Changed'"
else
  err "an empty '### Changed' was prepended to '### Added' notes"
fi

# 3. Bare bullets still need a heading, or the section renders headless.
out="$(render "$(printf -- '- a bare bullet')" 0)"
if [[ "$(count_changed "$out")" == "1" ]]; then
  ok "bare bullets still get a '### Changed' heading"
else
  err "bare notes lost their '### Changed' heading"
fi

# 4. The AI path already emits its own headings; nothing may be added.
out="$(render "$(printf '### Changed\n- from the model')" 1)"
if [[ "$(count_changed "$out")" == "1" ]]; then
  ok "AI-written body keeps exactly its own heading"
else
  err "AI path duplicated or dropped a heading"
fi

# 5. Whatever the body, the version header comes first.
out="$(render "$(printf '### Fixed\n- something')" 0)"
if [[ "$out" == '## [9.9.9] - 2026-01-01'* ]]; then
  ok "section starts with the version header"
else
  err "section does not start with '## [version] - date'"
fi

# 6. A release drains Unreleased into the new version exactly once.
# shellcheck source=../scripts/lib/release-changelog.sh
. "$PLUGIN_ROOT/scripts/lib/release-changelog.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
cat > "$tmpdir/in.md" <<'MD'
# Changelog

## Unreleased

### Fixed
- first pending fix
- second pending fix

## [1.2.3] - 2026-01-01

### Changed
- old release
MD
unreleased="$(release_unreleased_body "$tmpdir/in.md")"
printf '## [1.2.4] - 2026-01-02

%s
' "$unreleased" > "$tmpdir/section.md"
release_write_changelog "$tmpdir/in.md" "$tmpdir/section.md" "$tmpdir/out.md"
if [[ "$(grep -c 'first pending fix' "$tmpdir/out.md")" == "1" ]] \
  && [[ "$(grep -c '^## Unreleased$' "$tmpdir/out.md")" == "1" ]] \
  && awk '/^## Unreleased$/{getline; if ($0=="") ok=1} END{exit !ok}' "$tmpdir/out.md" \
  && grep -q '^## \[1.2.4\] - 2026-01-02$' "$tmpdir/out.md"; then
  ok "Unreleased is drained into the new version exactly once"
else
  err "Unreleased body was duplicated, retained, or lost"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
