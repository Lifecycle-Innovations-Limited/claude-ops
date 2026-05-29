#!/usr/bin/env python3
"""ops-cron-pocket-executor — Pocket supervisor (stateless, headless).

Architecture (v3 — stateless Python supervisor):
  • The supervisor IS this cron script. No long-lived Claude Code
    session. Each tick, all bookkeeping runs in plain Python.
  • For each pending non-outbound task in tasks.jsonl, we spawn ONE
    `claude -p <worker-prompt>` subprocess in the background, log its
    spawn-ledger entry, and on completion persist a done.json receipt.
  • Concurrency cap (default 3) keeps the box well-behaved. Workers in
    flight survive across cron ticks; the next tick reaps completed
    ones and spawns more if there is queue + headroom.

Why v3 replaces v2:
  v2 piped a 13 KB supervisor prompt into a long-running `claude.exe`
  session via `tail -f /dev/null`. In headless mode Claude exits after
  the first turn (no real TTY for follow-up turns), but the tail keeps
  the wrapper bash alive — so the watchdog mistook a dead supervisor
  for an alive one and never made progress. v3 removes Claude from the
  supervisor role entirely; Claude only runs as a per-task worker via
  `claude -p`, which is purpose-built for single-shot headless use.

Each cron tick:
  1. Process supervisor-replies.jsonl → relay to workers, mark questions
     answered, archive.
  2. Reap completed worker subprocesses (PID watchdog) → write done.json
     receipt + update in_flight registry.
  3. Read tasks.jsonl from cursor; for each new task:
       - outbound (send_message / draft_email / send_file) → stays in
         drafts.jsonl, NOT dispatched.
       - otherwise → spawn a `claude -p` worker (subject to concurrency
         cap), record in spawn-ledger.jsonl + in-flight.json.
     Advance cursor only after dispatch (or skip-to-drafts) decision is
     persisted.
  4. Write .supervisor-health + .executor-health heartbeats.

Env:
  POCKET_STATE_DIR        default ~/.claude/state/pocket
  POCKET_CLAUDE_BIN       default /usr/local/bin/claude
  POCKET_EXEC_CWD         worker working dir, default $HOME
  POCKET_MAX_CONCURRENT   default 3
  POCKET_WORKER_MODEL     default claude-sonnet-4-6
  POCKET_WORKER_TIMEOUT   seconds, default 1800 (30 min)
  POCKET_EXEC_DRY_RUN=1   inspect only, no spawns / no writes.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-cron-pocket-executor]"
HOME = Path(os.path.expanduser("~"))

STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
CLAUDE_BIN = os.environ.get("POCKET_CLAUDE_BIN", "/usr/local/bin/claude")
EXEC_CWD = Path(os.environ.get("POCKET_EXEC_CWD", str(HOME)))
MAX_CONCURRENT = int(os.environ.get("POCKET_MAX_CONCURRENT", "3"))
WORKER_MODEL = os.environ.get("POCKET_WORKER_MODEL", "claude-sonnet-4-6")
WORKER_TIMEOUT = int(os.environ.get("POCKET_WORKER_TIMEOUT", "1800"))
DRY_RUN = os.environ.get("POCKET_EXEC_DRY_RUN") == "1"

# Least-privilege worker isolation (security hardening). When POCKET_WORKER_USER
# is set, each `claude --bg` worker is launched as that restricted unix user via
# `sudo -n` instead of inheriting the executor user's full privileges. This caps
# the blast radius of a prompt-injected/auto-promoted task: the worker can only
# touch what that user is granted (e.g. ~/Projects), not the executor's secrets,
# cloud creds, or SSH keys. Default empty = unchanged behaviour (runs as the
# executor user). When set, the deployment must also provide a NOPASSWD sudoers
# entry (<executor-user> -> POCKET_WORKER_USER; `sudo -n` fails loudly rather
# than prompting if missing) and a Claude config dir the worker can read, pointed
# to via POCKET_WORKER_CLAUDE_CONFIG_DIR (passed as CLAUDE_CONFIG_DIR).
WORKER_USER = os.environ.get("POCKET_WORKER_USER", "").strip()
WORKER_CLAUDE_CONFIG_DIR = os.environ.get("POCKET_WORKER_CLAUDE_CONFIG_DIR", "").strip()

DURABLE_LOG = STATE_DIR / "tasks.jsonl"
CURSOR_FILE = STATE_DIR / "supervisor-cursor.txt"
SPAWN_LEDGER = STATE_DIR / "spawn-ledger.jsonl"
IN_FLIGHT = STATE_DIR / "in-flight.json"
RESULTS_DIR = STATE_DIR / "executor-results"
WORKER_LOGS = STATE_DIR / "worker-logs"
QUESTIONS = STATE_DIR / "supervisor-questions.jsonl"
REPLIES = STATE_DIR / "supervisor-replies.jsonl"
REPLIES_ARCHIVE = STATE_DIR / "replies-archive.jsonl"
ANSWERED = STATE_DIR / "answered-questions.jsonl"
DRAFTS = STATE_DIR / "drafts.jsonl"
SUPERVISOR_HEALTH = STATE_DIR / ".supervisor-health"
EXECUTOR_HEALTH = STATE_DIR / ".executor-health"
LOG_FILE = STATE_DIR / "executor.log"

OUTBOUND_KINDS = {"send_message", "draft_email", "send_file", "send_sms", "send_whatsapp"}


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


def write_health(target: Path, status: str, msg: str = "", extra: dict | None = None) -> None:
    payload = {"status": status, "message": msg, "last_run": now_iso()}
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2))
    except OSError as e:
        log(f"health write to {target.name} failed: {e}")


def read_cursor() -> int:
    if not CURSOR_FILE.exists():
        return 0
    try:
        return int(CURSOR_FILE.read_text().strip() or "0")
    except (OSError, ValueError):
        return 0


def write_cursor(pos: int) -> None:
    if DRY_RUN:
        return
    try:
        CURSOR_FILE.write_text(str(pos))
    except OSError as e:
        log(f"cursor write failed: {e}")


def load_in_flight() -> dict[str, dict]:
    if not IN_FLIGHT.exists():
        return {}
    try:
        data = json.loads(IN_FLIGHT.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_in_flight(data: dict[str, dict]) -> None:
    if DRY_RUN:
        return
    try:
        IN_FLIGHT.write_text(json.dumps(data, indent=2))
    except OSError as e:
        log(f"in-flight save failed: {e}")


def append_jsonl(path: Path, obj: dict) -> None:
    if DRY_RUN:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as f:
            f.write(json.dumps(obj) + "\n")
    except OSError as e:
        log(f"append to {path.name} failed: {e}")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    out.append(obj)
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return out


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


# ── Reply relay ───────────────────────────────────────────────────────────────


def process_replies() -> int:
    """Drain supervisor-replies.jsonl → notify workers via a per-worker
    inbox file, archive processed replies, mark questions answered.
    Returns number of replies processed."""
    if not REPLIES.exists():
        return 0
    raw = REPLIES.read_text()
    if not raw.strip():
        return 0
    new_replies: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            if isinstance(r, dict) and r.get("id"):
                new_replies.append(r)
        except json.JSONDecodeError:
            continue
    if not new_replies:
        return 0

    questions = read_jsonl(QUESTIONS)
    answered_ids: set[str] = set()
    processed = 0
    for r in new_replies:
        qid = r["id"]
        q = next((qq for qq in questions if qq.get("id") == qid and qq.get("status") == "open"), None)
        if not q:
            log(f"reply for unknown/closed qid {qid} — archiving")
            append_jsonl(REPLIES_ARCHIVE, r)
            processed += 1
            continue
        worker = q.get("from_worker", "")
        if worker:
            worker_inbox = STATE_DIR / "worker-inboxes" / f"{worker}.jsonl"
            append_jsonl(worker_inbox, {
                "ts": now_iso(),
                "from": "supervisor",
                "qid": qid,
                "answer": r.get("answer", ""),
                "via": r.get("via", ""),
            })
        append_jsonl(ANSWERED, {**q, "status": "answered",
                                "answer": r.get("answer", ""),
                                "answered_at": now_iso()})
        append_jsonl(REPLIES_ARCHIVE, r)
        answered_ids.add(qid)
        processed += 1
        log(f"relayed reply qid={qid} to worker={worker or '(none)'}")

    if not DRY_RUN and processed:
        try:
            remaining = [q for q in questions if q.get("id") not in answered_ids]
            QUESTIONS.write_text(
                ("\n".join(json.dumps(q) for q in remaining) + "\n") if remaining else ""
            )
            REPLIES.write_text("")
        except OSError as e:
            log(f"questions/replies rewrite failed: {e}")
    return processed


# ── Worker subprocess management ──────────────────────────────────────────────


WORKER_PROMPT_TEMPLATE = """You are a single-shot Pocket worker. Complete EXACTLY ONE task and exit.

