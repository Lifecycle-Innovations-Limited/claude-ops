---
name: ops-competitors
description: 'Competitor-intel dashboard and management UI. Tracks brand signals, page-diff alerts, pricing changes, App Store moves, and weekly synthesis reports. Powered by the competitor-intel cron pipeline.'
argument-hint: '[brand-name|refresh [brand]|add-url <brand> <competitor> <kind> <url>|alerts|help]'
allowed-tools:
  - Bash
  - Read
  - Edit
  - AskUserQuestion
effort: low
maxTurns: 15
disallowedTools:
  - Write
  - NotebookEdit
---

## Runtime Context

Before rendering, load competitor context:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname $(which ops-competitors 2>/dev/null) 2>/dev/null)/..}"
OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
source "$PLUGIN_ROOT/scripts/lib/competitor/context.sh" 2>/dev/null || true
CTX=$(competitor_context 2>/dev/null || echo '{"configured":false,"reason":"lib_not_found"}')
```

# OPS ► COMPETITORS — Intel Dashboard

Parse `$ARGUMENTS` and dispatch to the matching mode below.

---

## Mode: No args — Dashboard

Show all tracked brands with last_run, alert counts, and recent activity. Use `competitor_briefing_line` for each brand row.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► COMPETITORS — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TRACKED BRANDS ([n] total)
  [brand]   last run [date]   [n] alerts · [n] med · [n] low
  ...

PENDING QUEUES
  immediate: [n]   daily: [n]

RECENT HIGH ALERTS (last 7d)
  [timestamp]  [brand]  [competitor]  [snippet…]
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If `configured == false`: print setup hint and stop.

```bash
# Load context
source "$PLUGIN_ROOT/scripts/lib/competitor/context.sh"
competitor_context --window-days 7
competitor_briefing_line
```

Mobile mode (Rule 7): one line per brand, no banner, no box-drawing.

---

## Mode: `<brand-name>` — Drill-down

Full event timeline (last 30d), top competitors, latest report, per-competitor signal breakdown.

1. Run `competitor_context --brand "<brand>" --window-days 30`
2. Print brand metadata: category, competitor list, last_run, last_discovery
3. Print per-competitor signal breakdown (group events by `.competitor`)
4. Read latest report:
   ```bash
   SLUG=$(echo "<brand>" | tr '[:upper:] /' '[:lower:]--' | tr -cd 'a-z0-9-_.')
   REPORT="$OPS_DATA_DIR/reports/competitor-intel/latest-${SLUG}.md"
   [[ -f "$REPORT" ]] && head -80 "$REPORT"
   ```
5. Print full high-severity event timeline sorted newest-first

Output format:

```
BRAND: [name]  category: [cat]  last run: [date]
competitors: [a, b, c, ...]

SIGNAL BREAKDOWN
  [competitor]   high: [n]  med: [n]  low: [n]

LATEST REPORT (excerpt)
  [first 80 lines of report]

EVENT TIMELINE (30d — [n] total)
  [timestamp]  HIGH  [competitor]  [source]  [snippet…]
  ...
```

---

## Mode: `refresh [brand]`

Manually triggers the weekly intel cron immediately.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-...}"
CRON_SCRIPT="$PLUGIN_ROOT/scripts/ops-cron-competitor-intel.sh"

# If a specific brand is given, pass it via env override
if [[ -n "$BRAND_ARG" ]]; then
  BRAND_NAME="$BRAND_ARG" bash "$CRON_SCRIPT"
else
  bash "$CRON_SCRIPT"
fi
```

Stream output. Inform the user when done and show updated `competitor_briefing_line`.

---

## Mode: `add-url <brand> <competitor> <kind> <url>`

Add a page-diff monitored URL to `preferences.json`. Valid `<kind>` values: `pricing`, `features`, `changelog`, `careers`.

1. Validate args — if any missing, explain usage and stop.
2. Show the proposed change:
   ```
   Add URL for [brand] → [competitor] ([kind]):
     [url]
   ```
3. AskUserQuestion: `[Add]` / `[Cancel]`
4. On confirm, merge via jq:
   ```bash
   PREFS="$OPS_DATA_DIR/preferences.json"
   jq --arg brand "$BRAND" --arg comp "$COMP" --arg kind "$KIND" --arg url "$URL" '
     .competitor_intel.urls[$brand][$comp][$kind] = $url
   ' "$PREFS" > /tmp/prefs-tmp.json && mv /tmp/prefs-tmp.json "$PREFS"
   ```
5. Confirm written.

---

## Mode: `alerts`

Tail the last 20 lines of the alerts log:

```bash
ALERTS="$OPS_DATA_DIR/reports/competitor-intel/alerts.log"
if [[ -f "$ALERTS" ]]; then
  tail -20 "$ALERTS"
else
  echo "No alerts log found at $ALERTS"
fi
```

---

## Mode: `help` / unknown args

Print available subcommands:

```
ops-competitors                           — dashboard (all brands)
ops-competitors <brand>                   — drill-down: events, report, breakdown
ops-competitors refresh [brand]           — run intel cron now (optional brand filter)
ops-competitors add-url <b> <c> <k> <url> — add page-diff URL to preferences.json
ops-competitors alerts                    — tail alerts.log (last 20 lines)
ops-competitors help                      — this message
```

---

## Error states

- `configured == false` → print `"Competitor-intel not configured. Run /ops:setup competitor-intel to get started."` and stop.
- `CRON_SCRIPT` not found → print path and stop.
- `PREFS` not writable for `add-url` → surface error, do not silently fail.
