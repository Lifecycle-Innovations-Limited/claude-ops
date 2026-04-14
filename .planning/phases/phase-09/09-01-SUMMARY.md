---
phase: "09"
plan: "01"
subsystem: ci-release
tags: [ci, github-actions, release, linux, os-compat]
dependency_graph:
  requires: []
  provides: [automated-github-release, linux-ci-coverage]
  affects: [.github/workflows/ci.yml, .github/workflows/release.yml]
tech_stack:
  added: [actions/create-release@v1, ubuntu-24.04 runner]
  patterns: [OS matrix strategy, awk CHANGELOG parsing, IS_MACOS guard pattern]
key_files:
  created:
    - .github/workflows/release.yml
  modified:
    - .github/workflows/ci.yml
    - claude-ops/tests/test-bin-scripts.sh
    - claude-ops/tests/test-skills-lint.sh
decisions:
  - "Used actions/create-release@v1 (stable, no deps) over gh CLI approach"
  - "IS_MACOS guard checks unguarded macOS tool usage on Linux rather than wrapping individual calls — bin scripts already have their own guards internally"
  - "prerelease flag auto-detected via contains(github.ref_name, '-') for semver pre-release tags"
metrics:
  duration: "~12 minutes"
  completed: "2026-04-14T08:44:31Z"
  tasks_completed: 2
  files_changed: 4
---

# Phase 09 Plan 01: CI & Release Pipeline Summary

Automated release pipeline via GitHub Actions tag push + Linux CI coverage on ubuntu-24.04.

## What Was Built

### Task 1: ubuntu-24.04 CI Matrix + OS-Guard Test Scripts

**`.github/workflows/ci.yml`** — Added matrix strategy `[ubuntu-latest, ubuntu-24.04]` to the existing `lint-and-check` job. Added new `test-suite` job (depends on `lint-and-check`) that runs `claude-ops/tests/run-all.sh` on both OS targets with `shellcheck` pre-installed.

**`claude-ops/tests/test-bin-scripts.sh`** — Added `IS_MACOS` detection at the top. Added check block that verifies on Linux that no bin script contains unguarded calls to `security find-generic-password`, `pbcopy`, `osascript`, or `defaults read`. On macOS, it simply acknowledges macOS tool usage.

**`claude-ops/tests/test-skills-lint.sh`** — Added `IS_MACOS` detection at the top. All `grep` calls already use `-E` (POSIX extended regex) — no `-P` GNU-only flags were present. `find` calls already use POSIX-compatible flags.

### Task 2: Automated Release Workflow

**`.github/workflows/release.yml`** — New workflow triggering on `v*` tag push:
1. Extracts version from tag (`${GITHUB_REF_NAME#v}`)
2. Parses `claude-ops/CHANGELOG.md` with awk to extract the section for the pushed version
3. Falls back to generic notes if version not found in CHANGELOG
4. Updates `"version"` field in both `claude-ops/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` via `sed -i`
5. Commits version bumps back to `main` with `[skip ci]` to prevent loop
6. Creates GitHub Release via `actions/create-release@v1` with parsed notes; sets `prerelease: true` for tags containing `-`

## Commits

| Hash | Message |
|------|---------|
| e0fd0b6 | feat(09-01): add ubuntu-24.04 CI matrix + OS-guard test scripts |
| 69e87c8 | feat(09-01): create automated release workflow |

## Deviations from Plan

None — plan executed exactly as written.

## Threat Mitigations Applied

| Threat ID | Mitigation |
|-----------|-----------|
| T-09-01-01 | Commit-back step uses `--quiet` no-op check; `[skip ci]` prevents loop; limited to version field only |
| T-09-01-03 | `permissions: contents: write` scoped minimally — no secrets/packages permissions |

## Self-Check

- [x] `.github/workflows/ci.yml` — modified, matrix present
- [x] `.github/workflows/release.yml` — created, `create-release` job present
- [x] `claude-ops/tests/test-bin-scripts.sh` — IS_MACOS guard added
- [x] `claude-ops/tests/test-skills-lint.sh` — IS_MACOS guard added
- [x] Both test scripts pass locally (176 skills checks + 68 bin checks, 0 failures)
- [x] release.yml passes `bash -n` syntax check

## Self-Check: PASSED
