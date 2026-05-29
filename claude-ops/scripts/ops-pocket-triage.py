#!/usr/bin/env python3
"""ops-pocket-triage — Opus-powered safety gate for Pocket-inferred tasks.

Reads pending-triage.jsonl, asks Opus (with extended thinking) for each item:
  "Is this something a Claude Code agent can safely execute autonomously
  given Sam's known rules and the task's domain?"

Routes each task into one of four buckets:

  ACT    → tasks.jsonl   (supervisor will pick up, dispatch a worker)
  DRAFT  → drafts.jsonl  (outbound content; Rule 6 — per-message approval)
  DROP   → dropped.jsonl (personal / private / non-task / duplicate / silly)
  ASK    → review.jsonl  (high-stakes or ambiguous; Sam must decide)

A reasoning trace (Opus's extended-thinking summary) is persisted for every
decision so the call is auditable.

Safety doctrine — the model is told that "safe to ACT autonomously" means:
  • READ-ONLY by default (file scans, API health checks, log review, etc.)
  • State-mutating ops only when the mutation is local, reversible, scoped
    to Sam's own infra, and not financial or identity-touching.
  • NEVER autonomous: outbound comms, account creation, signing/auth flows,
    spending money, personal/family/household, anything involving someone
    else's consent.
  • ASK when intent is ambiguous, scope is unclear, or the cost of acting
    wrongly is high.

Env:
  POCKET_STATE_DIR              default ~/.claude/state/pocket
  POCKET_TRIAGE_MODEL           default claude-opus-4-7
  POCKET_TRIAGE_THINKING_TOKENS default 4000
  POCKET_TRIAGE_MAX_TOKENS      default 1500
  POCKET_TRIAGE_DRY_RUN=1       skip routing writes, just log decisions
  ANTHROPIC_API_KEY / Claude Code OAuth (auto-resolved from keychain)

Files (under POCKET_STATE_DIR):
  pending-triage.jsonl  IN — produced by watcher
  tasks.jsonl           OUT — ACT verdicts (append)
  drafts.jsonl          OUT — DRAFT verdicts (append)
  dropped.jsonl         OUT — DROP audit log (append)
  review.jsonl          OUT — ASK queue for Sam
  triage-decisions.jsonl OUT — full audit of every decision + thinking
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerr
from urllib import request as urlreq

LOG_PREFIX = "[ops-pocket-triage]"

# === Phase 2 hook: decision log =====================================
try:
    import importlib.util as _ilu

    _SCRIPTS = Path(
        os.environ.get("POCKET_SCRIPTS_DIR", str(Path(__file__).resolve().parent))
    )
    _dec_spec = _ilu.spec_from_file_location(
        "_pkt_decisions", _SCRIPTS / "ops-pocket-decisions.py"
    )
    _dec_mod = _ilu.module_from_spec(_dec_spec)
    _dec_spec.loader.exec_module(_dec_mod)
except Exception as _e:
    _dec_mod = None
    # Don't crash triage if the decision log can't load, but DO signal it —
    # silent loss of the audit trail should be visible to the operator.
    print(
        f"WARN ops-pocket-triage: decision log unavailable ({_e!r}); "
        "decisions will NOT be audited this run",
        file=sys.stderr,
    )
# ====================================================================

HOME = Path(os.path.expanduser("~"))

# ---------------------------------------------------------------------------
# User identity context — loaded from ~/.claude/state/pocket/user-context.json
# Shape:
#   {
#     "owner_name": "Your Name",
#     "team_members": ["Teammate One", "Teammate Two"]
#   }
# This file is in user state and must NOT be committed to source control.
# If the file is missing, generic placeholders are used (no crash).
# ---------------------------------------------------------------------------
_USER_CONTEXT_PATH = Path(
    os.environ.get(
        "POCKET_USER_CONTEXT",
        HOME / ".claude/state/pocket/user-context.json",
    )
)
try:
    _ctx = json.loads(_USER_CONTEXT_PATH.read_text())
    _OWNER_NAME: str = _ctx.get("owner_name") or "the user"
    _TEAM_MEMBERS: list[str] = _ctx.get("team_members") or []
except (OSError, json.JSONDecodeError):
    _OWNER_NAME = "the user"
    _TEAM_MEMBERS = []

_TEAM_MEMBERS_DESC = (
    ", ".join(_TEAM_MEMBERS)
    if _TEAM_MEMBERS
    else "team members (configure in user-context.json)"
)

STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
MODEL = os.environ.get("POCKET_TRIAGE_MODEL", "claude-sonnet-4-6")
RETRY_ON_RATE_LIMIT = os.environ.get("POCKET_TRIAGE_RETRY_RATE_LIMIT", "1") != "0"
RATE_LIMIT_BACKOFF_SECS = int(os.environ.get("POCKET_TRIAGE_RATE_LIMIT_BACKOFF", "60"))
THINKING_BUDGET = int(os.environ.get("POCKET_TRIAGE_THINKING_TOKENS", "4000"))
MAX_TOKENS = int(os.environ.get("POCKET_TRIAGE_MAX_TOKENS", "1500"))
DRY_RUN = os.environ.get("POCKET_TRIAGE_DRY_RUN") == "1"

PENDING = STATE_DIR / "pending-triage.jsonl"
TASKS = STATE_DIR / "tasks.jsonl"
DRAFTS = STATE_DIR / "drafts.jsonl"
DROPPED = STATE_DIR / "dropped.jsonl"
REVIEW = STATE_DIR / "review.jsonl"
AUDIT = STATE_DIR / "triage-decisions.jsonl"
HEALTH = STATE_DIR / ".triage-health"
LOG_FILE = STATE_DIR / "triage.log"


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
        HEALTH.write_text(json.dumps(payload, indent=2))
    except OSError as e:
        log(f"health write failed: {e}")


_SYSTEM_PROMPT_TEMPLATE = """You are the safety triage agent for {owner_name}'s personal automation pipeline. {owner_name} records voice memos via Pocket AI. A Haiku layer extracts implicit tasks from each transcript. Your job is to decide, for ONE candidate task at a time, whether a Claude Code subagent can safely execute it autonomously on their machine.

