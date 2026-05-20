# OPS ► POCKET — Architecture Reference

Long-form architecture, state, and lifecycle reference for the Pocket voice-memo pipeline. Cross-referenced from [`SKILL.md`](./SKILL.md).

The pipeline turns voice memos recorded into Pocket (or any external memo source the watcher is wired to) into running Claude tasks, then notifies the operator on WhatsApp + email when each task starts and completes.

## Pipeline overview

```
 ┌─────────────────────────┐
 │ Pocket API              │
 └─────────┬───────────────┘
           │ poll (cron)
           ▼
 [1] ops-cron-pocket-watcher.py
           │ writes pending-triage.jsonl
           ▼
 [2] ops-pocket-triage.py            (Opus + extended thinking)
           │ ACT ⇒ tasks.jsonl
           │ SKIP ⇒ logged, discarded
           ▼
 [3] ops-cron-pocket-executor.py     (watchdog cron)
           │ ensures tmux session `pocket-exec` is alive
           │ respawns supervisor window if missing
           ▼
     SUPERVISOR (long-lived Claude Code in tmux)
           │ reads tasks.jsonl via cursor
           │ spawns workers in new tmux windows
           │ appends to spawn-ledger.jsonl
           ▼
     WORKER teammates
           │ run the task to completion
           │ write executor-results/<task_id>.done.json + .out.md|.out.txt
           ▼
 [4] ops-pocket-activity-notifier.py (60s launchd LaunchAgent)
           │ tails spawn-ledger (START events)
           │ scans executor-results dir (DONE events)
           │ enqueues kind=whatsapp + kind=email rows
           ▼
     supervisor-out-queue.jsonl
           │
           ├─► [5] ops-pocket-out-queue.py        (kind=whatsapp)
           │       └─► WhatsApp self-chat (whatsmeow bridge, port 8080)
           │
           └─► [6] ops-pocket-email-bridge.py     (kind=email)
                   └─► gog gmail send --attach (Gmail OAuth)
```

`ops-pocket-whatsapp-bridge.py` is the **inbound** counterpart in the 7-script set — it polls the operator's own self-chat for replies that should be threaded back into the supervisor's async question/reply protocol. The notifier handles **outbound**; this script handles **inbound** (user replying to a question the supervisor asked).

## Scripts (eight, including the install helper)

All paths relative to `$CLAUDE_PLUGIN_ROOT/scripts/`.

| # | Script                                | Role          | Runs as                       | Interval |
|---|---------------------------------------|---------------|-------------------------------|----------|
| 1 | `ops-cron-pocket-watcher.py`          | Watcher       | cron (user crontab)           | ~5 min   |
| 2 | `ops-pocket-triage.py`                | Triage        | cron / on-demand              | ~5 min   |
| 3 | `ops-cron-pocket-executor.py`         | Exec watchdog | cron                          | ~1 min   |
| 3a | (supervisor)                         | Long-lived    | tmux window `pocket-exec:supervisor` | always |
| 4 | `ops-pocket-activity-notifier.py`     | Notifier      | launchd LaunchAgent            | 60s     |
| 5 | `ops-pocket-out-queue.py`             | WA bridge out | cron                          | 60s     |
| 6 | `ops-pocket-email-bridge.py`          | Email bridge  | cron                          | 60s     |
| 7 | `ops-pocket-whatsapp-bridge.py`       | WA bridge in  | cron                          | 60s     |
|   | `install-pocket-notifier.sh`          | Installer     | one-shot                      | —       |

The 7-script set the SKILL.md is built around is: watcher, triage, executor, notifier, out-queue, email-bridge, whatsapp-bridge. The install helper is supporting infrastructure.

## State directory layout

Default: `$HOME/.claude/state/pocket/` — override via `POCKET_STATE_DIR`.

