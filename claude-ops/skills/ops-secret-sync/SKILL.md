---
name: ops-secret-sync
description: Detects and syncs Doppler→GitHub secrets drift. Compares last-updated timestamps between Doppler and GH repo secrets; flags stale GH secrets (>24h behind Doppler); confirms with user before writing any changes. Safe to run in CI or locally.
argument-hint: "[--repo <owner/repo>] [--project <doppler-proj>] [--config <doppler-env>] [--dry-run]"
allowed-tools:
  - Bash
  - AskUserQuestion
effort: medium
maxTurns: 20
---

# OPS ► SECRET-SYNC

Detect GitHub secrets that are stale relative to Doppler. Confirm before syncing.

## CLI/API Reference

| Command | Purpose |
|---------|---------|
| `gh secret list --repo <owner/repo> --json name,updatedAt` | List GH repo secrets with timestamps |
| `doppler secrets --project <proj> --config <env> --json` | List Doppler secrets with metadata |
| `doppler secrets get <NAME> --project <proj> --config <env> --plain` | Fetch raw value for sync |
| `gh secret set <NAME> --repo <owner/repo>` | Write secret to GH (reads stdin) |

---

## Phase 1 — Resolve arguments

Parse `$ARGUMENTS`:

- `--repo <owner/repo>` → target GitHub repo (required unless registry provides default)
- `--project <proj>` → Doppler project name (required)
- `--config <env>` → Doppler config/environment, e.g. `prd`, `stg` (default: `prd`)
- `--dry-run` → report drift only, never write

If `--repo` is missing, load `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/registry.json` and let the user pick via `AskUserQuestion` (max 4 at a time).

If `--project` is missing, run:

```bash
doppler projects --json 2>/dev/null | jq -r '.[].slug'
```

and let the user pick via `AskUserQuestion` (max 4 at a time).

---

## Phase 2 — Fetch secret inventories

Run in parallel (background both, then collect):

```bash
# GH secrets (names + last-updated timestamps, ISO-8601)
gh secret list --repo <owner/repo> --json name,updatedAt 2>/dev/null
```

```bash
# Doppler secrets (names + metadata including updated_at)
doppler secrets --project <proj> --config <env> --json 2>/dev/null
```

Parse outputs:

**GH format** (array):
```json
[{"name": "INNGEST_SIGNING_KEY", "updatedAt": "2026-04-23T09:12:00Z"}, ...]
```

**Doppler format** (object keyed by name):
```json
{
  "INNGEST_SIGNING_KEY": {"computed": "...", "note": "", "rawValue": "...", "updatedAt": "2026-04-23T10:00:00Z"},
  ...
}
```

> Note: Doppler's `--json` flag returns computed values inline. Use `doppler secrets get <NAME> --plain` only at sync time to avoid holding all values in memory.

---

## Phase 3 — Drift detection

For each secret in Doppler:

1. Check if a GH secret with the same name exists.
2. If yes: compute `delta = doppler_updated_at - gh_updated_at` (seconds).
3. If `delta > 86400` (24 hours): mark as **DRIFTED**.
4. If GH secret does NOT exist: mark as **GH_MISSING** (flag but do not auto-create — requires explicit user confirm).

Build drift report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SECRET-SYNC — <repo> / <proj>/<config>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Doppler secrets : <N>
 GH repo secrets : <M>
 Matched         : <K>
 DRIFTED (>24h)  : <D>
 GH missing      : <G>

 DRIFTED SECRETS
   <NAME>  Doppler: <date>  GH: <date>  delta: <Nd>
   ...

 GH MISSING (in Doppler but absent from GH)
   <NAME>
   ...

 IN SYNC (no action needed)
   <NAME>  last-synced: <date>
   ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If `--dry-run` is set or no drift found: stop here and display report.

---

## Phase 4 — Confirm before syncing (REQUIRED — never skip)

> Rule 5 compliance: every secret write requires per-action confirmation.

If drift was found, ask:

```
AskUserQuestion({
  title: "Sync stale GH secrets from Doppler?",
  question: "Found <D> drifted + <G> missing secrets for <repo>.\n\nSync all, pick specific ones, or skip?",
  options: [
    { value: "all",    label: "Sync all drifted + missing" },
    { value: "pick",   label: "Pick which secrets to sync" },
    { value: "drifted", label: "Sync drifted only (skip missing)" },
    { value: "skip",   label: "Skip — report only" }
  ]
})
```

**On "Pick"**: present drifted secrets 4-at-a-time via `AskUserQuestion` checkboxes. Collect user selections. Proceed only with confirmed names.

**On "Skip"**: stop. Print report path.

---

## Phase 5 — Sync confirmed secrets

For each confirmed secret name:

```bash
doppler secrets get <NAME> --project <proj> --config <env> --plain 2>/dev/null \
  | gh secret set <NAME> --repo <owner/repo>
```

After each write, verify:

```bash
gh secret list --repo <owner/repo> --json name,updatedAt \
  | jq -r '.[] | select(.name == "<NAME>") | .updatedAt'
```

Confirm the `updatedAt` advanced. If it did not advance: report failure for that secret and continue with the rest.

Print per-secret outcome:

```
  synced : INNGEST_SIGNING_KEY  (Doppler 2026-04-23 → GH updated)
  FAILED : SOME_KEY             (gh secret set exited non-zero)
```

---

## Phase 6 — Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SYNC COMPLETE — <repo>
 Synced  : <S> secrets
 Failed  : <F> secrets
 Skipped : <K> secrets
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If failures > 0: suggest `doppler run --project <proj> --config <env> -- gh secret set <NAME> --repo <repo>` as a manual fallback.

---

## Example: recurring drift pattern

This skill exists because of a common drift pattern:

| Project | Secret | Situation |
|---------|--------|-----------|
| `<your-api>` | `INNGEST_SIGNING_KEY` | Rotated in Doppler — GH secret was 24 days stale, CI failures started after the grace period |
| `<your-service>` | `CEREBRAS_API_KEY` | Added to Doppler, never propagated to GH secrets — CI gate failed |
| `<your-service>` | `OPENROUTER_API_KEY` | Same pattern — GH missing, Doppler current |

Running `/ops:secret-sync --repo <your-org>/<your-api> --project <your-api> --config prd` would have surfaced `INNGEST_SIGNING_KEY` as DRIFTED before CI failed.

---

## Safety rules

- **Never** read or print raw secret values in the summary or logs.
- **Never** sync without user confirmation (Rule 5).
- Doppler values flow directly from `doppler secrets get --plain` into `gh secret set` via a pipe — they are never stored in shell variables, temp files, or command substitution.
- `--dry-run` always safe: no writes, report only.

---

## Mobile / SSH (Rule 7)

When `$SSH_CONNECTION` / `$OPS_MOBILE=1` / `$COLUMNS < 80`: skip the banner, emit compact lines:

```
repo: your-org/example-project-api  project: example-project-api/prd
drifted: 2  missing: 1
INNGEST_SIGNING_KEY  doppler: 2026-04-23  gh: 2026-03-30  (24d stale)
CEREBRAS_API_KEY     gh: MISSING
```
