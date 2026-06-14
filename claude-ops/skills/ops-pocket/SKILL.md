---
name: ops-pocket
description: Pocket voice-memo pipeline command center. Surfaces the watcher → triage → executor → notifier → bridges chain that turns Pocket-recorded voice memos into running Claude tasks, with WhatsApp + email notifications. Routes — status, setup, tasks, test, logs, restart, whatsapp on|off, email on|off.
argument-hint: '[status|setup|tasks|test|logs [N]|restart|whatsapp on|off|email on|off]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
effort: low
maxTurns: 25
---

# OPS ► POCKET

Surfaces the Pocket voice-memo pipeline as a discoverable slash command. The pipeline was previously orphaned — 7 scripts, no entry point. This skill is the entry point.

For the full architecture reference (every state file, every script, every failure mode) see [`STATUS.md`](./STATUS.md) sibling to this file.

## Runtime Context

Before any route runs, resolve:

1. **State dir**: `${POCKET_STATE_DIR:-$HOME/.claude/state/pocket}`. Every file mentioned below is relative to this dir.
2. **Plugin root**: `${CLAUDE_PLUGIN_ROOT}` — used to invoke pipeline scripts under `scripts/`.
3. **Daemon health snapshot**: `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-health.json` — surface its `pocket-*` service status if present.

If `$POCKET_STATE_DIR` does not exist on disk, the pipeline has never been bootstrapped — route to `setup` automatically (no autoroute on `status` if the user explicitly asked for status).

## Routing table

Parse `$ARGUMENTS` and route immediately. First token decides the route.

| First arg             | Route                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| (empty) / `status`    | **Status dashboard** — daemon health + queue depths + cursors + counts      |
| `setup`               | Delegate to `skills/setup/channels/pocket.md` if present; else inline steps |
| `tasks`               | Pending + in-progress + recently-completed task list                        |
| `test`                | End-to-end synthetic completion test (covered below)                        |
| `logs [N]`            | Tail N lines (default 50) of notifier + run + executor logs                 |
| `restart`             | Kickstart launchd notifier + (re)spawn `pocket-exec` tmux supervisor        |
| `whatsapp on` / `off` | Toggle WhatsApp self-chat sink                                              |
| `email on` / `off`    | Toggle email self-mail sink                                                 |

Anything else: print the routing table and exit.

---

## Route — `status` (default)

The default route. Read state files, render a compact dashboard.

**Read these — in parallel where possible:**

```bash
STATE_DIR="${POCKET_STATE_DIR:-$HOME/.claude/state/pocket}"

# Daemon plist liveness
launchctl list com.claude-ops.pocket-activity-notifier 2>/dev/null \
  | awk '/PID/{print "pid="$3} /LastExitStatus/{print "exit="$3}'

# Supervisor tmux session
tmux has-session -t pocket-exec 2>/dev/null && echo "tmux=up" || echo "tmux=down"
tmux list-windows -t pocket-exec 2>/dev/null | wc -l

# Queue depths (line counts)
wc -l < "$STATE_DIR/pending-triage.jsonl" 2>/dev/null
wc -l < "$STATE_DIR/tasks.jsonl" 2>/dev/null
wc -l < "$STATE_DIR/spawn-ledger.jsonl" 2>/dev/null
wc -l < "$STATE_DIR/supervisor-out-queue.jsonl" 2>/dev/null

# Completed reports
ls "$STATE_DIR/executor-results/"*.done.json 2>/dev/null | wc -l

# Last pull cursor
cat "$STATE_DIR/cursor.txt" 2>/dev/null

# Last 3 notifications (from out-queue-sent.jsonl)
tail -n 3 "$STATE_DIR/out-queue-sent.jsonl" 2>/dev/null

# Per-component health
for h in .activity-notifier-health .out-queue-health .email-bridge-health .health; do
  cat "$STATE_DIR/$h" 2>/dev/null
done
```

