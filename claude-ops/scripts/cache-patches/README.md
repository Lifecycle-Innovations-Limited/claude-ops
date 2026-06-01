# cache-patches — local plugin-cache patch registry

`ops-update` (step 4) runs every `*.sh` in this directory against the freshly
materialised plugin cache, **in filename order**, after a plugin upgrade.

Use this for fixes that must live on the box *before they are merged upstream*
— e.g. a hotfix to a `bin/` script or `SKILL.md` that the new cache version
overwrites on every `claude plugin update`. Once the fix ships in a release,
delete the patch here (the upstream version supersedes it).

## Contract

Each patch script:

- Receives the new cache dir as `$1` (e.g. `~/.claude/plugins/cache/ops-marketplace/ops/2.19.0`).
- **MUST be idempotent** — gate every edit on a sentinel string so a re-run is a no-op.
- Should exit `0` on success; a non-zero exit is logged as a non-fatal warning.
- Must not touch anything outside the cache dir it is handed.

## Example

```bash
#!/usr/bin/env bash
set -euo pipefail
CACHE="${1:?cache dir required}"
target="$CACHE/bin/some-script"
sentinel="# PATCH-XYZ applied"
grep -qF "$sentinel" "$target" && exit 0          # already patched → no-op
printf '\n%s\n' "$sentinel" >> "$target"          # apply, gated by sentinel
```

This registry is intentionally empty when every local fix has been released
upstream — that is the desired steady state.
