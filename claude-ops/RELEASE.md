# Releasing claude-ops

The `ops` plugin is distributed through the **`ops-marketplace`** Claude Code
marketplace, which is this repo. A release = bump the version in lockstep across
every version-bearing file, land it on `main`, then refresh installs.

## TL;DR — use the script

```bash
# from anywhere inside the repo (script auto-locates the repo root)
claude-ops/bin/ops-release                 # patch bump (X.Y.Z -> X.Y.Z+1), auto-merge + tag
claude-ops/bin/ops-release --type minor    # minor bump
claude-ops/bin/ops-release --type major    # major bump
claude-ops/bin/ops-release --version 3.0.0 # explicit version
claude-ops/bin/ops-release --no-merge      # open the PR, leave it for review
claude-ops/bin/ops-release --dry-run       # preview only, touch nothing
```

After the release lands, refresh the local install:

```
/plugin marketplace update ops-marketplace
# then update the `ops` plugin when prompted
```

## What a release changes

| File                                                    | Field                           | Role                                                       |
| ------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `claude-ops/.claude-plugin/plugin.json`                 | `.version`                      | the plugin's own version                                   |
| `.claude-plugin/marketplace.json` (repo root)           | `.plugins[name=="ops"].version` | the **marketplace registry** entry Claude Code reads       |
| `claude-ops/package.json` (auto-detected; or repo root) | `.version`                      | the `claude-ops-bin` npm package (bin-script runtime deps) |
| `claude-ops/CHANGELOG.md`                               | new `## [X.Y.Z] - DATE` section | human-readable history (Keep a Changelog + SemVer)         |

`ops-release` keeps all of these in sync — never bump them by hand, or the
marketplace, package, and plugin disagree and installs resolve the wrong version.
(`package.json` had previously drifted to 2.15.0 because the old release path
never touched it; it is now bumped in lockstep.)

## What the script does (flow)

1. `git fetch origin`, read current version from `plugin.json`.
2. Compute the next version (`--type` bump or `--version`).
3. Create an **isolated worktree** off `origin/main` (the shared main checkout is
   never touched — safe while daemons/other agents are live).
4. Bump `plugin.json` + `marketplace.json` + `package.json` (via `jq`), prepend
   the CHANGELOG section (notes from `--notes`, else commit subjects since the
   last CHANGELOG bump), and validate the JSON.
5. Commit `release: vX.Y.Z`, push the branch, open a PR to `main`.
6. Unless `--no-merge`: squash-merge `--admin`, then (unless `--no-tag`) create
   and push the `vX.Y.Z` git tag.
7. Remove the worktree.

## Versioning

Semantic Versioning: **major** = breaking change to skills/commands/hook
contracts; **minor** = new skill/command/agent or backward-compatible feature;
**patch** = fixes, tweaks, docs, internal tooling.

## Manual fallback

If `ops-release` is unavailable, do the same by hand in a worktree off
`origin/main`: bump the three JSON `version` fields (plugin.json,
marketplace.json, package.json), add the CHANGELOG section, `commit --no-verify`,
push, `gh pr create --base main`, `gh pr merge --squash --admin`, `git tag
vX.Y.Z && git push origin vX.Y.Z`.
