# ops-social-planner — Spec

> Visual, PR-able, engine-agnostic planner that auto-generates the current state of **every**
> ops-socials + ops-marketing planned **post and ad**, **per identity/project, per channel** —
> regardless of the posting engine (Typefully, upload-post, Meta, Google Ads, …).

## Problem

Planned content is scattered across engines with no single review surface, and identities are
easy to confuse (personal founder brand vs project brands). There was no way to _see_ what's
queued, where it lands, when, and why — across channels.

## Goals

1. **One read-only dashboard** of all scheduled posts + ads, grouped by identity/project → channel → time.
2. **Engine-agnostic**: a normalized schema; per-engine fetchers behind a dispatch keyed on
   `marketing.<identity|project>.social.engine.primary`. Adding an engine = adding one fetcher.
3. **Templatable & PR-able**: UI + collector live in the repo; **zero owner data is committed**
   (Rule 0). Real copy/handles/IDs are generated at runtime into `$OPS_DATA_DIR` (outside the repo).
4. **Per-item context**: copy (full, per-platform variant), local + relative time, a derived
   **rationale** (why this slot), media (image/video thumb), and extracted links.
5. **2026 best practices**: zero-build static SPA (instant, embeddable — no `npm install` in a
   plugin), semantic + a11y, light/dark, responsive, shareable URL state, reduced-motion safe.

## Non-goals

- Editing/publishing from the UI (read-only review; mutation stays in ops-socials/ops-marketing
  behind Rule 6 per-message approval).
- Hosting remotely. Localhost only.

## Architecture

```
bin/ops-social-planner            # node, zero-dep. subcommands: collect | serve | open (default: collect+serve+open)
skills/ops-social-planner/
  SKILL.md                        # /ops:ops-social-planner router (+ agent enrichment path: ads via MCP, richer rationale)
  SPEC.md                         # this file
  ui/index.html                   # static SPA shell
  ui/app.js                       # ES module: fetch state.json → render; URL-hash state
  ui/styles.css                   # design tokens, light/dark, responsive
  ui/state.sample.json            # PII-free synthetic fixture so the UI renders in the PR with no creds
```

Runtime data (gitignored / outside repo): `$OPS_DATA_DIR/social-planner/state.json`
(`OPS_DATA_DIR` is resolved at runtime via `lib/registry-path.sh`, honoring `$CLAUDE_PLUGIN_DATA_DIR`).

### Collector flow

1. Read `$PREFS_PATH/preferences.json` → `marketing.social_identities.personal.*` +
   `marketing.projects.*.social`.
2. For each identity/project, dispatch on `social.engine.primary`:
   - `typefully` → GET `https://api.typefully.com/v2/social-sets/{id}/drafts?status=scheduled`
     (+ per-draft GET for full `posts[].text` / media). Auth: `Bearer` (key from `~/.config/typefully/config.json`).
   - `upload-post` → GET `https://api.upload-post.com/api/uploadposts/schedule`. Auth: `Apikey`
     (key resolved from `engine.upload_post.api_key_ref`, e.g. `doppler:project/config/SECRET`).
   - `meta-graph` / `meta-ads` / `google-ads` → **extension hook**. v1 returns
     `{status:"hook-pending"}` (UI shows the Ads tab with an honest "collector hook pending"
     state — never fabricated data).
   - `null` / `unprovisioned` → emitted as an identity with 0 items + `status:"unprovisioned"`.
3. Normalize → `deriveRationale()` per item (slot-time × channel norm × launch-sequence keywords).
4. Write `state.json`; serve `ui/` + `state.json` over localhost; open browser.

### Normalized schema (v1)

```jsonc
{ "generated_at","timezone",
  "engine_status": { "<engine>": {"ok":bool,"count":int,"reason":str?} },
  "identities": [ { "id","label","kind":"personal|project","engine","status",
      "channels":[...], "items":[ Item ] } ] }
// Item: { id, identity, channel, kind:"post|ad", type:"photo|video|text|thread",
//         scheduled_at, copy, thread?:[...], rationale, media:[{type,url,thumb}],
//         links:[...], char_count, source:{engine,ref,edit_url?} }
```

## Rationale derivation (heuristic, deterministic)

- **Slot (UTC hour)** → audience window label (07 morning-authority, 11 build-in-public,
  13 US-morning engagement, 15–16 LinkedIn professional, 17–18 evening casual).
- **Channel norm** → format intent (LI long-form authority, X hook/thread, Threads casual,
  IG visual+link-in-bio, Reddit value-first, YouTube SEO title, GBP local).
- **Sequence** (keyword) → `teaser` ("almost here", "this week", "👀") / `launch`
  ("it's here", "is live", "download") / `education` (default).
  Agent path (`/ops:ops-social-planner` via SKILL.md) can replace heuristic rationale with an
  LLM-written one and pull ads through MCP (Meta/Google) before regenerating.

## Best-practice checklist (2026)

- Zero build step; native ES modules; no runtime framework dependency.
- Semantic HTML, full keyboard nav, visible focus, `aria-*`, `prefers-reduced-motion`,
  `prefers-color-scheme` + manual toggle persisted to `localStorage`.
- Fluid type (`clamp`), CSS grid + container-ish responsive, design tokens via custom properties.
- Shareable state in URL hash (`#id=<project>&channel=<channel>&view=posts`).
- Read-only; no secrets in client; `state.json` served from a localhost-bound server only.
- Defensive: renders from `state.sample.json` when no live state exists.

## Verification

- `bin/ops-social-planner collect` writes valid JSON; `engine_status` reflects reality.
- UI renders sample fixture with no creds; renders live state with creds.
- `tests/test-no-secrets.sh` passes (no owner data committed).
