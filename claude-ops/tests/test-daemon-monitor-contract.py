#!/usr/bin/env python3
"""Run the real manager, selector and guard predicate against a private HOME."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get("TEST_BASH") or next(
    (str(path) for path in (Path("/opt/homebrew/bin/bash"), Path("/usr/local/bin/bash")) if path.exists()),
    shutil.which("bash"),
)


class MonitorContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / "home"
        self.data = self.home / ".claude/plugins/data/ops-ops-marketplace"
        self.runtime = self.data / "runtime/reviewed"
        self.runtime.mkdir(parents=True)
        self.bin = self.data / "bin"
        self.bin.mkdir()
        self.sentinel = self.base / "forbidden"
        self.selector = self.bin / "ops-daemon-monitor-selector.py"
        candidate = ROOT / "scripts/ops-daemon-monitor-selector.py"
        if candidate.exists():
            shutil.copy2(candidate, self.selector)
        self.wrapper = self.bin / "ops-daemon.sh"
        prefix_path = ROOT / "scripts/ops-daemon-monitor-prefix.sh"
        prefix = prefix_path.read_text() if prefix_path.exists() else (
            '#!/usr/bin/env bash\n'
            'if [[ -e "$OPS_DATA_DIR/daemon-monitor.json" || -L "$OPS_DATA_DIR/daemon-monitor.json" || "${1:-}" == "--monitor-only" ]]; then\n'
            '  exec python3 -I "$OPS_DATA_DIR/bin/ops-daemon-monitor-selector.py" "$@"\n'
            'fi\n'
        )
        self.wrapper.write_text(prefix + 'echo legacy >> "$FORBIDDEN_MARKER"\nexit 93\n')
        self.wrapper.chmod(0o755)
        for name in ("ops-daemon.sh", "ops-daemon-monitor.py"):
            shutil.copy2(ROOT / "scripts" / name, self.runtime / name)
        self.manifest = {"mode": "monitor_only", "runtime": str(self.runtime), "sha256": {
            name: hashlib.sha256((self.runtime / name).read_bytes()).hexdigest()
            for name in ("ops-daemon.sh", "ops-daemon-monitor.py")}}
        self.manifest_path = self.data / "daemon-monitor.json"
        self.save_manifest()
        (self.data / "daemon-services.json").write_text(json.dumps({"services": {
            "unsafe": {"enabled": True, "command": f'touch "{self.sentinel}"'}}}))
        self.plist_path = self.home / "Library/LaunchAgents/com.claude-ops.daemon.plist"
        self.plist_path.parent.mkdir(parents=True)
        self.fakebin = self.base / "fakebin"
        self.fakebin.mkdir()
        for name, body in {
            "uname": 'printf "Darwin\\n"',
            "sleep": ':',
            "launchctl": 'printf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"; exit 0',
        }.items():
            path = self.fakebin / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        self.plugin = self.base / "plugin"
        (self.plugin / "scripts").mkdir(parents=True)
        (self.plugin / "bin").mkdir()
        for name in ("ops-daemon-manager.sh", "com.claude-ops.daemon.plist", "ops-daemon-launcher.sh",
                     "ops-daemon-monitor-prefix.sh"):
            source = ROOT / "scripts" / name
            if name == "ops-daemon-manager.sh" and os.environ.get("OPS_DAEMON_MANAGER_SOURCE"):
                source = Path(os.environ["OPS_DAEMON_MANAGER_SOURCE"])
            shutil.copy2(source, self.plugin / "scripts" / name)
        if candidate.exists():
            shutil.copy2(candidate, self.plugin / "scripts" / candidate.name)
        (self.plugin / "scripts/ops-daemon.sh").write_text('#!/bin/sh\necho legacy >> "$FORBIDDEN_MARKER"\n')
        migration = self.plugin / "bin/ops-post-update-migrate"
        migration.write_text('#!/bin/sh\necho migration >> "$FORBIDDEN_MARKER"\n')
        migration.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home), "OPS_DATA_DIR": str(self.data),
                    "CLAUDE_PLUGIN_ROOT": str(self.plugin), "FORBIDDEN_MARKER": str(self.sentinel),
                    "LAUNCHCTL_LOG": str(self.base / "launchctl.log"),
                    "PATH": str(self.fakebin) + os.pathsep + os.environ["PATH"]}
        self.write_plist([BASH, str(self.wrapper), "--monitor-only"])

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def write_plist(self, args, env=None):
        # Mirrors mac_generate_plist: monitor mode always carries OPS_DATA_DIR.
        plist = {"Label": "com.claude-ops.daemon", "ProgramArguments": args,
                 "EnvironmentVariables": {"OPS_DATA_DIR": str(self.data)} if env is None else env}
        self.plist_path.write_bytes(plistlib.dumps(plist))

    def run_manager(self, command):
        return subprocess.run([BASH, str(self.plugin / "scripts/ops-daemon-manager.sh"), command],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def run_wrapper(self, *args):
        return subprocess.run([BASH, str(self.wrapper), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def test_upgrade_preserves_monitor_args_and_existing_guard_does_not_rewrite(self):
        result = self.run_manager("upgrade")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = plistlib.loads(self.plist_path.read_bytes())
        self.assertEqual(data["ProgramArguments"], [BASH, str(self.wrapper), "--monitor-only"])
        # Actual unchanged guard predicate: it returns before rewriting or bootstrapping.
        args = list(data.get("ProgramArguments") or [])
        unchanged_guard_matches = len(args) >= 2 and os.path.realpath(args[1]) == os.path.realpath(self.wrapper)
        self.assertTrue(unchanged_guard_matches)
        self.assertFalse(self.sentinel.exists())

    def test_ensure_current_skips_migrations_and_preserves_mode(self):
        before = self.plist_path.read_bytes()
        result = self.run_manager("ensure-current")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.plist_path.read_bytes(), before)
        self.assertFalse(self.sentinel.exists())

    def test_ensure_current_repairs_a_guard_rewrite_without_losing_mode(self):
        self.write_plist([BASH, str(self.wrapper)])
        result = self.run_manager("ensure-current")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = plistlib.loads(self.plist_path.read_bytes())["ProgramArguments"]
        self.assertEqual(args, [BASH, str(self.wrapper), "--monitor-only"])
        self.assertFalse(self.sentinel.exists())

    def test_ensure_current_rejects_wrong_interpreter_or_data_dir(self):
        expected_args = [BASH, str(self.wrapper), "--monitor-only"]
        stale = {
            "wrong interpreter": ([ "/bin/false", str(self.wrapper), "--monitor-only"], None),
            "injected data dir": (expected_args, {"OPS_DATA_DIR": str(self.base / "other-data")}),
            "missing data dir": (expected_args, {}),
        }
        for name, (args, env) in stale.items():
            with self.subTest(stale=name):
                self.write_plist(args, env)
                result = self.run_manager("ensure-current")
                self.assertEqual(result.returncode, 0, result.stderr)
                plist = plistlib.loads(self.plist_path.read_bytes())
                self.assertEqual(plist["ProgramArguments"], expected_args)
                self.assertEqual(plist["EnvironmentVariables"]["OPS_DATA_DIR"], str(self.data))
                self.assertFalse(self.sentinel.exists())

    def test_restart_never_bootstraps_a_legacy_plist_when_mode_is_pinned(self):
        self.write_plist([BASH, str(self.plugin / "scripts/ops-daemon.sh")])
        result = self.run_manager("restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = plistlib.loads(self.plist_path.read_bytes())["ProgramArguments"]
        self.assertEqual(args, [BASH, str(self.wrapper), "--monitor-only"])
        self.assertFalse(self.sentinel.exists())

    def test_status_recognizes_the_current_monitor_contract(self):
        result = self.run_manager("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["plist_version_match"])
        self.assertFalse(self.sentinel.exists())

    def test_wrapper_without_flag_still_enters_only_pinned_monitor(self):
        result = self.run_wrapper("--run-once")
        self.assertEqual(result.returncode, 0, result.stderr)
        health = json.loads((self.data / "daemon-health.json").read_text())
        self.assertEqual(health["mode"], "monitor_only")
        self.assertFalse(health["actions_enabled"])
        self.assertFalse(self.sentinel.exists())

    def test_invalid_manifest_and_pin_fail_before_manager_mutations_or_legacy(self):
        for mutation in ("bad_json", "wrong_mode", "wrong_hash", "outside_runtime"):
            self.save_manifest()
            if mutation == "bad_json":
                self.manifest_path.write_text("{bad json")
            else:
                d = dict(self.manifest)
                if mutation == "wrong_mode":
                    d["mode"] = "legacy"
                elif mutation == "wrong_hash":
                    d["sha256"] = {**d["sha256"], "ops-daemon.sh": "0" * 64}
                else:
                    d["runtime"] = str(self.plugin / "scripts")
                self.manifest_path.write_text(json.dumps(d))
            self.assertNotEqual(self.run_wrapper("--run-once").returncode, 0)
            self.assertNotEqual(self.run_manager("upgrade").returncode, 0)
            self.assertFalse(self.sentinel.exists())
            self.assertFalse((self.base / "launchctl.log").exists())

    def test_explicit_monitor_flag_missing_manifest_never_falls_through(self):
        self.manifest_path.unlink()
        self.assertNotEqual(self.run_wrapper("--monitor-only", "--run-once").returncode, 0)
        self.assertFalse(self.sentinel.exists())

    def test_missing_manifest_without_a_flag_never_falls_through_the_pinned_wrapper(self):
        self.manifest_path.unlink()
        self.assertNotEqual(self.run_wrapper("--run-once").returncode, 0)
        self.assertFalse(self.sentinel.exists())

    def test_tampered_selector_or_wrapper_is_never_enabled(self):
        original_selector = self.selector.read_bytes()
        original_wrapper = self.wrapper.read_bytes()
        for target, payload in ((self.selector, original_selector + b"\n# edited\n"),
                                (self.wrapper, b'#!/usr/bin/env bash\necho legacy >> "$FORBIDDEN_MARKER"\n' + original_wrapper)):
            self.selector.write_bytes(original_selector)
            self.wrapper.write_bytes(original_wrapper)
            target.write_bytes(payload)
            for command in ("upgrade", "ensure-current", "restart"):
                result = self.run_manager(command)
                self.assertEqual(result.returncode, 78, (target.name, command, result.stderr))
                self.assertIn("reviewed bytes", result.stderr)
            self.assertFalse((self.base / "launchctl.log").exists())
            self.assertFalse(self.sentinel.exists())
        self.selector.write_bytes(original_selector)
        self.wrapper.write_bytes(original_wrapper)
        self.assertEqual(self.run_manager("ensure-current").returncode, 0)

    def test_missing_manifest_with_installed_selector_blocks_manager_upgrade(self):
        self.manifest_path.unlink()
        self.assertNotEqual(self.run_manager("upgrade").returncode, 0)
        self.assertFalse((self.base / "launchctl.log").exists())
        self.assertFalse(self.sentinel.exists())

    def test_non_macos_manager_refuses_mode_before_any_service_effect(self):
        (self.fakebin / "uname").write_text('#!/bin/sh\nprintf "Linux\\n"\n')
        for command in ("install", "restart", "ensure-current"):
            self.assertNotEqual(self.run_manager(command).returncode, 0)
        self.assertFalse(self.sentinel.exists())
        self.assertFalse((self.base / "launchctl.log").exists())

    def test_launcher_missing_manifest_with_installed_selector_fails_closed(self):
        self.manifest_path.unlink()
        legacy = self.home / ".claude/plugins/cache/ops-marketplace/ops/9.9.9/scripts"
        legacy.mkdir(parents=True)
        (legacy / "ops-daemon.sh").write_text('#!/bin/sh\necho legacy >> "$FORBIDDEN_MARKER"\nexit 93\n')
        result = subprocess.run([BASH, str(self.plugin / "scripts/ops-daemon-launcher.sh"), "--run-once"],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertFalse(self.sentinel.exists())

    def test_launcher_respects_mode_before_looking_for_plugin_versions(self):
        result = subprocess.run([BASH, str(self.plugin / "scripts/ops-daemon-launcher.sh"), "--run-once"],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.data / "daemon-health.json").read_text())["mode"], "monitor_only")
        self.assertFalse(self.sentinel.exists())


if __name__ == "__main__":
    unittest.main()
