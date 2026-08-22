#!/usr/bin/env python3
"""One approval store for outbound messages, shared by every CLI that can send.

There used to be two independent guards, each with its own token file: the PreToolUse
hook (/tmp/.claude-send-ok) and the MCP proxy ledger (/tmp/.claude-send-ok-all). A
single message crossed both, so arming an approval meant writing two files and hoping
the counts stayed in step. Any other CLI on the same proxy saw a third picture.

Now there is one state file, one expiry and one counter:

    /tmp/.claude-outbound-guard.json
    {"remaining": 3, "minted": 1786732800, "ttl": 900, "spent": {"<fingerprint>": 1786732801}}

And one rule that rules out double counting: a message is identified by recipient plus
content. When a second guard sees a fingerprint already recorded within
SPENT_WINDOW_SEC, that is the same message, already paid for. It passes and nothing is
deducted. One message costs exactly one unit no matter how many layers it crosses.

The Node twin lives at ../outbound-guard.mjs (and, when installed, at
~/.claude/mcp-proxy/outbound-guard.mjs). It reads and writes this same file with the
same rules, and the test suite asserts both sides agree on the fingerprint.
"""
from __future__ import annotations

import hashlib
import json
import os
import time

STATE = "/tmp/.claude-outbound-guard.json"
# Window in which the same message reaching a second guard is treated as already paid.
# Generous enough for a slow MCP round trip, short enough that a genuinely new message
# never rides in free.
SPENT_WINDOW_SEC = 120
# Legacy single-use token. Kept working while not every CLI has moved over; the
# canonical state above wins whenever it exists.
LEGACY_SINGLE = "/tmp/.claude-send-ok"
LEGACY_SINGLE_TTL = 120


def fingerprint(recipient: str, body: str) -> str:
    """Identity of a message: who it goes to, and what it says.

    Channel is deliberately excluded. The same mail arriving via the hook and via the
    proxy must hash identically, even when the two layers name the channel differently.
    """
    r = (recipient or "").strip().lower()
    b = " ".join((body or "").split())[:400]
    return hashlib.sha256(f"{r}|{b}".encode("utf-8")).hexdigest()[:32]


def _read() -> dict | None:
    try:
        with open(STATE) as f:
            d = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(d, dict):
        return None
    if time.time() - d.get("minted", 0) > d.get("ttl", 0):
        _clear()
        return None
    return d


def _write(d: dict) -> None:
    tmp = STATE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(d, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, STATE)
    except OSError:
        pass


def _clear() -> None:
    for p in (STATE, STATE + ".tmp"):
        try:
            os.remove(p)
        except OSError:
            pass


def mint(count: int, ttl: int) -> None:
    """Called by `ok`. Sets the counter; never adds to what was already there."""
    _write({"remaining": int(count), "minted": int(time.time()),
            "ttl": int(ttl), "spent": {}})


def peek() -> tuple[int, int]:
    """(remaining, seconds still valid). (0, 0) when nothing is armed."""
    d = _read()
    if not d:
        return (0, 0)
    left = int(d.get("ttl", 0) - (time.time() - d.get("minted", 0)))
    return (int(d.get("remaining", 0)), max(0, left))


def consume(recipient: str = "", body: str = "") -> bool:
    """True when this message may go. Deducts at most one unit.

    The same fingerprint inside the window is the same message, already charged at an
    earlier guard, so it passes for free.
    """
    fp = fingerprint(recipient, body)
    d = _read()
    if d:
        now = time.time()
        spent = {k: v for k, v in (d.get("spent") or {}).items()
                 if now - v < SPENT_WINDOW_SEC}
        if fp in spent:
            d["spent"] = spent
            _write(d)
            return True
        remaining = int(d.get("remaining", 0))
        if remaining > 0:
            remaining -= 1
            spent[fp] = now
            if remaining <= 0 and not spent:
                _clear()
            else:
                d["remaining"] = remaining
                d["spent"] = spent
                _write(d)
            return True
        # Counter at zero but still inside the window. Only a repeat of an
        # already-paid message may pass, and that was handled above.
        return False

    # No canonical state: fall back to the old single-use token so a CLI that has not
    # been migrated keeps behaving as before.
    try:
        st = os.stat(LEGACY_SINGLE)
    except OSError:
        return False
    if time.time() - st.st_mtime > LEGACY_SINGLE_TTL:
        return False
    try:
        os.remove(LEGACY_SINGLE)
    except OSError:
        pass
    return True


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "peek"
    if cmd == "mint":
        mint(int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 900)
        print("minted", *peek())
    elif cmd == "consume":
        ok = consume(sys.argv[2] if len(sys.argv) > 2 else "",
                     sys.argv[3] if len(sys.argv) > 3 else "")
        print("allow" if ok else "deny", *peek())
        sys.exit(0 if ok else 1)
    else:
        r, t = peek()
        print(f"remaining={r} valid_for={t}s")
