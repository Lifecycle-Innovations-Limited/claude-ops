#!/usr/bin/env python3
"""pocket-responder — the SOLE consumer of bot approval input and the SOLE writer
of approval decisions. One canonical surface for BOTH Pocket items AND social
drafts. Replaces email-cos-tg-approve.py (taps) + ops-pocket-approvals.py
--replies (email/text) with one normalizer.

Self-contained by design: it does NOT import ops-pocket-approvals.py (which has
drifted across branches/box copies — some lack the reply-matching helpers). The
ASK ingestion (review.jsonl/drafts.jsonl), option extraction, reply regexes and
code resolution are all inlined here so the responder behaves identically no
matter which approvals.py happens to be deployed.

Modes:
  send     post each open ASK to Telegram as a tappable message (✅ Approve /
           ❌ Reject, or a)/b)/c) for choice items). Idempotent + capped. Also
           (re)writes the A/D codemap so freeform replies like "approve A3" and
           "A3 b" resolve to the same items. Social-publish ASKs (kind=
           social_publish) post as plain Approve/Reject.
  process  drain the single normalized inbox the listener tees to
           responder-inbox.jsonl and act on every event:
             tap   (callback_query)  -> exact verb resolve (pa/pr/po)
             text  (freeform reply)  -> fast-path regex, else Haiku LLM mapper
           Each resolved decision writes the SAME sinks the executor already
           consumes (tasks.jsonl + approval-resolved.jsonl) — or, for
           kind=social_publish, publishes the Typefully draft. Then it confirms
           in Telegram (toast for taps, a reply for text) and freezes the button
           message via editMessageText.

Routing back to the requesting agent is the shared queue: a resolved Pocket
decision -> tasks.jsonl -> pocket-executor runs it. No per-agent socket; no
executor changes.

Config (env or ~/.config/email-cos/config.sh + ~/.mcp-secrets.env):
  EMAIL_COS_APPROVAL_BOT_TOKEN  Bot token (falls back to TELEGRAM_BOT_TOKEN).
  EMAIL_COS_TG_CHAT_ID          Owner chat/user id. Required (exits cleanly if unset).
  POCKET_STATE_DIR              Pipeline state dir (default /var/lib/pocket-pipeline).
  COS_TG_SEND_CAP               Max button messages per send run (default 8).
  POCKET_CLAUDE_BIN             claude binary for the LLM mapper (default: resolved).
  POCKET_RESPONDER_MODEL        LLM model for freeform mapping (default claude-haiku-4-5).
  POCKET_RESPONDER_LLM          "0" disables the LLM fallback (fast-path only).
  POCKET_RESPONDER_LLM_THRESHOLD  Min confidence to act on an LLM mapping (default 0.6).
  POCKET_TYPEFULLY_JS           typefully.js path (social publish). Default: skill path.
  TYPEFULLY_API_KEY             required for social_publish approve.
"""

from __future__ import annotations
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, time
import urllib.parse, urllib.request

STATE = pathlib.Path(os.environ.get("POCKET_STATE_DIR", "/var/lib/pocket-pipeline"))
REVIEW = STATE / "review.jsonl"
DRAFTS = STATE / "drafts.jsonl"
INBOX = STATE / "responder-inbox.jsonl"          # supersedes tg-callbacks.jsonl
INBOX_SEEN = STATE / "responder-inbox.seen"      # cb ids + t:<message_id> for text
CALLMAP = STATE / "tg-callmap.json"              # sid -> entry (button messages)
CODEMAP = STATE / "approval-codemap.json"        # A1/D1 -> entry (freeform refs)
TASKS = STATE / "tasks.jsonl"
RESOLVED = STATE / "approval-resolved.jsonl"
HOLDS = STATE / "approval-holds.jsonl"           # actions held by the validation guard
LOG = STATE / "responder.log"

# Pre-promotion validation guard: outbound message kinds get a staleness/rule check
# before they are committed to tasks.jsonl. social_publish is excluded (an explicit
# publish, not a message). Disable with POCKET_VALIDATE_ACTIONS=0.
VALIDATE_KINDS = {"send_message", "email_reply"}