Use extended thinking. Reason step-by-step about:
  1. Domain — is this business/code, or personal/family/household?
  2. Reversibility — can a wrong action be undone cheaply?
  3. External effects — does it touch other humans (email, Slack, calendars)? Spend money? Create accounts? Sign anything?
  4. Information needed — would the agent need the owner's identity, ID documents, biometric, or in-person presence?
  5. Ambiguity — is the task scope clear, or is the agent likely to invent the wrong thing?
  6. Duplication / staleness — is this likely already done, or so vague it's a musing rather than a task?

Then assign exactly ONE verdict:

  ACT    — A Claude Code subagent can safely execute this autonomously. Defaults: read-only (file scans, API health, log review, AWS describe-*, code analysis, repo status). Mutations only if local-and-reversible (write a draft file, run tests, generate a report). NO outbound, NO money, NO identity ops.

  DRAFT  — The task produces outbound content (email, Slack, WhatsApp, social post, calendar invite). The subagent can DRAFT it but must NEVER send. Per the owner's Rule 6, every outbound message needs per-message approval.

  DROP   — Not appropriate for autonomous execution AND not worth the owner's manual review. Examples: personal/family/household tasks ("kitchen quote"), study plans, vague musings, things that need the owner's body or ID in person, items the agent has no chance of doing well.

  ASK    — Ambiguous, high-stakes, or scope-unclear. Worth the owner reviewing before committing to a category. Examples: tasks needing ID/face verification, judgment calls involving other people, high-stakes decisions.

Return STRICT JSON, no markdown, no prose outside the JSON:

{{
  "verdict": "ACT" | "DRAFT" | "DROP" | "ASK",
  "confidence": 0.0-1.0,
  "reasoning": "<2-4 sentence summary of why — distill your extended thinking>",
  "scoped_task_description": "<if ACT: a tightened, executable version of the task; if DRAFT: what the draft should cover; else: empty>",
  "concerns": ["<any specific risks the executing agent should know>"]
}}

Owner context (NEVER assume otherwise):
  • Owner name: {owner_name}
  • Known team members: {team_members}
  • Per the owner's global CLAUDE.md, outbound comms are NEVER autonomously sent. Period.
  • Per the owner's global CLAUDE.md, infrastructure mutations require explicit confirmation.
  • Personal/family items are out of scope for this pipeline.
