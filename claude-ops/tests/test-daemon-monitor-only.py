#!/usr/bin/env python3
"""Exercise the real daemon entrypoint without permitting external actions."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get("TEST_BASH") or next(
    (str(path) for path in (Path("/opt/homebrew/bin/bash"), Path("/usr/local/bin/bash")) if path.exists()),
    shutil.which("bash"),
)


class MonitorOnlyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.data = self.base / "data"
        self.data.mkdir()
        self.plugin = self.base / "plugin"
        (self.plugin / "scripts").mkdir(parents=True)
        shutil.copy2(ROOT / "scripts/ops-daemon.sh", self.plugin / "scripts")
        helper = ROOT / "scripts/ops-daemon-monitor.py"
        if helper.exists():
            shutil.copy2(helper, self.plugin / "scripts")
        (self.plugin / "lib").mkdir()
        self.marker = self.base / "forbidden"
        # Sourcing a legacy helper or executing any service command is forbidden.
        (self.plugin / "lib/os-detect.sh").write_text(
            'echo sourced >> "$FORBIDDEN_MARKER"; exit 91\n'
        )
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("curl", "aws", "doppler", "dcli", "claude", "launchctl", "osascript", "gog", "eval"):
            path = self.bin / name
            path.write_text('#!/bin/sh\necho forbidden >> "$FORBIDDEN_MARKER"\nexit 92\n')
            path.chmod(0o755)
        command = f'touch "{self.marker}"'
        self.config = {"services": {
            "unsafe-cron": {"enabled": True, "cron": "* * * * *", "command": command, "health_check": command},
            "unsafe-persistent": {"enabled": True, "command": command},
            "disabled": {"enabled": False, "command": command},
        }}
        self.config_path = self.data / "daemon-services.json"
        self.config_path.write_text(json.dumps(self.config))
        self.env = {**os.environ, "HOME": str(self.home), "OPS_DATA_DIR": str(self.data),
                    "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "CLAUDE_PLUGIN_ROOT": str(self.plugin), "FORBIDDEN_MARKER": str(self.marker)}
        self.entry = self.plugin / "scripts/ops-daemon.sh"

    def run_once(self, *args):
        return subprocess.run([BASH, str(self.entry), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def health(self):
        return json.loads((self.data / "daemon-health.json").read_text())

    def test_real_entrypoint_blocks_commands_helpers_and_inherent_actions(self):
        result = self.run_once("--monitor-only", "--run-once")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.health()
        self.assertEqual(report["mode"], "monitor_only")
        self.assertFalse(report["actions_enabled"])
        self.assertEqual(set(report["services"]), {"unsafe-cron", "unsafe-persistent"})
        self.assertEqual(report["services"]["unsafe-cron"]["status"], "not_started_monitor_only")
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.data / "logs").exists())
        self.assertFalse((self.data / "cache").exists())
        self.assertEqual(json.loads(self.config_path.read_text()), self.config)
        self.assertEqual(set(self.data.iterdir()), {self.config_path, self.data / "daemon-health.json", self.data / ".daemon-monitor.lock"})

    def test_monitor_flag_order_cannot_execute_install_or_other_legacy_mode(self):
        for args in (("--install", "--monitor-only"), ("--monitor-only", "--uninstall"),
                     ("--monitor-only", "--os"), ("--monitor-only", "--unknown")):
            result = self.run_once(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.marker.exists())
            self.assertFalse((self.data / "daemon-health.json").exists())

    def test_passive_liveness_is_not_a_vendor_or_service_health_claim(self):
        previous = {"services": {"unsafe-persistent": {"pid": os.getpid()}}}
        (self.data / "daemon-health.json").write_text(json.dumps(previous))
        result = self.run_once("--run-once", "--monitor-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        service = self.health()["services"]["unsafe-persistent"]
        self.assertEqual(service["status"], "not_started_monitor_only")
        self.assertIsNone(service["pid"])
        self.assertEqual(service["observation"]["pid_alive"], True)
        self.assertEqual(service["observation"]["identity_verified"], False)
        self.assertFalse(self.marker.exists())

    def test_bad_or_missing_config_is_explicit_and_never_green(self):
        for value in (None, "{bad json", json.dumps({"services": []}),
                      json.dumps({"services": {"bad": {"enabled": "true"}}})):
            if value is None:
                self.config_path.unlink()
            else:
                self.config_path.write_text(value)
            result = self.run_once("--monitor-only", "--run-once")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = self.health()
            self.assertEqual(report["services"], {})
            self.assertIsNotNone(report["action_needed"])
            self.assertEqual(report["action_needed"]["kind"], "config_error")
            self.assertFalse(report["actions_enabled"])
            self.assertFalse(self.marker.exists())

    def test_health_symlink_is_rejected_without_overwriting_its_target(self):
        target = self.base / "protected"
        target.write_text("unchanged")
        (self.data / "daemon-health.json").symlink_to(target)
        result = self.run_once("--monitor-only", "--run-once")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertTrue((self.data / "daemon-health.json").is_symlink())
        self.assertFalse(self.marker.exists())

    def test_existing_live_daemon_health_is_not_overwritten(self):
        previous = {"pid": os.getpid(), "services": {}}
        path = self.data / "daemon-health.json"
        path.write_text(json.dumps(previous))
        result = self.run_once("--monitor-only", "--run-once")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(path.read_text()), previous)
        self.assertFalse(self.marker.exists())

    def test_existing_monitor_lock_prevents_a_second_writer(self):
        lock_path = self.data / ".daemon-monitor.lock"
        with lock_path.open("w") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_once("--monitor-only", "--run-once")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.data / "daemon-health.json").exists())
        self.assertFalse(self.marker.exists())

    def test_invalid_previous_health_stays_unknown_without_running_commands(self):
        (self.data / "daemon-health.json").write_text("{bad json")
        result = self.run_once("--monitor-only", "--run-once")
        self.assertEqual(result.returncode, 0, result.stderr)
        service = self.health()["services"]["unsafe-persistent"]
        self.assertIsNone(service["observation"]["pid_alive"])
        self.assertEqual(service["last_health"], "unknown")
        self.assertFalse(self.marker.exists())

    def test_symlink_entrypoint_resolves_only_the_canonical_helper(self):
        entry = self.base / "linked-daemon.sh"
        entry.symlink_to(self.entry)
        result = subprocess.run([BASH, str(entry), "--monitor-only", "--run-once"],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.health()["mode"], "monitor_only")
        self.assertFalse(self.marker.exists())

    def test_resident_mode_refreshes_and_sigterm_has_no_legacy_cleanup(self):
        process = subprocess.Popen([BASH, str(self.entry), "--monitor-only"], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if (self.data / "daemon-health.json").exists():
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.05)
            self.assertIsNone(process.poll())
            self.assertEqual(self.health()["pid"], process.pid)
            initial_timestamp = self.health()["timestamp"]
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline and self.health()["timestamp"] == initial_timestamp:
                time.sleep(0.1)
            self.assertNotEqual(self.health()["timestamp"], initial_timestamp)
            self.assertGreaterEqual(self.health()["uptime_seconds"], 30)
            self.assertFalse(self.marker.exists())
            process.terminate()
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertFalse(self.marker.exists())
            self.assertFalse((self.data / "cache").exists())
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
