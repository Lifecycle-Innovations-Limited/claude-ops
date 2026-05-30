#!/usr/bin/env python3
"""Telegram inline-button approvals for the pocket digest.

  send     post each open ASK to Telegram as a message with tappable buttons
           (✅ Approve / ❌ Reject, or a)/b)/c) for choice items) + write a
           callmap (short_id -> full ASK entry) for the processor.
  process  drain callbacks the listener tee'd to tg-callbacks.jsonl: promote the
           tapped decision (same logic as ops-pocket-approvals cmd_replies),
           answer the callback (toast), and edit the message to show the result.

Same bot as the message-listener, so we never poll getUpdates here — the listener
tees callback_query events to tg-callbacks.jsonl and we act on the file.

Configuration (env vars or ~/.config/email-cos/config.sh):
  EMAIL_COS_APPROVAL_BOT_TOKEN  Bot token (falls back to TELEGRAM_BOT_TOKEN).
  EMAIL_COS_TG_CHAT_ID          Numeric chat/user ID to send button messages to.
                                Required — script exits cleanly if unset.
  EMAIL_COS_APPROVALS_PY        Path to ops-pocket-approvals.py.
                                Default: path relative to this script's location
                                (../../scripts/ops-pocket-approvals.py).
  POCKET_STATE_DIR              Pipeline state dir (default: /var/lib/pocket-pipeline).
  COS_TG_SEND_CAP               Max button messages per send run (default: 8).
"""

import json, os, hashlib, subprocess, importlib.util, pathlib, urllib.parse, urllib.request, sys, time

STATE = pathlib.Path(os.environ.get("POCKET_STATE_DIR", "/var/lib/pocket-pipeline"))
CALLMAP = STATE / "tg-callmap.json"
CALLBACKS = STATE / "tg-callbacks.jsonl"
CB_SEEN = STATE / "tg-callbacks.seen"
TASKS = STATE / "tasks.jsonl"
RESOLVED = STATE / "approval-resolved.jsonl"

TOKEN = os.environ.get("EMAIL_COS_APPROVAL_BOT_TOKEN") or os.environ.get(
    "TELEGRAM_BOT_TOKEN", ""
)

CHAT = os.environ.get("EMAIL_COS_TG_CHAT_ID", "")
if not CHAT:
    print("EMAIL_COS_TG_CHAT_ID is not set — exiting.", file=sys.stderr)
    sys.exit(0)

# Path to ops-pocket-approvals.py. Configurable via EMAIL_COS_APPROVALS_PY.
# Default resolves relative to this script: email-cos/ → scripts/ops-pocket-approvals.py
_default_approvals_py = str(
    pathlib.Path(__file__).resolve().parent.parent
    / "scripts"
    / "ops-pocket-approvals.py"
)
APPROVALS_PY = os.path.expanduser(
    os.environ.get("EMAIL_COS_APPROVALS_PY", _default_approvals_py)
)


