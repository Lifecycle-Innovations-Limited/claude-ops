# Pocket notifications

Config-driven notifications for the whole pocket module: pocket components emit an
**event id**; the `ops-pocket-notify` dispatcher decides — from
`preferences.json → pocket.notifications` — **which channels** to send on, and
**when** (per-event schedule + cooldown + severity escalation). The operator picks
all of this **interactively** via `/ops:setup` / `/ops:ops-settings`; emitters
never hardcode channels or timing.

## Flow

```
component  ──ops-pocket-notify <event> <msg> [--severity]──▶  dispatcher
                                                               │ reads preferences.json
                                                               │ pocket.notifications.events[<event>]
                                                               │ schedule + cooldown + severity gate
                                                               ▼
                                          channels: telegram | email | whatsapp | slack
                                          (via ops-telegram-bot-send / out-queue drain)
```

## Event taxonomy (whole module)

| Event | Emitted by | When |
|-------|-----------|------|
| `env-broker.uid-rejected` | pocket-env-broker | a non-worker uid tried to pull a secret (probing signal) |
| `env-broker.denied` | pocket-env-broker | a worker requested a non-allowlisted secret |
| `worker.spawned` | executor | a worker started |
| `worker.completed` | executor | a worker finished successfully |
| `worker.failed` | executor | a worker exited non-zero / timed out |
| `queue.stuck` | watcher | the task queue stopped draining |
| `daemon.down` | daemon manager | a pocket daemon is not running |

New events are **off by default** (no channels) until opted in.

## preferences.json schema

```json
{
  "pocket": {
    "notifications": {
      "tz": "Europe/Amsterdam",
      "default_cooldown": 300,
      "defaults": { "channels": [], "severity": "medium" },
      "events": {
        "env-broker.uid-rejected": {
          "channels": ["telegram"], "severity": "high",
          "schedule": { "cooldown": 60 }
        },
        "env-broker.denied": {
          "channels": ["telegram"], "severity": "medium",
          "schedule": { "cooldown": 300, "quiet_hours": { "start": "22:00", "end": "08:00" } }
        },
        "worker.failed":    { "channels": ["email"],  "severity": "medium" },
        "worker.completed": { "channels": [] },
        "queue.stuck":      { "channels": ["telegram", "email"], "severity": "high" },
        "daemon.down":      { "channels": ["telegram", "email"], "severity": "high" }
      }
    }
  }
}
```

### Per-event `schedule`

| Key | Meaning |
|-----|---------|
| `cooldown` | seconds between sends for the same event (rate-limit) |
| `quiet_hours` | `{start,end}` `HH:MM` window where the event is suppressed |
| `active_days` | weekday ints `0=Mon..6=Sun`; absent/empty = every day |
| `escalate_severities` | severities that BYPASS quiet_hours/active_days (default `["high"]`) |

So a `high`-severity probe always pages you, even at 3am; a `medium` "worker
completed" respects quiet hours and active days.

## Channels

| Channel | Sent via |
|---------|----------|
| `telegram` | `ops-telegram-bot-send` (operator self-chat — outbound-gate exempt) |
| `email` | enqueued to `supervisor-out-queue.jsonl` (drained by `ops-pocket-out-queue`) |
| `whatsapp` | enqueued to the out-queue |
| `slack` | enqueued to the out-queue |

## Usage / testing

```bash
ops-pocket-notify worker.failed "task X failed" --severity medium
ops-pocket-notify env-broker.uid-rejected "uid 1001 probed GOG_ACCOUNT" --severity high --dry-run --json
```

`--dry-run --json` resolves the event against preferences and prints which
channels *would* fire (and any suppression reason) without sending — used by the
setup flow's **test-send** and by the test suite.

## Interactive setup

`/ops:setup` → *pocket notifications* (and `/ops:ops-settings`) walks each event:
pick channels (≤4 per prompt, paginated), set the schedule (cooldown, quiet
hours, active days, escalation), and fire a `--dry-run` preview. Writes
`pocket.notifications` into `preferences.json`.
