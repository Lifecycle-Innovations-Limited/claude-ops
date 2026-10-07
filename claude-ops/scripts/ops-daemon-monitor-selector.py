#!/usr/bin/env python3
"""Select only the operator-pinned monitor; invalid mode state never runs legacy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

FILES = ("ops-daemon.sh", "ops-daemon-monitor.py")


def validate(data):
    manifest = data / "daemon-monitor.json"
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError("missing or symlinked mode manifest")
    with manifest.open("rb") as stream:
        raw = stream.read(16385)
    if len(raw) > 16384:
        raise ValueError("mode manifest too large")
    config = json.loads(raw)
    if not isinstance(config, dict) or set(config) != {"mode", "runtime", "sha256"}:
        raise ValueError("invalid mode fields")
    if config["mode"] != "monitor_only" or not isinstance(config["runtime"], str):
        raise ValueError("invalid mode")
    runtime = Path(config["runtime"]).resolve(strict=True)
    runtime.relative_to(data / "runtime")
    if runtime == data / "runtime" or not runtime.is_dir():
        raise ValueError("invalid runtime directory")
    pins = config["sha256"]
    if not isinstance(pins, dict) or set(pins) != set(FILES):
        raise ValueError("invalid file pins")
    for name in FILES:
        path = runtime / name
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError("invalid pinned file")
        if not isinstance(pins[name], str) or not re.fullmatch(r"[0-9a-f]{64}", pins[name]):
            raise ValueError("invalid hash pin")
        with path.open("rb") as stream:
            raw = stream.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != pins[name]:
            raise ValueError("pinned file changed")
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--monitor-only", action="store_true")
    parser.add_argument("--run-once", action="store_true")
    args = parser.parse_args()
    if args.validate and (args.monitor_only or args.run_once):
        parser.error("--validate cannot be combined with execution flags")
    data = Path(os.environ.get("OPS_DATA_DIR") or Path.home() / ".claude/plugins/data/ops-ops-marketplace").resolve()
    try:
        runtime = validate(data)
    except (OSError, ValueError, TypeError):
        parser.exit(78, "Invalid monitor-only contract; legacy execution refused.\n")
    if args.validate:
        return
    bash = next((path for path in ("/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash")
                 if os.path.isfile(path) and os.access(path, os.X_OK)), None)
    if bash is None:
        parser.exit(78, "No fixed Bash executable found; legacy execution refused.\n")
    os.environ["OPS_DATA_DIR"] = str(data)
    argv = [bash, str(runtime / "ops-daemon.sh"), "--monitor-only"]
    if args.run_once:
        argv.append("--run-once")
    os.execv(bash, argv)


if __name__ == "__main__":
    main()