```
~/.claude/state/pocket/
├── cursor.txt                       # watcher: last polled timestamp
├── seen.json                        # watcher: dedup set of pocket item IDs
├── pending-triage.jsonl             # awaiting triage decision (watcher → triage)
├── tasks.jsonl                      # canonical task store (triage → supervisor)
├── drafts.jsonl                     # watcher-inferred low-confidence items
├── spawn-ledger.jsonl               # every worker spawn (supervisor → notifier)
├── supervisor-cursor.txt            # supervisor's read cursor into tasks.jsonl
├── supervisor-out-queue.jsonl       # outbound notification queue
├── out-queue-sent.jsonl             # delivered WhatsApp notifications ledger
├── executor-results/
│   ├── <task_id>.done.json          # worker completion marker (canonical)
│   ├── <task_id>.completed.json     # legacy completion marker (also handled)
│   ├── <task_id>.out.md             # worker report (markdown)
│   └── <task_id>.out.txt            # worker report (plain text)
├── whatsapp-config.json             # outbound WhatsApp sink config
├── email-config.json                # outbound email sink config
│
├── .health                          # watcher health
├── .activity-notifier-health        # notifier health (read by ops-doctor)
├── .activity-notifier.spawn-cursor  # notifier: byte cursor into spawn-ledger
├── .activity-notifier.seen-results  # notifier: set of seen .done basenames
├── .out-queue-health                # WA out-queue health
├── .out-queue-cursor                # WA out-queue: byte cursor
├── .email-bridge-health             # email bridge health
│
├── run.log                          # watcher log
├── executor.log                     # executor watchdog log
├── activity-notifier.log            # notifier log
├── activity-notifier.stdout.log     # launchd stdout
├── activity-notifier.stderr.log     # launchd stderr
├── out-queue.log                    # WA bridge out log
└── email-bridge.log                 # email bridge log
```

## Lifecycle — a single voice memo

1. **Recording** — user records a voice memo into Pocket.
2. **Watcher tick** (cron, ~5 min later) — `ops-cron-pocket-watcher.py` reads `cursor.txt`, hits the Pocket API for items newer than the cursor, dedupes against `seen.json`, transcribes if needed, writes a row to `pending-triage.jsonl`, advances cursor, writes `.health`.
3. **Triage tick** — `ops-pocket-triage.py` reads new rows from `pending-triage.jsonl`, asks Opus (extended thinking) for an ACT or SKIP verdict per item. ACT rows are appended to `tasks.jsonl` with a structured verdict. SKIP rows are logged and discarded.
4. **Executor watchdog tick** (cron, ~60s) — `ops-cron-pocket-executor.py` ensures the tmux session `pocket-exec` exists with an `_idle` keepalive window. If the supervisor window died, respawns it from `templates/pocket-supervisor-prompt.md`. Detects orphan worker windows (running but not in the spawn-ledger — supervisor crashed mid-spawn).
5. **Supervisor wake** — long-lived Claude session in `pocket-exec:supervisor` reads from `tasks.jsonl` via its own `supervisor-cursor.txt`. For each new ACT task, creates an Agent Teams teammate in a new tmux window, appends a START row to `spawn-ledger.jsonl`.
6. **Worker run** — the teammate completes the task. On exit it writes `executor-results/<task_id>.done.json` + a report file (`.out.md` or `.out.txt`).
7. **Notifier tick** (launchd, every 60s) — `ops-pocket-activity-notifier.py`:
   - tails `spawn-ledger.jsonl` from `.activity-notifier.spawn-cursor` → emits START events.
   - scans `executor-results/` against `.activity-notifier.seen-results` → emits DONE events.
   - for each event, writes one row per enabled channel (`kind: whatsapp` and/or `kind: email`) to `supervisor-out-queue.jsonl`.
8. **WhatsApp drain** (cron, 60s) — `ops-pocket-out-queue.py` reads `supervisor-out-queue.jsonl` from `.out-queue-cursor`, filters `kind=whatsapp`, validates `chat_jid` matches the configured self-chat (refuses to send to anything else — defense in depth against a poisoned queue row), posts to the whatsmeow bridge at `localhost:8080`, appends to `out-queue-sent.jsonl`.
9. **Email drain** (cron, 60s) — `ops-pocket-email-bridge.py` reads the same queue, filters `kind=email`, calls `gog gmail send --to <self_email> --subject ... --body ... --attach <report_file>`.
10. **Inbound** (cron, 60s) — `ops-pocket-whatsapp-bridge.py` polls the WhatsApp bridge's sqlite for new `is_from_me=1` messages in the configured `chat_jid` since the last seen message id. These are surfaced to the supervisor as async answers to pending questions (the supervisor uses file-based question/reply, not `AskUserQuestion`, since it has no attached terminal).

