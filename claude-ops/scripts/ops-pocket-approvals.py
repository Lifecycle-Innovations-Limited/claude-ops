#!/usr/bin/env python3
"""ops-pocket-approvals — surface ASK/DRAFT items to the owner by email and act
on their APPROVE/REJECT replies.

Modes:
  --digest   email the owner the current open ASK (review.jsonl) + DRAFT
             (drafts.jsonl) items, each with a short code (A1/D1...), via the
             email-bridge SES backend. Idempotent: only emails when the open
             set changed.
  --replies  poll the owner's Gmail (gog) for "APPROVE <code|id>" /
             "REJECT <code|id>" / "<code> <letter>" and act:
             APPROVE -> append the task to tasks.jsonl (executor runs it; the
             worker keeps its own Rule-6 staging for any 3rd-party send);
             REJECT -> record dropped;
             <code> <letter> -> choice-item selection, promotes with
             chosen_option/chosen_option_label fields.
             Idempotent via approval-resolved.jsonl.

ASK schema (additive fields, all optional — no regression on old records):
  action_preview      : str   — one sentence: what APPROVE concretely does.
  decision_question   : str   — the actual question for choice items.
  options             : list  — [{"key": "a", "label": "<text>"}, ...]
                                When present, item is a CHOICE not a yes/no.

Recipient is locked to email-config.self_address. Self-notification to the
owner only.

Requires the SES email backend in ops-pocket-email-bridge.py (send_email's
`backend`/`ses_cfg` kwargs) — see the related "SES email backend" PR.
"""

from __future__ import annotations
import hashlib, json, os, re, sys, time, subprocess
from pathlib import Path

STATE = Path(
    os.environ.get("POCKET_STATE_DIR", str(Path.home() / ".claude/state/pocket"))
)
REVIEW = STATE / "review.jsonl"
DRAFTS = STATE / "drafts.jsonl"
TASKS = STATE / "tasks.jsonl"
RESOLVED = STATE / "approval-resolved.jsonl"  # ids approved/rejected
CODEMAP = STATE / "approval-codemap.json"  # code -> {id,kind,title,...}
NOTIFIED = STATE / "approval-notified.json"  # hash of last-digested open set
LOG = STATE / "approvals.log"
CFG = STATE / "email-config.json"
# Sibling scripts dir: env override, else this file's own directory.
SCRIPTS = Path(
    os.environ.get("POCKET_SCRIPTS_DIR", str(Path(__file__).resolve().parent))
)
GOG = os.environ.get("POCKET_GOG_BIN", "gog")

# Context preview length in digest (word-boundary truncated).
CTX_PREVIEW_CHARS = int(os.environ.get("POCKET_DIGEST_CTX_CHARS", "600"))


def log(m):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} [approvals] {m}"
    print(line, file=sys.stderr)
    try:
        open(LOG, "a").write(line + "\n")
    except OSError:
        pass