def _api(method, payload):
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = urllib.parse.urlencode(
        {
            k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
            for k, v in payload.items()
        }
    ).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=data), timeout=15
        ) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _load_approvals():
    spec = importlib.util.spec_from_file_location("appr", APPROVALS_PY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _sid(item_id):
    return "i" + hashlib.sha1(item_id.encode()).hexdigest()[:10]


def cmd_send():
    m = _load_approvals()
    items = m.open_items()
    if not items:
        print("no open items")
        return
    resolved = m._resolved_ids() if hasattr(m, "_resolved_ids") else set()
    cap = int(os.environ.get("COS_TG_SEND_CAP", "8"))
    # Idempotent: keep prior button messages, only send items not already sent.
    callmap = json.loads(CALLMAP.read_text()) if CALLMAP.exists() else {}
    already = {v.get("id") for v in callmap.values()}
    sent = 0
    for it in items:
        if sent >= cap:
            break
        iid = it["id"]
        if iid in resolved or iid in already:
            continue
        sid = _sid(iid)
        opts = []
        ap = ""
        # reuse the option extractor added in #387 if present
        if hasattr(m, "_extract_option_fields"):
            try:
                ap, dq, opts = m._extract_option_fields(it.get("raw", {}))
            except Exception:
                opts = []
        title = it.get("title", "")[:120]
        ctx = it.get("ctx") or ""
        ctx = (
            m._truncate_words(ctx, 500) if hasattr(m, "_truncate_words") else ctx[:500]
        )
        text = f"*{title}*\n{ctx}"
        if ap:
            text += f"\n\n→ *Approve =* {ap}"
        if opts:
            rows = [
                [
                    {
                        "text": f"{o['key']}) {o['label'][:40]}",
                        "callback_data": f"po:{sid}:{o['key']}",
                    }
                ]
                for o in opts
            ]
            rows.append([{"text": "❌ Reject", "callback_data": f"pr:{sid}"}])
        else:
            rows = [
                [
                    {"text": "✅ Approve", "callback_data": f"pa:{sid}"},
                    {"text": "❌ Reject", "callback_data": f"pr:{sid}"},
                ]
            ]
        r = _api(
            "sendMessage",
            {
                "chat_id": CHAT,
                "text": text[:3800],
                "parse_mode": "Markdown",
                "reply_markup": {"inline_keyboard": rows},
            },
        )
        mid = (r.get("result") or {}).get("message_id")
        callmap[sid] = {
            "id": iid,
            "kind": it.get("kind"),
            "bucket": it.get("bucket"),
            "raw": it.get("raw"),
            "options": opts,
            "message_id": mid,
            "title": title,
        }
        if r.get("ok"):
            sent += 1
    CALLMAP.write_text(json.dumps(callmap, indent=0))
    print(f"sent {sent} button message(s); callmap={len(callmap)}")


def cmd_process():
    if not CALLBACKS.exists():
        print("no callbacks")
        return
    m = _load_approvals()
    callmap = json.loads(CALLMAP.read_text()) if CALLMAP.exists() else {}
    seen = set(CB_SEEN.read_text().split()) if CB_SEEN.exists() else set()
    resolved = m._resolved_ids() if hasattr(m, "_resolved_ids") else set()
    acted = 0
    for line in CALLBACKS.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            cb = json.loads(line)
        except Exception:
            continue
        cbid = str(cb.get("id"))
        if cbid in seen:
            continue
        seen.add(cbid)
        data = cb.get("data", "")
        parts = data.split(":")
        verb, sid = (parts[0], parts[1]) if len(parts) >= 2 else ("", "")
        ent = callmap.get(sid)
        toast = "Unknown / expired item."
        if ent and ent["id"] not in resolved:
            raw = ent.get("raw") or {}
            if verb == "pr":
                open(RESOLVED, "a").write(
                    json.dumps(
                        {"id": ent["id"], "decision": "REJECT", "ts": time.time()}
                    )
                    + "\n"
                )
                toast = "❌ Rejected."
            elif verb in ("pa", "po"):
                task = raw.get("task", raw) if isinstance(raw, dict) else {}
                task = dict(task)
                task["id"] = ent["id"]
                task.setdefault("kind", "action_item")
                task["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                if verb == "po" and len(parts) >= 3:
                    task["chosen_option"] = parts[2]
                    lbl = next(
                        (
                            o["label"]
                            for o in ent.get("options", [])
                            if o["key"] == parts[2]
                        ),
                        "",
                    )
                    task["chosen_option_label"] = lbl
                    toast = f"✅ Chose {parts[2]}) {lbl[:40]}"
                else:
                    toast = "✅ Approved — running."
                open(TASKS, "a").write(json.dumps(task) + "\n")
                open(RESOLVED, "a").write(
                    json.dumps(
                        {"id": ent["id"], "decision": "APPROVE", "ts": time.time()}
                    )
                    + "\n"
                )
            resolved.add(ent["id"])
            acted += 1
            # tap feedback + freeze the message
            _api("answerCallbackQuery", {"callback_query_id": cbid, "text": toast})
            if ent.get("message_id"):
                _api(
                    "editMessageText",
                    {
                        "chat_id": CHAT,
                        "message_id": ent["message_id"],
                        "text": f"*{ent.get('title', '')}*\n{toast}",
                        "parse_mode": "Markdown",
                    },
                )
        else:
            _api("answerCallbackQuery", {"callback_query_id": cbid, "text": toast})
    CB_SEEN.write_text("\n".join(sorted(seen)) + "\n")
    print(f"processed callbacks; acted={acted}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "send"
    {"send": cmd_send, "process": cmd_process}.get(mode, cmd_send)()
