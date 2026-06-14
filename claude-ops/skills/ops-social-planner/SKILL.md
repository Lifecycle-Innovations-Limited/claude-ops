---
name: ops-social-planner
description: Visual, engine-agnostic planner for all scheduled social posts and ads across every identity and project. Auto-generates the current state of ops-socials + ops-marketing planned content per project, per channel, regardless of posting engine (Typefully, upload-post, Meta, Google Ads), and serves a clean local web UI. Use when the user says social planner, content calendar, what's scheduled, planned posts, show my queue, posting schedule, social dashboard, or runs /ops-social-planner. Read-only — never publishes (mutation stays in /ops-socials + /ops-marketing behind per-message approval).
argument-hint: '[--project <id>] [--collect-only] [--port <n>] [--no-open]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - mcp__typefully__typefully_list_drafts
  - mcp__typefully__typefully_get_draft
  - mcp__typefully__typefully_get_queue
  - mcp__upload-post__list_scheduled
  - mcp__upload-post__list_profiles
effort: medium
maxTurns: 25
---

# /ops-social-planner — engine-agnostic planned-content viewer

Read-only dashboard of **every** scheduled post and ad, grouped **identity/project → channel → time**,
**regardless of posting engine**. Personal/founder identity and project brands stay strictly separated
(see `/ops-socials` identity rules). See `SPEC.md` for the full design.

## What it does

1. `bin/ops-social-planner collect` reads `$PREFS_PATH/preferences.json`
   (`marketing.social_identities.personal.*` + `marketing.projects.*.social`), dispatches a
   **per-engine fetcher** keyed on `social.engine.primary`, normalizes to one schema, and writes
   `$OPS_DATA_DIR/social-planner/state.json` (**owner data — never committed**, Rule 0).
2. It then serves the static UI (`ui/`) on localhost and opens the browser.

## Engines

| `engine.primary`          | Source                                                                                 | Status                       |
| ------------------------- | -------------------------------------------------------------------------------------- | ---------------------------- |
| `typefully`               | `GET /v2/social-sets/{id}/drafts` (Bearer; key from `~/.config/typefully/config.json`) | ✅ wired                     |
| `upload-post`             | `GET /api/uploadposts/schedule` (Apikey; key from `engine.upload_post.api_key_ref`)    | ✅ wired                     |
| `meta-graph` / `meta-ads` | Graph Ads API per project BM/token                                                     | 🔌 hook (UI shows "pending") |
| `google-ads`              | GAQL per project customer id                                                           | 🔌 hook                      |
| `null` / unprovisioned    | —                                                                                      | shown fail-closed (0 items)  |

Adding an engine = adding one `fetch<Engine>()` in `bin/ops-social-planner` + a dispatch branch. No UI change.

## Run it

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/ops-social-planner"                 # collect → serve → open
"${CLAUDE_PLUGIN_ROOT}/bin/ops-social-planner" collect          # regenerate state.json only
"${CLAUDE_PLUGIN_ROOT}/bin/ops-social-planner" serve --port 7937  # serve existing state
```

The UI renders `ui/state.sample.json` (synthetic, PII-free) when no live state exists, so it works
with zero credentials — useful for the PR preview.

## Agent enrichment path (optional, when invoked as a skill)

The headless collector covers posts on wired engines. When richer output is wanted, the agent can:

- Pull **ads** via MCP (`mcp__meta__*`, Google Ads) per project and merge `kind:"ad"` items into `state.json`.
- Replace the heuristic `rationale` with an LLM-written one (slot + sequence + channel intent).
- Re-run `serve` to refresh.
  Do **not** publish or edit from here — routing/mutation belongs to `/ops-socials` + `/ops-marketing`.

## Guarantees

- Read-only. No secrets in the client. Server binds `127.0.0.1` only.
- Identity separation honored: personal vs project never merged; unprovisioned projects render fail-closed.
- No owner data committed — only `ui/` + `bin/` + `SPEC.md` + the synthetic fixture.
