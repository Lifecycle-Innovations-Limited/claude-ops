---
phase: 10-google-ads
plan: "02"
subsystem: ops-marketing
tags: [google-ads, gaql, searchstream, campaign-dashboard, search-terms, budget-recommendations]
dependency_graph:
  requires: [google-ads-credential-resolution, google-ads-token-refresh]
  provides: [google-ads-dashboard, google-ads-search-terms-report, google-ads-budget-recommendations]
  affects: [ops-marketing/SKILL.md]
tech_stack:
  added: []
  patterns: [gaql-searchstream, micros-to-dollars-awk, division-by-zero-guards, banner-table-output]
key_files:
  created: []
  modified:
    - claude-ops/skills/ops-marketing/SKILL.md
decisions:
  - "Combined Tasks 1 and 2 into single SKILL.md edit since both modify the same ## google-ads section — committed atomically as Task 1 commit (116eaf8)"
  - "Used jq @tsv + while-read pipeline for table rendering to avoid subshell output loss in bash"
  - "Negative keyword candidates use jq select() filter inline rather than a second API call"
  - "Impact percentage for budget recommendations uses awk to avoid integer division edge cases"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 1
requirements_completed: [GADS-01, GADS-04, GADS-06]
---

# Phase 10 Plan 02: Google Ads Read-Only Operations Summary

Three read-only Google Ads sub-commands wired via GAQL `searchStream`: campaign performance dashboard (last 7 days), Search Terms Report with negative keyword candidates (last 30 days), and budget optimization recommendations — all monetary values converted from micros to dollars with 2 decimal places.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement Google Ads campaign dashboard (GADS-01) | 116eaf8 | claude-ops/skills/ops-marketing/SKILL.md |
| 2 | Implement Search Terms Report and budget recommendations (GADS-04, GADS-06) | 116eaf8 | claude-ops/skills/ops-marketing/SKILL.md |

Note: Both tasks were implemented in a single atomic edit to the `## google-ads` section and committed together as 116eaf8. No work was lost or skipped — all content for both tasks is present.

## What Was Built

### Sub-command Routing Table

Added a routing table immediately after the credential/token-refresh guard in `## google-ads`:

| Input | Action |
|---|---|
| (empty), dashboard, overview | Campaign dashboard — last 7 days |
| search-terms, terms | Search Terms Report — last 30 days |
| budget-recs, recommendations, recs | Budget recommendations from Google |
| campaigns, manage | Plan 03 |
| keywords, kw | Plan 03 |

### Dashboard Sub-command (GADS-01)

- GAQL query: `campaign`, `campaign_budget`, and `metrics.*` fields for last 7 days, top 20 by spend, status != REMOVED
- Summary header: Total Spend, Total Conversions, Overall ROAS (computed via awk with division-by-zero guard)
- Per-campaign table: Campaign | Status | Budget/day | Spend | Impr | Clicks | CTR | Conv | ROAS
- All monetary values: `costMicros / 1000000` via awk `printf "%.2f"`
- CTR: `clicks / impressions * 100` with zero-impressions guard
- ROAS: `conversionsValue / spend` with zero-spend guard (shows "—")
- Empty state: "No active campaigns found in the last 7 days."
- API error: parses `.[0].error.message` and shows hint to check credentials

### Search Terms Report Sub-command (GADS-04)

- GAQL query: `search_term_view` resource, last 30 days, impressions > 0, top 100 by impressions
- Status column mapping: `ADDED` → "✓ Added", `EXCLUDED` → "✗ Excluded", `NONE` → "○ New"
- Per-term table: Search Term | Status | Campaign | Ad Group | Impr | Clicks | Cost | Conv
- Negative keyword candidates section: inline jq `select()` filters terms where conversions == 0 AND costMicros > 1000000 (>$1 spend)
- Empty state: "No search term data found for the last 30 days."
- API error handling matches dashboard pattern

### Budget Recommendations Sub-command (GADS-06)

- GAQL query: `recommendation` resource filtered to `IN (CAMPAIGN_BUDGET, MOVE_UNUSED_BUDGET, MARGINAL_ROI_CAMPAIGN_BUDGET, FORECASTING_CAMPAIGN_BUDGET)`
- Type column mapping: human-readable labels for all 4 recommendation types
- Per-recommendation table: Type | Campaign | Current Budget | Recommended | Impact
- Impact column: percentage impressions increase from `baseMetrics.impressions` to `potentialMetrics.impressions`; shows "—" if base is 0
- Budget values from `currentBudgetAmountMicros` and `recommendedBudgetAmountMicros` converted from micros to dollars
- Empty state: "No budget recommendations available. Google needs campaign data to generate recommendations."
- API error handling matches dashboard pattern

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

One implementation note: Tasks 1 and 2 both target the same section of SKILL.md. Rather than writing Task 1, committing, then re-opening the file for Task 2 (which would risk diff conflicts on the exact same lines), both sub-command blocks were written in a single edit and committed as a single atomic change (116eaf8). The task commit log above attributes both tasks to this commit, which accurately represents the work done.

## Threat Model Compliance

| Threat | Status |
|--------|--------|
| T-10-05: GAQL responses contain campaign names/spend | Accepted — data stays in terminal output only |
| T-10-06: searchStream queries on large accounts | Mitigated — LIMIT 20 on dashboard, LIMIT 100 on search terms; both applied in plan as specified |

## Known Stubs

None — all three sub-commands are fully wired with GAQL queries, data extraction, and output formatting. Plan 03 sub-commands (campaigns/manage, keywords/kw) are documented as "see Plan 03" in the routing table, which is intentional per the phased plan design.

## Threat Flags

None — no new network endpoints or auth paths beyond what was planned. All queries use the same `searchStream` endpoint already established in the threat model.

## Self-Check: PASSED

- `claude-ops/skills/ops-marketing/SKILL.md` — modified, committed 116eaf8
- Commit 116eaf8 exists in git log (confirmed above)
- `grep -q "GOOGLE ADS.*Last 7 Days"` — PASS
- `grep -q "SEARCH TERMS REPORT"` — PASS
- `grep -q "BUDGET RECOMMENDATIONS"` — PASS
- `grep -c "searchStream"` returns 3 — PASS
- `grep -q "Negative keyword candidates"` — PASS
- `grep -q "recommendedBudgetAmountMicros"` — PASS
- `grep -c "━━━"` returns 21 (6 banner lines from 3 sub-commands + existing banners) — PASS
