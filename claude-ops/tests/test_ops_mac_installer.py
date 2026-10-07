"""Only temporary file fixtures; installer never executes helper payloads."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts/ops-mac/install-helper.py'
spec = importlib.util.spec_from_file_location('installer', PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_backup_install_and_rollback_preserve_mode(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            source, target = root / 'source', root / 'target'
            source.write_bytes(b'new\n')
            target.write_bytes(b'old "caf\xc3\xa9"\n')
            target.chmod(0o751)
            old = target.read_bytes()
            backup = installer.install(source, target, installer.digest(target))
            self.assertEqual(backup.read_bytes(), old)
            self.assertEqual(target.read_bytes(), b'new\n')
            self.assertEqual(target.stat().st_mode & 0o777, 0o751)
            installer.install(backup, target, installer.digest(target))
            self.assertEqual(target.read_bytes(), old)

    def test_preserves_owner_and_refuses_chown_failure(self):
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'new')
            target.write_bytes(b'old')
            original = target.stat()
            with mock.patch.object(installer.os, 'chown', wraps=installer.os.chown) as chown:
                installer.install(source, target, installer.digest(target))
                self.assertEqual(chown.call_count, 2)
                for call in chown.call_args_list:
                    self.assertEqual(call.args[1:], (original.st_uid, original.st_gid))
            self.assertEqual((target.stat().st_uid, target.stat().st_gid), (original.st_uid, original.st_gid))
            with mock.patch.object(installer.os, 'chown', side_effect=PermissionError('fixture refusal')):
                with self.assertRaises(PermissionError):
                    installer.install(source, target, installer.digest(target))
            self.assertEqual(target.read_bytes(), b'new')

    def test_changed_bytes_refused(self):
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d) / 'target'
            target.write_bytes(b'old')
            with self.assertRaises(ValueError):
                installer.install(target, target, 'wrong')
            self.assertEqual(target.read_bytes(), b'old')

    def test_new_library_exclusive_creation(self):
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'library')
            self.assertIsNone(installer.install(source, target, 'absent'))
            self.assertEqual(target.read_bytes(), b'library')
            with self.assertRaises(ValueError):
                installer.install(source, target, 'absent')

    def test_router_installer_is_dry_run_without_toolkit(self):
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d) / 'fixture'
            target.write_bytes(b'original')
            command = PATH.parents[2] / 'bin/ops-mac'
            result = subprocess.run(['/bin/bash', str(command), 'maintenance', 'install', 'agent-log-rotate', '--target', str(target), '--expected-sha256', installer.digest(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'verified; dry-run only, no files installed\n')
            self.assertEqual(target.read_bytes(), b'original')

    def test_replace_failure_leaves_original(self):
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'new')
            target.write_bytes(b'old')
            with mock.patch.object(installer.os, 'replace', side_effect=OSError('fixture failure')):
                with self.assertRaises(OSError):
                    installer.install(source, target, installer.digest(target))
            self.assertEqual(target.read_bytes(), b'old')


if __name__ == '__main__':
    unittest.main()
