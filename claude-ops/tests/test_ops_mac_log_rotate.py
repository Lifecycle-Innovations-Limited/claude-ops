"""Isolated compatibility tests; never rotate live logs or run jobs."""
import contextlib
import importlib.machinery
import importlib.util
import io
import os
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(os.getenv("OPS_MAC_LOG_SOURCE", str(pathlib.Path(__file__).resolve().parents[1] / "scripts/ops-mac/agent-log-rotate")))
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


class RotationTests(unittest.TestCase):
    def fixture(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = pathlib.Path(tmp.name) / 'worker.log'
        path.write_bytes(b'original log\n' * 100)
        return path

    def test_main_reports_archive_failure_and_returns_nonzero(self):
        path = self.fixture()
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(module, 'discover', return_value=[('fixture', str(path))]), mock.patch.object(module, 'rotate', return_value=(False, 'FAILED: archival incomplete')), mock.patch.object(module.sys, 'argv', ['agent-log-rotate']), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = module.main()
        self.assertNotEqual(code, 0)
        self.assertIn('FAILED: archival incomplete', err.getvalue())

    def test_same_second_archive_collision_never_overwrites(self):
        path = self.fixture()
        archive = path.parent / module.ARCHIVE_SUBDIR
        archive.mkdir()
        previous = archive / 'worker.log.fixed.gz'
        previous.write_bytes(module.gzip.compress(b'previous archive'))
        original = previous.read_bytes()
        source_bytes = path.read_bytes()
        with mock.patch.object(module.time, 'strftime', return_value='fixed'):
            changed, message = module.rotate(str(path), 'fixture', 1, 10, False, False)
        self.assertTrue(changed, message)
        self.assertEqual(previous.read_bytes(), original)
        archives = list(archive.glob('*.gz'))
        self.assertEqual(len(archives), 2)
        self.assertEqual({module.gzip.decompress(item.read_bytes()) for item in archives}, {b'previous archive', source_bytes})
        self.assertEqual(path.read_bytes(), b'')

    def test_competing_writer_lock_keeps_live_file_unchanged(self):
        import fcntl
        path = self.fixture()
        original = path.read_bytes()
        with open(str(path) + '.rotate.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            changed, message = module.rotate(str(path), 'fixture', 1, 10, False, False)
        self.assertFalse(changed, message)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse((path.parent / module.ARCHIVE_SUBDIR).exists())

    def test_archival_failure_never_truncates(self):
        path = self.fixture()
        original = path.read_bytes()
        with mock.patch.object(module.gzip, 'GzipFile', side_effect=OSError('fixture compression failure')):
            changed, message = module.rotate(str(path), 'fixture', 1, 10, False, False)
        self.assertFalse(changed, message)
        self.assertEqual(path.read_bytes(), original)

    def test_appends_during_archive_are_preserved_not_truncated(self):
        path = self.fixture()
        original = path.read_bytes()
        copy = module.shutil.copyfileobj
        def append_after_copy(src, dst, length):
            copy(src, dst, length)
            with path.open('ab') as writer:
                writer.write(b'new line\n')
        with mock.patch.object(module.shutil, 'copyfileobj', side_effect=append_after_copy):
            changed, message = module.rotate(str(path), 'fixture', 1, 10, False, False)
        self.assertFalse(changed, message)
        self.assertEqual(path.read_bytes(), original + b'new line\n')


if __name__ == "__main__":
    unittest.main()
