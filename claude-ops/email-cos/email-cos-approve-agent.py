#!/usr/bin/env python3
"""Agentic approval interpreter for pocket ASKs (natural language UX, no codes required).

Reads the account owner's replies to [Pocket] digests, interprets intent (strict
'APPROVE A1' fast-path OR natural language via the configured NL_MODEL) against the
open codemap, and promotes/rejects using the same logic as ops-pocket-approvals.py
cmd_replies (writes tasks.jsonl + resolved.jsonl).

Confirms decisions back over email-cos-notify.sh (Telegram/Slack) and WhatsApp
when those channels are enabled.

Configuration comes from env variables set by email-cos-sender.sh (which sources
lib/config.sh). State dir = EMAIL_COS_POCKET_STATE_DIR.
"""

import json, os, re, subprocess, time, pathlib

# ── Config from environment ────────────────────────────────────────────────
_SCRIPT_DIR = pathlib.Path(__file__).parent
STATE = pathlib.Path(
    os.environ.get("EMAIL_COS_POCKET_STATE_DIR", "/var/lib/pocket-pipeline")
)
SD = pathlib.Path(
    os.environ.get(
        "EMAIL_COS_STATE_DIR", str(pathlib.Path.home() / ".local/state/email-cos")
    )
)
ACCOUNT = os.environ.get("EMAIL_COS_ACCOUNT", "")
NL_MODEL = os.environ.get("EMAIL_COS_NL_MODEL", "claude-haiku-4-5-20251001")
WA_ENABLE = os.environ.get("EMAIL_COS_WA_ENABLE", "false").lower() == "true"
WA_JID = os.environ.get("EMAIL_COS_WA_JID", "")
WA_BRIDGE_URL = os.environ.get("EMAIL_COS_WA_BRIDGE_URL", "http://localhost:8080")

CODEMAP = STATE / "approval-codemap.json"
RESOLVED = STATE / "approval-resolved.jsonl"
TASKS = STATE / "tasks.jsonl"
SEEN = SD / "approve-seen.txt"

# ── Helpers ────────────────────────────────────────────────────────────────


def gog(*a):
    if not ACCOUNT:
        return ""
    return subprocess.run(
        ["gog", "gmail", *a, "-a", ACCOUNT, "--no-input"],
        capture_output=True,
        text=True,
        timeout=60,
        env=os.environ,
    ).stdout


def resolved_ids():
    if not RESOLVED.exists():
        return set()
    out = set()
    for ln in RESOLVED.read_text().splitlines():
        try:
            out.add(json.loads(ln)["id"])
        except Exception:
            pass
    return out


