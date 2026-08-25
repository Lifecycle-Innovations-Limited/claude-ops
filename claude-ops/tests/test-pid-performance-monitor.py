#!/usr/bin/env python3
"""Regression tests for the shipped macOS PID pressure monitor."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
MONITOR_PATH = ROOT / "scripts" / "macos" / "pid-performance-monitor.py"
SPEC = importlib.util.spec_from_file_location("pid_performance_monitor", MONITOR_PATH)
assert SPEC and SPEC.loader
monitor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = monitor
SPEC.loader.exec_module(monitor)


def proc(
    pid: int,
    command: str,
    *,
    ppid: int = 1,
    cpu: float = 0.0,
    elapsed_s: int = 120,
    state: str = "S",
    nice: int = 0,
) -> monitor.Proc:
    return monitor.Proc(pid, ppid, cpu, 1024, elapsed_s, state, nice, command)


class PressureMonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.telemetry: list[dict] = []
        self.common = [
            mock.patch.object(monitor, "memory_free_pct", return_value=90),
            mock.patch.object(monitor, "swap_mb", return_value=0.0),
            mock.patch.object(monitor, "load_state", return_value={"rg": {}}),
            mock.patch.object(monitor, "append_telemetry", side_effect=self.telemetry.append),
            mock.patch.object(monitor.time, "sleep", return_value=None),
            mock.patch.object(monitor, "FEATURE_OFF", pathlib.Path("/path/that/does/not/exist")),
        ]
        for patcher in self.common:
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def recent_timestamp(seconds_ago: int = 1) -> str:
        return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def run_main(
        self,
        *,
        table: dict[int, monitor.Proc],
        cpu_samples: list[dict[str, float]],
        loads: list[float],
        argv: list[str] | None = None,
        prior_state: dict | None = None,
    ) -> dict:
        if prior_state is not None:
            state_patch = mock.patch.object(monitor, "load_state", return_value=prior_state)
            state_patch.start()
            self.addCleanup(state_patch.stop)
        with (
            mock.patch.object(sys, "argv", [str(MONITOR_PATH), *(argv or ["--dry-run"])]),
            mock.patch.object(monitor, "processes", side_effect=lambda: table),
            mock.patch.object(monitor, "cpu_sample", side_effect=cpu_samples),
            mock.patch.object(monitor, "load_averages", return_value=loads),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(0, monitor.main())
        self.assertTrue(self.telemetry)
        return self.telemetry[-1]

    def test_persistent_state_counts_ignore_one_frame_u(self) -> None:
        samples = [
            {1: proc(1, "one", state="U"), 2: proc(2, "two", state="U")},
            {1: proc(1, "one", state="S"), 2: proc(2, "two", state="U")},
            {1: proc(1, "one", state="R"), 2: proc(2, "two", state="U"), 3: proc(3, "three", state="Z")},
        ]
        self.assertEqual((1, 1, 1), monitor.persistent_state_counts(samples))

    def test_cpu_pressure_requires_all_three_low_idle_samples(self) -> None:
        record = self.run_main(
            table={},
            cpu_samples=[
                {"user": 70.0, "sys": 10.0, "idle": 20.0},
                {"user": 20.0, "sys": 10.0, "idle": 70.0},
                {"user": 65.0, "sys": 10.0, "idle": 25.0},
            ],
            loads=[1.0, 1.0, 1.0],
        )
        self.assertFalse(record["pressure"])
        self.assertFalse(record["pressure_reasons"]["cpu"])

    def test_sustained_load_requires_both_load1_and_load5_over_threshold(self) -> None:
        high = monitor.NCPU * monitor.LOAD_PRESSURE_MULTIPLIER + 1
        normal_cpu = [{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3
        transient = self.run_main(table={}, cpu_samples=normal_cpu, loads=[high, 1.0, 1.0])
        self.assertFalse(transient["pressure"])
        sustained = self.run_main(table={}, cpu_samples=normal_cpu, loads=[high, high, 1.0])
        self.assertTrue(sustained["pressure"])
        self.assertTrue(sustained["pressure_reasons"]["sustained_load"])

    def test_broad_scan_requires_exact_command_root_and_hermes_ancestor(self) -> None:
        hermes = proc(10, "python -m hermes_cli.main gateway")
        broad = proc(20, f"rg --files --sortr=modified {monitor.HOME / 'Developer'}", ppid=10, cpu=20.0, state="U")
        narrow = proc(21, "rg --files --sortr=modified .", ppid=10, cpu=20.0, state="U")
        foreign = proc(22, f"rg --files --sortr=modified {monitor.HOME}", ppid=1, cpu=20.0, state="U")
        table = {p.pid: p for p in (hermes, broad, narrow, foreign)}
        first = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
        )
        self.assertEqual([], first["actions"])
        key = f"{broad.pid}:{broad.command}"
        repeated = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
            prior_state={"rg": {key: {"consecutive": 1, "last_seen": self.recent_timestamp()}}},
        )
        term_actions = [a for a in repeated["actions"] if a["type"] == "term_runaway_rg"]
        self.assertEqual([20], [a["pid"] for a in term_actions])
        self.assertEqual("would_terminate", term_actions[0]["result"])

    def test_protected_workloads_are_never_qos_or_termination_targets(self) -> None:
        table: dict[int, monitor.Proc] = {}
        pid = 100
        for pattern in monitor.PROTECTED_PATTERNS:
            table[pid] = proc(pid, f"/usr/bin/{pattern} pytest", cpu=90.0, state="U")
            pid += 1
        record = self.run_main(
            table=table,
            cpu_samples=[{"user": 80.0, "sys": 10.0, "idle": 10.0}] * 3,
            loads=[100.0, 100.0, 100.0],
        )
        self.assertEqual([], record["actions"])

    def test_xcode_simulator_and_healify_are_directly_protected(self) -> None:
        protected_commands = {
            301: "/usr/bin/xcodebuild -workspace Healify.xcworkspace build",
            302: "/usr/bin/swift-frontend -frontend -c Sources/App.swift",
            303: "/Applications/OrbStack.app/qemu-system-aarch64 -machine virt",
            304: "/Applications/HealifyAIHealthCoach.app/HealifyAIHealthCoach",
        }
        table = {pid: proc(pid, command, cpu=99.0, state="U") for pid, command in protected_commands.items()}
        for p in table.values():
            self.assertTrue(monitor.protected(p), p.command)
            self.assertFalse(monitor.qos_candidate(p), p.command)
        record = self.run_main(
            table=table,
            cpu_samples=[{"user": 80.0, "sys": 10.0, "idle": 10.0}] * 3,
            loads=[100.0, 100.0, 100.0],
        )
        self.assertEqual([], record["actions"])

    def test_qos_candidate_rejects_wrappers_and_installers(self) -> None:
        self.assertFalse(monitor.qos_candidate(proc(1, '/bin/zsh -c "python -m pytest tests"')))
        self.assertFalse(monitor.qos_candidate(proc(2, "/opt/homebrew/bin/pip install -q ruff pytest")))
        self.assertTrue(monitor.qos_candidate(proc(3, "/opt/homebrew/bin/pytest tests")))
        self.assertTrue(monitor.qos_candidate(proc(4, "/opt/homebrew/bin/python3 -m pytest tests")))
        self.assertTrue(monitor.qos_candidate(proc(5, "/repo/node_modules/jest-worker/build/workers/processChild.js")))

    def test_pressure_qos_actions_exclude_payload_substring_false_positives(self) -> None:
        table = {
            201: proc(201, '/bin/zsh -c "python -m pytest tests"', cpu=80.0),
            202: proc(202, "/opt/homebrew/bin/pip install -q ruff pytest", cpu=80.0),
            203: proc(203, "/opt/homebrew/bin/pytest tests", cpu=80.0),
        }
        record = self.run_main(
            table=table,
            cpu_samples=[{"user": 80.0, "sys": 10.0, "idle": 10.0}] * 3,
            loads=[100.0, 100.0, 100.0],
        )
        qos_pids = [action["pid"] for action in record["actions"] if action["type"] == "qos_background"]
        self.assertEqual([203], qos_pids)

    def test_repeated_broad_scan_is_required_when_not_blocked(self) -> None:
        hermes = proc(10, "python -m hermes_cli.main gateway")
        broad = proc(20, f"rg --files --sortr=modified {monitor.HOME}", ppid=10, cpu=20.0, state="R")
        table = {10: hermes, 20: broad}
        key = f"{broad.pid}:{broad.command}"
        first = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
        )
        self.assertEqual([], first["actions"])
        second = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
            prior_state={"rg": {key: {"consecutive": 1, "last_seen": self.recent_timestamp()}}},
        )
        term_actions = [a for a in second["actions"] if a["type"] == "term_runaway_rg"]
        self.assertEqual([20], [a["pid"] for a in term_actions])

    def test_stale_broad_scan_observation_does_not_count_as_consecutive(self) -> None:
        hermes = proc(10, "python -m hermes_cli.main gateway")
        broad = proc(20, f"rg --files --sortr=modified {monitor.HOME}", ppid=10, cpu=20.0, state="R")
        table = {10: hermes, 20: broad}
        key = f"{broad.pid}:{broad.command}"
        stale_timestamp = self.recent_timestamp(monitor.RG_OBSERVATION_MAX_GAP_S + 30)
        record = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
            prior_state={"rg": {key: {"consecutive": 99, "last_seen": stale_timestamp}}},
        )
        self.assertEqual([], record["actions"])

    def test_missing_or_invalid_timestamp_does_not_count_as_consecutive(self) -> None:
        now = datetime.now(timezone.utc)
        self.assertFalse(monitor.prior_observation_is_recent({"consecutive": 1}, now))
        self.assertFalse(monitor.prior_observation_is_recent({"last_seen": "not-a-time"}, now))
        self.assertFalse(monitor.prior_observation_is_recent({"last_seen": "2000-01-01T00:00:00Z"}, now))


if __name__ == "__main__":
    unittest.main(verbosity=2)