"""

SYSTEM_PROMPT = _SYSTEM_PROMPT_TEMPLATE.format(
    owner_name=_OWNER_NAME,
    team_members=_TEAM_MEMBERS_DESC,
)


def _is_rate_limited(decision: dict) -> bool:
    """Detect rate-limit signals in a triage_one result so the caller can
    retry. Looks at structured _error + free-text concerns (since Claude
    Code's exit-code stderr includes the upstream message)."""
    err = str(decision.get("_error", "")).lower()
    if "429" in err or "rate" in err:
        return True
    concerns = decision.get("concerns") or []
    blob = " ".join(str(c) for c in concerns).lower()
    return "rate_limit" in blob or "429" in blob or "quota" in blob


def triage_one(task: dict) -> dict:
    """Public triage entry point. Calls `_triage_once`; on a rate-limit
    failure (and if RETRY_ON_RATE_LIMIT is set), sleeps
    RATE_LIMIT_BACKOFF_SECS and retries exactly once. The historical
    failure mode (2026-05-20: 12/22 records defaulted to ASK on a
    sustained Opus 429 burst) — one retry with a 60s pause clears it
    in practice, and Sonnet (the new default) has a much higher ceiling
    than Opus so this rarely fires at all."""
    decision = _triage_once(task)
    if RETRY_ON_RATE_LIMIT and _is_rate_limited(decision):
        log(
            f"rate-limited on first attempt; backing off {RATE_LIMIT_BACKOFF_SECS}s then retrying once"
        )
        time.sleep(RATE_LIMIT_BACKOFF_SECS)
        retry = _triage_once(task)
        retry["_retried_after_rate_limit"] = True
        retry["_initial_attempt_error"] = decision.get("_error") or "rate-limited"
        return retry
    return decision


def _triage_once(task: dict) -> dict:
    """Run triage via `claude -p` subprocess (uses Claude Code's internal
    session — same auth as the user's interactive chat, no per-token rate
    limits). ANTHROPIC_API_KEY is unset for the call so OAuth wins (a stale
    invalid key in shell env would otherwise short-circuit Claude Code).
    """
    user_msg = (
        f"{SYSTEM_PROMPT}\n\n"
        f"---\n\n"
        f"Candidate inferred task to triage:\n\n"
        f"Title: {task.get('title', '(none)')}\n"
        f"Priority hint: {task.get('priority', '(none)')}\n"
        f"Confidence (from Haiku inference): {task.get('confidence', '(none)')}\n"
        f"Context from recording: {task.get('context', '(none)')}\n"
        f"Source recording id: {task.get('recording_id', '(none)')}\n"
        f"Captured at: {task.get('captured_at', '(none)')}\n\n"
        f"Think carefully then output ONLY the JSON object — no prose, no markdown fences."
    )

    claude_bin = os.environ.get("POCKET_CLAUDE_BIN", str(HOME / ".local/bin/claude"))
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    cmd = [
        claude_bin,
        "--dangerously-skip-permissions",
        "--model",
        MODEL,
        "-p",
        user_msg,
    ]
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return {
            "verdict": "ASK",
            "confidence": 0.0,
            "reasoning": "claude -p timed out after 180s; defaulted to ASK.",
            "scoped_task_description": "",
            "concerns": ["timeout"],
            "_error": "timeout",
        }
    except Exception as e:
        return {
            "verdict": "ASK",
            "confidence": 0.0,
            "reasoning": f"claude -p invocation failed: {type(e).__name__}; defaulted to ASK.",
            "scoped_task_description": "",
            "concerns": [str(e)[:160]],
            "_error": "spawn_failed",
        }

    if proc.returncode != 0:
        return {
            "verdict": "ASK",
            "confidence": 0.0,
            "reasoning": f"claude -p exited {proc.returncode}; defaulted to ASK.",
            "scoped_task_description": "",
            "concerns": [proc.stderr.strip()[:160] or proc.stdout.strip()[:160]],
            "_error": f"exit_{proc.returncode}",
        }

    text_out = (proc.stdout or "").strip()
    thinking_text = ""  # claude -p plain mode doesn't expose thinking; that's fine — reasoning is in JSON field
    # Strip markdown fences if any
    if text_out.startswith("```"):
        import re as _re

        text_out = _re.sub(r"^```(?:json)?\s*", "", text_out)
        text_out = _re.sub(r"\s*```$", "", text_out)

    try:
        decision = json.loads(text_out)
    except json.JSONDecodeError:
        log(f"Opus returned bad JSON: {text_out[:200]}")
        decision = {
            "verdict": "ASK",
            "confidence": 0.0,
            "reasoning": "Opus output unparseable; defaulting to ASK.",
            "scoped_task_description": "",
            "concerns": [f"bad json: {text_out[:80]}"],
        }
    decision["_thinking"] = thinking_text.strip()[:4000]
    decision["_model"] = MODEL
    decision["_raw_output_len"] = len(text_out)
    return decision


def append_jsonl(path: Path, obj: dict) -> None:
    if DRY_RUN:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(obj) + "\n")


def _id_already_routed(task_id: str) -> str | None:
    """Idempotency guard: scan all 4 destination files for this id. Returns
    the route name (TASKS|DRAFTS|DROPPED|REVIEW) if found, else None.
    Prevents the same inferred task from being routed twice if the watcher
    re-queues it (cursor rewind, seen-set reset, etc).
    """
    if not task_id:
        return None
    for label, p in (
        ("TASKS", TASKS),
        ("DRAFTS", DRAFTS),
        ("DROPPED", DROPPED),
        ("REVIEW", REVIEW),
    ):
        if not p.exists():
            continue
        try:
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("id") == task_id:
                    return label
        except OSError:
            continue
    return None


