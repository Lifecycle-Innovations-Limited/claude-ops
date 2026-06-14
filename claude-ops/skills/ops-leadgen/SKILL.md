---
name: ops-leadgen
description: My-Project B2B wholesale leadgen review and send flow. Shows pending cold-email drafts from my-project-b2b-leadgen, lets you approve/skip each one, and fires approved drafts one-at-a-time via Rule-6-gated `my-project-leadgen send`. Never batches sends.
argument-hint: '[review | send --draft-id N | usage | scrape | draft]'
allowed-tools:
  - Bash
  - Read
effort: low
maxTurns: 20
---

# ops-leadgen

Wraps `my-project-leadgen` CLI for the daily leadgen review-and-send loop.

**Repo:** `~/Projects/my-project-b2b-leadgen`
**DB:** `~/Projects/my-project-b2b-leadgen/leads.db` (gitignored)
**Run with Doppler:** `doppler run --project my-project-b2b-leadgen --config dev -- my-project-leadgen <cmd>`

## Argument routing

| Argument             | Action                                           |
| -------------------- | ------------------------------------------------ |
| `review` (default)   | Show pending drafts one-by-one, approve or skip  |
| `send --draft-id N`  | Send a single approved draft (Rule-6 gated)      |
| `usage`              | Print today's Apollo reveals + Apify runs        |
| `scrape [--limit N]` | Discover new NL HR contacts via Apollo           |
| `enrich`             | Run Apify enrichment on unenriched leads         |
| `draft`              | Generate Claude NL/EN drafts for undrafted leads |

## Review + send flow (Rule 6)

**NEVER send multiple drafts in one turn. Each send is a separate staged-draft → approval → send cycle.**

1. Run `my-project-leadgen review` (or fetch pending drafts from DB directly)
2. For each pending draft, show the user:
   - Lead: name, title, company, email
   - Language, subject, full body
3. Ask: `[Send]` / `[Skip]` / `[Stop review]`
4. On `[Send]`:
   a. Show complete draft one final time
   b. Wait for Sam to type `ok` / `send` / `ship it` — this creates `/tmp/.claude-send-ok`
   c. Run: `doppler run --project my-project-b2b-leadgen --config dev -- my-project-leadgen send --draft-id N`
   d. Confirm output shows `Sent OK. Gmail message ID: <id>`
5. Move to the next draft only after the current one is fully resolved.

## Scrape → enrich → draft (pipeline)

```bash
# Step 1: discover contacts (costs Apollo reveals — check usage first)
doppler run --project my-project-b2b-leadgen --config dev -- \
  my-project-leadgen usage

doppler run --project my-project-b2b-leadgen --config dev -- \
  my-project-leadgen scrape --limit 50

# Step 2: enrich with Apify website crawler
doppler run --project my-project-b2b-leadgen --config dev -- \
  my-project-leadgen enrich

# Step 3: generate Claude drafts
doppler run --project my-project-b2b-leadgen --config dev -- \
  my-project-leadgen draft

# Step 4: review + send (Rule-6 gated, one at a time)
doppler run --project my-project-b2b-leadgen --config dev -- \
  my-project-leadgen review
```

## Daily usage cap

- Apollo reveals: **200/day** max (tracked in `leads.db daily_usage`)
- Apify runs: ~$0.02/run (3 pages per domain)
- Always run `usage` first to check remaining reveals before scraping

## DB queries (read-only diagnostics)

```bash
# Pending drafts count
sqlite3 ~/Projects/my-project-b2b-leadgen/leads.db \
  "SELECT count(*) FROM drafts WHERE status='pending';"

# Today's sends
sqlite3 ~/Projects/my-project-b2b-leadgen/leads.db \
  "SELECT d.subject, l.email, s.sent_at FROM sends s
   JOIN drafts d ON d.id=s.draft_id
   JOIN leads l ON l.id=d.lead_id
   WHERE date(s.sent_at)=date('now');"
```

## Rule 6 — no exceptions

Per CLAUDE.md Rule 6: every outbound send requires individual staging + approval.
The `my-project-leadgen send` command physically blocks unless `/tmp/.claude-send-ok` exists.
Sam creates this token by typing `ok` / `send it` / `ship it` in the chat.
Token is one-shot — consumed on send. Next send needs a new approval.
