---
name: ops-ship
description: One-command full release chain for the claude-ops ("ops") plugin — sweep and admin-merge every open PR, then publish a new version (bump plugin.json + marketplace.json registry + package.json + CHANGELOG, open release PR, admin-merge, tag), then pull it onto the box. Use when you have one or more merged-ready PRs and want to ship a new published version in a single step instead of merging PRs by hand and then releasing. Combines the PR sweep + /ops:ops-release + /ops:ops-update.
argument-hint: '[--type patch|minor|major] [--version X.Y.Z] [--notes "changelog body"] [--base BRANCH] [--no-update] [--dry-run]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# OPS ► SHIP — merge-all-PRs → release → update, in one command

The whole release chain in a single shot:

1. **Sweep** — admin squash-merge **every open, non-draft PR** targeting the base
   branch (default `main`), **overriding required checks/reviews** (`gh pr merge
--admin`). A failed merge aborts before the release — no partial ship.
2. **Release** — delegates to `bin/ops-release`: bump `plugin.json` +
   `marketplace.json` registry + `package.json` + `CHANGELOG`, open the release PR,
   admin-merge to `main`, tag `vX.Y.Z`.
3. **Update** — runs the installed `ops-update` to pull the new version onto this
   box (skip with `--no-update`).

> `ops-ship` = sweep + `/ops:ops-release` + `/ops:ops-update` in one. For just the
> publish step use `/ops:ops-release`; for just the pull step use `/ops:ops-update`.

## ⚠️ It admin-merges EVERY open non-draft PR — review the sweep first

By design the sweep is aggressive: it admin-merges **all** open non-draft PRs on the
base branch, bypassing required checks (red CI, missing reviews) — exactly what you
want for a trusted solo/own-org repo, dangerous if an unrelated or half-baked PR is
open. So **always dry-run first and show which PRs it will merge** before applying
(Rule 5 — bulk merge + outward-facing release + tag is high-impact and hard to
reverse). It only skips drafts.

## ⚠️ Run it from the REPO CHECKOUT, not the cache

Like `ops-release`, `ops-ship` resolves its targets relative to its own path and
needs `REPO_ROOT/.claude-plugin/marketplace.json`, which the plugin **cache** lacks.
Run the copy inside a git checkout of the repo:

```bash
SHIP=""
for d in ~/Projects/claude-ops-workspace/claude-ops ~/Projects/claude-ops/claude-ops "$HOME"/Projects/*/claude-ops; do
  if [ -f "$d/.claude-plugin/marketplace.json" ] && [ -x "$d/claude-ops/bin/ops-ship" ]; then
    SHIP="$d/claude-ops/bin/ops-ship"; break
  fi
done
[ -n "$SHIP" ] || { echo "no claude-ops checkout with marketplace.json found"; exit 1; }
```

## How to run it

### 1. Dry-run — show the sweep + the version bump

```bash
"$SHIP" --type patch --dry-run
```

Present: the list of open PRs it will admin-merge, the version bump (current → new),
the manifests touched, and the CHANGELOG block. (`--notes` defaults to a bullet list
of the merged PR titles; pass `--notes "…"` to override.)

### 2. Confirm

Use **AskUserQuestion** before applying (this merges PRs AND publishes):

```
Ship: admin-merge N open PR(s) on main, then release <CUR> → <NEW> + tag?
  [Ship it]
  [Dry-run only]
  [Cancel]
```

### 3. Apply

```bash
"$SHIP" --type patch                 # or --version X.Y.Z, --notes "…", --no-update
```

Stream the step output (sweep → release → update). On success it ends with the new
tag and the reload reminder. Surface the final line verbatim:

> **Restart Claude Code (or run `/reload-plugins`) to load v<NEW>.**

## Flags

| Flag                         | Effect                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `--type patch\|minor\|major` | Semver bump for the release (default `patch`).                                                |
| `--version X.Y.Z`            | Exact target version instead of bumping.                                                      |
| `--notes "…"`                | CHANGELOG body. Defaults to a bullet list of the merged PR titles.                            |
| `--base BRANCH`              | Base branch for the PR sweep only (must be `main`; `ops-release` always publishes to `main`). |
| `--no-update`                | Don't run `ops-update` afterwards (publish only).                                             |
| `--dry-run`                  | Report only — list PRs + the bump, change nothing. Always run this first.                     |

## Notes

- **PRs target `main`** and are squash-merged with `--admin` (own-org PRs can't be
  self-approved; admin bypasses the review/required-check gates).
- **REST quota:** the sweep and `ops-release` use `gh` (GitHub REST). If REST is
  exhausted (HTTP 403 rate-limit), wait for the reset window — `ops-ship` aborts
  before releasing if any merge fails rather than partial-shipping.
- **Publish ≠ loaded.** The running session won't see the new version until
  `ops-update` (pull, run automatically unless `--no-update`) **and**
  `/reload-plugins` (load).
- Siblings: `/ops:ops-release` (publish only), `/ops:ops-update` (pull only).
