#!/usr/bin/env python3
"""Regression tests for the shipped macOS PID pressure monitor."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import sys
import unittest
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
            mock.patch.object(monitor, "processes", return_value=table),
            mock.patch.object(monitor, "cpu_sample", side_effect=cpu_samples),
            mock.patch.object(monitor, "load_averages", return_value=loads),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(0, monitor.main())
        self.assertTrue(self.telemetry)
        return self.telemetry[-1]

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
        record = self.run_main(
            table=table,
            cpu_samples=[{"user": 10.0, "sys": 5.0, "idle": 85.0}] * 3,
            loads=[1.0, 1.0, 1.0],
        )
        term_actions = [a for a in record["actions"] if a["type"] == "term_runaway_rg"]
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
            prior_state={"rg": {key: {"consecutive": 1}}},
        )
        term_actions = [a for a in second["actions"] if a["type"] == "term_runaway_rg"]
        self.assertEqual([20], [a["pid"] for a in term_actions])


if __name__ == "__main__":
    unittest.main(verbosity=2)