**Output format (desktop):**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► POCKET — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DAEMONS
  watcher          [running|stalled]    last tick [Xs ago]
  triage           [running|idle]
  executor watchdog [running|stalled]   tmux pocket-exec=[up|down] (N windows)
  activity-notifier [running|stalled]   pid [N]
  out-queue        [running|disabled|error]
  email-bridge     [running|disabled|error]

QUEUES
  pending-triage   [N items]            (awaiting ACT/SKIP decision)
  tasks.jsonl      [N items]            (canonical task store)
  spawn-ledger     [N spawns]
  out-queue        [N pending]
  executor-results [N .done.json]

CURSORS
  watcher last pull   [ISO timestamp from cursor.txt]
  last completion     [latest .done.json mtime]

CHANNELS
  whatsapp         [on|off|misconfigured]   chat_jid=[masked tail]
  email            [on|off|misconfigured]   to=[masked]

LAST 3 NOTIFICATIONS
  [N. kind type | task_id | sent_at]
──────────────────────────────────────────────────────
```

**Mobile mode** (Rule 7 — `$SSH_CONNECTION`/`$SSH_CLIENT`/`$SSH_TTY` set OR `$OPS_MOBILE=1` OR `$COLUMNS<80`): plain text lines, no boxes, no emoji prefixes:

```
pocket: watcher running, exec tmux=up, notifier pid=N
queues: triage 0, tasks 12 (3 active), out 0
last pull: 5m ago. last done: 12m ago.
channels: whatsapp on, email off.
```

After the dashboard, use `AskUserQuestion` (max 4 — Rule 1) ONLY if there is something actionable (stalled daemon, pending-triage > 0, etc.). On a clean board, exit silently.

---

## Route — `setup`

Delegate to the setup channel doc when it exists:

```bash
SETUP_DOC="$CLAUDE_PLUGIN_ROOT/skills/setup/channels/pocket.md"
[[ -f "$SETUP_DOC" ]] && cat "$SETUP_DOC"
```

If `pocket.md` does not exist, print the inline onboarding sequence:

1. Confirm `pocket-cli` (or equivalent Pocket API auth) is on PATH.
2. Drop a `whatsapp-config.json` and/or `email-config.json` under `$STATE_DIR` (see STATUS.md for schemas).
3. Run `bash $CLAUDE_PLUGIN_ROOT/scripts/install-pocket-notifier.sh` to register the launchd LaunchAgent.
4. Verify with `/ops:pocket status`.

Per Rule 4 (background by default during setup) and Rule 2 (never delegate commands to the user) — run the install script via Bash with `run_in_background: true`. Per Rule 3, never auto-skip channel selection — if `whatsapp-config.json` and `email-config.json` are both missing, ask via `AskUserQuestion` which to configure first (`[WhatsApp]` / `[Email]` / `[Both]` / `[Skip]`).

---

## Route — `tasks`

Render a single combined list. No `AskUserQuestion` — read-only by default.

```bash
STATE_DIR="${POCKET_STATE_DIR:-$HOME/.claude/state/pocket}"

# Pending triage (awaiting ACT/SKIP)
tail -n 50 "$STATE_DIR/pending-triage.jsonl" 2>/dev/null

# Live tasks (canonical store)
tail -n 50 "$STATE_DIR/tasks.jsonl" 2>/dev/null

# In-flight workers (windows in pocket-exec tmux, excluding _idle + supervisor)
tmux list-windows -t pocket-exec -F '#{window_name}' 2>/dev/null \
  | grep -vE '^(_idle|supervisor)$'

# Recently completed (.done.json sorted by mtime, last 10)
ls -t "$STATE_DIR/executor-results/"*.done.json 2>/dev/null | head -10
```

Format:

```
PENDING TRIAGE (N)
  [id] [created] [title]

ACTIVE TASKS (N)
  [task_id] [status] [title] [started]

