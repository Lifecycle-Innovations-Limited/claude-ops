#!/usr/bin/env python3
"""
bg-send — inject a user message into a running `claude --bg` session.

Talks to the Claude Code background-session supervisor's control socket
(`/tmp/cc-daemon-<uid>/<sha8>/control.sock`) and issues a `reply` op.

Wire format (reverse-engineered from claude 2.1.150 by stracing
`claude logs <short>`): newline-delimited JSON. One line per message.

Reply payload:
  {"proto":1,"op":"reply","short":"<8 hex chars>","text":"<message>"}\\n

Exit codes: 0 ok, 2 usage, 3 socket missing, 4 send failure, 5 supervisor error.
"""

from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

ROSTER_PATH = Path.home() / ".claude" / "daemon" / "roster.json"
PROTO = 1
SHORT_LEN = 8


def discover_control_sock() -> Path:
    """The supervisor's control socket lives at
    /tmp/cc-daemon-<uid>/<sha8>/control.sock. The instance dir is the SHA-256
    (first 8 hex) of the supervisor's resolved cwd, but it isn't published on
    its own — each worker's rendezvousSock starts with the same dir, so we
    pull it from the roster."""
    if ROSTER_PATH.exists():
        try:
            roster = json.loads(ROSTER_PATH.read_text())
            for w in (roster.get("workers") or {}).values():
                rv = w.get("rendezvousSock", "")
                if "/rv/" in rv:
                    sock = Path(rv.split("/rv/")[0]) / "control.sock"
                    if sock.exists():
                        return sock
        except (json.JSONDecodeError, OSError):
            pass
    uid = os.getuid()
    base = Path(f"/tmp/cc-daemon-{uid}")
    if base.is_dir():
        for inst in base.iterdir():
            sock = inst / "control.sock"
            if sock.exists():
                return sock
    raise FileNotFoundError("could not discover supervisor control.sock")


def normalize_short(session_id: str) -> str:
    s = session_id.lower().strip().split("-")[0]
    if len(s) < SHORT_LEN or not all(c in "0123456789abcdef" for c in s[:SHORT_LEN]):
        raise ValueError(f"session id {session_id!r} does not start with 8 hex chars")
    return s[:SHORT_LEN]


def send_reply(short: str, text: str, timeout: float = 3.0) -> dict:
    sock_path = discover_control_sock()
    msg = {"proto": PROTO, "op": "reply", "short": short, "text": text}
    line = json.dumps(msg, separators=(",", ":")) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(str(sock_path))
        s.sendall(line.encode("utf-8"))
        s.settimeout(timeout)
        buf = b""
        try:
            while b"\n" not in buf and len(buf) < 65536:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except socket.timeout:
            pass
    if not buf:
        return {
            "ok": True,
            "note": "no response (reply ops are typically fire-and-forget)",
        }
    first_line = buf.split(b"\n", 1)[0].decode("utf-8", "replace")
    try:
        return json.loads(first_line)
    except json.JSONDecodeError:
        return {"ok": False, "raw": first_line[:300]}


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: bg-send <session-id-or-short> <text>", file=sys.stderr)
        return 2
    try:
        short = normalize_short(argv[1])
    except ValueError as e:
        print(f"bg-send: {e}", file=sys.stderr)
        return 2
    try:
        result = send_reply(short, argv[2])
    except FileNotFoundError as e:
        print(f"bg-send: {e}", file=sys.stderr)
        return 3
    except OSError as e:
        print(f"bg-send: socket error: {e}", file=sys.stderr)
        return 4
    print(json.dumps(result))
    if isinstance(result, dict) and result.get("ok") is False:
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
