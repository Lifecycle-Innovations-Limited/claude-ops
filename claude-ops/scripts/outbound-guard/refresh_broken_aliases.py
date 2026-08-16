#!/usr/bin/env python3
"""Keep the list of broken send-as aliases current from Gmail's own bounces.

Gmail stamps a message SENT and only afterwards posts a delivery failure into the
thread, and that failure lands in Trash under CATEGORY_UPDATES rather than the inbox.
So a misconfigured alias fails invisibly: the sender sees a sent message, the
recipient never gets it, and nobody finds out until the other side chases.

This scans recent 'Send mail as' failures, extracts which alias each one was sent
from, and writes them to ~/.claude/state/broken-send-aliases.json. The outbound guard
reads that file and refuses to send from a listed alias, because approving such a send
only produces another silent bounce.

Run it on a timer, or after fixing an alias to clear it:

    python3 refresh_broken_aliases.py           # rescan and rewrite the list
    python3 refresh_broken_aliases.py --clear support@example.com
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

STATE = os.path.expanduser("~/.claude/state/broken-send-aliases.json")
WINDOW = "newer_than:90d"
# Gmail's wording when a send-as relay refuses the credentials.
SIGNATURE = "Send mail as"


def gog(args, timeout=180):
    return subprocess.run(["gog"] + args, capture_output=True, text=True, timeout=timeout)


def known_aliases() -> list[str]:
    p = gog(["gmail", "settings", "sendas", "list", "-j", "--no-input"])
    try:
        d = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        return []
    rows = d if isinstance(d, list) else d.get("sendAs", [])
    return [r.get("sendAsEmail", "") for r in rows if r.get("sendAsEmail")]


def scan() -> dict:
    aliases = known_aliases()
    p = gog(["gmail", "search", f'in:anywhere "{SIGNATURE}" misconfigured {WINDOW}',
             "--max", "40", "-j", "--results-only", "--no-input"])
    try:
        rows = json.loads(p.stdout or "[]")
    except json.JSONDecodeError:
        rows = []

    hits: dict[str, dict] = {}
    seen_threads = set()
    for r in rows:
        tid = r.get("threadId") or r.get("id")
        if not tid or tid in seen_threads:
            continue
        seen_threads.add(tid)
        t = gog(["gmail", "thread", "get", tid, "-j"], timeout=120)
        try:
            d = json.loads(t.stdout or "{}")
        except json.JSONDecodeError:
            continue
        msgs = d.get("thread", {}).get("messages", [])

        # Which alias failed is the From of the SENT message in this thread, not any
        # address that happens to appear in the bounce text. Matching alias names
        # inside the bounce body is wrong: the bounce quotes the recipient too, which
        # made the primary account look broken when it has no SMTP relay at all.
        bounced = False
        sender = ""
        for m in msgs:
            h = {x["name"]: x.get("value", "")
                 for x in m.get("payload", {}).get("headers", [])}
            frm = (h.get("From") or "").lower()
            if "mailer-daemon" in frm or "postmaster" in frm:
                bounced = True
            elif "SENT" in (m.get("labelIds") or []):
                mm = re.search(r"[\w.+-]+@[\w.-]+", frm)
                if mm and mm.group(0) in [a.lower() for a in aliases]:
                    sender = mm.group(0)
        if bounced and sender:
            e = hits.setdefault(sender, {"count": 0, "last_seen": ""})
            e["count"] += 1
            dt = r.get("date") or ""
            if dt > e["last_seen"]:
                e["last_seen"] = dt
    return hits


def write(hits: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    payload = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": ("Aliases whose sends bounced with a 'Send mail as' misconfiguration. "
                 "The outbound guard refuses to send from these. Fix the app password "
                 "in Gmail Settings, Accounts, Send mail as, then rerun this script."),
        "aliases": hits,
    }
    with open(STATE, "w") as f:
        json.dump(payload, f, indent=2)
    os.chmod(STATE, 0o600)


def load() -> dict:
    try:
        with open(STATE) as f:
            return (json.load(f) or {}).get("aliases", {}) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> int:
    if "--clear" in sys.argv:
        i = sys.argv.index("--clear")
        target = sys.argv[i + 1] if len(sys.argv) > i + 1 else ""
        hits = load()
        if target in hits:
            del hits[target]
            write(hits)
            print(f"cleared {target}; {len(hits)} still listed")
        else:
            print(f"{target} was not listed")
        return 0

    hits = scan()
    write(hits)
    if not hits:
        print("no broken aliases found")
        return 0
    print(f"{len(hits)} broken alias(es):")
    for a, e in sorted(hits.items(), key=lambda kv: -kv[1]["count"]):
        print(f"  {a:38} {e['count']:3} bounces, last {e['last_seen']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
