---
name: ops-update
description: "OPS on-demand: This skill should be used when the user asks to \"update ops plugin\", \"upgrade…"
argument-hint: '[--dry-run|--force|--to X.Y.Z|--no-prune|--no-patches|--no-rewrite|--no-localsync]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# OPS ► UPDATE — one-command local plugin upgrade

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Upgrades the local **claude-ops** plugin to the newest version published in the
`ops-marketplace` catalogue, then leaves the box clean: no stale cache dirs, no
dangling version-pinned paths.

## Automatic daily check (detect only, never auto-installs)

`bin/ops-update-check` runs daily from the ops daemon (`update-check` service)
and answers one question: is a newer version published? It writes the verdict to
`~/.claude/state/ops-update/update-available.json` and exits **3** when an
update exists, **0** when current.

**It never installs anything.** Detection and application are deliberately split:
a background job that swapped the plugin out mid-session would break a working
install at the worst possible moment. Applying is always `ops-update`, run on
the user's word.

When you see that an update is available — because the state file says so, or
because the user asks — surface it once and offer to apply it:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/ops-update-check" --json    # current verdict, throttled to daily
"${CLAUDE_PLUGIN_ROOT}/bin/ops-update-check" --force   # recheck now, ignoring the throttle
```

Then a single `AskUserQuestion`: `[Update now]` `[Show what changed]` `[Not now]`.
Only on `Update now` do you run `bin/ops-update`. Never chain the two, and never
apply an update the user has not just agreed to in that exchange.

Flags: `--json` (verdict on stdout), `--no-fetch` (compare against the catalogue
already on disk, no network), `--force` (ignore the once-a-day throttle),
`--quiet` (write state, print nothing — how the daemon runs it). Override the
cadence with `$OPS_UPDATE_CHECK_INTERVAL` in seconds.

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
10. **Companions** — `bin/ops-update` step 9 runs `scripts/install-companions.sh`
    against `plugin-dependencies.json`. Every companion with `required: true` is
    co-installed when missing and updated on every ops-update:
    - **desktop-act** — `/ops:desktop` + captcha cascade
    - **gsd** — `/ops:flow` project mode, `/ops:projects`, `/ops:go`
    - **gstack** — skills clone for `/ops:flow` ad-hoc (`/spec` `/review` `/qa` `/ship`)
    - **superpowers** — merge / orchestrate / triage checkpoints
    - **feature-dev** — `/ops:ops-feature-dev`
    Skip only with `--no-companions` or `OPS_SKIP_COMPANIONS=1`.

```bash
# manual companion pass
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-companions.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-companions.sh --status"
# skip from ops-update:
${CLAUDE_PLUGIN_ROOT}/bin/ops-update --no-companions
```

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
| `--no-companions` | Skip required companion co-install/update (desktop-act, gsd, gstack, superpowers, feature-dev). |

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
