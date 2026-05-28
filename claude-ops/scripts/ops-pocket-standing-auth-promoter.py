#!/usr/bin/env python3
"""ops-pocket-standing-auth-promoter — auto-resolve ASKs Sam has pre-authorized.

Sam's 2026-05-25 directive: "you may always auto nudge agents without my
permission thats your mission" + "babysit pocket workers + nudge stalls. so
sam has to do nothing but leave pocket notes".

When pocket-triage classifies a task as ASK (high-stakes / ambiguous), this
script post-processes review.jsonl: if the task matches one of the standing
authorization rules in standing-auth-rules.json, it's auto-promoted to
tasks.jsonl (so pocket-executor spawns a worker) and removed from review.jsonl.

The original ASK row is preserved in approval-resolved.jsonl with verdict=
"auto-approve" + reason citing the matched rule for audit.

Idempotent: tracks promoted task ids in seen.json (shared with watcher).

Env:
  POCKET_STATE_DIR     default ~/.claude/state/pocket
  POCKET_DRY_RUN=1     log decisions, don't mutate files
"""

from __future__ import annotations
import importlib.util
import json, os, re, sys
from pathlib import Path
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).resolve().parent
HOME = Path(os.path.expanduser("~"))
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
REVIEW = STATE_DIR / "review.jsonl"
TASKS = STATE_DIR / "tasks.jsonl"
RESOLVED = STATE_DIR / "approval-resolved.jsonl"
SEEN = STATE_DIR / "seen.json"
RULES = STATE_DIR / "standing-auth-rules.json"
PARK_RULES = STATE_DIR / "park-rules.json"
PARKED = STATE_DIR / "parked.jsonl"
LOG_PREFIX = "[standing-auth-promoter]"
DRY_RUN = os.environ.get("POCKET_DRY_RUN") == "1"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_rules() -> list[dict]:
    """Standing-auth rules JSON. Format:
    [{"id":"nudge-agents","match_any":["nudge","monitor.*fleet","fleet.*agents"],"reason":"..."}]
    Match against title + context (case-insensitive)."""
    if not RULES.exists():
        # Seed with Sam's initial standing auth — nudging the agent fleet.
        default = [
            {
                "id": "agent-nudge-and-fleet-supervision",
                "match_any": [
                    r"\bnudge\b",
                    r"\bmonitor.*(fleet|agents?)\b",
                    r"\b(fleet|agents?).*(monitor|supervis)",
                    r"\bagent.*list\b",
                    r"send.*messages.*(agents?|workers?|subagents?)",
                ],
                "reason": "Sam standing-authorized agent nudging/fleet supervision 2026-05-25",
            },
        ]
        if not DRY_RUN:
            RULES.parent.mkdir(parents=True, exist_ok=True)
            RULES.write_text(json.dumps(default, indent=2))
        return default
    try:
        return json.loads(RULES.read_text())
    except Exception as e:
        log(f"rules load err: {e}")
        return []


def load_park_rules() -> list[dict]:
    """Deny-list: tasks matching these patterns are PARKED (kept out of the
    executor) because another owner (e.g. the orchestrator working a dedicated
    worktree) already owns them. Park beats promote — checked first."""
    if not PARK_RULES.exists():
        default = [
            {
                "id": "healify-prod-fires-owned-by-orchestrator",
                "match_any": [
                    r"dedup.*(loop|duplicate|retry)",
                    r"anna.*(503|empty.?answer)",
                    r"/api/goals",
                    r"P3012",
                    r"prisma.*migrat",
                    r"cloudwatch:putmetricdata",
                    r"headbucket",
                    r"meditation.*s3|s3.*meditation",
                ],
                "reason": "Healify prod/staging fires owned by orchestrator in dedicated worktree (2026-05-25). Do not auto-spawn duplicate workers.",
            },
        ]
        if not DRY_RUN:
            PARK_RULES.parent.mkdir(parents=True, exist_ok=True)
            PARK_RULES.write_text(json.dumps(default, indent=2))
        return default
    try:
        return json.loads(PARK_RULES.read_text())
    except Exception as e:
        log(f"park rules load err: {e}")
        return []


