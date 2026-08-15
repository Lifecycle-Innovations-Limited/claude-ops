#!/usr/bin/env python3
"""The guard must not fire on text that merely names a send command.

A pattern that matches any mention blocks commit messages, documentation and audit
scripts. That happened on the first version of the drafts-send rule: writing the phrase
in a commit message was enough to block `git commit`. A guard that cries wolf gets
worked around, which is worse than the gap it was closing.

Run: python3 claude-ops/tests/outbound-guard/test-false-positives.py
"""
import json
import os
import subprocess
import sys

HOOK = os.environ.get(
    "OUTBOUND_HOOK",
    os.path.expanduser("~/.claude/scripts/hooks/block-outbound-comms.py"),
)
G = "gog gmail"

# Prose and tooling that names a send command without invoking one.
MUST_PASS = [
    ("commit message", f'git commit -m "fix: also catch {G} drafts send (plural)"'),
    ("grep for the pattern", f"grep -rn '{G} send' ~/.claude/scripts"),
    ("shell comment", f"# {G} send --to a@b.com --body hi  (example only)"),
    ("echo of the command", f"echo 'run {G} drafts send <id> to flush a draft'"),
]

# Known limitation, asserted so it cannot regress silently in the unsafe direction.
# A heredoc body carrying a full send command with flags is still blocked. Detecting
# heredoc bodies reliably means parsing shell, and the failure is fail-safe: it blocks
# something harmless rather than allowing something real. Write such docs to a file
# with the Write tool instead of a heredoc, or split the flags across lines.
KNOWN_BLOCKED = [
    ("docs heredoc", f"cat > README.md <<'EOF'\nUse {G} send --to x to send mail\nEOF"),
]

# Still has to block: a genuine invocation with a real draft id.
MUST_BLOCK = [
    ("real drafts send", f"{G} drafts send r2782687644185019208"),
    ("real draft send", f"{G} draft send r2782687644185019208"),
]


def run(cmd):
    payload = {"tool_name": "Bash", "tool_input": {"command": cmd}}
    p = subprocess.run([sys.executable, "-S", HOOK], input=json.dumps(payload),
                       capture_output=True, text=True, timeout=30)
    return p.returncode


def main():
    tok = "/tmp/.claude-send-ok"
    if os.path.exists(tok):
        os.remove(tok)
    bad = 0
    print("MUST PASS (naming a command is not invoking one)")
    for name, cmd in MUST_PASS:
        rc = run(cmd)
        ok = rc == 0
        bad += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name:24} exit={rc}")
    print("\nMUST BLOCK (a real invocation)")
    for name, cmd in MUST_BLOCK:
        rc = run(cmd)
        ok = rc == 2
        bad += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {name:24} exit={rc}")
    print("\nKNOWN LIMITATION (blocked today, fail-safe direction)")
    for name, cmd in KNOWN_BLOCKED:
        rc = run(cmd)
        ok = rc == 2
        bad += not ok
        note = "still blocked, as documented" if ok else "now passes, update the docs"
        print(f"  {'ok  ' if ok else 'FAIL'} {name:24} exit={rc}  ({note})")
    print(f"\n{'ALL GOOD' if not bad else str(bad) + ' FAIL'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
