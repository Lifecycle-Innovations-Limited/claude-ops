---
name: people
description: Sync Apple Contacts to Notion 'People' database. Track last_contacted, relationship_strength, recent_topics, next_nudge_due. Foundation for relationship intelligence — birthdays, anniversaries, overdue-outreach, news-mention nudges.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# /ops:people

Apple Contacts is source of truth. Notion "People" database is the working layer.

## Subcommands

| Subcommand | What it does |
|---|---|
| `sync` (default) | Pull Apple Contacts via `pc contacts fetch`, upsert to Notion People DB |
| `birthdays [--window 7]` | Who has a birthday/anniversary in the next N days |
| `overdue` | Who's past their relationship-strength cadence and needs reach-out |
| `whois <name>` | Pull single person's full profile + last interaction across all channels |
| `bump <name>` | Manually mark "I just talked to X" — resets last_contacted |

## Notion People schema (auto-created on first run)

| Property | Type | Source |
|---|---|---|
| name | title | Apple Contacts |
| emails | multi-select | Apple Contacts |
| phones | multi-select | Apple Contacts |
| birthday | date | Apple Contacts (year may be missing) |
| relationship_strength | select: close, active, dormant, professional, family | Heuristic + manual |
| last_contacted | date | Computed from Gmail/Slack/iMessage/WhatsApp |
| last_topic | rich_text | Last 1-line subject from any channel |
| next_nudge_due | date | Computed: last_contacted + cadence_for(strength) |
| brand_context | multi-select: your brand/project codes | Inferred from email domains/threads |
| notes | rich_text | Manual |

## Cadences (configurable)

- `close` — 14 days (partner, parents, closest friends)
- `active` — 30 days (team, frequent collaborators)
- `professional` — 60 days (clients, partners)
- `dormant` — 180 days (warm but distant)
- `family` — birthday + anniversary + monthly check-in

## Sync logic

1. `pc contacts fetch --format json` — pull all Apple Contacts
2. For each contact: upsert into Notion People DB matched by email (primary) or phone
3. Walk last 30 days of Gmail/Slack/iMessage/WhatsApp threads to compute `last_contacted`
4. Compute `next_nudge_due = last_contacted + cadence_for(relationship_strength)`
5. Write a ledger entry: `kind=nudge`, `brand=OPS`, status=done

## Behavior

- First run will ask owner to confirm `relationship_strength` for top ~30 contacts
- Subsequent runs are silent unless something new is inferred
- Birthdays without years get treated as recurring annual; first detection asks owner to confirm before storing

## Ledger writes

```bash
~/.claude-ops/bin/ledger claim --claim-key "people:sync:$(date +%F)" --kind nudge \
  --brand OPS --title "Apple Contacts → Notion sync" --source claude-ops
# ... sync ...
~/.claude-ops/bin/ledger resolve <id> --status done
```