TOKEN = os.environ.get("EMAIL_COS_APPROVAL_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT = os.environ.get("EMAIL_COS_TG_CHAT_ID", "")
if not CHAT:
    print("EMAIL_COS_TG_CHAT_ID is not set — exiting.", file=sys.stderr)
    sys.exit(0)


def log(m):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} [responder] {m}"
    print(line, file=sys.stderr)
    try:
        open(LOG, "a").write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Inlined ASK ingestion + helpers (decoupled from ops-pocket-approvals.py)
# ---------------------------------------------------------------------------
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
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "..."


def _extract_option_fields(raw: dict):
    """(action_preview, decision_question, options) from an ASK raw record.
    Looks in both the top-level dict and a nested 'triage' sub-dict."""
    if not isinstance(raw, dict):
        return "", "", []
    triage = raw.get("triage") or {}
    return (
        raw.get("action_preview") or triage.get("action_preview") or "",
        raw.get("decision_question") or triage.get("decision_question") or "",
        raw.get("options") or triage.get("options") or [],
    )


def _norm(item):
    t = item.get("task", item)
    return (
        t.get("id") or item.get("id"),
        t.get("kind") or item.get("kind", "action_item"),
        (t.get("title") or item.get("title") or "")[:140],
        # Keep generous context here; cmd_send() does the final Telegram-fit
        # truncation. The old 600-char cap silently amputated long ASKs
        # (email drafts, voice-memo action items) before they were ever rendered.
        (t.get("context") or item.get("context") or "")[:6000],
        t,
    )


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
            ap, dq, opts = _extract_option_fields(raw)
            items.append({
                "id": iid, "bucket": tag, "kind": kind, "title": title, "ctx": ctx,
                "raw": raw, "action_preview": ap, "decision_question": dq, "options": opts,
            })
    return items


# Reply patterns (inlined from the richer approvals.py variant).
#   Classic: APPROVE A1 / REJECT A1 / APPROVE <uuid>
#   Choice:  A1 b / A1: b / APPROVE A1 b
_RE_CLASSIC = re.compile(r"\b(APPROVE|REJECT)\s+([A-Za-z]\d+|[a-z0-9\-]{6,})\b", re.I)
_RE_CHOICE = re.compile(r"(?:APPROVE\s+)?([A-Za-z]\d+)[:\s]+([a-z])\b", re.I)
_RE_DIGEST_CHOICE_EXAMPLE = re.compile(r"\(e\.g\.[\s:]*$", re.I)
# Force-override: re-promote a guard-held action, bypassing validation.
_RE_FORCE = re.compile(r"\bforce\s+([A-Za-z]\d+|[a-z0-9\-]{6,})\b", re.I)


def _choice_match_is_digest_example(body: str, mt: re.Match) -> bool:
    prefix = body[max(0, mt.start() - 24): mt.start()]
    return _RE_DIGEST_CHOICE_EXAMPLE.search(prefix) is not None


def _resolve_code(codemap: dict, ref: str):
    ent = codemap.get(ref) or codemap.get(ref.upper())
    if ent:
        return ent
    return next((c for c in codemap.values() if c.get("id") == ref), None)


def _sid(item_id):
    return "i" + hashlib.sha1(item_id.encode()).hexdigest()[:10]


def _recommended_key(it, opts):
    """Recommended option key for an ASK, if any: a per-option `recommended:true`
    first, then a top-level recommended_option/recommended_key (also checked in raw
    + raw.triage). '' if none. Backward-compatible — producers that don't set it
    just get no star."""
    for o in opts or []:
        if isinstance(o, dict) and o.get("recommended"):
            return str(o.get("key") or "")
    raw = it.get("raw") if isinstance(it.get("raw"), dict) else {}
    tri = raw.get("triage") if isinstance(raw.get("triage"), dict) else {}
    for src in (it, raw, tri):
        if isinstance(src, dict) and (src.get("recommended_option") or src.get("recommended_key")):
            return str(src.get("recommended_option") or src.get("recommended_key"))
    return ""


