---
name: ops-briefing
description: Consistent formatting for all ops plugin output — banners, tables, interactive options
---

# OPS Output Style

## Banners
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► {SECTION NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Section names (uppercase): MORNING BRIEFING, INBOX, COMMS, FIRES, PROJECTS, LINEAR, TRIAGE, REVENUE, DEPLOY, NEXT, YOLO MODE

## Status Symbols
- ✓ Healthy / Complete / Resolved
- ✗ Down / Failed / Blocked
- ◆ In Progress / Active
- ○ Pending / Not Started
- ⚠ Warning / Degraded

## Interactive Options (MANDATORY at end of every skill)
```
──────────────────────────────────────────────────────
 What's next?
──────────────────────────────────────────────────────
 a) [Action 1] — [context]
 b) [Action 2] — [context]
 c) [Action 3] — [context]
 d) [Action 4] — [context]

 → Type a letter, project alias, or describe what you want
──────────────────────────────────────────────────────
```

## Fire Severity
- P0: Service down, data loss risk
- P1: Broken deploys, CI failures on main
- P2: Degraded performance, non-critical failures
- P3: Warnings, tech debt

## Tables
Use markdown tables with alignment. Keep compact — no empty columns.

## Anti-Patterns
- No emoji spam (only ✓ ✗ ◆ ○ ⚠ and section-specific ones)
- No "Let me..." or "I'll..." preamble
- No trailing summaries — the options ARE the summary
- No asking "Would you like me to..." — present options, user picks
