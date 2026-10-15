---
name: ops-leadgen
description: "OPS on-demand: This skill should be used when the user asks to \"leadgen drafts\", \"cold email approve\"…"
argument-hint: '[review | send --draft-id N | usage | scrape | draft]'
allowed-tools:
  - Bash
  - Read
effort: low
maxTurns: 20
---

# ops-leadgen

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Wraps `my-project-leadgen` CLI for the daily leadgen review-and-send loop.

**Repo:** `~/Projects/my-project-b2b-leadgen`
**DB:** `~/Projects/my-project-b2b-leadgen/leads.db` (gitignored)
**Run with Doppler:** `doppler run --project my-project-b2b-leadgen --config dev -- my-project-leadgen <cmd>`

## Argument routing

| Argument             | Action                                           |
| -------------------- | ------------------------------------------------ |
| `review` (default)   | Show pending drafts one-by-one, approve or skip  |
| `send --draft-id N`  | Hand one draft to the host's approved outbound gate (Rule 6) |
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
4. On `[Send]`: one draft, one approval, one send, only through the host's
   approved outbound gate.
   a. Pass the exact recipient, subject and full latest body to that gate; it shows
      the complete text and binds the owner's native yes to those bytes.
   b. Approval is that native yes on the shown draft only. A typed word, file, token
      or counter is never consent, and one approval never covers another draft.
   c. After the gate reports delivery, confirm it on a fresh read of the sent mail,
      then record the send in the leadgen database.
   d. If the gate refuses or cannot send this channel, keep the draft pending with the
      exact diagnostic. Never run a direct sender as a substitute for the gate.
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

Per `ops-rules` Rule 6: every outbound send is one draft, one approval, one send,
only through the host's approved outbound gate. A local file, shell token or
counter is defense in depth at most, never the owner's consent. Each draft needs its
own native approval on the latest shown text.
