#!/usr/bin/env python3
"""Checks the outbound hook blocks every send path and lets read-only calls through.

The cases live in this file rather than on the command line on purpose: the hook reads
the text of the Bash command, so a test that spells the patterns out on the command line
would block itself.
"""
import json
import os
import subprocess
import sys

# Path to the hook under test. Defaults to the installed hook on this machine;
# override with OUTBOUND_HOOK to test a copy inside a checkout.
HOOK = os.environ.get(
    "OUTBOUND_HOOK",
    os.path.expanduser("~/.claude/scripts/hooks/block-outbound-comms.py"),
)
BR = "http://127.0.0.1:%d/api/send"
G = "gog gmail"

MUST_BLOCK = [
    ("whatsapp-nl MCP", {"tool_name": "mcp__whatsapp-nl__send_message",
                         "tool_input": {"recipient": "15551230001@s.whatsapp.net", "message": "t"}}),
    ("whatsapp-us MCP", {"tool_name": "mcp__whatsapp-us__send_message",
                         "tool_input": {"recipient": "15551230002@s.whatsapp.net", "message": "t"}}),
    ("whatsapp file", {"tool_name": "mcp__whatsapp-nl__send_file",
                       "tool_input": {"recipient": "15551230001@s.whatsapp.net", "media_path": "/x"}}),
    ("bridge curl 8080", {"tool_name": "Bash",
                          "tool_input": {"command": "curl -s -X POST " + (BR % 8080) + " -d @x"}}),
    ("bridge curl 8082", {"tool_name": "Bash",
                          "tool_input": {"command": "curl -s -X POST " + (BR % 8082) + " -d @x"}}),
    ("gog drafts send", {"tool_name": "Bash",
                         "tool_input": {"command": G + " drafts send r123"}}),
    ("gog draft send", {"tool_name": "Bash",
                        "tool_input": {"command": G + " draft send r123"}}),
    ("gog gmail send", {"tool_name": "Bash",
                        "tool_input": {"command": G + " send --to a@b.com --body hi"}}),
    ("gmail MCP send", {"tool_name": "mcp__gog__gmail_send",
                        "tool_input": {"to": "a@b.com", "subject": "x", "body": "y"}}),
    ("slack MCP", {"tool_name": "mcp__slack__conversations_add_message",
                   "tool_input": {"channel_id": "C1", "payload": "hi"}}),
]

MUST_PASS = [
    ("gmail search", {"tool_name": "Bash",
                      "tool_input": {"command": G + " search in:inbox --max 5"}}),
    ("gmail archive", {"tool_name": "Bash",
                       "tool_input": {"command": G + " archive 123 --force"}}),
    ("whatsapp list", {"tool_name": "mcp__whatsapp-nl__list_messages",
                       "tool_input": {"chat_jid": "x@lid"}}),
    ("whatsapp archive", {"tool_name": "mcp__whatsapp-nl__archive_chat",
                          "tool_input": {"chat_jid": "x@lid", "archive": True}}),
    ("plain ls", {"tool_name": "Bash", "tool_input": {"command": "ls -la /tmp"}}),
]


def run(payload):
    p = subprocess.run([sys.executable, "-S", HOOK], input=json.dumps(payload),
                       capture_output=True, text=True, timeout=30)
    return p.returncode


def main():
    tok = "/tmp/.claude-send-ok"
    if os.path.exists(tok):
        os.remove(tok)
    bad = 0
    print("MUST BLOCK (expected exit 2)")
    for name, payload in MUST_BLOCK:
        rc = run(payload)
        ok = rc == 2
        bad += not ok
        print(f"  {'ok ' if ok else 'FAIL'}  {name:20} exit={rc}")
    print("\nMUST PASS (expected exit 0)")
    for name, payload in MUST_PASS:
        rc = run(payload)
        ok = rc == 0
        bad += not ok
        print(f"  {'ok ' if ok else 'FAIL'}  {name:20} exit={rc}")
    print(f"\n{'ALL GOOD' if not bad else str(bad) + ' FAIL'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
