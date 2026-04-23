#!/usr/bin/env bash
# ops-install-git-hooks.sh — installs post-commit/post-merge invalidation
# hooks into every repo registered in scripts/registry.json. The hooks
# remove stale cache timestamp files so the next daemon warm cycle refreshes
# only those specific caches, without waiting for the normal throttle window.
#
# Phase 16 INFR-02: smart cache invalidation.
#
# Usage:
#   ops-install-git-hooks.sh             # install/update hooks in all registered repos
#   ops-install-git-hooks.sh --dry-run   # show what would change, write nothing
#   ops-install-git-hooks.sh --uninstall # remove only the guarded block, keep the rest

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --uninstall) MODE="uninstall" ;;
    -h|--help)
      echo "Usage: $0 [--dry-run|--uninstall]"
      exit 0
      ;;
  esac
done

if [[ ! -f "$REGISTRY" ]]; then
  echo "registry.json not found at $REGISTRY" >&2
  exit 0
fi

# Extract repo paths from registry.json (supports both top-level
# projects[].paths[] and the simpler {path: ...} shape).
mapfile -t REPO_PATHS < <(python3 - "$REGISTRY" <<'PY'
import json, sys, os
try:
  data = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(0)

def _paths_from(item):
  out = []
  if not isinstance(item, dict):
    return out
  if isinstance(item.get("paths"), list):
    out.extend([p for p in item["paths"] if isinstance(p, str)])
  if isinstance(item.get("path"), str):
    out.append(item["path"])
  return out

paths = []
if isinstance(data, dict):
  if isinstance(data.get("projects"), list):
    for item in data["projects"]:
      paths.extend(_paths_from(item))
  elif isinstance(data.get("projects"), dict):
    for _, v in data["projects"].items():
      paths.extend(_paths_from(v))
  else:
    paths.extend(_paths_from(data))
elif isinstance(data, list):
  for item in data:
    paths.extend(_paths_from(item))

seen = set()
for p in paths:
  expanded = os.path.expanduser(p)
  if expanded in seen: continue
  seen.add(expanded)
  print(expanded)
PY
)

BEGIN_MARK="# BEGIN ops-daemon-invalidate"
END_MARK="# END ops-daemon-invalidate"

HOOK_BODY=$(cat <<'HOOK'
# Invalidate ops-daemon caches so the next warm pass regenerates them fresh.
STALE_TS=(
  "$HOME/.claude/plugins/data/ops-ops-marketplace/cache/.briefing_ts"
  "$HOME/.claude/plugins/data/ops-ops-marketplace/cache/.projects_ts"
  "$HOME/.claude/plugins/data/ops-ops-marketplace/cache/.marketing_ts"
  "$HOME/.claude/plugins/data/ops-ops-marketplace/cache/.prs_ts"
  "$HOME/.claude/plugins/data/ops-ops-marketplace/cache/.ci_ts"
)
for _f in "${STALE_TS[@]}"; do
  rm -f "$_f" 2>/dev/null || true
done
HOOK
)

_write_hook() {
  local hook_file="$1" mode="$2"
  local new_block
  new_block=$(printf '%s\n%s\n%s' "$BEGIN_MARK" "$HOOK_BODY" "$END_MARK")

  if [[ "$mode" == "uninstall" ]]; then
    [[ -f "$hook_file" ]] || { echo "skip"; return 0; }
    python3 - "$hook_file" "$BEGIN_MARK" "$END_MARK" <<'PY'
import re, sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(path).read()
content = re.sub(
  re.escape(begin) + r'.*?' + re.escape(end) + r'\n?',
  '',
  content,
  flags=re.DOTALL,
)
open(path, 'w').write(content)
PY
    echo "uninstalled"
    return 0
  fi

  if [[ ! -f "$hook_file" ]]; then
    if [[ "$mode" == "dry-run" ]]; then echo "would-create"; return 0; fi
    {
      printf '#!/usr/bin/env bash\n'
      printf '%s\n' "$new_block"
    } > "$hook_file"
    chmod +x "$hook_file"
    echo "installed"
    return 0
  fi

  if grep -q "$BEGIN_MARK" "$hook_file" 2>/dev/null; then
    if [[ "$mode" == "dry-run" ]]; then echo "would-update"; return 0; fi
    python3 - "$hook_file" "$BEGIN_MARK" "$END_MARK" "$new_block" <<'PY'
import re, sys
path, begin, end, block = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content = open(path).read()
content = re.sub(
  re.escape(begin) + r'.*?' + re.escape(end),
  block,
  content,
  flags=re.DOTALL,
)
open(path, 'w').write(content)
PY
    echo "updated"
    return 0
  fi

  if [[ "$mode" == "dry-run" ]]; then echo "would-append"; return 0; fi
  {
    printf '\n'
    printf '%s\n' "$new_block"
  } >> "$hook_file"
  chmod +x "$hook_file" 2>/dev/null || true
  echo "appended"
}

installed=0
updated=0
appended=0
skipped=0
uninstalled=0

if [[ "${#REPO_PATHS[@]}" -eq 0 ]]; then
  echo "No repos with path fields in $REGISTRY — nothing to do."
  exit 0
fi

for repo in "${REPO_PATHS[@]}"; do
  if [[ ! -d "$repo/.git/hooks" ]]; then
    skipped=$((skipped+1))
    echo "  $repo: skip (no .git/hooks)"
    continue
  fi
  for hook_name in post-commit post-merge; do
    hook_file="$repo/.git/hooks/$hook_name"
    result=$(_write_hook "$hook_file" "$MODE")
    case "$result" in
      installed)   installed=$((installed+1)) ;;
      updated)     updated=$((updated+1)) ;;
      appended)    appended=$((appended+1)) ;;
      uninstalled) uninstalled=$((uninstalled+1)) ;;
    esac
    echo "  $repo/.git/hooks/$hook_name: $result"
  done
done

echo ""
if [[ "$MODE" == "uninstall" ]]; then
  echo "Summary: uninstalled=$uninstalled"
elif [[ "$MODE" == "dry-run" ]]; then
  echo "Summary (dry-run): previewed ${#REPO_PATHS[@]} repos"
else
  echo "Summary: installed=$installed updated=$updated appended=$appended skipped=$skipped"
fi