IN-FLIGHT WORKERS (N)
  [tmux window name] [up since]

RECENTLY COMPLETED (last 10)
  [task_id] [duration] [report file]
```

---

## Route — `test` (synthetic end-to-end)

Smoke-tests the full notifier → out-queue → both bridges path **without** going through the watcher or triage. Same flow as the manual session-level test that was run when the notifier shipped.

**Steps:**

1. **Pre-flight**: verify `$STATE_DIR/whatsapp-config.json` OR `email-config.json` has `enabled: true`. If neither: print `not configured — run /ops:pocket setup` and exit.
2. **Generate a synthetic task_id** like `test-$(date +%s)`.
3. **Append a tasks.jsonl entry** for the synthetic task (so the notifier can title-resolve it):
   ```bash
   echo "{\"task_id\":\"$TID\",\"title\":\"synthetic pocket test\",\"created_at\":\"$(date -u +%FT%TZ)\",\"verdict\":\"ACT\"}" \
     >> "$STATE_DIR/tasks.jsonl"
   ```
4. **Drop a synthetic `.done.json`** into `executor-results/`:
   ```bash
   cat > "$STATE_DIR/executor-results/$TID.done.json" <<EOF
   {"task_id":"$TID","status":"done","completed_at":"$(date -u +%FT%TZ)","report_file":"$TID.out.md"}
   EOF
   echo "# Synthetic test report\n\nThis is a test artifact from /ops:pocket test." \
     > "$STATE_DIR/executor-results/$TID.out.md"
   ```
5. **Manually invoke the notifier once** (don't wait 60s for launchd):
   ```bash
   "$CLAUDE_PLUGIN_ROOT/scripts/ops-pocket-activity-notifier.py" --once 2>&1 | tail -20
   ```
   (If `--once` is not supported, run the script with `POCKET_NOTIFIER_ONESHOT=1` env var, or just `python3 ops-pocket-activity-notifier.py`.)
6. **Drain both bridges** in parallel:
   ```bash
   "$CLAUDE_PLUGIN_ROOT/scripts/ops-pocket-out-queue.py" 2>&1 | tail -10
   "$CLAUDE_PLUGIN_ROOT/scripts/ops-pocket-email-bridge.py" 2>&1 | tail -10
   ```
7. **Verify delivery** — for each enabled channel:
   - **WhatsApp**: tail `$STATE_DIR/out-queue-sent.jsonl` for an entry with the synthetic task_id. (Do NOT use `mcp__whatsapp__list_messages` — the bridge's own sent ledger is the source of truth.)
   - **Email**: tail `$STATE_DIR/email-bridge.log` for `SENT` on the synthetic task_id.
8. **Cleanup**:
   ```bash
   rm -f "$STATE_DIR/executor-results/$TID.done.json" \
         "$STATE_DIR/executor-results/$TID.out.md"
   ```
   Leave the `tasks.jsonl` line (append-only log; harmless).

**Report:**

```
POCKET ► TEST
  task_id: [tid]
  whatsapp: [SENT|SKIPPED-disabled|FAIL: reason]
  email:    [SENT|SKIPPED-disabled|FAIL: reason]
  duration: [Xs]
```

If any channel fails, surface the last error line from the corresponding `*.log` and `.health` file.

---

## Route — `logs [N]`

```bash
N="${ARG_2:-50}"
STATE_DIR="${POCKET_STATE_DIR:-$HOME/.claude/state/pocket}"

for f in activity-notifier.log run.log executor.log out-queue.log email-bridge.log; do
  echo "==> $f <=="
  tail -n "$N" "$STATE_DIR/$f" 2>/dev/null || echo "(missing)"
done
```

For Rule 7 mobile mode, default `N=20` and skip per-file headers.

---

## Route — `restart`

```bash
# 1. Kickstart the launchd activity-notifier
launchctl kickstart -k "gui/$(id -u)/com.claude-ops.pocket-activity-notifier" 2>&1