Task ID: {task_id}
Title: {title}
Priority: {priority}
Due: {due}
Source recording: {recording_id}

Context:
{context}

Hard rules:
  - STAY ON THIS TASK. No sibling work, no scope expansion. If you
    notice something else, mention it in your final summary — do NOT
    act on it.
  - Outbound comms (email, Slack, WhatsApp, SMS) require per-message
    approval. NEVER send. Stage drafts inline in your summary instead.
  - Destructive ops (rm -rf, force-push, drop table, aws ... delete-*)
    NEVER without owner confirmation. Stop and describe what you would
    have done.
  - You are running headless via `claude -p`. You will NOT get
    follow-up turns. Plan your single response carefully.
  - YOU HAVE A REAL HEADLESS BROWSER. For ANY web/dashboard/login/QA
    task (ManyChat, Meta Business Manager, Stripe, Vercel, etc.) use the
    gstack browse CLI:
      BROWSE="$HOME/.claude/skills/gstack/browse/dist/browse"
      "$BROWSE" goto <url> ; "$BROWSE" text ; "$BROWSE" click "<sel>" ;
      "$BROWSE" fill "<sel>" "<val>" ; "$BROWSE" screenshot ; "$BROWSE" cookie-import
    It is HEADLESS and works on a Linux box. The chrome-devtools MCP
    (mcp__chrome-devtools__*) is also connected as an alternative. Browser
    tasks are NOT impossible here — never say "Mac-only"; drive the browser.
  - For authenticated sites, fetch credentials from Dashlane: `dcli`
    (e.g. `dcli password <site>`). Or import synced cookies via
    `"$BROWSE" cookie-import`.
  - Gmail/Calendar are authed via `gog` (account in $GOG_ACCOUNT;
    GOG_ACCOUNT + GOG_KEYRING_PASSWORD are in the environment): e.g.
    `gog gmail search "<q>" -j --results-only --no-input`, `gog gmail get <id> -j`.
  - AWS CLI and the Cloudflare API are available for infra tasks.
  - Other read tools: Bash, Grep, Glob, Read, WebFetch. For writes/edits,
    use them as needed to complete the task (respecting the rules above).
  - End with a markdown block titled `## Outcome` describing what you
    did, what (if anything) was blocked, and any follow-up the owner
    should review. Keep it to 4-8 lines.

