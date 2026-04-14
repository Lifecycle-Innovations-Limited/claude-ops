# Push Notifications (`fires-watcher`)

`claude-ops` ships a background service called `fires-watcher` that replaces
the old polling workflow of `/ops:fires`. Instead of you having to remember to
ask for fires, the daemon polls your fire sources every 60 seconds and pushes
a notification the moment a new CRITICAL or HIGH incident appears.

> Related issue: [#21 — push notifications for P0s](https://github.com/Lifecycle-Innovations-Limited/claude-ops/issues/21).

## What `fires-watcher` does

Every 60 seconds (configurable via `FIRES_WATCHER_INTERVAL`), the watcher:

1. Runs `bin/ops-infra` and inspects ECS cluster health. A cluster in
   `degraded` state produces a **HIGH** event; a cluster that is fully
   `down` produces a **CRITICAL** event.
2. Queries the Sentry API (`organizations/<org>/issues/?query=is:unresolved`)
   for unresolved issues at `level=error` (**HIGH**) or `level=fatal`
   (**CRITICAL**) — only when `$SENTRY_AUTH_TOKEN` and `sentry_org` are both
   configured.
3. Diffs the result against the previous state file at
   `~/.claude/plugins/data/ops-ops-marketplace/fires-watcher.state.json`.
4. For every new or escalated incident, calls
   `scripts/ops-notify.sh <severity> <title> <body> [--link <url>]`, which
   fans out to every configured sink.
5. Updates a health file at
   `~/.claude/plugins/data/ops-ops-marketplace/fires-watcher.health` so the
   main daemon can monitor it.

The watcher is **read-only** — it never mutates infrastructure (Rule 5).

## The six sink options

`ops-notify.sh` tries sinks in this order and fans out to **all** that are
configured (there is no "pick one" — you get alerts everywhere you want them):

| Priority | Sink              | Trigger env / pref                                                                  |
| -------- | ----------------- | ----------------------------------------------------------------------------------- |
| 1        | Telegram bot      | `$TELEGRAM_BOT_TOKEN` + `$TELEGRAM_NOTIFY_CHAT_ID` (falls back to `$TELEGRAM_OWNER_ID`) |
| 2        | Discord webhook   | `$DISCORD_WEBHOOK_URL` (shared with `/ops:comms discord send`)                       |
| 3        | ntfy.sh           | `$NTFY_TOPIC` (optionally `$NTFY_SERVER` for a self-hosted instance)                |
| 4        | Pushover          | `$PUSHOVER_USER` + `$PUSHOVER_TOKEN`                                                |
| 5        | macOS `osascript` | Local desktop notification (macOS only — guarded behind a Darwin check)             |
| 6        | stderr log        | Always runs if nothing else is configured — written to `logs/ops-notify.log`        |

Every env var above also has a `$PREFS_PATH` fallback (the dispatch script
reads `~/.claude/plugins/data/ops-ops-marketplace/preferences.json` when the
env var isn't set), so you don't have to export secrets globally.

### Severity-to-emoji mapping

| Severity | Emoji | Notes                                  |
| -------- | ----- | -------------------------------------- |
| CRITICAL | 🔴    | Pushover priority `1`, ntfy priority `5` |
| HIGH     | 🟠    | Pushover priority `1`, ntfy priority `4` |
| MEDIUM   | 🟡    | Pushover priority `0`, ntfy priority `3` |
| LOW      | 🟢    | Pushover priority `-1`, ntfy priority `2` |

## How to choose a sink

- **Most users →** Telegram. You already set up a Telegram bot to use
  `/ops:comms`, so this is zero extra work.
- **No account, free →** ntfy.sh. Pick a random topic name like
  `claude-ops-fires-<random>`, subscribe from the ntfy mobile app, done.
- **Premium iOS/Android →** Pushover. ~$5 one-time per platform, fastest and
  most reliable delivery with priority bypass for CRITICAL.
- **Team channel →** Discord webhook. Drops the alert into an existing
  `#incidents` channel where your team already lives.
- **Desktop only →** macOS `osascript`. Silent fallback; fine for a dev
  laptop but don't rely on it as your only sink.

Configure multiple — if your laptop is offline, a Pushover push still reaches
you; if Telegram's API is flaky, Discord still works.

## Debounce rules

To avoid waking you up every minute about the same fire:

- **New incident** — notify immediately, record fingerprint + severity +
  timestamp.
- **Same fingerprint, same severity** — suppress for **30 minutes** from the
  last notification. Override with `FIRES_WATCHER_DEBOUNCE` (seconds).
- **Same fingerprint, higher severity** — re-notify immediately (e.g., ECS
  cluster went from `degraded` → `down`). The stored severity is bumped so
  the next HIGH event doesn't re-trigger until the 30-minute window elapses.
- **Incident resolves** — the fingerprint simply stops appearing in the probe
  output; no "all clear" ping is sent (noise vs signal tradeoff).

Fingerprints are stable across ticks:
- Infra: `infra:<cluster>:<status>`
- Sentry: `sentry:<issue_id>`

State lives at `~/.claude/plugins/data/ops-ops-marketplace/fires-watcher.state.json`
and survives daemon restarts.

## Testing your setup

Send a test event through every configured sink:

```bash
scripts/ops-notify.sh CRITICAL "test" "is this thing on"
```

You should see a red-dot alert on every sink you've wired up. Check
`logs/ops-notify.log` under your data dir for a per-sink status line.

To verify the watcher loop, run it in the foreground for 2-3 ticks:

```bash
FIRES_WATCHER_INTERVAL=10 scripts/ops-fires-watcher.sh
```

Tail the log with `tail -f ~/.claude/plugins/data/ops-ops-marketplace/logs/fires-watcher.log`.

## Enabling / disabling the watcher

`fires-watcher` is **disabled by default**. Opt in either way:

1. **Guided:** `/ops:setup notifications` — walks you through sink selection
   and enables the service.
2. **Manual:** edit
   `~/.claude/plugins/data/ops-ops-marketplace/daemon-services.json` and flip
   `services.fires-watcher.enabled` to `true`, then restart the daemon.

To disable it again without losing config:

- Run `/ops:setup notifications --skip`, **or**
- Flip `enabled` back to `false` in `daemon-services.json` and restart the
  daemon (`scripts/ops-daemon.sh restart`).

## Polling vs event-driven — tradeoffs

This design uses 60-second polling rather than webhooks. Rationale:

- Sentry + AWS both support webhooks, but receiving them would require the
  user to run (and expose) an HTTP listener — a hard ask for a CLI plugin
  that runs on random laptops behind NAT.
- 60 s worst-case latency is acceptable for CRITICAL P0s; most on-call
  rotations already tolerate ≥ 1 minute of alert lag.
- Polling works uniformly across any fire source (Sentry, AWS, Datadog, New
  Relic, custom CloudWatch) without per-source webhook handlers.
- If sub-minute latency becomes important later, the watcher can be swapped
  for a webhook listener without changing the notification surface —
  `ops-notify.sh` is the stable boundary.

## Files

- `scripts/ops-fires-watcher.sh` — the daemon poll loop
- `scripts/ops-notify.sh` — the sink dispatcher
- `scripts/daemon-services.default.json` — service registration
- `skills/setup/SKILL.md` §3m — guided setup flow