# Words signalling "change this before it goes out" rather than a plain yes. Used
# to block the footgun where a freeform reply like "send but say Friday" on an
# outbound email ASK gets mis-mapped to a bare APPROVE and the UNEDITED draft is
# sent to a third party. Edit-then-send re-drafting is not wired yet.
_RE_EDIT_INTENT = re.compile(
    r"\b(change|instead of|edit|reword|rewrite|replace|revise|adjust|tweak|shorter|"
    r"longer|add that|mention|leave out|take out|remove the|"
    r"make it (?:shorter|longer|clearer|more|less|sound|polite|formal|casual|better)|"
    r"don'?t say|say(?:\s+that)?|send but|reslant|soften|reschedule to)\b", re.I)


def _edit_intent(body):
    return bool(_RE_EDIT_INTENT.search(body or ""))


# ---------------------------------------------------------------------------
# Telegram API
# ---------------------------------------------------------------------------
def _api(method, payload):
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in payload.items()}
    ).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=15) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _send(text):
    return _api("sendMessage", {"chat_id": CHAT, "text": text[:3800], "parse_mode": "Markdown"})


# ---------------------------------------------------------------------------
# send — buttons + codemap
# ---------------------------------------------------------------------------
def cmd_send():
    items = open_items()
    if not items:
        log("send: no open items")
        print("no open items")
        return
    resolved = _resolved_ids()
    cap = int(os.environ.get("COS_TG_SEND_CAP", "8"))
    callmap = json.loads(CALLMAP.read_text()) if CALLMAP.exists() else {}
    already = {v.get("id") for v in callmap.values()}

    # (Re)build the A/D codemap over the FULL open set (stable order) so freeform
    # "approve A3" / "A3 b" resolve even for items whose button was sent earlier.
    codemap, a, d = {}, 0, 0
    for it in items:
        if it["id"] in resolved:
            continue
        if it.get("bucket") == "DRAFT":
            d += 1
            code = f"D{d}"
        else:
            a += 1
            code = f"A{a}"
        codemap[code] = {
            "id": it["id"], "kind": it.get("kind"), "title": it.get("title", ""),
            "bucket": it.get("bucket"), "raw": it.get("raw"), "options": it.get("options") or [],
            "social_set": it["raw"].get("social_set") if isinstance(it.get("raw"), dict) else None,
            "typefully_draft_id": it["raw"].get("typefully_draft_id") if isinstance(it.get("raw"), dict) else None,
        }
    CODEMAP.write_text(json.dumps(codemap, indent=2))

    sent = 0
    for it in items:
        if sent >= cap:
            break
        iid = it["id"]
        if iid in resolved or iid in already:
            continue
        sid = _sid(iid)
        opts = it.get("options") or []
        ap = it.get("action_preview") or ""
        dq = it.get("decision_question") or ""
        kind = it.get("kind") or ""
        title = (it.get("title") or "")[:140]
        # Give the body the bulk of Telegram's 4096-char budget; the old 500-char
        # cut amputated long ASKs (full email drafts, voice-memo action items).
        ctx = _truncate_words(it.get("ctx") or "", 3200)
        rk = _recommended_key(it, opts)
        text = f"*{title}*\n{ctx}"
        if dq:
            text += f"\n\n❓ *{dq}*"
        if ap:
            text += f"\n\n→ *Approve =* {ap}"
        if opts:
            rows = []
            for o in opts:
                star = "⭐ " if rk and str(o.get("key", "")).lower() == rk.lower() else ""
                rows.append([{"text": f"{star}{o['key']}) {o['label'][:38]}", "callback_data": f"po:{sid}:{o['key']}"}])
            rows.append([{"text": "❌ None / reject", "callback_data": f"pr:{sid}"}])
            if rk:
                text += f"\n\n⭐ _= recommended ({rk})_"
        else:
            rows = [[
                {"text": "✅ Approve", "callback_data": f"pa:{sid}"},
                {"text": "❌ Reject", "callback_data": f"pr:{sid}"},
            ]]
        # Advertise freeform reply — but NOT on outbound message kinds, where a
        # freeform "send but change X" would mis-map to a bare APPROVE and silently
        # send the unedited draft to a third party (also guarded in _handle_text).
        if not _is_outbound(it):
            text += "\n\n💬 _Or just reply in your own words — e.g. “do b”, “skip this one”, or your own instruction._"
        r = _api("sendMessage", {
            "chat_id": CHAT, "text": text[:3800], "parse_mode": "Markdown",
            "reply_markup": {"inline_keyboard": rows},
        })
        mid = (r.get("result") or {}).get("message_id")
        raw = it.get("raw") if isinstance(it.get("raw"), dict) else {}
        callmap[sid] = {
            "id": iid, "kind": it.get("kind"), "bucket": it.get("bucket"),
            "raw": it.get("raw"), "options": opts, "message_id": mid, "title": title,
            "social_set": raw.get("social_set"), "typefully_draft_id": raw.get("typefully_draft_id"),
        }
        if r.get("ok"):
            sent += 1
        else:
            log(f"send: sendMessage failed for {iid}: {r.get('error') or r}")
    CALLMAP.write_text(json.dumps(callmap, indent=0))
    log(f"send: sent {sent} button message(s); callmap={len(callmap)} codemap={len(codemap)}")
    print(f"sent {sent} button message(s); callmap={len(callmap)}")