def _load_jsonl(p):
    out = []
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def _truncate_words(text: str, max_chars: int) -> str:
    """Truncate text at a word boundary, appending '...' when cut."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "..."


def _norm(item):
    """Return (id, kind, title, ctx, raw) from a review/draft row (raw or wrapped)."""
    t = item.get("task", item)
    return (
        t.get("id") or item.get("id"),
        t.get("kind") or item.get("kind", "action_item"),
        (t.get("title") or item.get("title") or "")[:120],
        (t.get("context") or item.get("context") or "")[:600],
        t,
    )


def _extract_option_fields(raw: dict) -> tuple[str, str, list]:
    """Pull action_preview, decision_question, options from an ASK raw record.

    Looks in both the top-level dict and a nested 'triage' sub-dict so records
    written by ops-pocket-triage.py (which puts everything in 'triage') and
    records written directly are both handled.
    """
    triage = raw.get("triage") or {}
    action_preview = raw.get("action_preview") or triage.get("action_preview") or ""
    decision_question = (
        raw.get("decision_question") or triage.get("decision_question") or ""
    )
    options = raw.get("options") or triage.get("options") or []
    return action_preview, decision_question, options


def _resolved_ids():
    return {r.get("id") for r in _load_jsonl(RESOLVED)}


def open_items():
    res = _resolved_ids()
    items = []
    for src, tag in ((REVIEW, "ASK"), (DRAFTS, "DRAFT")):
        for it in _load_jsonl(src):
            iid, kind, title, ctx, raw = _norm(it)
            if not iid or iid in res:
                continue
            if any(x["id"] == iid for x in items):
                continue
            action_preview, decision_question, options = _extract_option_fields(raw)
            items.append(
                {
                    "id": iid,
                    "bucket": tag,
                    "kind": kind,
                    "title": title,
                    "ctx": ctx,
                    "raw": raw,
                    "action_preview": action_preview,
                    "decision_question": decision_question,
                    "options": options,
                }
            )
    return items


def send_via_bridge(subject, body):
    """Reuse email-bridge send_email (SES backend) to mail the owner."""
    sys.path.insert(0, str(SCRIPTS))
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "ebridge", SCRIPTS / "ops-pocket-email-bridge.py"
    )
    eb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eb)
    cfg = json.loads(CFG.read_text())
    to = cfg.get("self_address")
    ok, info = eb.send_email(
        to, subject, body, backend=cfg.get("backend", "gog"), ses_cfg=cfg
    )
    return ok, info, to


def _render_item(code: str, it: dict) -> list[str]:
    """Return digest lines for one item. Choice items get option list + letter instruction."""
    lines = []
    is_choice = bool(it.get("options"))

    lines.append(f"[{code}] ({it['bucket']}) {it['title']}")

    # Context preview — word-boundary truncated
    ctx = it.get("ctx") or ""
    if ctx:
        lines.append(f"      {_truncate_words(ctx, CTX_PREVIEW_CHARS)}")

    # Action preview (what APPROVE actually does)
    ap = it.get("action_preview") or ""
    if ap:
        lines.append(f"      -> Approve = {ap}")

    if is_choice:
        dq = it.get("decision_question") or ""
        if dq:
            lines.append(f"      Q: {dq}")
        for opt in it["options"]:
            lines.append(f"        {opt['key']}) {opt['label']}")
        lines.append(
            f"      Reply: {code} <letter>  (e.g. {code} {it['options'][0]['key']})"
        )
    else:
        lines.append(f"      Reply: APPROVE {code}  or  REJECT {code}")

    lines.append("")
    return lines


def cmd_digest():
    items = open_items()
    if not items:
        log("digest: no open items")
        return 0

    codemap = {}
    a = d = 0

    # Header: explain both reply styles
    header_lines = [
        "Pending Pocket items need your decision.",
        "Reply to this email with one line per item:",
        "  Yes/No items:  APPROVE <code>   or   REJECT <code>",
        "  Choice items:  <code> <letter>  (e.g. A1 b)",
        "",
    ]

    item_lines: list[str] = []
    for it in items:
        if it["bucket"] == "ASK":
            a += 1
            code = f"A{a}"
        else:
            d += 1
            code = f"D{d}"
        codemap[code] = {
            "id": it["id"],
            "kind": it["kind"],
            "title": it["title"],
            "bucket": it["bucket"],
            "raw": it["raw"],
            "options": it["options"],
        }
        item_lines.extend(_render_item(code, it))

    body = "\n".join(header_lines + item_lines)

    # Idempotency: skip if same open set already notified
    h = hashlib.sha256(
        json.dumps([(it["id"], it["bucket"]) for it in items]).encode()
    ).hexdigest()
    prev = json.loads(NOTIFIED.read_text()).get("hash") if NOTIFIED.exists() else None
    if h == prev:
        log(f"digest: open set unchanged ({len(items)} items) — not re-emailing")
        if not CODEMAP.exists():
            CODEMAP.write_text(json.dumps(codemap, indent=2))
            log("digest: wrote missing approval-codemap.json for unchanged open set")
        return 0

    ok, info, to = send_via_bridge(f"[Pocket] {len(items)} item(s) need approval", body)
    CODEMAP.write_text(json.dumps(codemap, indent=2))
    if ok:
        NOTIFIED.write_text(
            json.dumps({"hash": h, "ts": time.time(), "count": len(items)})
        )
    log(f"digest: emailed {len(items)} items to {to} ok={ok} info={info}")
    return 0 if ok else 1


def _gog_search_replies():
    """Find recent emails from the owner replying to approval digests."""
    try:
        r = subprocess.run(
            [
                GOG,
                "gmail",
                "search",
                "from:me subject:[Pocket] newer_than:2d",
                "--max",
                "15",
                "-j",
                "--results-only",
                "--no-input",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            env=os.environ,
        )
        if r.returncode != 0:
            log(f"gog search rc={r.returncode}: {r.stderr[:150]}")
            return []
        return json.loads(r.stdout or "[]")
    except Exception as e:
        log(f"gog search err {e}")
        return []


def _gog_body_and_subject(msg_id):
    try:
        r = subprocess.run(
            [GOG, "gmail", "get", msg_id, "-j", "--no-input"],
            capture_output=True,
            text=True,
            timeout=60,
            env=os.environ,
        )
        d = json.loads(r.stdout or "{}")
        return (d.get("body") or d.get("snippet") or ""), (d.get("subject") or "")
    except Exception:
        return "", ""


def _is_digest_outbound_subject(subject):
    """Sent digest uses '[Pocket] N item(s) need approval' without a Re: prefix; skip those."""
    s = (subject or "").strip()
    if re.match(r"(?i)^re:\s*", s):
        return False
    return (
        re.match(r"^\[Pocket\]\s+\d+\s+item\(s\)\s+need\s+approval\s*$", s) is not None
    )


# ---------------------------------------------------------------------------
# Reply patterns
#   Classic:   APPROVE A1   /   REJECT A1   /   APPROVE <uuid>
#   Choice:    A1 b         /   A1: b        /   APPROVE A1 b
# ---------------------------------------------------------------------------
_RE_CLASSIC = re.compile(r"\b(APPROVE|REJECT)\s+([A-Za-z]\d+|[a-z0-9\-]{6,})\b", re.I)
# Choice: optional "APPROVE " prefix, then code, then colon-or-space, then letter.
# Captured groups: (opt_approve, code, letter)
_RE_CHOICE = re.compile(r"(?:APPROVE\s+)?([A-Za-z]\d+)[:\s]+([a-z])\b", re.I)
_RE_DIGEST_CHOICE_EXAMPLE = re.compile(r"\(e\.g\.[\s:]*$", re.I)


def _choice_match_is_digest_example(body: str, mt: re.Match) -> bool:
    """True when the match is inside a digest '(e.g. CODE letter)' example in quoted text."""
    prefix = body[max(0, mt.start() - 24) : mt.start()]
    return _RE_DIGEST_CHOICE_EXAMPLE.search(prefix) is not None


def _resolve_code(codemap: dict, ref: str):
    """Look up a codemap entry by short code (A1) or raw id."""
    ent = codemap.get(ref) or codemap.get(ref.upper())
    if ent:
        return ent
    # Fall back to raw id match
    return next((c for c in codemap.values() if c.get("id") == ref), None)


def cmd_replies():
    if not CODEMAP.exists():
        log("replies: no codemap yet")
        return 0
    codemap = json.loads(CODEMAP.read_text())
    res = _resolved_ids()
    acted = 0
    self_addr = json.loads(CFG.read_text()).get("self_address", "")

    for m in _gog_search_replies():
        frm = (m.get("from") or "").lower()
        if not self_addr or self_addr.lower() not in frm:
            continue
        body, subj = _gog_body_and_subject(m.get("id", ""))
        if _is_digest_outbound_subject(subj):
            continue

        # Track which ids we've already acted on in this message so we don't
        # process the same id twice (choice regex may also match classic).
        handled_in_msg: set[str] = set()

        # --- Choice replies first (higher specificity) ---
        for mt in _RE_CHOICE.finditer(body):
            if _choice_match_is_digest_example(body, mt):
                continue
            ref = mt.group(1)
            letter = mt.group(2).lower()
            ent = _resolve_code(codemap, ref)
            if not ent:
                continue
            tid = ent["id"]
            if tid in res or tid in handled_in_msg:
                continue
            options = ent.get("options") or []
            if not options:
                # Not a choice item — let classic handler decide
                continue
            valid_keys = {o["key"].lower() for o in options}
            if letter not in valid_keys:
                log(
                    f"choice reply {ref} {letter}: invalid key (valid: {valid_keys}) — skipping"
                )
                continue
            chosen_opt = next(o for o in options if o["key"].lower() == letter)
            task = (
                ent["raw"].get("task", ent["raw"])
                if isinstance(ent["raw"], dict)
                else {}
            )
            task = dict(task)
            task["id"] = tid
            task.setdefault("kind", "action_item")
            task["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            task["chosen_option"] = letter
            task["chosen_option_label"] = chosen_opt["label"]
            open(TASKS, "a").write(json.dumps(task) + "\n")
            open(RESOLVED, "a").write(
                json.dumps(
                    {
                        "id": tid,
                        "decision": "CHOOSE",
                        "chosen": letter,
                        "ts": time.time(),
                    }
                )
                + "\n"
            )
            log(
                f"CHOOSE {ref} {letter} -> promoted {tid} (option: {chosen_opt['label']}) to tasks.jsonl"
            )
            acted += 1
            res.add(tid)
            handled_in_msg.add(tid)

        # --- Classic APPROVE/REJECT ---
        for mt in _RE_CLASSIC.finditer(body):
            verb = mt.group(1).upper()
            ref = mt.group(2)
            ent = _resolve_code(codemap, ref)
            if not ent:
                continue
            tid = ent["id"]
            if tid in res or tid in handled_in_msg:
                continue

            # A bare APPROVE on a choice item is ambiguous — leave unresolved.
            if verb == "APPROVE" and (ent.get("options") or []):
                log(
                    f"APPROVE {ref}: choice item needs a letter (e.g. {ref} a) — leaving unresolved"
                )
                continue

            if verb == "APPROVE":
                task = (
                    ent["raw"].get("task", ent["raw"])
                    if isinstance(ent["raw"], dict)
                    else {}
                )
                task = dict(task)
                task["id"] = tid
                if ent.get("bucket") == "DRAFT":
                    task["kind"] = "action_item"
                else:
                    task.setdefault("kind", "action_item")
                task["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                open(TASKS, "a").write(json.dumps(task) + "\n")
                open(RESOLVED, "a").write(
                    json.dumps({"id": tid, "decision": "APPROVE", "ts": time.time()})
                    + "\n"
                )
                log(f"APPROVE {ref} -> promoted {tid} to tasks.jsonl")
                acted += 1
            else:
                open(RESOLVED, "a").write(
                    json.dumps({"id": tid, "decision": "REJECT", "ts": time.time()})
                    + "\n"
                )
                log(f"REJECT {ref} -> dropped {tid}")
                acted += 1
            res.add(tid)
            handled_in_msg.add(tid)

    log(f"replies: acted={acted}")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--digest"
    sys.exit(
        cmd_digest()
        if mode == "--digest"
        else cmd_replies()
        if mode == "--replies"
        else 2
    )
