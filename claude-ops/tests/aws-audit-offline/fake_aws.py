#!/usr/bin/env python3
"""Offline synthetic AWS stub. Never contacts AWS. Not account evidence.

Invoked as argv: aws <service> <operation> ...
Stdout and stderr are the canned payload. The process exit code is the canned code.
"""
import json
import os
import sys

FIXTURE = os.environ["AWS_AUDIT_FIXTURE"]


def load():
    with open(FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


def match(spec, argv):
    if spec.get("argv") and argv != spec["argv"]:
        return False
    for part in spec.get("contains", []):
        if part not in argv:
            return False
    for part in spec.get("excludes", []):
        if part in argv:
            return False
    return True


def page_of(spec, argv):
    pages = spec.get("pages")
    if not pages:
        return spec
    token = None
    if "--starting-token" in argv:
        token = argv[argv.index("--starting-token") + 1]
    for page in pages:
        if page.get("token") == token:
            return page
    return {"exit": 1, "stdout": "", "stderr": "fixture: unknown page token\n"}


def main():
    argv = sys.argv[1:]
    log_path = os.environ.get("AWS_AUDIT_CALL_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")
    fixture = load()
    best = None
    best_key = (-1, -1)
    for spec in fixture.get("calls", []):
        if match(spec, argv):
            contains = spec.get("contains") or []
            key = (len(json.dumps(contains)), len(contains))
            if key > best_key:
                best, best_key = spec, key
    if best is not None:
        chosen = page_of(best, argv)
        sys.stdout.write(chosen.get("stdout", best.get("stdout", "")))
        sys.stderr.write(chosen.get("stderr", best.get("stderr", "")))
        return int(chosen.get("exit", best.get("exit", 0)))
    sys.stderr.write("fixture: unmatched aws argv: %s\n" % " ".join(argv))
    return 1


if __name__ == "__main__":
    sys.exit(main())