# ---------------------------------------------------------------------------
# decision application (shared by taps + text)
# ---------------------------------------------------------------------------
def _resolve_claude_bin():
    b = os.environ.get("POCKET_CLAUDE_BIN")
    if b and os.path.exists(b):
        return b
    for c in (
        os.path.expanduser("~/.local/bin/claude"),
        os.path.expanduser("~/.claude/local/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ):
        if os.path.exists(c):
            return c
    return shutil.which("claude")


# ---------------------------------------------------------------------------
# Pre-promotion validation guard (staleness + standing-rule check)
# ---------------------------------------------------------------------------
def _is_outbound(ent):
    """True for outbound message actions that should be validated before sending."""
    raw = ent.get("raw") if isinstance(ent.get("raw"), dict) else {}
    kind = ent.get("kind") or (raw.get("kind") if isinstance(raw, dict) else None)
    return kind in VALIDATE_KINDS or (isinstance(raw, dict) and bool(raw.get("email_reply")))


def _code_for_id(item_id):
    """Best-effort A/D code lookup from the codemap (for the force-override hint)."""
    try:
        cm = json.loads(CODEMAP.read_text()) if CODEMAP.exists() else {}
        for code, ent in cm.items():
            if ent.get("id") == item_id:
                return code
    except Exception:
        pass
    return ""


def _load_approval_rules():
    """The owner's standing rules for whether an approved action should still fire.
    Read from POCKET_APPROVAL_RULES or ~/.config/email-cos/approval-rules.md if present;
    otherwise a generic built-in rubric (no personal data)."""
    p = os.environ.get("POCKET_APPROVAL_RULES") or os.path.expanduser(
        "~/.config/email-cos/approval-rules.md"
    )
    if os.path.exists(p):
        try:
            return open(p).read()[:4000]
        except OSError:
            pass
    return (
        "- HOLD if the request appears already handled, resolved, or superseded "
        "(e.g. a meeting was already scheduled/accepted, the thread already has a "
        "later reply, the task is now obsolete).\n"
        "- HOLD if the action commits to a specific time/date on the owner's behalf "
        "unless the owner clearly set that time — scheduling is usually delegated.\n"
        "- HOLD if the action contradicts a more recent message or event in the context.\n"
        "- Otherwise PROCEED."
    )


def _gather_action_context(ent):
    """Best-effort recent-activity bundle for the action's thread/recipient via gog.
    Returns '' if gog is unavailable or anything fails (validator then defaults proceed)."""
    raw = ent.get("raw") if isinstance(ent.get("raw"), dict) else {}
    er = raw.get("email_reply") or {}
    to = (er.get("to") or "").strip()
    subj = (er.get("subject") or ent.get("title") or "").replace("Re:", "").strip()
    gog = shutil.which("gog") or os.path.expanduser("~/.local/bin/gog")
    if not (gog and os.path.exists(gog)):
        return ""
    clauses = []
    if to:
        clauses.append(f"(from:{to} OR to:{to})")
    if subj:
        clauses.append(f"subject:({subj[:60]})")
    if not clauses:
        return ""
    query = " OR ".join(clauses) + " newer_than:14d"
    try:
        r = subprocess.run(
            [gog, "gmail", "search", query, "--max", "10", "-j", "--results-only", "--no-input"],
            capture_output=True, text=True, timeout=45, env=os.environ,
        )
        rows = json.loads(r.stdout or "[]")
    except Exception:
        return ""
    bits = []
    for m in rows[:10]:
        bits.append(
            f"- [{m.get('date','')}] {(m.get('from') or '')[:40]} | {(m.get('subject') or '')[:75]}"
        )
    return "\n".join(bits)


def _validate_action(ent):
    """Return (ok, reason). ok=False => HOLD. Degrades to (True, '') on any failure —
    the guard never blocks an approval because of its own error."""
    cb = _resolve_claude_bin()
    if not cb:
        return True, ""
    raw = ent.get("raw") if isinstance(ent.get("raw"), dict) else {}
    er = raw.get("email_reply") or {}
    action = {
        "kind": ent.get("kind"),
        "to": er.get("to"),
        "subject": er.get("subject") or ent.get("title"),
        "body": (er.get("body") or "")[:1500],
    }
    ctx = _gather_action_context(ent)
    rules = _load_approval_rules()
    model = os.environ.get("POCKET_RESPONDER_MODEL", "claude-haiku-4-5")
    prompt = (
        "You are a pre-send guard for an action the owner already approved. Decide "
        "PROCEED (send it) or HOLD (it looks stale, already handled, or breaks a rule). "
        'Output ONLY JSON: {"decision":"proceed"|"hold","reason":"<short>"}.\n\n'
        f"OWNER RULES:\n{rules}\n\n"
        f"PROPOSED ACTION:\n{json.dumps(action, ensure_ascii=False)}\n\n"
        f"RECENT CONTEXT (thread + related activity; may be empty):\n{ctx or '(none available)'}\n\n"
        "If context is empty or unclear, default to proceed. JSON:"
    )
    try:
        r = subprocess.run([cb, "-p", prompt, "--model", model],
                           capture_output=True, text=True, timeout=90, env=os.environ)
        out = (r.stdout or "").strip()
    except Exception as e:
        log(f"validate: invocation error {e} — proceeding")
        return True, ""
    mt = re.search(r"\{.*\}", out, re.S)
    if not mt:
        return True, ""
    try:
        d = json.loads(mt.group(0))
    except Exception:
        return True, ""
    if (d.get("decision") or "").strip().lower() == "hold":
        return False, (d.get("reason") or "looks already handled / stale")[:200]
    return True, ""


def _publish_social(ent):
    """Publish a staged Typefully draft. Returns (ok, info)."""
    raw = ent.get("raw") if isinstance(ent.get("raw"), dict) else {}
    draft_id = ent.get("typefully_draft_id") or raw.get("typefully_draft_id")
    social_set = str(ent.get("social_set") or raw.get("social_set") or "")
    if not draft_id or not social_set:
        return False, "missing typefully_draft_id/social_set"
    if not os.environ.get("TYPEFULLY_API_KEY"):
        return False, "TYPEFULLY_API_KEY not set on box"
    tj = os.environ.get(
        "POCKET_TYPEFULLY_JS", os.path.expanduser("~/.claude/skills/typefully/scripts/typefully.js")
    )
    if not os.path.exists(tj):
        return False, f"typefully.js not found at {tj}"
    node = shutil.which("node") or "/usr/bin/node"
    try:
        r = subprocess.run(
            [node, tj, "drafts:publish", social_set, str(draft_id)],
            capture_output=True, text=True, timeout=60, env=os.environ,
        )
        if r.returncode != 0:
            return False, (r.stderr or r.stdout or "publish rc!=0")[:200]
        return True, (r.stdout or "published")[:200]
    except Exception as e:
        return False, str(e)[:200]


def _apply_decision(ent, decision, option=None, force=False):
    """Write the canonical sinks for one decision. Returns a short toast string.
    decision in {APPROVE, REJECT, CHOOSE}. Branches on kind=social_publish.
    force=True bypasses the pre-promotion validation guard."""
    iid = ent["id"]
    kind = ent.get("kind") or (ent.get("raw") or {}).get("kind") if isinstance(ent.get("raw"), dict) else ent.get("kind")

    if decision == "REJECT":
        open(RESOLVED, "a").write(json.dumps({"id": iid, "decision": "REJECT", "ts": time.time()}) + "\n")
        if kind == "social_publish":
            log(f"REJECT social {iid} — draft left unpublished")
            return "❌ Rejected — draft left unpublished."
        return "❌ Rejected."

    # Pre-promotion validation guard: before committing an outbound action, check it is
    # still valid (not already handled, not rule-breaking). HOLD instead of promoting;
    # the owner overrides with `force <code>`. Skipped when forced/disabled/non-outbound.
    if (not force and _is_outbound(ent)
            and os.environ.get("POCKET_VALIDATE_ACTIONS", "1") != "0"):
        ok, reason = _validate_action(ent)
        if not ok:
            open(RESOLVED, "a").write(
                json.dumps({"id": iid, "decision": "HELD", "reason": reason, "ts": time.time()}) + "\n"
            )
            try:
                open(HOLDS, "a").write(
                    json.dumps({"id": iid, "kind": kind, "reason": reason, "ts": time.time()}) + "\n"
                )
            except OSError:
                pass
            log(f"HELD {iid}: {reason}")
            code = _code_for_id(iid)
            hint = f"force {code}" if code else "force <code>"
            return f"⚠️ Held — {reason}\nReply `{hint}` to send anyway."

    if kind == "social_publish":
        ok, info = _publish_social(ent)
        open(RESOLVED, "a").write(json.dumps({
            "id": iid, "decision": "APPROVE", "kind": "social_publish",
            "published": ok, "info": info, "ts": time.time(),
        }) + "\n")
        log(f"APPROVE social {iid} published={ok} info={info}")
        return "✅ Published." if ok else f"⚠️ Approve recorded but publish failed: {info}"

    raw = ent.get("raw") or {}
    task = raw.get("task", raw) if isinstance(raw, dict) else {}
    task = dict(task)
    task["id"] = iid
    task.setdefault("kind", "action_item")
    task["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rec = {"id": iid, "decision": "APPROVE", "ts": time.time()}
    toast = "✅ Approved — running."
    if decision == "CHOOSE" and option:
        task["chosen_option"] = option
        lbl = next((o["label"] for o in (ent.get("options") or []) if o["key"].lower() == option.lower()), "")
        task["chosen_option_label"] = lbl
        rec = {"id": iid, "decision": "CHOOSE", "chosen": option, "ts": time.time()}
        toast = f"✅ Chose {option}) {lbl[:40]}"
    open(TASKS, "a").write(json.dumps(task) + "\n")
    open(RESOLVED, "a").write(json.dumps(rec) + "\n")
    log(f"{rec['decision']} {iid} -> tasks.jsonl")
    return toast


def _callmap_entry_for_id(callmap, item_id):
    for sid, ent in callmap.items():
        if ent.get("id") == item_id:
            return sid, ent
    return None, None


def _freeze(callmap_ent, toast):
    if callmap_ent and callmap_ent.get("message_id"):
        _api("editMessageText", {
            "chat_id": CHAT, "message_id": callmap_ent["message_id"],
            "text": f"*{callmap_ent.get('title','')}*\n{toast}", "parse_mode": "Markdown",
        })


# ---------------------------------------------------------------------------
# freeform LLM mapper
# ---------------------------------------------------------------------------
def _llm_map(codemap, message):
    """Map a freeform message to decisions against the open-ASK set.
    Returns a list of {code, decision, option?, confidence}. [] on any failure."""
    if os.environ.get("POCKET_RESPONDER_LLM", "1") == "0":
        return []
    cb = _resolve_claude_bin()
    if not cb:
        log("llm: claude binary not found — skipping LLM fallback")
        return []
    if not codemap:
        return []
    lines = []
    for code, ent in codemap.items():
        opts = ent.get("options") or []
        ob = "  options: " + "; ".join(f"{o['key']}) {o['label'][:50]}" for o in opts) if opts else ""
        lines.append(f"{code}: {ent.get('title','')[:120]}{ob}")
    catalog = "\n".join(lines)
    model = os.environ.get("POCKET_RESPONDER_MODEL", "claude-haiku-4-5")
    prompt = (
        "You map a person's freeform approval message to decisions on a fixed list "
        "of pending items. Output ONLY a JSON array, no prose.\n\n"
        "Each element: {\"code\": \"A1\", \"decision\": \"approve\"|\"reject\"|\"choose\", "
        "\"option\": \"a\" (only for choose), \"confidence\": 0.0-1.0}.\n"
        "Rules: only reference codes from the list. If the message clearly targets "
        "several items (\"reject all the music ones\"), emit one element each. If you "
        "are not confident which item is meant, return [] (do NOT guess). For yes/no "
        "items use approve|reject; for items with options use choose + the option key.\n\n"
        f"PENDING ITEMS:\n{catalog}\n\nMESSAGE:\n{message}\n\nJSON:"
    )
    try:
        r = subprocess.run([cb, "-p", prompt, "--model", model],
                           capture_output=True, text=True, timeout=90, env=os.environ)
        out = (r.stdout or "").strip()
    except Exception as e:
        log(f"llm: invocation failed: {e}")
        return []
    mt = re.search(r"\[.*\]", out, re.S)
    if not mt:
        return []
    try:
        arr = json.loads(mt.group(0))
    except Exception:
        return []
    return arr if isinstance(arr, list) else []


# ---------------------------------------------------------------------------
# process — the unified drain
# ---------------------------------------------------------------------------
def _handle_tap(cb, callmap, resolved, seen):
    cbid = str(cb.get("id"))
    if cbid in seen:
        return 0
    seen.add(cbid)
    data = cb.get("data", "")
    parts = data.split(":")
    verb, sid = (parts[0], parts[1]) if len(parts) >= 2 else ("", "")
    ent = callmap.get(sid)
    if not ent or ent["id"] in resolved:
        _api("answerCallbackQuery", {"callback_query_id": cbid, "text": "Unknown / expired item."})
        return 0
    if verb == "pr":
        toast = _apply_decision(ent, "REJECT")
    elif verb == "po" and len(parts) >= 3:
        toast = _apply_decision(ent, "CHOOSE", option=parts[2])
    elif verb == "pa":
        toast = _apply_decision(ent, "APPROVE")
    else:
        _api("answerCallbackQuery", {"callback_query_id": cbid, "text": "Unknown action."})
        return 0
    resolved.add(ent["id"])
    _api("answerCallbackQuery", {"callback_query_id": cbid, "text": toast})
    _freeze(ent, toast)
    return 1


def _handle_text(ev, codemap, callmap, resolved, seen):
    mid = ev.get("message_id")
    key = f"t:{mid}"
    if key in seen:
        return 0
    seen.add(key)
    body = ev.get("text") or ""
    if not body.strip():
        return 0

    acted = 0
    handled_ids: set[str] = set()
    matched_any = False

    # --- Force override: re-promote a guard-held action, bypassing validation. ---
    forced = False
    for mt in _RE_FORCE.finditer(body):
        ent = _resolve_code(codemap, mt.group(1))
        if not ent:
            continue
        forced = True
        toast = _apply_decision(ent, "APPROVE", force=True)
        resolved.add(ent["id"]); handled_ids.add(ent["id"]); acted += 1
        _, cment = _callmap_entry_for_id(callmap, ent["id"])
        _freeze(cment, toast)
        _send(f"{toast}  (forced {mt.group(1)})")
    if forced:
        return acted

    # --- Fast-path: choice replies first (higher specificity), then classic. ---
    for mt in _RE_CHOICE.finditer(body):
        if _choice_match_is_digest_example(body, mt):
            continue
        ref, letter = mt.group(1), mt.group(2).lower()
        ent = _resolve_code(codemap, ref)
        if not ent or not (ent.get("options") or []):
            continue  # not a choice item — let classic handle it
        matched_any = True
        tid = ent["id"]
        if tid in resolved or tid in handled_ids:
            continue
        valid = {o["key"].lower() for o in ent["options"]}
        if letter not in valid:
            _send(f"`{ref}` has no option `{letter}` (valid: {', '.join(sorted(valid))}).")
            continue
        toast = _apply_decision(ent, "CHOOSE", option=letter)
        resolved.add(tid); handled_ids.add(tid); acted += 1
        _, cment = _callmap_entry_for_id(callmap, tid)
        _freeze(cment, toast)
        _send(f"{toast}  ({ref}: {ent.get('title','')[:60]})")

    for mt in _RE_CLASSIC.finditer(body):
        verb, ref = mt.group(1).upper(), mt.group(2)
        ent = _resolve_code(codemap, ref)
        if not ent:
            continue
        matched_any = True
        tid = ent["id"]
        if tid in resolved or tid in handled_ids:
            continue
        if verb == "APPROVE" and (ent.get("options") or []):
            _send(f"`{ref}` is a choice item — reply e.g. `{ref} a`.")
            continue
        if verb == "APPROVE" and _is_outbound(ent) and _edit_intent(body):
            _send(f"`{ref}` looks like an *edit*, not a plain approve — I won't send the "
                  f"original draft as-is. Tap ✅ Approve (or reply `approve {ref}`) to send "
                  f"it unchanged, or `reject {ref}` to skip. _(Edit-then-send for emails isn't wired yet.)_")
            continue
        toast = _apply_decision(ent, "APPROVE" if verb == "APPROVE" else "REJECT")
        resolved.add(tid); handled_ids.add(tid); acted += 1
        _, cment = _callmap_entry_for_id(callmap, tid)
        _freeze(cment, toast)
        _send(f"{toast}  ({ref}: {ent.get('title','')[:60]})")

    if matched_any:
        return acted

    # --- LLM fallback for natural language ("approve the Duetti one"). ---
    decisions = _llm_map(codemap, body)
    thresh = float(os.environ.get("POCKET_RESPONDER_LLM_THRESHOLD", "0.6"))
    confident = []
    for dd in decisions:
        if not isinstance(dd, dict):
            continue
        code = (dd.get("code") or "").strip()
        dec = (dd.get("decision") or "").strip().lower()
        try:
            conf = float(dd.get("confidence") or 0)
        except (TypeError, ValueError):
            conf = 0.0
        ent = _resolve_code(codemap, code) if code else None
        if ent and dec in ("approve", "reject", "choose") and conf >= thresh:
            confident.append((ent, dec, dd.get("option")))
    if not confident:
        _send(
            "I couldn't confidently match that to a pending item. "
            "Reply with a code, e.g. `approve A1`, `A2 b`, or `reject A3`."
        )
        return 0
    for ent, dec, option in confident:
        tid = ent["id"]
        if tid in resolved or tid in handled_ids:
            continue
        if dec == "choose":
            if not option:
                _send(f"`{ent.get('title','')[:50]}` needs an option letter.")
                continue
            toast = _apply_decision(ent, "CHOOSE", option=option)
        else:
            if dec == "approve" and _is_outbound(ent) and _edit_intent(body):
                _send(f"That looks like an *edit* of “{ent.get('title','')[:50]}”, not a plain "
                      f"approve — I won't send the original draft as-is. Tap ✅ Approve to send it "
                      f"unchanged, or reply `reject` to skip. _(Edit-then-send for emails isn't wired yet.)_")
                continue
            toast = _apply_decision(ent, dec.upper())
        resolved.add(tid); handled_ids.add(tid); acted += 1
        _, cment = _callmap_entry_for_id(callmap, tid)
        _freeze(cment, toast)
        _send(f"{toast}  ({ent.get('title','')[:60]})")
    return acted


def cmd_process():
    if not INBOX.exists():
        print("no inbox")
        return
    callmap = json.loads(CALLMAP.read_text()) if CALLMAP.exists() else {}
    codemap = json.loads(CODEMAP.read_text()) if CODEMAP.exists() else {}
    seen = set(INBOX_SEEN.read_text().split()) if INBOX_SEEN.exists() else set()
    resolved = _resolved_ids()
    acted = 0
    for line in INBOX.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get("type")
        if t == "tap":
            acted += _handle_tap({"id": ev.get("id"), "data": ev.get("data", "")}, callmap, resolved, seen)
        elif t == "text":
            acted += _handle_text(ev, codemap, callmap, resolved, seen)
    INBOX_SEEN.write_text("\n".join(sorted(seen)) + "\n")
    log(f"process: acted={acted}")
    print(f"processed inbox; acted={acted}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "send"
    {"send": cmd_send, "process": cmd_process}.get(mode, cmd_send)()
