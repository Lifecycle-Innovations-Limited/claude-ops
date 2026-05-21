#!/usr/bin/env python3
"""ops-cron-pocket-executor — Watchdog for the persistent Pocket supervisor.

Architecture (v2 — Agent Teams):
  • A single long-lived Claude Code session runs in tmux window
    `pocket-exec:supervisor`. It uses Agent Teams (TeamCreate +
    Agent(team_name=...)) to spawn worker teammates per Pocket task.
  • The supervisor reads `tasks.jsonl` directly on each wake (via its own
    cursor file `supervisor-cursor.txt`) and dispatches up to N teammates.
  • This script's only job is to keep that supervisor window alive.

Behaviour each cron tick:
  1. Ensure tmux session `pocket-exec` exists (with an `_idle` keepalive window).
  2. Check that `supervisor` window still has a live `claude` process — if
     missing or dead, respawn it from the prompt template.
  3. Write health heartbeat to `.executor-health`.

What this script does NOT do anymore:
  • Spawning per-task worker windows (the supervisor does that as teammates).
  • Reading tasks.jsonl (the supervisor handles it).

Env:
  POCKET_STATE_DIR        default ~/.claude/state/pocket
  POCKET_TMUX_SESSION     default pocket-exec
  POCKET_CLAUDE_BIN       default $HOME/.local/bin/claude
  POCKET_EXEC_CWD         supervisor working dir, default $HOME
  POCKET_SUPERVISOR_PROMPT path to supervisor prompt; default = bundled template
  POCKET_EXEC_DRY_RUN=1   skip tmux spawns, just log intent.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-cron-pocket-executor]"
HOME = Path(os.path.expanduser("~"))

STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
TMUX_SESSION = os.environ.get("POCKET_TMUX_SESSION", "pocket-exec")
TMUX_SOCKET = os.environ.get("POCKET_TMUX_SOCKET", "")  # e.g. "claw" → tmux -L claw; empty = default
CLAUDE_BIN = os.environ.get("POCKET_CLAUDE_BIN", str(HOME / ".local/bin/claude"))
EXEC_CWD = Path(os.environ.get("POCKET_EXEC_CWD", str(HOME)))
DRY_RUN = os.environ.get("POCKET_EXEC_DRY_RUN") == "1"

SUPERVISOR_WINDOW = "supervisor"
SUPERVISOR_PROMPT = Path(
    os.environ.get(
        "POCKET_SUPERVISOR_PROMPT",
        str(Path(__file__).resolve().parent.parent / "templates" / "pocket-supervisor-prompt.md"),
    )
)

HEALTH_FILE = STATE_DIR / ".executor-health"
LOG_FILE = STATE_DIR / "executor.log"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now_iso()} {LOG_PREFIX} {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def write_health(status: str, msg: str = "", extra: dict | None = None) -> None:
    payload = {"status": status, "message": msg, "last_run": now_iso()}
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEALTH_FILE.write_text(json.dumps(payload, indent=2))
    except OSError as e:
        log(f"health write failed: {e}")


def tmux(*args: str, capture: bool = True) -> tuple[int, str, str]:
    base = ["tmux", "-L", TMUX_SOCKET] if TMUX_SOCKET else ["tmux"]
    cmd = [*base, *args]
    try:
        proc = subprocess.run(cmd, capture_output=capture, text=True, timeout=15)
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        log("tmux not found on PATH")
        return 127, "", "tmux not installed"
    except subprocess.TimeoutExpired:
        log(f"tmux {args[0]} timed out")
        return 124, "", "timeout"


def list_windows() -> list[tuple[str, str]]:
    """Returns [(name, pid_of_first_pane), ...]"""
    rc, out, _ = tmux(
        "list-windows", "-t", TMUX_SESSION,
        "-F", "#{window_name}|#{pane_pid}",
    )
    if rc != 0:
        return []
    pairs: list[tuple[str, str]] = []
    for line in out.splitlines():
        if "|" in line:
            name, pid = line.split("|", 1)
            pairs.append((name, pid))
    return pairs


def ensure_session() -> bool:
    rc, _, _ = tmux("has-session", "-t", TMUX_SESSION)
    if rc == 0:
        return True
    log(f"creating tmux session '{TMUX_SESSION}'")
    rc, _, err = tmux(
        "new-session", "-d", "-s", TMUX_SESSION, "-n", "_idle",
        "-c", str(EXEC_CWD),
        "bash", "-l",
    )
    if rc != 0:
        log(f"tmux new-session failed: {err.strip()[:200]}")
        return False
    return True


def supervisor_alive() -> bool:
    """A 'live' supervisor has a `claude` process in its pane process tree."""
    for name, pid in list_windows():
        if name != SUPERVISOR_WINDOW:
            continue
        # pgrep -P checks children; we want to know if `claude` is anywhere in
        # the descendant tree.
        try:
            out = subprocess.run(
                ["pgrep", "-P", pid],
                capture_output=True, text=True, timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return True  # can't verify; assume alive to avoid thrashing
        children_pids = [p for p in out.stdout.split() if p]
        # Walk one level: check `ps` for any descendant whose command contains 'claude'
        if not children_pids:
            return False
        try:
            ps = subprocess.run(
                ["ps", "-o", "command=", "-p", ",".join(children_pids)],
                capture_output=True, text=True, timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return True
        return "claude" in ps.stdout.lower()
    return False


def ensure_supervisor() -> str:
    """Returns 'spawned', 'alive', 'respawned', 'missing_prompt', or 'failed'."""
    names = {n for n, _ in list_windows()}
    has_window = SUPERVISOR_WINDOW in names

    if has_window and supervisor_alive():
        return "alive"

    if not SUPERVISOR_PROMPT.exists():
        log(f"supervisor prompt missing at {SUPERVISOR_PROMPT}")
        return "missing_prompt"

    if has_window:
        log("supervisor window exists but Claude is not running — killing for clean respawn")
        tmux("kill-window", "-t", f"{TMUX_SESSION}:{SUPERVISOR_WINDOW}")

    log("spawning supervisor window")
    # Inner command: pipe prompt into claude; keep shell open after exit so a
    # post-mortem is visible if Claude crashes.
    # Pipe the prompt as the first user message, then keep stdin open with
    # `tail -f /dev/null` so Claude treats it as an interactive session and
    # honors ScheduleWakeup. Without this, stdin EOF causes immediate exit.
    inner = (
        f"export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1; "
        f"( cat {shlex.quote(str(SUPERVISOR_PROMPT))}; tail -f /dev/null ) | "
        f"{shlex.quote(CLAUDE_BIN)} --dangerously-skip-permissions; "
        f"echo; echo '[supervisor] exited at $(date -u +%FT%TZ) — next watchdog tick will respawn'; "
        f"exec bash -l"
    )
    rc, _, err = tmux(
        "new-window", "-t", TMUX_SESSION, "-n", SUPERVISOR_WINDOW,
        "-c", str(EXEC_CWD),
        "bash", "-c", inner,
    )
    if rc != 0:
        log(f"supervisor spawn failed: {err.strip()[:200]}")
        return "failed"
    return "spawned" if not has_window else "respawned"


SPAWN_LEDGER = STATE_DIR / "spawn-ledger.jsonl"
TEAM_MAILBOX = Path(os.path.expanduser("~/.claude/teams/pocket-orchestrator/inboxes/team-lead.json"))
RESULTS_DIR = STATE_DIR / "executor-results"
ORPHAN_DIR = STATE_DIR / "orphans"
DURABLE_LOG = STATE_DIR / "tasks.jsonl"


def _load_ledger() -> dict[str, dict]:
    """Map worker_name -> {pocket_task_id, title, ts}. Latest entry wins."""
    if not SPAWN_LEDGER.exists():
        return {}
    out: dict[str, dict] = {}
    try:
        for raw in SPAWN_LEDGER.read_text().splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                continue
            w = e.get("worker")
            if w:
                out[w] = e
    except OSError:
        return {}
    return out


def _load_durable_ids() -> set[str]:
    """All known pocket_task_ids from the durable log — used to validate ledger entries."""
    if not DURABLE_LOG.exists():
        return set()
    ids: set[str] = set()
    try:
        for raw in DURABLE_LOG.read_text().splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                t = json.loads(raw)
                tid = t.get("id")
                if tid:
                    ids.add(tid)
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return ids


def reap_mailbox() -> tuple[int, int]:
    """Scan the team mailbox for substantive (non-idle) worker messages,
    persist each as a durable receipt linked to its pocket_task_id.

    Returns (persisted_count, orphan_count). Orphans are messages from
    workers not in the spawn-ledger — these indicate the supervisor either
    skipped writing the ledger entry OR a teammate did unauthorized work.
    Orphans are quarantined under STATE_DIR/orphans/ with a warning log.
    """
    if not TEAM_MAILBOX.exists():
        return (0, 0)
    try:
        messages = json.loads(TEAM_MAILBOX.read_text())
    except (OSError, json.JSONDecodeError):
        return (0, 0)
    if not isinstance(messages, list):
        return (0, 0)

    ledger = _load_ledger()
    durable_ids = _load_durable_ids()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ORPHAN_DIR.mkdir(parents=True, exist_ok=True)

    persisted = 0
    orphans = 0
    for m in messages:
        text = m.get("text", "") or ""
        # Skip idle / heartbeat JSON payloads
        if text.startswith("{") and ("idle_notification" in text or "shutdown" in text):
            continue
        sender = m.get("from", "") or ""
        ts = m.get("timestamp", "") or now_iso()
        summary = (m.get("summary") or text[:300]).strip()
        if not summary:
            continue

        # Stable receipt id: ISO-timestamp + sender, sanitized
        safe_ts = ts.replace(":", "").replace(".", "_")[:20]
        receipt_name = f"{safe_ts}__{sender}.completed.json"

        ledger_entry = ledger.get(sender)
        if ledger_entry and ledger_entry.get("pocket_task_id") in durable_ids:
            target_dir = RESULTS_DIR
            pocket_task_id = ledger_entry["pocket_task_id"]
            kind = "linked"
        else:
            target_dir = ORPHAN_DIR
            pocket_task_id = None
            kind = "orphan"

        target = target_dir / receipt_name
        if target.exists():
            continue  # idempotent

        receipt = {
            "ts": ts,
            "worker": sender,
            "summary": m.get("summary"),
            "text": text,
            "color": m.get("color"),
            "pocket_task_id": pocket_task_id,
            "ledger_entry": ledger_entry,
            "kind": kind,
            "captured_by": "executor-reaper",
            "captured_at": now_iso(),
        }
        try:
            target.write_text(json.dumps(receipt, indent=2))
            if kind == "orphan":
                orphans += 1
                log(f"ORPHAN work persisted: {sender} (no ledger entry) — {summary[:80]}")
            else:
                persisted += 1
        except OSError as e:
            log(f"failed to write receipt {target}: {e}")
    return (persisted, orphans)


def main() -> int:
    write_health("running", "watchdog tick")
    log("watchdog tick")

    if DRY_RUN:
        log("(dry-run) skipping tmux ops")
        write_health("ok", "dry-run", extra={"supervisor": "skipped"})
        return 0

    if not ensure_session():
        write_health("error", "tmux session bootstrap failed")
        return 2

    status = ensure_supervisor()

    # Mechanical receipt persistence — independent of supervisor behavior.
    persisted, orphans = reap_mailbox()

    write_health("ok", f"supervisor={status} reaped={persisted} orphans={orphans}", extra={
        "supervisor": status,
        "session": TMUX_SESSION,
        "receipts_persisted": persisted,
        "orphan_receipts": orphans,
    })
    log(f"done supervisor={status} reaped={persisted} orphans={orphans}")
    return 0 if status in ("alive", "spawned", "respawned") else 1


if __name__ == "__main__":
    sys.exit(main())