def promote(ent, decision):
    """Mirror of cmd_replies promote logic."""
    if decision == "APPROVE":
        raw = ent["raw"]
        task = raw.get("task", raw) if isinstance(raw, dict) else {}
        task = dict(task)
        task["id"] = ent["id"]
        if ent.get("bucket") == "DRAFT":
            task["kind"] = "action_item"
        else:
            task.setdefault("kind", "action_item")
        task["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        open(TASKS, "a").write(json.dumps(task) + "\n")
        open(RESOLVED, "a").write(
            json.dumps({"id": ent["id"], "decision": "APPROVE", "ts": time.time()})
            + "\n"
        )
    else:
        open(RESOLVED, "a").write(
            json.dumps({"id": ent["id"], "decision": "REJECT", "ts": time.time()})
            + "\n"
        )


def confirm(msg):
    """Fan out confirmation to all enabled channels."""
    notify_script = _SCRIPT_DIR / "email-cos-notify.sh"
    subprocess.run([str(notify_script), msg], capture_output=True, timeout=20)
    if WA_ENABLE and WA_JID:
        subprocess.run(
            [
                "curl",
                "-s",
                "-m",
                "10",
                "-o",
                "/dev/null",
                "-X",
                "POST",
                f"{WA_BRIDGE_URL}/api/send",
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps({"recipient": WA_JID, "message": msg}),
            ],
            timeout=15,
        )


def interpret(reply_text, codemap):
    """Return [{code, decision}]. Strict regex first, Haiku NL fallback."""
    decisions = {}
    for mt in re.finditer(r"\b(APPROVE|REJECT)\s+([A-Za-z]\d+)\b", reply_text, re.I):
        decisions[mt.group(2).upper()] = mt.group(1).upper()
    if decisions:
        return [{"code": k, "decision": v} for k, v in decisions.items()]

    items = "\n".join(
        f"{c}: ({v.get('bucket')}) {v.get('title')}" for c, v in codemap.items()
    )
    prompt = (
        "You map a user's reply to approval decisions on a fixed list of pending items. "
        "SAFETY: approving triggers a real action (e.g. sending an email), so NEVER guess. "
        "Only include an item if the reply UNAMBIGUOUSLY refers to THAT specific item — by its "
        "code (A1/D2), or by a person/company/subject keyword that actually appears in the item's title. "
        "If the reply mentions something that does NOT clearly match any listed item, OMIT it. "
        "'all'/'everything'/'approve them all' applies to every listed item. "
        'Output ONLY compact JSON: {"decisions":[{"code":"A1","decision":"APPROVE"}]} (APPROVE or REJECT). '
        'If nothing clearly matches, return {"decisions":[]}.\n\n'
        f"ITEMS:\n{items}\n\nUSER REPLY:\n{reply_text[:1500]}\n"
    )
    r = subprocess.run(
        [
            "claude",
            "--print",
            "--model",
            NL_MODEL,
            "--dangerously-skip-permissions",
            prompt,
        ],
        capture_output=True,
        text=True,
        timeout=90,
    )
    try:
        m = re.search(r"\{.*\}", r.stdout, re.S)
        return json.loads(m.group(0)).get("decisions", []) if m else []
    except Exception:
        return []


def main():
    if not CODEMAP.exists():
        print("no codemap")
        return

    codemap = json.loads(CODEMAP.read_text())
    seen = set(SEEN.read_text().split()) if SEEN.exists() else set()
    res = resolved_ids()
    acted = []

    def apply_text(text):
        for dec in interpret(text, codemap):
            code = (dec.get("code") or "").upper()
            verb = (dec.get("decision") or "").upper()
            ent = codemap.get(code)
            if not ent or ent["id"] in res or verb not in ("APPROVE", "REJECT"):
                continue
            promote(ent, verb)
            res.add(ent["id"])
            acted.append(
                f"{'Approved' if verb == 'APPROVE' else 'Rejected'} {code} ({ent.get('title', '')[:40]})"
            )

    # ── Channel 1: Gmail replies ─────────────────────────────────────────
    raw = gog(
        "search",
        "from:me subject:[Pocket] newer_than:3d",
        "--max",
        "15",
        "-j",
        "--results-only",
    )
    try:
        msgs = json.loads(raw or "[]")
    except Exception:
        msgs = []
    for m in msgs:
        mid = m.get("id")
        if not mid or mid in seen:
            continue
        subj = m.get("subject") or ""
        if re.match(r"^\[Pocket\]\s+\d+\s+item", subj) and not subj.lower().startswith(
            "re:"
        ):
            seen.add(mid)
            continue
        body = ""
        try:
            d = json.loads(gog("get", mid, "-j") or "{}")
            body = d.get("body") or d.get("snippet") or ""
        except Exception:
            pass
        if body:
            apply_text(body)
        seen.add(mid)

    # ── Channel 2: Slack self-DM replies ─────────────────────────────────
    OUR_PREFIXES = (
        "\U0001f4e5",
        "\U0001f4e7",
        "✅",
        "\U0001f916",
        "⚠️",
        "\U0001f9ea",
        "\U0001f9f9",
        "\U0001f4ca",
    )
    slack_script = _SCRIPT_DIR / "email-cos-slack.sh"
    if os.environ.get("EMAIL_COS_SLACK_ENABLE", "false").lower() == "true":
        try:
            hist = json.loads(
                subprocess.run(
                    [str(slack_script), "history"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                ).stdout
                or "{}"
            )
        except Exception:
            hist = {}
        for sm in hist.get("messages", []) or []:
            ts = sm.get("ts")
            text = (sm.get("text") or "").strip()
            if not ts or not text:
                continue
            key = "slack:" + ts
            if key in seen:
                continue
            seen.add(key)
            if sm.get("bot_id") or text.startswith(OUR_PREFIXES):
                continue
            apply_text(text)

    # ── Channel 3: Telegram (MTProto, optional) ──────────────────────────
    tg_bot = os.environ.get("EMAIL_COS_TG_BOT_USERNAME", "")
    tg_read = _SCRIPT_DIR / "pocket-telegram-read"
    if (
        os.environ.get("EMAIL_COS_TG_ENABLE", "false").lower() == "true"
        and tg_bot
        and tg_read.exists()
    ):
        try:
            tg = json.loads(
                subprocess.run(
                    [str(tg_read), tg_bot, "12"],
                    capture_output=True,
                    text=True,
                    timeout=45,
                ).stdout
                or "{}"
            )
        except Exception:
            tg = {}
        for tm in tg.get("messages", []) or []:
            if not tm.get("out"):
                continue
            text = (tm.get("text") or "").strip()
            if not text:
                continue
            key = "tg:" + str(tm.get("id"))
            if key in seen:
                continue
            seen.add(key)
            apply_text(text)

    SEEN.write_text("\n".join(sorted(seen)) + "\n")
    if acted:
        confirm("email-cos approvals applied:\n" + "\n".join(acted))
        print("acted:\n" + "\n".join(acted))
    else:
        print("no new approval replies")


if __name__ == "__main__":
    main()
