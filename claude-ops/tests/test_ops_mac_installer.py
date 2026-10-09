"""Only temporary file fixtures; installer never executes helper payloads."""
import importlib.util
import os
import pathlib
import subprocess
import sys
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

    def test_router_refuses_non_macos_before_any_install(self):
        # Runs on every platform: a uname fixture reports Linux, and the product
        # gate must refuse before touching the target.
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'uname').write_text('#!/bin/sh\necho Linux\n')
            (root / 'uname').chmod(0o755)
            target = root / 'fixture'
            target.write_bytes(b'original')
            command = PATH.parents[2] / 'bin/ops-mac'
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['/bin/bash', str(command), 'maintenance', 'install', 'agent-log-rotate', '--target', str(target), '--expected-sha256', installer.digest(target)], capture_output=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'macOS only', result.stderr)
            self.assertEqual(target.read_bytes(), b'original')

    @unittest.skipUnless(sys.platform == 'darwin',
                         'SKIP: ops-mac router is macOS-only; installer itself is covered above')
    def test_router_installer_is_dry_run_without_toolkit(self):
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d) / 'fixture'
            target.write_bytes(b'original')
            command = PATH.parents[2] / 'bin/ops-mac'
            result = subprocess.run(['/bin/bash', str(command), 'maintenance', 'install', 'agent-log-rotate', '--target', str(target), '--expected-sha256', installer.digest(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'verified; dry-run only, no files installed\n')
            self.assertEqual(target.read_bytes(), b'original')

    def test_cooperative_lock_held_across_final_check_and_replace(self):
        # A cooperating peer that tries to take the target lock while the
        # installer is replacing must be refused: check and replace are one
        # critical section, so the peer cannot slip new bytes in between.
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'new')
            target.write_bytes(b'old')
            lock_path = pathlib.Path(str(target) + '.install.lock')
            observed = []
            real_replace = installer.os.replace

            def peer_then_replace(src, dst):
                fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
                try:
                    installer.fcntl.flock(fd, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                    observed.append('peer acquired lock')
                    installer.fcntl.flock(fd, installer.fcntl.LOCK_UN)
                except BlockingIOError:
                    observed.append('peer blocked')
                finally:
                    os.close(fd)
                return real_replace(src, dst)

            with mock.patch.object(installer.os, 'replace', side_effect=peer_then_replace):
                installer.install(source, target, installer.digest(target))
            self.assertEqual(observed, ['peer blocked'])
            self.assertEqual(target.read_bytes(), b'new')

    def test_install_refuses_while_peer_holds_lock(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'new')
            target.write_bytes(b'old')
            fd = os.open(str(target) + '.install.lock', os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                for expected in (installer.digest(target), 'absent'):
                    with self.subTest(expected=expected):
                        with self.assertRaises(ValueError):
                            installer.install(source, target, expected)
                self.assertEqual(target.read_bytes(), b'old')
                self.assertEqual(list(pathlib.Path(d).glob('target.bak.*')), [])
            finally:
                os.close(fd)

    def test_peer_change_after_backup_is_refused_under_lock(self):
        # Bytes that change before the locked recheck are never overwritten.
        with tempfile.TemporaryDirectory() as d:
            source, target = pathlib.Path(d) / 'source', pathlib.Path(d) / 'target'
            source.write_bytes(b'new')
            target.write_bytes(b'old')
            expected = installer.digest(target)
            real_chown = installer.os.chown

            def chown_then_peer_write(path, uid, gid):
                real_chown(path, uid, gid)
                if '.install.' in str(path):
                    target.write_bytes(b'peer')

            with mock.patch.object(installer.os, 'chown', side_effect=chown_then_peer_write):
                with self.assertRaises(ValueError):
                    installer.install(source, target, expected)
            self.assertEqual(target.read_bytes(), b'peer')

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
