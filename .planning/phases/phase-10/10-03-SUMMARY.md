---
phase: 10-google-ads
plan: "03"
subsystem: ops-marketing
tags: [google-ads, campaign-management, keyword-planner, ad-groups, mutate-api, gaql]
dependency_graph:
  requires: [google-ads-credential-resolution, google-ads-token-refresh, google-ads-dashboard, google-ads-search-terms-report, google-ads-budget-recommendations]
  provides: [google-ads-campaign-management, google-ads-keyword-planner, google-ads-ad-group-management]
  affects: [ops-marketing/SKILL.md, docs/skills-reference.md]
tech_stack:
  added: []
  patterns: [campaigns-mutate, campaignBudgets-mutate, adGroups-mutate, adGroupCriteria-mutate, generateKeywordIdeas, micros-to-dollars-awk, destructive-action-confirmation]
key_files:
  created: []
  modified:
    - claude-ops/skills/ops-marketing/SKILL.md
    - claude-ops/docs/skills-reference.md
decisions:
  - "New campaigns always created in PAUSED status for safety — user must explicitly enable after review"
  - "Tasks 1 and 2 both modify SKILL.md; implemented in single edit to avoid diff conflicts, covered by single commit ddd54e5"
  - "Budget adjustment fetches current budget resource name via searchStream before mutating — avoids needing user to know the internal resource name"
  - "Keyword immutability note included inline with add-keyword docs to prevent confusion about why text/match-type changes require remove+recreate"
metrics:
  duration_minutes: 18
  completed_date: "2026-04-15"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 2
requirements_completed: [GADS-02, GADS-03, GADS-05]
---

# Phase 10 Plan 03: Google Ads Write Operations Summary

Campaign management (create/pause/enable/budget), Keyword Planner (seed-to-ideas with volume/competition/bids), and ad group management (create groups, add/remove/bid-update keywords) — all wired via Google Ads REST mutate endpoints with Rule 5 confirmation guards on destructive actions.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement campaign management sub-commands (GADS-02) | ddd54e5 | claude-ops/skills/ops-marketing/SKILL.md |
| 2 | Implement Keyword Planner and ad group/keyword management (GADS-03, GADS-05) | ddd54e5 | claude-ops/skills/ops-marketing/SKILL.md |
| 3 | Update skills reference documentation | 67c6d9a | claude-ops/docs/skills-reference.md |

Note: Tasks 1 and 2 both target `## google-ads` in SKILL.md. They were written in a single atomic edit and committed together as ddd54e5 to prevent diff conflicts. All content for both tasks is present.

## What Was Built

### Sub-command Routing Table (updated)

Replaced Plan 02 "see Plan 03" placeholder rows with final entries:

| Input | Action |
|---|---|
| campaigns, manage | Campaign management — list, create, pause, enable, adjust budget |
| keywords, kw, keyword-planner | Keyword Planner — discover keywords with volume and bid data |
| ad-groups, ag | Ad group management — list, create, add/remove keywords, adjust bids |

### Campaign Management Sub-section (GADS-02)

- **List campaigns**: GAQL `searchStream` query selecting id, name, status, channel type, budget — output as table
- **Create campaign** (`campaigns create`): Two-step mutate — (1) `campaignBudgets:mutate` to create budget resource, (2) `campaigns:mutate` to create campaign; always starts `PAUSED`; collects name, budget, channel type via AskUserQuestion
- **Pause campaign** (`campaigns pause <ID>`): `campaigns:mutate` with `updateMask: "status"` → `PAUSED`; requires AskUserQuestion confirmation per Rule 5
- **Enable campaign** (`campaigns enable <ID>`): Same mutate pattern with `ENABLED`; no confirmation needed (non-destructive)
- **Adjust budget** (`campaigns budget <ID> <AMOUNT>`): Fetches current budget resource name via searchStream, then `campaignBudgets:mutate` with `updateMask: "amountMicros"`; requires AskUserQuestion confirmation showing old→new amounts per Rule 5

### Keyword Planner Sub-section (GADS-03)

