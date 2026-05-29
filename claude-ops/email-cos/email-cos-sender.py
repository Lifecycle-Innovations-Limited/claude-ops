#!/usr/bin/env python3
"""Drains APPROVED email-triage replies from pocket tasks.jsonl and sends them via gog.
Plain subprocess — NOT subject to the Claude Bash outbound hook. Idempotent via ledger.

Config is read from env (loaded by email-cos-sender.sh which sources lib/config.sh).
"""

import json, os, subprocess, pathlib

_ACCOUNT = os.environ.get("EMAIL_COS_ACCOUNT", "")
_PS = pathlib.Path(
    os.environ.get("EMAIL_COS_POCKET_STATE_DIR", "/var/lib/pocket-pipeline")
)
_SD = pathlib.Path(
    os.environ.get(
        "EMAIL_COS_STATE_DIR", str(pathlib.Path.home() / ".local/state/email-cos")
    )
)

TASKS = _PS / "tasks.jsonl"
LEDGER = _SD / "sent.ledger"

if not _ACCOUNT:
    print("email-cos-sender: EMAIL_COS_ACCOUNT not configured", flush=True)
    raise SystemExit(1)

sent = set(LEDGER.read_text().split()) if LEDGER.exists() else set()
new_sent = []

if TASKS.exists():
    for line in TASKS.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            t = json.loads(line)
        except Exception:
            continue
        if t.get("source") != "email-triage" or not t.get("approved_at"):
            continue
        tid = t.get("id")
        if not tid or tid in sent:
            continue
        er = t.get("email_reply") or {}
        to = er.get("to")
        subj = er.get("subject")
        body = er.get("body")
        rmid = er.get("reply_to_msg_id")
        if not (to and subj and body):
            continue
        cmd = [
            "gog",
            "gmail",
            "send",
            "-a",
            _ACCOUNT,
            "--to",
            to,
            "--subject",
            subj,
            "--body",
            body,
            "--no-input",
        ]
        if rmid:
            cmd += ["--reply-to-message-id", rmid]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        ok = r.returncode == 0
        with open(_SD / "sender.out", "a") as f:
            f.write(
                f"{t.get('approved_at')} send {tid} to={to} ok={ok} {r.stderr[:120]}\n"
            )
        if ok:
            sent.add(tid)
            new_sent.append(tid)

if new_sent:
    LEDGER.write_text("\n".join(sorted(sent)) + "\n")
    print(f"sent {len(new_sent)}: {new_sent}")
else:
    print("nothing to send")
