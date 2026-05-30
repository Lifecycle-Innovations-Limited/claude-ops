---
name: tonight
description: Evening tomorrow-brief. Reads the Ops Ledger, calendar, and People DB. Surfaces tomorrow's meetings with prep status, birthdays hitting tomorrow, overdue outreach, top 3 priorities, and any unresolved decisions from today. Push notification if anything is genuinely time-sensitive.
allowed-tools:
  - Bash
  - Read
---

# /ops:tonight

The "before-bed brief." Counterpart to `/ops:go` (morning).

## Output sections

1. **Tomorrow's calendar** — every meeting >=15min with: attendees, prep status (brief
   exists Y/N), and the suggested 1-line prep ask if no brief exists.
2. **Birthdays / anniversaries tomorrow** — from Notion People DB. Pre-drafted
   message ready to send.
3. **Overdue outreach** — anyone whose `next_nudge_due <= tomorrow`. Top 3 only.
4. **Top 3 priorities for tomorrow** — pulled from Linear (assignee=me, priority<=High,
   updated last 7d, not Done).
5. **Unresolved from today** — ledger entries with `status=awaiting_sam` still open.

## Behavior

- Runs in claude-ops when Sam is at the Mac
- Runs in Perplexity when Sam isn't (Perplexity reads the same Notion ledger)
- Both systems write a ledger entry `kind=nudge`, `brand=OPS`, `claim_key=tonight:YYYY-MM-DD`
  so they don't both fire
- Push notification only if section 5 has unresolved items OR section 3 has anyone
  past cadence

## Schedule

Suggested cron: `30 21 * * 1-5` Europe/Amsterdam (9:30pm weekdays)
Or run manually with `/ops:tonight`

## Ledger writes

Each section that surfaces an item writes a sub-entry so morning `/ops:go` can pick
up where this left off without re-deriving.