def route(task: dict, decision: dict) -> str:
    """Write task to the correct destination based on verdict. Returns route name."""
    verdict = (decision.get("verdict") or "ASK").upper()
    # Idempotency: skip if this id is already routed somewhere
    task_id = task.get("id", "")
    prior = _id_already_routed(task_id)
    if prior:
        log(f"SKIP {task_id} — already in {prior}")
        return f"SKIP_{prior}"
    routed = dict(task)
    routed["triage"] = {
        "verdict": verdict,
        "confidence": decision.get("confidence"),
        "reasoning": decision.get("reasoning"),
        "scoped": decision.get("scoped_task_description"),
        "concerns": decision.get("concerns"),
        "model": decision.get("_model"),
        "decided_at": now_iso(),
    }
    if verdict == "ACT":
        # Promote: use scoped description if provided, keep original context
        if decision.get("scoped_task_description"):
            routed["title"] = decision["scoped_task_description"][:140] or routed.get(
                "title"
            )
        routed["kind"] = "task"  # supervisor treats these like manual tasks
        routed["promoted_from"] = "inferred"
        append_jsonl(TASKS, routed)
    elif verdict == "DRAFT":
        routed["kind"] = "draft_email"  # generic outbound kind; supervisor leaves alone
        append_jsonl(DRAFTS, routed)
    elif verdict == "DROP":
        append_jsonl(DROPPED, routed)
    else:  # ASK
        append_jsonl(REVIEW, routed)
    return verdict


def main() -> int:
    write_health("running", "triage tick")
    log(f"start (dry_run={DRY_RUN}, model={MODEL})")

    try:
        initial = PENDING.read_bytes()
    except OSError as e:
        log(f"read pending failed: {e}")
        write_health("error", f"read pending: {e}")
        return 1

    if not initial.strip():
        log("no pending items — nothing to triage")
        write_health("ok", "no pending items", extra={"counts": {}})
        return 0

    consumed = len(initial)
    tasks = []
    for raw in initial.decode("utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            tasks.append(json.loads(raw))
        except json.JSONDecodeError as e:
            log(f"bad jsonl: {e}")
    log(f"loaded {len(tasks)} pending items")

    counts = {"ACT": 0, "DRAFT": 0, "DROP": 0, "ASK": 0}
    inter_call_pause = float(os.environ.get("POCKET_TRIAGE_PACE_SEC", "8"))
    for i, task in enumerate(tasks, 1):
        if i > 1 and inter_call_pause > 0:
            time.sleep(inter_call_pause)  # avoid bursting Claude Max quota
        title = (task.get("title") or "")[:70]
        log(f"[{i}/{len(tasks)}] triaging: {title}")
        decision = triage_one(task)
        verdict = route(task, decision)
        counts[verdict] = counts.get(verdict, 0) + 1
        log(
            f"[{i}/{len(tasks)}] verdict={verdict} conf={decision.get('confidence')} — {decision.get('reasoning', '')[:120]}"
        )
        # Audit log every decision with full thinking
        append_jsonl(
            AUDIT,
            {
                "ts": now_iso(),
                "task": task,
                "decision": decision,
                "routed_to": verdict,
            },
        )
        if _dec_mod and not DRY_RUN:
            try:
                _dec_mod.write_decision(
                    _dec_mod.make(
                        event_type=task.get("source", "triage"),
                        recording_id=task.get("recording_id", ""),
                        title=task.get("title") or task.get("recording_title", ""),
                        summary_excerpt=task.get("context", "") or "",
                        classification=verdict,
                        confidence=float(decision.get("confidence", 0) or 0),
                        reasoning=str(decision.get("reasoning", ""))[:1500],
                        action_taken=verdict,
                        model=MODEL,
                    )
                )
            except Exception as _e:
                log(f"decision log skip: {_e}")

    # Drop only the snapshot we read; bytes appended during triage are kept.
    if not DRY_RUN:
        try:
            current = PENDING.read_bytes()
        except OSError:
            current = b""
        tail = current[consumed:] if len(current) >= consumed else current
        try:
            PENDING.write_bytes(tail)
        except OSError as e:
            log(f"FATAL: could not rewrite pending file: {e}")
            write_health("error", f"rewrite pending: {e}")
            return 1
    log(f"done counts={counts}")
    write_health("ok", f"triaged={sum(counts.values())}", extra={"counts": counts})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted")
        sys.exit(130)
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
