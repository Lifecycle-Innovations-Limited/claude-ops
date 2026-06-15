---
name: ops-update
description: Upgrade the local claude-ops ("ops") plugin to the latest published version in one command — refresh the marketplace catalogue, update the installed plugin (with stale-cache force-reinstall fallback), reapply local cache patches, prune every old cache version, rewrite stale version-pinned paths, run per-version migrations, then prompt to reload. Use when the box is on an older plugin version, after a release, or when the cache looks stale.
argument-hint: '[--dry-run|--force|--to X.Y.Z|--no-prune|--no-patches|--no-rewrite|--no-localsync]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# OPS ► UPDATE — one-command local plugin upgrade

Upgrades the local **claude-ops** plugin to the newest version published in the
`ops-marketplace` catalogue, then leaves the box clean: no stale cache dirs, no
dangling version-pinned paths.

The workhorse is **`${CLAUDE_PLUGIN_ROOT}/bin/ops-update`**. It runs a 9-step loop:

1. **Refresh catalogue** — `claude plugin marketplace update ops-marketplace` (git-pulls the clone).
2. **Resolve target** — newest version from the refreshed `marketplace.json` (or `--to X.Y.Z`).
3. **Update plugin** — `claude plugin update ops@ops-marketplace`, with a force-reinstall fallback (`rm` cache + `claude plugin install`) for the Claude Code bug where `update` reports "already latest" while the cache stays stale ([anthropics/claude-code#61954](https://github.com/anthropics/claude-code/issues/61954)).
4. **Reapply patches** — runs idempotent scripts in `scripts/cache-patches/` against the new cache (empty when all fixes are upstream — the desired state).
5. **Prune** — deletes every old `cache/ops-marketplace/ops/<ver>/` except the new one.
6. **Rewrite** — fixes stale `cache/.../ops/<oldver>/` paths in live configs/scripts/systemd units only (never logs, memory, or transcripts — those use `${CLAUDE_PLUGIN_ROOT}` at runtime so they self-resolve).
7. **Migrate** — runs `ops-post-update-migrate` (idempotent, per-version). It also maintains a stable `cache/.../ops/current/` directory (rsynced from the new version and repointed in `installed_plugins.json`) so Claude Code GC'ing the old versioned dir mid-session never causes "Plugin directory does not exist" hook errors.
8. **Local sync** — if a linked local source checkout of this repo is present under `~/Projects`, fast-forwards its `main` to `origin/main` so a dev clone never silently drifts behind the published release. Acts only on a clean `main` (never clobbers uncommitted WIP, a feature branch, or unpushed commits); a no-op when no checkout exists. Skip with `--no-localsync`.
9. **Report** — old→new, what changed, and that a restart / `/reload-plugins` is needed to load it.

## How to run it

Steps 5–6 are destructive (prune + rewrite), so **always dry-run first, show the
plan, confirm, then apply** (Rule 5).

### 1. Dry-run and show the plan

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-update --dry-run
```

Present the output: current → target version, which cache versions would be
pruned, which files would be rewritten. If the dry-run shows
`already on <ver>` and nothing to prune/rewrite, tell the user the box is
already current and stop (offer `--force` only if they suspect a stale cache).

### 2. Confirm

Use **AskUserQuestion** before applying:

```
Upgrade local claude-ops <CUR> → <NEW>?  (prunes N old cache versions, rewrites M files)
  [Apply upgrade]
  [Force re-materialise cache]   ← only if same-version stale-cache is suspected
  [Cancel]
```

### 3. Apply

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-update          # or: --force
```

Stream the step-by-step output. On success, surface the final line verbatim:

> **Restart Claude Code (or run `/reload-plugins`) to load v<NEW>.**

The running session will NOT see the new version until reload — this is a Claude
Code constraint, not a failure.

## Flags

| Flag           | Effect                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `--dry-run`    | Report only; change nothing. Always run this first.                     |
| `--force`      | Force-reinstall even when the CLI claims "already latest" (bug #61954). |
| `--to X.Y.Z`   | Target a specific version instead of the catalogue's newest.            |
| `--no-prune`     | Keep old cache versions.                                              |
| `--no-patches`   | Skip the cache-patch reapply step.                                    |
| `--no-rewrite`   | Skip the stale-version-path rewrite step.                            |
| `--no-localsync` | Skip fast-forwarding a linked local source checkout's `main`.        |

## Mobile / SSH (Rule 7)

The bin auto-detects a non-TTY and drops colour; its output is already
line-per-fact, so relay it as-is — no tables, no banners.

## Notes

- **Idempotent.** Re-running on an already-current box is a near no-op (resolve →
  "already on <ver>" → nothing to prune/rewrite/migrate).
- **Public repo / no secrets** (Rule 0): the script reads only `$HOME/.claude/plugins`
  state; it writes no personal data.
- To publish a new version first, see `${CLAUDE_PLUGIN_ROOT}/bin/ops-release`
  (bumps `plugin.json` + `marketplace.json` + `CHANGELOG`, opens the release PR,
  tags). `ops-release` ships it; `ops-update` pulls it down locally.
