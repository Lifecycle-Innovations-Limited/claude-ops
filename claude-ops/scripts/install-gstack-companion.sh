#!/usr/bin/env bash
# install-gstack-companion.sh — co-install gstack as a skills clone.
#
# gstack is not a Claude Code marketplace plugin. It ships as a git repo of
# skills (default: garrytan/gstack) cloned under ~/.claude/skills/gstack so
# /ops:flow ad-hoc mode can route to /spec /review /qa /ship /browse etc.
#
# Portable: no host hardcodes. Override via env:
#   GSTACK_REPO   git URL (default https://github.com/garrytan/gstack.git)
#   GSTACK_DIR    install path (default: an existing ~/.local/share/gstack or\n#                 ~/.claude/skills/gstack, else ~/.local/share/gstack)
#   GSTACK_BRANCH branch or tag (default main)
#
# Usage:
#   bash scripts/install-gstack-companion.sh
#   bash scripts/install-gstack-companion.sh --status
#   bash scripts/install-gstack-companion.sh --dry-run
#   bash scripts/install-gstack-companion.sh --update
set -euo pipefail

GSTACK_REPO="${GSTACK_REPO:-https://github.com/garrytan/gstack.git}"
# Default install path. gstack's own current guidance is ~/.local/share/gstack:
# a checkout under ~/.claude/skills puts 54 top-level SKILL.md files (the `qa`
# one alone is ~90KB) inside an indexed skills tree, which loads into every
# agent context. Prefer an existing install over creating a second one.
if [ -n "${GSTACK_DIR:-}" ]; then
  :
elif [ -d "${HOME}/.local/share/gstack" ]; then
  GSTACK_DIR="${HOME}/.local/share/gstack"
elif [ -d "${HOME}/.claude/skills/gstack" ]; then
  GSTACK_DIR="${HOME}/.claude/skills/gstack"
else
  GSTACK_DIR="${HOME}/.local/share/gstack"
fi
GSTACK_BRANCH="${GSTACK_BRANCH:-main}"

STATUS_ONLY=0
DRY_RUN=0
UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --status) STATUS_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --update) UPDATE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
  esac
done

gstack_present() {
  if [[ -f "${GSTACK_DIR}/SKILL.md" ]]; then
    return 0
  fi
  if [[ -f "${GSTACK_DIR}/.agents/skills/gstack/SKILL.md" ]]; then
    return 0
  fi
  if [[ -f "${HOME}/.agents/skills/gstack/SKILL.md" ]]; then
    return 0
  fi
  return 1
}

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  if gstack_present; then
    echo "gstack: installed (${GSTACK_DIR})"
    exit 0
  fi
  echo "gstack: missing"
  exit 1
fi

if gstack_present && [[ "$UPDATE" -eq 0 ]]; then
  if [[ -d "${GSTACK_DIR}/.git" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "dry-run: would git -C ${GSTACK_DIR} pull --ff-only origin ${GSTACK_BRANCH}"
      exit 0
    fi
    if git -C "$GSTACK_DIR" fetch origin "$GSTACK_BRANCH" >/dev/null 2>&1 \
      && git -C "$GSTACK_DIR" merge --ff-only "origin/${GSTACK_BRANCH}" >/dev/null 2>&1; then
      echo "ok: gstack updated (ff-only) at ${GSTACK_DIR}"
    else
      echo "ok: gstack already present at ${GSTACK_DIR} (update skipped — non-ff or offline)"
    fi
  else
    echo "ok: gstack already present at ${GSTACK_DIR}"
  fi
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -d "${GSTACK_DIR}/.git" ]]; then
    echo "dry-run: would git -C ${GSTACK_DIR} pull --ff-only origin ${GSTACK_BRANCH}"
  else
    echo "dry-run: would git clone --branch ${GSTACK_BRANCH} ${GSTACK_REPO} ${GSTACK_DIR}"
  fi
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required to install gstack" >&2
  exit 1
fi

if [[ -d "${GSTACK_DIR}/.git" ]]; then
  git -C "$GSTACK_DIR" fetch origin "$GSTACK_BRANCH" >/dev/null 2>&1 || true
  if git -C "$GSTACK_DIR" merge --ff-only "origin/${GSTACK_BRANCH}" >/dev/null 2>&1; then
    echo "ok: gstack updated at ${GSTACK_DIR}"
    exit 0
  fi
  echo "ok: gstack present at ${GSTACK_DIR} (could not ff-only update)"
  exit 0
fi

if [[ -e "$GSTACK_DIR" && ! -d "${GSTACK_DIR}/.git" ]]; then
  echo "error: ${GSTACK_DIR} exists but is not a git clone — set GSTACK_DIR or remove it" >&2
  exit 1
fi

mkdir -p "$(dirname "$GSTACK_DIR")"
if git clone --depth 1 --branch "$GSTACK_BRANCH" "$GSTACK_REPO" "$GSTACK_DIR" >/dev/null 2>&1; then
  echo "ok: gstack cloned to ${GSTACK_DIR}"
  exit 0
fi

if git clone --depth 1 "$GSTACK_REPO" "$GSTACK_DIR" >/dev/null 2>&1; then
  echo "ok: gstack cloned to ${GSTACK_DIR} (default branch)"
  exit 0
fi

echo "error: could not clone gstack from ${GSTACK_REPO}" >&2
echo "  try: git clone ${GSTACK_REPO} ${GSTACK_DIR}" >&2
echo "  or set GSTACK_REPO / GSTACK_DIR / GSTACK_BRANCH" >&2
exit 1