# 2. (Re)spawn the pocket-exec supervisor via the executor watchdog cron script
"$CLAUDE_PLUGIN_ROOT/scripts/ops-cron-pocket-executor.py" 2>&1 | tail -10
```

If the launchd label is missing (notifier never installed), prompt via `AskUserQuestion`: `[Install notifier now]` / `[Skip]`. On install: run `scripts/install-pocket-notifier.sh` (Rule 4: `run_in_background: true`).

---

## Route — `whatsapp on|off` and `email on|off`

Both routes mutate a small JSON config file. Never overwrite the whole file — patch in place.

```bash
STATE_DIR="${POCKET_STATE_DIR:-$HOME/.claude/state/pocket}"
CFG="$STATE_DIR/whatsapp-config.json"   # or email-config.json
ACTION="${ARG_2}"                        # on | off
mkdir -p "$STATE_DIR"

if [[ ! -f "$CFG" ]]; then
  # Bootstrap empty config with enabled=false so subsequent `on` is meaningful.
  echo '{"enabled":false}' > "$CFG"
fi

case "$ACTION" in
  on)  python3 -c "import json,sys,pathlib; p=pathlib.Path('$CFG'); d=json.loads(p.read_text()); d['enabled']=True; p.write_text(json.dumps(d,indent=2))" ;;
  off) python3 -c "import json,sys,pathlib; p=pathlib.Path('$CFG'); d=json.loads(p.read_text()); d['enabled']=False; p.write_text(json.dumps(d,indent=2))" ;;
  *)   echo "usage: /ops:pocket {whatsapp|email} {on|off}"; exit 2 ;;
esac

# Echo new state
cat "$CFG"
```

**Required keys per channel** (validated by `status`):

- `whatsapp-config.json` — `chat_jid` (WhatsApp JID of the self-chat, e.g. `<digits>@s.whatsapp.net`).
- `email-config.json` — `to` (self-email address).

If `on` is requested but the required key is missing, switch state to `enabled: false` and route the user to `setup` via `AskUserQuestion`.

---

## Rule reminders

- **Rule 1**: Max 4 options per `AskUserQuestion`. None of the routes above need more.
- **Rule 2**: Never delegate commands to the user — every command runs through Bash.
- **Rule 3**: Never auto-skip channels in `setup` — always ask explicitly.
- **Rule 4**: Background by default in `setup` (`run_in_background: true`).
- **Rule 5**: This skill performs NO destructive ops — no deletes, no terminates, no force-kills beyond `launchctl kickstart -k` (which is a graceful restart, not a wipe).
- **Rule 6**: No outbound comms staged from this skill except the synthetic test message in `test`, which goes to the operator's OWN self-chat / self-email (already enabled by the user) — not to third parties. Per-message approval rule is satisfied by the test being a no-args opt-in.
- **Rule 7**: Mobile mode renders plain text only — see `status` example.

## Native tool usage

- `AskUserQuestion`: only when there is a real choice to make (stalled daemon → restart? missing channel config → bootstrap?). Never required on a green status.
- `Skill`: `setup` route may delegate to the setup channel doc.

## See also

- [`STATUS.md`](./STATUS.md) — full architecture: 8 scripts, every state file, lifecycle, troubleshooting.
- `scripts/ops-cron-pocket-watcher.py`, `scripts/ops-pocket-triage.py`, `scripts/ops-cron-pocket-executor.py`, `scripts/ops-pocket-activity-notifier.py`, `scripts/ops-pocket-out-queue.py`, `scripts/ops-pocket-email-bridge.py`, `scripts/ops-pocket-whatsapp-bridge.py`.
- `scripts/install-pocket-notifier.sh`, `scripts/com.claude-ops.pocket-activity-notifier.plist`.
- `templates/pocket-supervisor-prompt.md` — the prompt the long-lived supervisor runs under.
