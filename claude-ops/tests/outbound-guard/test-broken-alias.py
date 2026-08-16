#!/usr/bin/env python3
"""A send from a misconfigured alias must be refused outright, not merely gated.

Approving such a send changes nothing: Gmail stamps it SENT and the mail bounces into
Trash, so the sender believes it arrived and the recipient never sees it. The guard
therefore blocks it even when an approval token is present, and says how to fix it.

The alias list normally comes from the machine's own state file. This test writes a
throwaway HOME so it runs the same way anywhere and never depends on real addresses.
"""
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, "..", "..", "scripts", "outbound-guard"))
HOOK = os.environ.get("OUTBOUND_HOOK", os.path.join(SRC, "block-outbound-comms.py"))
# The approval store sits at a fixed path shared by every guard, so a test that leaves
# credit in it changes the result of whichever suite runs next.
STATE_FILES = ("/tmp/.claude-outbound-guard.json", "/tmp/.claude-send-ok")
BROKEN = "broken@example.com"
HEALTHY = "fine@example.com"
G = "gog gmail"


def run(cmd, home):
    env = dict(os.environ, HOME=home)
    p = subprocess.run(
        [sys.executable, "-S", HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}),
        capture_output=True, text=True, timeout=30, env=env)
    return p.returncode, (p.stderr or "")


def disarm():
    """Drop any approval credit. Absent files are the state we are aiming for."""
    for p in STATE_FILES:
        with contextlib.suppress(FileNotFoundError):
            os.remove(p)


def arm(home):
    """Mint a real approval so the test proves the block outranks the token."""
    subprocess.run([sys.executable, os.path.join(SRC, "outbound_guard.py"),
                    "mint", "5", "900"],
                   capture_output=True, timeout=30, env=dict(os.environ, HOME=home))


def main() -> int:
    home = tempfile.mkdtemp(prefix="guardtest-")
    os.makedirs(os.path.join(home, ".claude", "state"), exist_ok=True)
    with open(os.path.join(home, ".claude", "state",
                           "broken-send-aliases.json"), "w") as f:
        json.dump({"aliases": {BROKEN: {"count": 3}}}, f)

    fail = 0
    try:
        disarm()

        arm(home)
        rc, err = run(f"{G} send --to x@y.com --from {BROKEN} --body hi", home)
        ok = rc == 2 and "misconfigured" in err
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} broken alias blocked despite approval (exit={rc})")

        ok = "Send mail as" in err
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} block message names the repair")

        arm(home)
        rc, _ = run(f"{G} send --to x@y.com --from {HEALTHY} --body hi", home)
        ok = rc == 0
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} healthy alias still allowed (exit={rc})")

        # No sender flag at all uses the account default, which cannot be broken this way.
        arm(home)
        rc, _ = run(f"{G} send --to x@y.com --body hi", home)
        ok = rc == 0
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} default sender unaffected (exit={rc})")

        # And it must still be refused when there is no approval at all.
        disarm()
        rc, _ = run(f"{G} send --to x@y.com --from {BROKEN} --body hi", home)
        ok = rc == 2
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} broken alias blocked without approval (exit={rc})")

        # A recipient on the approved list skips the token gate entirely. That
        # bypass must not also skip the alias check: the relay is what is broken,
        # so the mail bounces whoever it was addressed to, and a trusted recipient
        # is precisely where an unnoticed bounce does the most damage.
        with open(os.path.join(home, ".claude", "state",
                               "outbound-approvals.json"), "w") as f:
            json.dump({"approved_recipients": ["trusted@example.com"]}, f)
        rc, err = run(f"{G} send --to trusted@example.com --from {BROKEN} --body hi", home)
        ok = rc == 2 and "misconfigured" in err
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} approved recipient does not bypass the alias block (exit={rc})")

        # The same recipient on a healthy alias must still take the bypass, or the
        # check above would pass simply because approvals stopped working.
        rc, _ = run(f"{G} send --to trusted@example.com --from {HEALTHY} --body hi", home)
        ok = rc == 0
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} approved recipient still bypasses on a healthy alias (exit={rc})")

        os.remove(os.path.join(home, ".claude", "state", "outbound-approvals.json"))

        # An empty list must not block anything, or a machine that never ran the
        # refresh script would have every send refused.
        os.remove(os.path.join(home, ".claude", "state", "broken-send-aliases.json"))
        arm(home)
        rc, _ = run(f"{G} send --to x@y.com --from {BROKEN} --body hi", home)
        ok = rc == 0
        fail += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} no alias list means no extra blocking (exit={rc})")
    finally:
        shutil.rmtree(home, ignore_errors=True)
        # Leave the shared store empty, which is also the safe state.
        disarm()

    print(f"\n{'ALL GOOD' if not fail else str(fail) + ' FAIL'}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
