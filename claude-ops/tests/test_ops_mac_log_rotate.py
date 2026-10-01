"""Isolated compatibility tests; never rotate live logs or run jobs."""
import contextlib
import importlib.machinery
import importlib.util
import io
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts/ops-mac/agent-log-rotate"
loader = importlib.machinery.SourceFileLoader("log_rotate", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class PlistTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)

    def write(self, data):
        path = self.root / "fixture.plist"
        path.write_bytes(data)
        return path

    def test_standard_xml_and_binary_need_no_fallback(self):
        for fmt in (plistlib.FMT_XML, plistlib.FMT_BINARY):
            expected = {"Label": "com.example.worker", "StandardOutPath": "a.log"}
            path = self.write(plistlib.dumps(expected, fmt=fmt))
            with mock.patch.object(module.subprocess, "run") as run:
                self.assertEqual(module.load_plist(path), expected)
                run.assert_not_called()

    def test_apple_valid_nonstandard_xml(self):
        data = b'<plist version="1.0"><!-- command --flag is opt-in --><dict><key>Label</key><string>com.example.worker</string><key>StandardOutPath</key><string>a&amp;b.log</string></dict></plist>'
        path = self.write(data)
        with self.assertRaises(Exception):
            plistlib.loads(data)
        normalized = plistlib.dumps({"Label": "com.example.worker", "StandardOutPath": "a&b.log"})
        with mock.patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, normalized, b"")) as run:
            self.assertEqual(module.load_plist(path)["StandardOutPath"], "a&b.log")
            self.assertEqual(run.call_args.args[0], ["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "--", str(path)])
            self.assertEqual(path.read_bytes(), data)

    def test_real_apple_conversion_on_isolated_fixture(self):
        if not pathlib.Path("/usr/bin/plutil").exists():
            self.skipTest("Apple plutil unavailable")
        path = self.write(b'<plist version="1.0"><!-- command --flag is opt-in --><dict><key>Label</key><string>com.example.worker</string><key>StandardOutPath</key><string>a&amp;b.log</string></dict></plist>')
        self.assertEqual(module.load_plist(path)["StandardOutPath"], "a&b.log")

    def test_invalid_plist_reported_on_stderr_only(self):
        self.write(b"not a plist")
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(module, "PLIST_DIRS", [str(self.root)]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(module.discover(), [])
        self.assertEqual(out.getvalue(), "")
        self.assertIn("cannot parse", err.getvalue())

    def test_empty_directory(self):
        with mock.patch.object(module, "PLIST_DIRS", [str(self.root)]):
            self.assertEqual(module.discover(), [])

    def test_multiline_quotes_unicode_preserved_and_deduplicated(self):
        value = 'logs/"café"\nsecond.log'
        self.write(plistlib.dumps({"Label": "com.example.worker", "StandardOutPath": value, "StandardErrorPath": value}))
        with mock.patch.object(module, "PLIST_DIRS", [str(self.root)]):
            self.assertEqual(module.discover(), [("com.example.worker", value)])

    def test_non_dictionary_rejected(self):
        path = self.write(plistlib.dumps(["unexpected"]))
        with self.assertRaises(ValueError):
            module.load_plist(path)

    def test_failed_converter_and_timeout_visible(self):
        path = self.write(b"bad")
        for effect in (OSError("unavailable"), subprocess.TimeoutExpired("plutil", 5)):
            with mock.patch.object(module.subprocess, "run", side_effect=effect):
                with self.assertRaises(ValueError):
                    module.load_plist(path)


if __name__ == "__main__":
    unittest.main()
