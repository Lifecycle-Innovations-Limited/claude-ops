#!/usr/bin/env python3
"""Passive daemon observations only: never execute configured commands or helpers."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import signal
import tempfile
import time

MAX_SNAPSHOT_BYTES = 1024 * 1024
INTERVAL_SECONDS = 30


def read_snapshot(path):
    with path.open("rb") as stream:
        raw = stream.read(MAX_SNAPSHOT_BYTES + 1)
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot too large")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("snapshot must be an object")
    return data


def observe_pid(pid):
    if type(pid) is not int or pid <= 1 or pid == os.getpid():
        return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return None


def write_health(data_dir, started):
    config_error = None
    try:
        config = read_snapshot(data_dir / "daemon-services.json")
        services = config.get("services")
        if not isinstance(services, dict) or len(services) > 256:
            raise ValueError("invalid services map")
        if any(not isinstance(value, dict) for value in services.values()):
            raise ValueError("invalid service entry")
        if any(type(value.get("enabled", False)) is not bool for value in services.values()):
            raise ValueError("invalid enabled flag")
    except (OSError, ValueError):
        services = {}
        config_error = {"kind": "config_error", "message": "Services configuration is missing or invalid."}

    try:
        prior = read_snapshot(data_dir / "daemon-health.json").get("services", {})
        if not isinstance(prior, dict):
            prior = {}
    except (OSError, ValueError):
        prior = {}

    observations = {}
    for name, config in services.items():
        if config.get("enabled") is not True:
            continue
        old = prior.get(name, {})
        old = old if isinstance(old, dict) else {}
        observation = old.get("observation", {})
        observation = observation if isinstance(observation, dict) else {}
        pid = observation.get("pid", old.get("pid"))
        alive = observe_pid(pid)
        observations[name] = {
            "status": "not_started_monitor_only",
            "pid": None,
            "last_health": "unknown",
            "reason": "Configured commands, health commands and cron jobs are not executed.",
            "observation": {
                "pid": pid if type(pid) is int and pid > 1 else None,
                "pid_alive": alive,
                "identity_verified": False,
                "source": "previous_daemon_health",
            },
        }

    health = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pid": os.getpid(),
        "uptime_seconds": int(time.monotonic() - started),
        "mode": "monitor_only",
        "actions_enabled": False,
        "services": observations,
        "action_needed": config_error,
    }
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".daemon-monitor-", dir=data_dir)
        with os.fdopen(fd, "w") as stream:
            json.dump(health, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, data_dir / "daemon-health.json")
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--monitor-only", action="store_true", required=True)
    parser.add_argument("--run-once", action="store_true")
    args = parser.parse_args()
    data_dir = Path(os.environ.get("OPS_DATA_DIR") or Path.home() / ".claude/plugins/data/ops-ops-marketplace")
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    health_path = data_dir / "daemon-health.json"
    if health_path.is_symlink():
        parser.exit(78, "Monitor-only refuses a symlinked health file.\n")
    try:
        lock_fd = os.open(data_dir / ".daemon-monitor.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        parser.exit(78, "Monitor-only could not acquire its exclusive writer lock.\n")
    try:
        previous = read_snapshot(health_path)
        previous_pid = previous.get("pid")
        if type(previous_pid) is int and previous_pid > 1 and observe_pid(previous_pid) is not False:
            parser.exit(78, "An existing daemon may still be running; health file left unchanged.\n")
    except FileNotFoundError:
        pass
    except ValueError:
        pass
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    while not stopped:
        write_health(data_dir, started)
        if args.run_once:
            break
        # Short local waits keep shutdown responsive without spawning a helper.
        for _ in range(INTERVAL_SECONDS):
            if stopped:
                break
            time.sleep(1)


if __name__ == "__main__":
    main()