Begin now. Be concise. The owner will read your final response."""


def build_worker_prompt(task: dict) -> str:
    return WORKER_PROMPT_TEMPLATE.format(
        task_id=task.get("id", "?"),
        title=(task.get("title") or "")[:200],
        priority=task.get("priority", "normal"),
        due=task.get("due") or "none",
        recording_id=task.get("recording_id") or "none",
        context=(task.get("context") or "")[:2000],
    )


def spawn_worker(task: dict) -> dict | None:
    """Spawn a `claude -p` subprocess for the task. Returns in-flight
    record on success, None on failure."""
    task_id = task.get("id")
    if not task_id:
        return None
    if DRY_RUN:
        log(f"(dry-run) would spawn worker for {task_id}")
        return None

    WORKER_LOGS.mkdir(parents=True, exist_ok=True)
    worker_id = f"worker-{task_id[:24]}-{uuid.uuid4().hex[:6]}"
    stdout_path = WORKER_LOGS / f"{worker_id}.out.log"
    stderr_path = WORKER_LOGS / f"{worker_id}.err.log"
    prompt = build_worker_prompt(task)

    # 2026-05-25: switched from `claude -p` (one-shot headless) to
    # `claude --bg ... -p PROMPT` so workers appear in `claude agents`, are
    # steerable via SendMessage, survive terminal disconnects, and Sam can
    # attach/inspect live. Prompt MUST be passed as -p argument; stdin is
    # ignored by --bg (would leave the session idle with "(send a prompt)").
    env = os.environ.copy()
    env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"] = "0"
    # Identify the worker to the env-broker audit log (pocket-env client reads these).
    env["POCKET_TASK_ID"] = str(task_id)
    env["POCKET_WORKER_ID"] = worker_id
    if WORKER_USER and WORKER_CLAUDE_CONFIG_DIR:
        # Point the restricted worker at a Claude config dir it can read.
        env["CLAUDE_CONFIG_DIR"] = WORKER_CLAUDE_CONFIG_DIR
    # Display name shown in `claude agents` list — short, categorical, NOT the
    # full prompt. Sam corrected 2026-05-25: name field ≠ prompt field.
    display_name = f"pocket: {(task.get('title') or task_id)[:60]}"
    cmd = [CLAUDE_BIN, "--dangerously-skip-permissions", "--bg",
           "--name", display_name,
           "--effort", "high",
           "--model", WORKER_MODEL,
           "--add-dir", str(EXEC_CWD),
           "-p", prompt]
    if WORKER_USER and WORKER_USER != (os.environ.get("USER") or ""):
        # Drop privileges: run the worker as the restricted POCKET_WORKER_USER.
        # `sudo -n` is non-interactive (fails loudly if NOPASSWD sudoers is missing
        # rather than hanging); `-H` sets HOME to the worker user's home so Claude
        # writes session state there; --preserve-env carries only the vars the
        # worker needs, dropping the executor user's secrets from the environment.
        _preserve = "PATH,CLAUDE_CONFIG_DIR,CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,ANTHROPIC_API_KEY,POCKET_WORKER_MODEL,POCKET_ENV_BROKER_SOCK,POCKET_STATE_DIR,POCKET_TASK_ID,POCKET_WORKER_ID"
        cmd = ["sudo", "-n", "-H", "-u", WORKER_USER, f"--preserve-env={_preserve}", "--", *cmd]

    try:
        out_f = stdout_path.open("w")
        err_f = stderr_path.open("w")
        # claude --bg returns immediately with session id on stdout, then detaches.
        proc = subprocess.Popen(
            cmd,
            cwd=str(EXEC_CWD),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out_f,
            stderr=err_f,
            start_new_session=True,
        )
        # Wait briefly for it to detach + write its session id, then keep going.
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        # Parse session id from stdout (claude --bg prints `backgrounded · <hex8>`).
        bg_session_id = None
        try:
            head = stdout_path.read_text()[:512]
            import re as _re
            m = _re.search(r"backgrounded[^a-f0-9]+([a-f0-9]{8,})", head)
            if m:
                bg_session_id = m.group(1)
        except Exception:
            pass
    except OSError as e:
        log(f"spawn failed for {task_id}: {e}")
        return None

    record = {
        "worker": worker_id,
        "pid": proc.pid,
        "pocket_task_id": task_id,
        "title": (task.get("title") or "")[:120],
        "started_at": now_iso(),
        "deadline_epoch": int(time.time()) + WORKER_TIMEOUT,
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
        "model": WORKER_MODEL,
        "bg_session_id": bg_session_id,  # for SendMessage / claude attach
        "spawn_mode": "claude-bg",
    }
    append_jsonl(SPAWN_LEDGER, {
        "ts": record["started_at"],
        "worker": worker_id,
        "pid": proc.pid,
        "pocket_task_id": task_id,
        "title": record["title"],
        "model": WORKER_MODEL,
        "bg_session_id": bg_session_id,
        "spawn_mode": "claude-bg",
    })
    log(f"spawned {worker_id} pid={proc.pid} task={task_id} bg_session={bg_session_id or 'unknown'}")
    return record



def _claude_agents_status_map() -> dict[str, str] | None:
    """Returns {sessionId: status} for all claude --bg sessions visible to the
    daemon. None if the query failed (never raises — reap must keep working)."""
    try:
        out = subprocess.run(
            [CLAUDE_BIN, "agents", "--json"],
            stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            return None
        d = json.loads(out.stdout or "[]")
        sessions = d if isinstance(d, list) else d.get("sessions", []) or []
        return {s.get("sessionId", ""): s.get("status", "?") for s in sessions if s.get("sessionId")}
    except Exception:
        return None


def _bg_session_done(bg_session_id: str | None, agents_map: dict[str, str] | None) -> bool:
    """A claude --bg session is 'done' when its session id no longer appears in
    `claude agents --json` (daemon evicts completed sessions) OR status is
    'completed'/'stopped'. Returns False if we have no session id or the daemon
    query failed (can't tell)."""
    if not bg_session_id or agents_map is None:
        return False
    full_key = next((k for k in agents_map if k.startswith(bg_session_id)), None)
    if full_key is None:
        return True
    return agents_map.get(full_key, "?") in ("completed", "stopped", "done")

def reap_workers(in_flight: dict[str, dict]) -> tuple[int, int]:
    """Check each in-flight worker. If exited, write done.json receipt
    and remove from registry. If past deadline, SIGTERM. Returns
    (completed_count, killed_count)."""
    # Invalidate cached agents map at start of each reap pass.
    reap_workers.__dict__.pop("_agents_map", None)
    completed = 0
    killed = 0
    now = int(time.time())
    for worker_id in list(in_flight.keys()):
        rec = in_flight[worker_id]
        pid = rec.get("pid")
        if not pid:
            del in_flight[worker_id]
            continue
        # For claude --bg workers, the spawned PID is just the shim that
        # handed off to claude-daemon — it exits ~5s after spawn. PID-alive
        # is meaningless. Use `claude agents --json` to query real session state.
        bg_session_id = rec.get("bg_session_id")
        spawn_mode = rec.get("spawn_mode", "")
        if spawn_mode == "claude-bg":
            # PID-alive is meaningless for bg workers; never fall through to legacy.
            if not bg_session_id:
                if now > rec.get("deadline_epoch", now + 1):
                    log(f"worker {worker_id} claude-bg missing session id — timed out")
                    killed += 1
                    del in_flight[worker_id]
                continue
            # Lazy-init the agents map per reap pass.
            if "_agents_map" not in reap_workers.__dict__:
                reap_workers._agents_map = _claude_agents_status_map()
            agents_map = reap_workers._agents_map
            if not _bg_session_done(bg_session_id, agents_map):
                # Still in-flight or daemon unreachable. Apply deadline timeout.
                if now > rec.get("deadline_epoch", now + 1):
                    log(f"worker {worker_id} bg={bg_session_id} timed out — stopping session")
                    try:
                        subprocess.run([CLAUDE_BIN, "stop", bg_session_id],
                                       stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
                    except Exception:
                        pass
                    killed += 1
                    continue
                continue
            # session disappeared from agents list → completed. Fall through to receipt.
        else:
            # Legacy claude -p path — PID check.
            alive = pid_alive(pid)
            if alive and now > rec.get("deadline_epoch", now + 1):
                log(f"worker {worker_id} pid={pid} timed out — SIGTERM")
                try:
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
                killed += 1
                continue
            if alive:
                continue
        task_id = rec.get("pocket_task_id", "unknown")
        stdout_path = Path(rec.get("stdout", ""))
        summary = ""
        # For claude --bg workers, the shim stdout is uninteresting (just session
        # banner). Pull the real conversation output from `claude logs <session>`.
        bg_session_id = rec.get("bg_session_id")
        spawn_mode = rec.get("spawn_mode", "")
        if spawn_mode == "claude-bg" and bg_session_id:
            # Daemon takes a few seconds to flush session output after stop.
            # Retry up to 3× with backoff before giving up.
            for attempt in range(3):
                try:
                    logs = subprocess.run(
                        [CLAUDE_BIN, "logs", bg_session_id],
                        stdin=subprocess.DEVNULL,
                        capture_output=True, text=True, timeout=15,
                    )
                    if logs.returncode == 0 and len(logs.stdout.strip()) > 200:
                        summary = logs.stdout[-4000:]
                        break
                except Exception as e:
                    log(f"claude logs fetch failed for {bg_session_id} (attempt {attempt+1}): {e}")
                time.sleep(2 * (attempt + 1))  # 2s, 4s, 6s
        if not summary and stdout_path.exists():
            try:
                txt = stdout_path.read_text()
                summary = txt[-4000:]
            except OSError:
                summary = ""
        receipt = {
            "status": "completed",
            "pocket_task_id": task_id,
            "worker": worker_id,
            "started_at": rec.get("started_at"),
            "completed_at": now_iso(),
            "summary": summary[-1500:],
            "stdout_path": str(stdout_path),
            "stderr_path": rec.get("stderr"),
        }
        try:
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            (RESULTS_DIR / f"{task_id}.done.json").write_text(json.dumps(receipt, indent=2))
        except OSError as e:
            log(f"failed to write receipt for {task_id}: {e}")
        log(f"reaped {worker_id} task={task_id}")
        del in_flight[worker_id]
        completed += 1
    return completed, killed


# ── Task pump ─────────────────────────────────────────────────────────────────


def pump_tasks(in_flight: dict[str, dict]) -> tuple[int, int, int]:
    """Read new tasks from durable log, dispatch up to concurrency cap.
    Returns (new_workers, drafts_frozen, queued_remaining_bytes)."""
    if not DURABLE_LOG.exists():
        return 0, 0, 0

    cursor = read_cursor()
    try:
        with DURABLE_LOG.open("rb") as f:
            f.seek(cursor)
            raw = f.read()
        file_size = DURABLE_LOG.stat().st_size
    except OSError as e:
        log(f"durable log read failed: {e}")
        return 0, 0, 0
    if not raw:
        return 0, 0, 0

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    dispatched = 0
    drafted = 0
    consumed = 0
    in_flight_task_ids = {r.get("pocket_task_id") for r in in_flight.values()}

    for line in lines:
        if not line.endswith("\n"):
            break  # partial trailing line — wait for next tick
        stripped = line.strip()
        line_bytes = len(line.encode("utf-8"))
        if not stripped:
            consumed += line_bytes
            continue
        try:
            task = json.loads(stripped)
        except json.JSONDecodeError:
            log(f"skipping malformed task line: {stripped[:120]}")
            consumed += line_bytes
            continue
        if not isinstance(task, dict):
            consumed += line_bytes
            continue
        task_id = task.get("id")
        if not task_id:
            log(f"task missing id, skipping: {stripped[:120]}")
            consumed += line_bytes
            continue
        kind = task.get("kind", "task")
        if kind in OUTBOUND_KINDS:
            append_jsonl(DRAFTS, task)
            drafted += 1
            log(f"frozen outbound draft kind={kind} task={task_id}")
            consumed += line_bytes
            continue
        if task_id in in_flight_task_ids:
            consumed += line_bytes
            continue
        receipt = RESULTS_DIR / f"{task_id}.done.json"
        if receipt.exists():
            consumed += line_bytes
            continue
        if len(in_flight) >= MAX_CONCURRENT:
            break  # don't consume this line; retry next tick
        rec = spawn_worker(task)
        if rec:
            in_flight[rec["worker"]] = rec
            in_flight_task_ids.add(rec["pocket_task_id"])
            dispatched += 1
        consumed += line_bytes

    new_cursor = cursor + consumed
    if new_cursor != cursor:
        write_cursor(new_cursor)
    queued_remaining = max(0, file_size - new_cursor)
    return dispatched, drafted, queued_remaining


# ── Main tick ─────────────────────────────────────────────────────────────────


def main() -> int:
    write_health(EXECUTOR_HEALTH, "running", "tick")
    log("tick")

    in_flight = load_in_flight()

    replies_processed = process_replies()
    completed, killed = reap_workers(in_flight)
    new_workers, drafts, queue_remaining = pump_tasks(in_flight)

    save_in_flight(in_flight)

    supervisor_state = {
        "status": "ok",
        "ts": now_iso(),
        "active_workers": len(in_flight),
        "queue_remaining_bytes": queue_remaining,
        "last_processed": f"cursor@{read_cursor()}",
        "replies_processed_this_tick": replies_processed,
        "workers_completed_this_tick": completed,
        "workers_killed_this_tick": killed,
        "workers_spawned_this_tick": new_workers,
        "drafts_frozen_this_tick": drafts,
    }
    if not DRY_RUN:
        try:
            SUPERVISOR_HEALTH.write_text(json.dumps(supervisor_state, indent=2))
        except OSError as e:
            log(f"supervisor-health write failed: {e}")

    write_health(
        EXECUTOR_HEALTH,
        "ok",
        f"active={len(in_flight)} spawned={new_workers} done={completed} drafts={drafts}",
        extra={
            "active_workers": len(in_flight),
            "spawned": new_workers,
            "completed": completed,
            "killed": killed,
            "drafts": drafts,
            "replies_processed": replies_processed,
            "queue_remaining_bytes": queue_remaining,
        },
    )
    log(
        f"done active={len(in_flight)} spawned={new_workers} "
        f"completed={completed} killed={killed} drafts={drafts} "
        f"replies={replies_processed} queue_remaining_bytes={queue_remaining}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health(EXECUTOR_HEALTH, "error", f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