- Endpoint: `:generateKeywordIdeas` (POST to customer resource)
- Collects seed keywords via AskUserQuestion (comma-separated, split to JSON array)
- Defaults: `languageConstants/1000` (English), `geoTargetConstants/2840` (United States); documents UK/Canada/Australia alternatives
- Output table: Keyword | Avg Monthly Searches | Competition | Low Bid | High Bid
- `lowTopOfPageBidMicros` and `highTopOfPageBidMicros` divided by 1,000,000 → `$X.XX`
- Sorted by `avgMonthlySearches` descending
- Empty state: "No keyword ideas found for these seeds. Try different or broader keywords."

### Ad Group Management Sub-section (GADS-05)

- **List ad groups** (`ad-groups list <CAMPAIGN_ID>`): GAQL query filtered by campaign.id, status != REMOVED
- **Create ad group** (`ad-groups create <CAMPAIGN_ID>`): `adGroups:mutate` with `SEARCH_STANDARD` type; collects name and CPC bid via AskUserQuestion; bid converted to micros
- **List keywords** (`ad-groups keywords <AD_GROUP_ID>`): GAQL query on `ad_group_criterion` with type = KEYWORD filter
- **Add keyword** (`ad-groups add-keyword <AD_GROUP_ID>`): `adGroupCriteria:mutate` create; collects keyword text, match type (Broad/Phrase/Exact → BROAD/PHRASE/EXACT), optional CPC bid; uses bash conditional expansion for optional bid field
- **Remove keyword** (`ad-groups remove-keyword <AD_GROUP_ID> <CRITERION_ID>`): `adGroupCriteria:mutate` remove with `adGroupCriteria/{AD_GROUP_ID}~{CRITERION_ID}` resource name; AskUserQuestion confirmation per Rule 5
- **Update bid** (`ad-groups update-bid <AD_GROUP_ID> <CRITERION_ID> <BID>`): `adGroupCriteria:mutate` update with `updateMask: "cpcBidMicros"` — only field that can be changed without remove+recreate
- Keyword immutability note documented inline: text and match type changes require remove and recreate

### Skills Reference Documentation (Task 3)

- Updated `/ops:marketing` description to include "Google Ads" alongside "Meta Ads"
- Added 6 Google Ads sub-command entries with descriptions matching SKILL.md implementation

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

One implementation note: Tasks 1 and 2 both target the same `## google-ads` section of SKILL.md. Rather than writing Task 1, committing, then re-opening the file for Task 2 (which would risk diff conflicts on exactly the same lines), both sub-command blocks were written in a single edit and committed atomically as ddd54e5. The task commit log above attributes both tasks to this commit.

## Threat Model Compliance

| Threat | Status |
|--------|--------|
| T-10-07: Campaign budget mutation | Mitigated — AskUserQuestion confirmation before budget changes; new campaigns always start PAUSED |
| T-10-08: Keyword removal | Mitigated — AskUserQuestion confirmation per Rule 5 before any remove operation |
| T-10-09: Campaign enable without review | Accepted — enabling a paused campaign is standard; budget was already set at create time |
| T-10-10: Excessive keyword additions | Accepted — Google Ads API has its own rate limits; plugin adds one keyword at a time |

## Known Stubs

None — all six sub-commands (campaigns list/create/pause/enable/budget, keyword planner, ad-groups list/create/keywords/add-keyword/remove-keyword/update-bid) are fully wired with API endpoints, data collection, and output formatting.

## Threat Flags

None — all mutate operations use the same `googleads.googleapis.com/v23` base URL already in the threat model. No new network endpoints or trust boundaries introduced.

## Self-Check: PASSED

- `claude-ops/skills/ops-marketing/SKILL.md` — modified, committed ddd54e5
- `claude-ops/docs/skills-reference.md` — modified, committed 67c6d9a
- `grep -c "mutate" claude-ops/skills/ops-marketing/SKILL.md` returns 10 (>= 6 required) — PASS
- `grep "generateKeywordIdeas"` — PASS
- `grep -c "AskUserQuestion"` returns 10 (>= 2 required) — PASS
- `grep "google-ads" claude-ops/docs/skills-reference.md` returns 6 matches (>= 3 required) — PASS
- `grep "campaigns:mutate"` — PASS
- `grep "campaignBudgets:mutate"` — PASS
- `grep "adGroups:mutate"` — PASS
- `grep "adGroupCriteria:mutate"` — PASS
- `grep "Keywords are immutable"` — PASS
- `grep "languageConstants/1000"` — PASS
- `grep "geoTargetConstants/2840"` — PASS
