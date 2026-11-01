#!/usr/bin/env python3
"""Portable lock + counter transaction for bin/ops-task-reminder.

Used where flock(1) is missing (macOS). It takes a real fcntl.flock() on the
same "<state_file>.flock" inode the flock(1) branch uses, so the two interoperate
on a box that has both. The whole read-increment-write (or reset) happens here
while the lock is held; the lock is the open file description, so the kernel
drops it when this process exits or is killed. The lock file is never renamed,
truncated or unlinked, so there is no pathname to race on.

Usage: task-reminder-lock.py <state_file> <threshold> <lock_timeout_s> <tool> <is_agent 0|1>

Exit status is always 0 (fail-open): a lock that is not taken within the
deadline means a missed count and no output. Unexpected errors are reported on
stderr, never swallowed silently.
"""
import fcntl
import os
import sys
import time

MAX_TIMEOUT_S = 600.0


def parse_float(raw, default):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return min(max(value, 0.0), MAX_TIMEOUT_S)


def acquire(lock_path, timeout_s):
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.05)


def write_state(path, text):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w") as handle:
        handle.write(text)
    os.replace(tmp, path)


def reminder_json(threshold):
    return """{
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[ops-task-reminder] No Task* tool used in the last %d calls. For multi-step work, consider TaskCreate to track open items, TaskUpdate to mark progress, TaskList to review status. Skip this reminder if your current work is a single quick action."
  }
}
""" % threshold


def main(argv):
    if len(argv) != 6:
        sys.stderr.write("ops-task-reminder: bad helper arguments\n")
        return 0
    state_file, raw_threshold, raw_timeout, tool, is_agent = argv[1:6]
    try:
        threshold = int(raw_threshold)
    except ValueError:
        threshold = 10
    timeout_s = parse_float(raw_timeout, 2.0)

    fd = acquire(state_file + ".flock", timeout_s)
    if fd is None:
        return 0  # fail-open: a missed count is cheaper than a stuck hook

    # Namespaced names such as "mcp__<server>__TaskUpdate": only the segment
    # after the last "__" counts.
    if tool.rpartition("__")[2].startswith("Task"):
        write_state(state_file, "0\n")
        return 0

    try:
        with open(state_file) as handle:
            count = int(handle.read().strip() or 0)
    except (OSError, ValueError):
        count = 0
    count += 1

    if count >= threshold:
        write_state(state_file, "0\n")
        if is_agent != "1":
            sys.stdout.write(reminder_json(threshold))
    else:
        write_state(state_file, "%d\n" % count)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # noqa: BLE001 - fail-open, but never silent
        sys.stderr.write("ops-task-reminder: lock helper failed: %s\n" % error)
        sys.exit(0)
