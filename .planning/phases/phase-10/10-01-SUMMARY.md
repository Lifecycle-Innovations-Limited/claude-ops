---
phase: 10-google-ads
plan: "01"
subsystem: ops-marketing
tags: [google-ads, oauth2, credentials, setup-wizard, dashboard]
dependency_graph:
  requires: []
  provides: [google-ads-credential-resolution, google-ads-token-refresh, google-ads-setup-flow, google-ads-dashboard-gather]
  affects: [ops-marketing/SKILL.md, skills/setup/SKILL.md, bin/ops-marketing-dash]
tech_stack:
  added: []
  patterns: [3-tier-credential-cascade, oauth2-refresh-token, localhost-redirect-server, parallel-gather-functions]
key_files:
  created: []
  modified:
    - claude-ops/skills/ops-marketing/SKILL.md
    - claude-ops/skills/setup/SKILL.md
    - claude-ops/bin/ops-marketing-dash
decisions:
  - "Used two-call AskUserQuestion pattern for marketing service selection to comply with Rule 1 (max 4 options)"
  - "Kept google-ads credential resolution fully in SKILL.md (no new bin scripts) matching existing zero-dependency pattern"
  - "gather_google_ads uses searchStream GAQL for campaign summary matching existing gather_X function pattern"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
requirements_completed: [GADS-07]
---

# Phase 10 Plan 01: Google Ads Credential Foundation Summary

Google Ads auth foundation wired via 3-tier credential cascade (userConfig → env → Doppler), full OAuth2 setup flow in setup wizard, and campaign pre-gather in dashboard script.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add Google Ads credential resolution and token refresh to SKILL.md | 2d69fca | claude-ops/skills/ops-marketing/SKILL.md |
| 2 | Add Google Ads OAuth setup flow to setup wizard and pre-gather to dashboard script | f9c93e0 | claude-ops/skills/setup/SKILL.md, claude-ops/bin/ops-marketing-dash |

## What Was Built

### Task 1 — ops-marketing/SKILL.md

- Added `google_ads_*` keys to Runtime Context userConfig list (6 keys)
- Added complete `### Google Ads` credential resolution block with:
  - 6 variables: `GADS_DEV_TOKEN`, `GADS_CLIENT_ID`, `GADS_CLIENT_SECRET`, `GADS_REFRESH_TOKEN`, `GADS_CUSTOMER_ID`, `GADS_LOGIN_CUSTOMER_ID`
  - Doppler fallback for `REFRESH_TOKEN` and `DEV_TOKEN`
  - Customer ID dash-stripping (`${GADS_CUSTOMER_ID//-/}`)
  - Access token refresh via `oauth2.googleapis.com/token`
  - `GADS_HEADERS` array with optional MCC `login-customer-id` header
- Updated routing table entry: `google-ads, gads`
- Added `## google-ads` section with credential and token guard checks
- Updated `## setup` auto-scan to include `GOOGLE_ADS_*` env vars, shell profile grep pattern, Doppler filter pattern, Dashlane, keychain, and Chrome history
- Added Google Ads setup paragraph describing the OAuth2 flow and smoke test

### Task 2 — setup/SKILL.md + bin/ops-marketing-dash

**setup/SKILL.md:**
- Restructured marketing AskUserQuestion into two sequential calls to comply with Rule 1 (max 4 options) — first call: Klaviyo, Meta Ads, Google Ads, More...; second call: GA4, GSC
- Added complete `#### Google Ads` sub-section in Step 3j with:
  - Step A: developer token (keep/reconfigure if found in auto-scan)
  - Step B: OAuth2 client ID + secret
  - Step C: browser OAuth flow via localhost:8080 redirect server (`run_in_background: true`)
  - Step D: customer ID discovery via `listAccessibleCustomers` with MCC auto-detection
  - Step E: smoke test against `listAccessibleCustomers`
  - Step F: save to `preferences.json` under `marketing.google_ads.*`
- Added `google-ads`, `gads` shortcuts to routing table
- Updated status summary line to include `google-ads`
- Updated auto-scan block to include `GOOGLE_ADS_*` vars

**bin/ops-marketing-dash:**
- Added 6-var credential resolution block after GSC block
- Added Doppler fallback for `GADS_REFRESH_TOKEN`
- Added `GADS_CUSTOMER_ID` dash-stripping
- Added `gather_google_ads()` function with:
  - Empty credential guard (returns "null" if unconfigured)
  - Access token refresh via OAuth2 token endpoint
  - GAQL `searchStream` query for campaign summary (last 7 days, top 20 by spend)
  - Optional `login-customer-id` header for MCC accounts
- Added `GADS_DATA=$(gather_google_ads) &` to parallel execution block
- Added `google_ads: $google_ads` to final JSON output

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

One minor adaptation: the plan's suggested `google-ads, gads` routing table entry in setup/SKILL.md was implemented as two separate backtick-wrapped values (`` `google-ads`, `gads` ``) to match the existing routing table formatting convention. This satisfies the plan's intent (both aliases route to Step 3j Google Ads).

## Threat Model Compliance

| Threat | Status |
|--------|--------|
| T-10-01: refresh_token in preferences.json | Mitigated — all token placeholders use `<YOUR_*>` format; Rule 0 enforced; no real tokens in committed files |
| T-10-02: localhost:8080 OAuth redirect | Accepted — documented in setup flow as standard desktop OAuth pattern |
| T-10-03: access_token in memory | Accepted — ephemeral, HTTPS only |
| T-10-04: developer_token in curl commands | Mitigated — stored in preferences.json not source; placeholder format used in examples |

## Known Stubs

None — all credential resolution, token refresh, and data gather patterns are fully wired. Actual Google Ads sub-command implementations (campaigns, keywords, search terms, budget optimization) are stubbed in `## google-ads` with a note that Plans 02 and 03 define them. This is intentional per the plan design — this plan establishes auth only.

## Threat Flags

None — no new network endpoints or auth paths beyond what was planned.

## Self-Check: PASSED

- `claude-ops/skills/ops-marketing/SKILL.md` — modified, committed 2d69fca
- `claude-ops/skills/setup/SKILL.md` — modified, committed f9c93e0
- `claude-ops/bin/ops-marketing-dash` — modified, committed f9c93e0
- Commit 2d69fca exists in git log
- Commit f9c93e0 exists in git log
- `bash -n claude-ops/bin/ops-marketing-dash` exits 0
- `grep -c "GADS_" claude-ops/skills/ops-marketing/SKILL.md` returns 21
