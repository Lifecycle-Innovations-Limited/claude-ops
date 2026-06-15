---
name: ops-release
description: Publish a new version of the claude-ops ("ops") plugin in one command — bump plugin.json + marketplace.json + package.json, prepend the CHANGELOG, open the release PR, admin squash-merge it to main, and tag vX.Y.Z. Use when shipping a fix/feature that has already merged to main and you want it published so /ops:ops-update can pull it down. This is the publish side; /ops:ops-update is the consume side.
argument-hint: '[--type patch|minor|major] [--version X.Y.Z] [--notes "changelog body"] [--no-ai] [--no-docs] [--no-wiki] [--dry-run] [--no-merge] [--no-tag]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# OPS ► RELEASE — one-command plugin publish

Cuts a new published version of the **claude-ops** plugin: bumps the version in the
three manifests, writes the CHANGELOG, opens a release PR, admin-merges it to
`main`, and pushes the `vX.Y.Z` tag. After it runs, `/ops:ops-update` pulls the new
version down to the box.

> **`ops-release` ships it · `/ops:ops-update` pulls it.** Order: merge your fix PR
> → `/ops:ops-release` → `/ops:ops-update`.

## ⚠️ Run it from the REPO CHECKOUT, not the cache

`bin/ops-release` resolves its targets **relative to its own location**:
`PLUGIN_DIR = <bin>/..`, `REPO_ROOT = <bin>/../..`, and it needs
`REPO_ROOT/.claude-plugin/marketplace.json`. The plugin **cache**
(`~/.claude/plugins/cache/ops-marketplace/ops/<ver>/bin/ops-release`) has **no**
`marketplace.json` above it, so running the cache copy fails with
`not found: …/.claude-plugin/marketplace.json`. Always run the copy inside a
**git checkout** of the repo (the dir that has both `.claude-plugin/marketplace.json`
and `claude-ops/bin/ops-release`).

Resolve it first:

```bash
RELEASE=""
for d in ~/Projects/claude-ops-workspace/claude-ops ~/Projects/claude-ops/claude-ops "$HOME"/Projects/*/claude-ops; do
  if [ -f "$d/.claude-plugin/marketplace.json" ] && [ -x "$d/claude-ops/bin/ops-release" ]; then
    RELEASE="$d/claude-ops/bin/ops-release"; REPO="$d"; break
  fi
done
[ -n "$RELEASE" ] || { echo "no claude-ops checkout with marketplace.json found — clone the repo first"; exit 1; }
echo "using: $RELEASE  (repo: $REPO)"
```

Make sure the checkout's `main` is **up to date and includes the fix you want to
publish** before releasing (`git -C "$REPO" fetch origin && git -C "$REPO" checkout main && git -C "$REPO" pull --ff-only`). The release branches from `origin/main`,
so anything not yet on `origin/main` will NOT be in the release.

## How to run it

Steps 3–5 are outward-facing + hard to reverse (open PR → **admin squash-merge to
`main`** → push a public `vX.Y.Z` tag), so **always dry-run first, show the plan,
confirm, then apply** (Rule 5).

### 1. Dry-run and show the plan

```bash
"$RELEASE" --type patch --notes "<one-line changelog body>" --dry-run
```

Present the output: current → target version, which 3 manifests get bumped, the
CHANGELOG block, and that it will branch `release/vX.Y.Z` → PR → admin-merge → tag.
Pick the bump type from the change: bug/patch fix → `--type patch`; new
backward-compatible feature → `--type minor`; breaking change → `--type major`
(or pin exactly with `--version X.Y.Z`).

### 2. Confirm

Use **AskUserQuestion** before applying:

```
Publish claude-ops <CUR> → <NEW>?  (bumps 3 manifests + CHANGELOG, opens PR, admin-merges to main, tags v<NEW>)
  [Publish release]
  [Dry-run only]
  [Cancel]
```

### 3. Apply

```bash
"$RELEASE" --type patch --notes "<one-line changelog body>"
```

Stream the step-by-step output. On success it prints the PR URL, the merge, and the
tag. Surface the final line verbatim and then tell the user to pull it down:

> **Released v<NEW>. Run `/ops:ops-update` to pull it onto this box.**

## Flags

| Flag                         | Effect                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| `--type patch\|minor\|major` | Semver bump from the current version (default `patch`).                   |
| `--version X.Y.Z`            | Set an exact target version instead of bumping.                           |
| `--notes "…"`                | Markdown body prepended to the CHANGELOG under the new version. Quote it. Overrides the AI changelog. |
| `--no-ai`                    | Skip AI changelog synthesis; fall back to commit subjects under `### Changed`. |
| `--no-docs`                  | Skip the `ops-sync-docs` count/badge reconciliation step.                 |
| `--no-wiki`                  | Skip syncing the GitHub wiki (counts/version + Release-Notes entry).      |
| `--dry-run`                  | Report only; change nothing (still previews the AI changelog). Always run this first. |
| `--no-merge`                 | Open the release PR but do NOT admin-merge it (leave for manual review).  |
| `--no-tag`                   | Skip pushing the `vX.Y.Z` tag.                                            |

## What it touches

1. `claude-ops/.claude-plugin/plugin.json` — `.version`
2. `.claude-plugin/marketplace.json` (repo root) — `.plugins[name==ops].version`
3. `claude-ops/package.json` — `.version` (if present)
4. `claude-ops/CHANGELOG.md` — prepends a `## [X.Y.Z] - <date>` block. By default the
   body is **AI-synthesized** from the commit range in Keep a Changelog style
   (`### Added/Changed/Fixed/Removed`); `--notes` overrides it, `--no-ai` falls back
   to commit subjects.
5. **Docs counts** — runs `bin/ops-sync-docs`, which reconciles every skill/agent
   count, shields.io badge, and version badge across `plugin.json`,
   `marketplace.json`, the READMEs, and `docs/*-reference.md` to the real tree.
   Deterministic and idempotent; never touches historical "up from X/Y" prose.
   Skip with `--no-docs`. (Run `bin/ops-sync-docs` standalone any time you add or
   remove a skill/agent.)
6. **GitHub wiki** — after merge+tag, clones the wiki, syncs its counts/version, and
   prepends a `Release-Notes.md` entry for the new version. Skip with `--no-wiki`.

It works inside an **isolated worktree** (`$REPO_ROOT/.worktrees/release/vX.Y.Z`,
branched from `origin/main`), so a dirty main checkout never leaks unrelated WIP
into the release commit. The worktree is removed on exit.

## Mobile / SSH (Rule 7)

The bin auto-detects a non-TTY and drops colour; its output is already
line-per-fact, so relay it as-is — no tables, no banners.

## Notes

- **PRs target `main`** (claude-ops convention), squash-merged with `--admin`
  because `example` can't self-approve its own-org PRs.
- **Publish ≠ deploy to the box.** The running session won't see the new version
  until `/ops:ops-update` (pull) + `/reload-plugins` (load).
- Sibling: `/ops:ops-update` (pull a published version locally + prune/rewrite).