## Config file schemas

### `whatsapp-config.json`

```json
{
  "enabled": true,
  "chat_jid": "<digits>@s.whatsapp.net",
  "include_attachments": true
}
```

`chat_jid` is the JID of the user's **self-chat** (where they can send messages to themselves on WhatsApp). The bridge validates outbound rows match this JID before sending.

### `email-config.json`

```json
{
  "enabled": true,
  "to": "user@example.com",
  "from_account": "user@example.com",
  "subject_prefix": ""
}
```

`from_account` is the gog/Gmail OAuth account to send through. `subject_prefix` is empty by default (the `[Pocket]` prefix was stripped in commit `739b29b` of `feat/pocket-notifier-templatize`).

## Out-queue row schema

```json
{
  "id": "<uuid>",
  "kind": "whatsapp",
  "task_id": "<task_id>",
  "event": "START",
  "title": "<task title from tasks.jsonl>",
  "chat_jid": "<digits>@s.whatsapp.net",
  "body": "<rendered message>",
  "attachments": ["<absolute path to report file>"],
  "enqueued_at": "2026-05-20T08:00:00Z"
}
```

`kind` is one of `whatsapp` or `email`. `event` is `START` or `DONE`. The notifier emits one row per enabled channel per event.

## Health surface (read by `ops-doctor` and `/ops:pocket status`)

Every long-running component writes a one-line JSON health file each tick:

```json
{
  "status": "running",
  "msg": "tick",
  "extra": { "sent": 0, "skipped": 0, "cursor": 12345 },
  "updated_at": "2026-05-20T08:00:00Z"
}
```

`status` is one of:

- `running` — last tick succeeded.
- `ok` — alias for `running` (notifier uses `ok` for no-work ticks).
- `disabled` — component is enabled in code but channel config is missing or `enabled: false`.
- `error` — last tick failed; `msg` carries the error.
- `stalled` — derived in the status dashboard when `updated_at` is older than 3× the expected tick interval.

## Common failure modes

| Symptom                                  | Most likely cause                                        | Fix                                                             |
|------------------------------------------|----------------------------------------------------------|-----------------------------------------------------------------|
| `whatsapp: disabled` in status           | `whatsapp-config.json` missing or `enabled: false`       | `/ops:pocket whatsapp on` (after `setup`)                       |
| Notifier `error: tmux not found`         | tmux not on PATH for the launchd LaunchAgent             | Re-run `install-pocket-notifier.sh` after `brew install tmux`   |
| out-queue `error: refusing — JID mismatch` | Queue row has a different `chat_jid` than config        | Inspect queue with `tail supervisor-out-queue.jsonl` — bad enqueue |
| WA messages delivered, email not        | gog Gmail OAuth expired                                  | `gog auth status` then `gog auth add <addr> --services gmail`  |
| `tmux=down` after `restart`              | `_idle` keepalive window died, supervisor never spawned  | `tmux kill-session -t pocket-exec` then re-run `restart`        |
| Pending-triage growing, tasks not        | Triage cron never running, or Opus quota hit             | Check `run.log` for triage errors; manually run `ops-pocket-triage.py` |
| Notifier never fires after worker done   | Worker wrote `.completed.json` but not `.done.json`      | Notifier handles both; check `.activity-notifier.seen-results`  |
| Duplicate notifications                  | `.activity-notifier.seen-results` was wiped              | Don't delete it; rebuild via `--once` won't re-emit if cursor intact |

## Why this skill exists

The pipeline shipped in commit `d64bf16` with 7 scripts but no entry point. Operators had to remember which `tail -f` to run, which launchd label to kickstart, which JSON to edit. This skill is the front door.

It is intentionally read-mostly: every command is reversible, no destructive operations, no outbound comms beyond the synthetic test that goes to the operator's own self-channels.
