#!/usr/bin/env python3
"""Persistent, PID-attributed macOS responsiveness monitor.

Default mode is safe apply: QoS-demote known background workloads during sustained
pressure and terminate only exact, repeatedly-observed Hermes-owned broad rg scans.
Use --dry-run for a side-effect-free decision report and --status for current health.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

HOME = pathlib.Path.home()
STATE_DIR = HOME / ".claude" / ".resource-monitor"
STATE_FILE = STATE_DIR / "pid-performance-state.json"
FEATURE_OFF = STATE_DIR / "pid-performance.off"
TELEMETRY = HOME / ".local" / "share" / "agent-logs" / "pid-performance.jsonl"
MAX_LOG_BYTES = 5 * 1024 * 1024
NCPU = os.cpu_count() or 8
BROAD_ROOTS = tuple(str(p) for p in (HOME, HOME / "Developer", HOME / "Developer" / "active", HOME / "Developer" / "scratch"))
RG_PREFIX = "rg --files --sortr=modified"
HERMES_MARKER = "hermes_cli.main gateway"
LOAD_PRESSURE_MULTIPLIER = 2.0
RG_OBSERVATION_MAX_GAP_S = 180
QOS_PATTERNS = (
    "gradle-daemon",
    "org.gradle.launcher.daemon",
    "eas-build-local",
    "expo export",
    "jest-worker",
    "pytest",
)
PROTECTED_PATTERNS = (
    "WindowServer", "kernel_task", "launchd", "loginwindow", "Finder.app",
    "Cursor.app", "Claude.app", "hermes_cli.main gateway", "tailscale",
    "OrbStack Helper", "Docker", "postgres", "dragonfly", "qdrant",
    "mcp-proxy", "gbrain serve", "coreaudiod", "Terminal.app", "Ghostty.app",
    "qemu-system-aarch64", "xcodebuild", "swift-frontend",
    "HealifyAIHealthCoach.app/HealifyAIHealthCoach",
)

@dataclass
class Proc:
    pid: int
    ppid: int
    cpu: float
    rss_kb: int
    elapsed_s: int
    state: str
    nice: int
    command: str


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(args: list[str], timeout: float = 10) -> str:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False).stdout


def elapsed_seconds(value: str) -> int:
    days = 0
    if "-" in value:
        day, value = value.split("-", 1)
        days = int(day)
    parts = [int(x) for x in value.split(":")]
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h, (m, s) = 0, parts
    else:
        h, m, s = 0, 0, parts[0]
    return days * 86400 + h * 3600 + m * 60 + s


def processes() -> dict[int, Proc]:
    out = run(["ps", "-Ao", "pid=,ppid=,pcpu=,rss=,etime=,state=,ni=,command="], 15)
    result: dict[int, Proc] = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) < 8:
            continue
        try:
            p = Proc(int(parts[0]), int(parts[1]), float(parts[2]), int(parts[3]),
                     elapsed_seconds(parts[4]), parts[5], int(parts[6]), parts[7])
            result[p.pid] = p
        except (ValueError, IndexError):
            continue
    return result


def cpu_sample() -> dict[str, float]:
    out = run(["top", "-l", "1", "-n", "0"], 15)
    match = re.search(r"CPU usage:\s*([0-9.]+)% user,\s*([0-9.]+)% sys,\s*([0-9.]+)% idle", out)
    if not match:
        return {"user": 0.0, "sys": 0.0, "idle": 0.0}
    return {"user": float(match.group(1)), "sys": float(match.group(2)), "idle": float(match.group(3))}


def memory_free_pct() -> int:
    out = run(["memory_pressure", "-Q"], 10)
    match = re.search(r"free percentage:\s*(\d+)%", out)
    return int(match.group(1)) if match else 0


def swap_mb() -> float:
    out = run(["sysctl", "-n", "vm.swapusage"], 5)
    match = re.search(r"used\s*=\s*([0-9.]+)M", out)
    return float(match.group(1)) if match else 0.0


def load_averages() -> list[float]:
    out = run(["sysctl", "-n", "vm.loadavg"], 5)
    return [float(x) for x in re.findall(r"[0-9.]+", out)[:3]] or [0.0, 0.0, 0.0]


def ancestor_chain(pid: int, table: dict[int, Proc], limit: int = 12) -> list[Proc]:
    chain: list[Proc] = []
    seen = set()
    current = table.get(pid)
    while current and current.ppid not in seen and len(chain) < limit:
        seen.add(current.pid)
        parent = table.get(current.ppid)
        if not parent:
            break
        chain.append(parent)
        current = parent
    return chain


def is_broad_rg(p: Proc) -> bool:
    first = p.command.split(None, 1)[0] if p.command else ""
    if pathlib.Path(first).name != "rg":
        return False
    if RG_PREFIX not in p.command:
        return False
    return any(re.search(rf"(?:^|\s){re.escape(root)}(?:\s|$)", p.command) for root in BROAD_ROOTS)


def is_hermes_owned(p: Proc, table: dict[int, Proc]) -> bool:
    return any(HERMES_MARKER in parent.command for parent in ancestor_chain(p.pid, table))


def protected(p: Proc) -> bool:
    return any(pattern.lower() in p.command.lower() for pattern in PROTECTED_PATTERNS)


def qos_candidate(p: Proc) -> bool:
    command = p.command.lower()
    first = command.split(None, 1)[0] if command else ""
    executable = pathlib.Path(first).name
    # Never classify a wrapper shell or installer from words in its payload.
    if executable in {"sh", "bash", "zsh", "fish", "env", "timeout", "pip", "pip3"}:
        return False
    if executable.startswith("pytest") or re.search(r"\bpython(?:[0-9.]*)?\s+-m\s+pytest\b", command):
        return True
    if "/jest-worker/" in command or "jest-worker/processchild" in command:
        return True
    return any(
        pattern.lower() in command
        for pattern in QOS_PATTERNS
        if pattern not in {"jest-worker", "pytest"}
    )


def parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def prior_observation_is_recent(prior: dict, now: datetime) -> bool:
    last_seen = parse_utc(prior.get("last_seen"))
    if last_seen is None:
        return False
    age = (now - last_seen).total_seconds()
    return 0 <= age <= RG_OBSERVATION_MAX_GAP_S


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {"rg": {}, "last_condition": "unknown", "last_action_ts": None}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    tmp.replace(STATE_FILE)


def append_telemetry(record: dict) -> None:
    TELEMETRY.parent.mkdir(parents=True, exist_ok=True)
    if TELEMETRY.exists() and TELEMETRY.stat().st_size > MAX_LOG_BYTES:
        rotated = TELEMETRY.with_suffix(".jsonl.1")
        rotated.unlink(missing_ok=True)
        TELEMETRY.replace(rotated)
    with TELEMETRY.open("a") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")


def taskpolicy_background(pid: int) -> bool:
    return subprocess.run(["taskpolicy", "-b", "-p", str(pid)], capture_output=True).returncode == 0


def renice_background(pid: int, current_nice: int) -> bool:
    if current_nice >= 10:
        return True
    return subprocess.run(["renice", "10", "-p", str(pid)], capture_output=True).returncode == 0


def health_score(cpu: dict[str, float], running: int, stuck: int, mem: int, swap: float) -> int:
    score = 100
    if cpu["idle"] < 20: score -= 25
    elif cpu["idle"] < 35: score -= 15
    elif cpu["idle"] < 60: score -= 5
    if running + stuck > NCPU * 2: score -= 15
    elif running + stuck > NCPU: score -= 7
    if stuck: score -= min(15, stuck * 5)
    if mem < 20: score -= 15
    elif mem < 40: score -= 5
    if swap > 1024: score -= 10
    return max(0, score)


def persistent_state_counts(samples: list[dict[int, Proc]]) -> tuple[int, int, int]:
    """Return latest runnable/zombie counts and same-PID U across all samples."""
    latest = samples[-1] if samples else {}
    running = sum(p.state.startswith("R") for p in latest.values())
    zombies = sum(p.state.startswith("Z") for p in latest.values())
    pid_sets = [
        {pid for pid, p in table.items() if p.state.startswith("U")}
        for table in samples
    ]
    stuck = len(set.intersection(*pid_sets)) if pid_sets else 0
    return running, stuck, zombies


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--force-pressure", action="store_true", help="test QoS decisions without fabricating PIDs")
    parser.add_argument("--rg-min-age", type=int, default=60, help=argparse.SUPPRESS)
    parser.add_argument("--rg-consecutive", type=int, default=2, help=argparse.SUPPRESS)
    args = parser.parse_args()

    table = processes()
    process_samples = [table]
    samples = [cpu_sample()]
    if not args.status:
        time.sleep(2)
        process_samples.append(processes())
        samples.append(cpu_sample())
        time.sleep(2)
        process_samples.append(processes())
        samples.append(cpu_sample())
        table = process_samples[-1]
    avg_cpu = {k: round(sum(s[k] for s in samples) / len(samples), 2) for k in samples[0]}
    running, stuck, zombies = persistent_state_counts(process_samples)
    mem = memory_free_pct()
    swap = swap_mb()
    loads = load_averages()
    # macOS load includes runnable tasks and tasks blocked in kernel I/O. A machine
    # can be overloaded while CPU remains partly idle, so sustained load must also
    # activate the safe guard. Requiring both load1 and load5 avoids reacting to a
    # single short spike.
    sustained_load = len(loads) >= 2 and loads[0] > NCPU * LOAD_PRESSURE_MULTIPLIER and loads[1] > NCPU * LOAD_PRESSURE_MULTIPLIER
    pressure = args.force_pressure or all(s["idle"] < 35 for s in samples) or sustained_load
    state = load_state()
    prior_rg = state.get("rg", {})
    current_rg: dict[str, dict] = {}
    actions: list[dict] = []
    observation_time = datetime.now(timezone.utc)
    observation_ts = observation_time.strftime("%Y-%m-%dT%H:%M:%SZ")

    for p in table.values():
        if not is_broad_rg(p) or not is_hermes_owned(p, table):
            continue
        key = f"{p.pid}:{p.command}"
        prior = prior_rg.get(key, {})
        prior_count = int(prior.get("consecutive", 0)) if prior_observation_is_recent(prior, observation_time) else 0
        consecutive = prior_count + 1
        current_rg[key] = {"consecutive": consecutive, "last_seen": observation_ts, "elapsed_s": p.elapsed_s, "state": p.state}
        # A one-frame U state is a normal filesystem wait on macOS, not enough
        # evidence to terminate work. Every TERM candidate must be observed in
        # monitor runs no more than RG_OBSERVATION_MAX_GAP_S apart; CPU, U state,
        # and system pressure only describe why the repeated scan is harmful.
        pathological = (
            p.elapsed_s >= args.rg_min_age
            and consecutive >= args.rg_consecutive
            and (p.cpu >= 10 or p.state.startswith("U") or pressure)
        )
        if pathological:
            decision = {"type": "term_runaway_rg", "pid": p.pid, "cpu": p.cpu, "elapsed_s": p.elapsed_s,
                        "state": p.state, "consecutive": consecutive, "command": p.command}
            if not args.dry_run and not args.status and not FEATURE_OFF.exists():
                # Re-read exact PID and command immediately before TERM to guard PID reuse.
                fresh_table = processes()
                fresh = fresh_table.get(p.pid)
                if fresh and fresh.command == p.command and is_broad_rg(fresh) and is_hermes_owned(fresh, fresh_table):
                    try:
                        os.kill(p.pid, signal.SIGTERM)
                        decision["result"] = "terminated"
                    except OSError as exc:
                        decision["result"] = f"failed:{exc.__class__.__name__}"
                else:
                    decision["result"] = "skipped_pid_changed"
            else:
                decision["result"] = "would_terminate"
            actions.append(decision)

    if pressure:
        for p in table.values():
            if protected(p) or not qos_candidate(p):
                continue
            decision = {"type": "qos_background", "pid": p.pid, "cpu": p.cpu, "nice_before": p.nice, "command": p.command}
            if not args.dry_run and not args.status and not FEATURE_OFF.exists():
                q = taskpolicy_background(p.pid)
                n = renice_background(p.pid, p.nice)
                decision["result"] = "applied" if q and n else "partial"
            else:
                decision["result"] = "would_apply"
            actions.append(decision)

    condition = "pressure" if pressure else "healthy"
    if not args.status and not args.dry_run:
        state.update({"rg": current_rg, "last_condition": condition, "last_run_ts": utc_now()})
        if actions:
            state["last_action_ts"] = utc_now()
        save_state(state)

    record = {"ts": utc_now(), "mode": "status" if args.status else "dry-run" if args.dry_run else "apply",
              "feature_off": FEATURE_OFF.exists(), "cpu": avg_cpu, "pressure": pressure,
              "pressure_reasons": {"cpu": all(s["idle"] < 35 for s in samples), "sustained_load": sustained_load},
              "load": loads, "mem_free_pct": mem, "swap_mb": swap,
              "running": running, "stuck": stuck, "zombies": zombies,
              "health_score": health_score(avg_cpu, running, stuck, mem, swap), "actions": actions}
    append_telemetry(record)
    print(json.dumps(record, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