def _load_watcher():
    """Reuse watcher's seen.json helpers and pocket_state_lock (shared state dir)."""
    path = SCRIPT_DIR / "ops-cron-pocket-watcher.py"
    spec = importlib.util.spec_from_file_location("ops_cron_pocket_watcher", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load watcher module at {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def partition_review(
    rules: list[dict], park_rules: list[dict], review_text: str
) -> tuple[list[tuple[dict, dict]], list[tuple[dict, dict]], list[str]]:
    promoted: list[tuple[dict, dict]] = []
    parked: list[tuple[dict, dict]] = []
    kept: list[str] = []
    for line in review_text.splitlines():
        if not line.strip():
            continue
        try:
            t = json.loads(line)
        except json.JSONDecodeError:
            kept.append(line)
            continue
        park_match = match_rule(park_rules, t)
        if park_match:
            parked.append((t, park_match))
            continue
        match = match_rule(rules, t)
        if match:
            promoted.append((t, match))
        else:
            kept.append(line)
    return promoted, parked, kept


def match_rule(rules: list[dict], task: dict) -> dict | None:
    hay = (
        task.get("title", "")
        + "\n"
        + task.get("context", "")
        + "\n"
        + task.get("summary", "")
        + "\n"
        + task.get("transcript", "")
    ).lower()
    for r in rules:
        for pat in r.get("match_any", []):
            try:
                if re.search(pat.lower(), hay):
                    return r
            except re.error:
                continue
    return None


def main() -> int:
    if not REVIEW.exists():
        log("no review.jsonl — nothing to promote")
        return 0
    rules = load_rules()
    park_rules = load_park_rules()
    if not rules:
        log("no standing-auth rules configured")
        return 0

    if DRY_RUN:
        promoted, parked, kept = partition_review(
            rules, park_rules, REVIEW.read_text()
        )
        review_was = len(kept) + len(promoted) + len(parked)
        if parked:
            log(f"parked {len(parked)} item(s) — owned elsewhere, not promoting")
        if promoted:
            log(f"promoting {len(promoted)} ASK→ACT under standing-auth rules")
            for t, m in promoted:
                log(
                    f"  (dry-run) PROMOTE id={t.get('id')} rule={m['id']} title={t.get('title', '')[:60]}"
                )
        elif not parked:
            log("0 promoted (no matches)")
        return 0

    w = _load_watcher()
    with w.pocket_state_lock():
        promoted, parked, kept = partition_review(
            rules, park_rules, REVIEW.read_text()
        )
        review_was = len(kept) + len(promoted) + len(parked)
        seen = w.load_seen()
        fresh_promoted: list[tuple[dict, dict]] = []
        already_promoted: list[tuple[dict, dict]] = []
        for t, m in promoted:
            tid = t.get("id")
            if isinstance(tid, str) and tid and tid in seen:
                already_promoted.append((t, m))
            else:
                fresh_promoted.append((t, m))
        if already_promoted:
            log(
                f"skip {len(already_promoted)} already-promoted id(s) in seen.json "
                "(crash recovery)"
            )

        # Log parked items (kept OUT of both review re-queue and executor).
        if parked:
            log(f"parked {len(parked)} item(s) — owned elsewhere, not promoting")
            with PARKED.open("a") as pf:
                for t, m in parked:
                    pf.write(
                        json.dumps(
                            {
                                "id": t.get("id"),
                                "title": t.get("title", ""),
                                "parked_at": now_iso(),
                                "rule_id": m["id"],
                                "reason": m.get("reason", ""),
                            }
                        )
                        + "\n"
                    )
            with RESOLVED.open("a") as rf:
                for t, m in parked:
                    rf.write(
                        json.dumps(
                            {
                                "id": t.get("id"),
                                "resolved_at": now_iso(),
                                "verdict": "parked",
                                "resolver": "standing-auth-promoter",
                                "rule_id": m["id"],
                                "reason": m.get("reason", ""),
                            }
                        )
                        + "\n"
                    )

        if not promoted:
            if parked:
                with REVIEW.open("w") as f:
                    for l in kept:
                        f.write(l + "\n")
                log(f"0 promoted; {len(parked)} parked + removed from review")
            else:
                log("0 promoted (no matches)")
            return 0

        if fresh_promoted:
            log(f"promoting {len(fresh_promoted)} ASK→ACT under standing-auth rules")
            TASKS.parent.mkdir(parents=True, exist_ok=True)
            with TASKS.open("a") as f:
                for t, m in fresh_promoted:
                    t["verdict"] = "ACT"
                    t["promoted_by"] = "standing-auth-promoter"
                    t["promoted_rule"] = m["id"]
                    t["promoted_at"] = now_iso()
                    f.write(json.dumps(t) + "\n")
                    log(f"  → tasks.jsonl id={t.get('id')} rule={m['id']}")
                    tid = t.get("id")
                    if isinstance(tid, str) and tid:
                        w._seen_add(seen, tid)
                        w.save_seen(seen)

            with RESOLVED.open("a") as f:
                for t, m in fresh_promoted:
                    f.write(
                        json.dumps(
                            {
                                "id": t.get("id"),
                                "resolved_at": now_iso(),
                                "verdict": "auto-approve",
                                "resolver": "standing-auth-promoter",
                                "rule_id": m["id"],
                                "reason": m.get("reason", ""),
                            }
                        )
                        + "\n"
                    )

        with REVIEW.open("w") as f:
            for l in kept:
                f.write(l + "\n")
        log(f"review.jsonl now has {len(kept)} rows (was {review_was})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
