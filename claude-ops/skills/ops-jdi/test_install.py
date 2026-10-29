"""Installer contract tests: a fake CLI, temporary source, destination and registry only."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ['JDI_FIXTURE'])
state_path = root / 'registry.json'
s = json.loads(state_path.read_text())
a = sys.argv[2:]
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps(a) + '\n')
key = ' '.join(a[:2]) if a[0] == 'marketplace' else a[0]
if key == 'marketplace list':
    print(json.dumps(s['markets'])); sys.exit(0)
if key == 'list':
    print(json.dumps(s['plugins'])); sys.exit(0)
if os.environ.get('JDI_FAIL') == key and not (root / 'failed').exists():
    (root / 'failed').touch()
    print('fixture injected failure', file=sys.stderr); sys.exit(17)
if key == 'marketplace add':
    s['markets'].append({'name': 'local-just-do-it', 'source': 'directory', 'path': a[2]})
elif key == 'marketplace remove':
    s['markets'] = []
elif key in ('install', 'update'):
    assert a[-2:] == ['--scope', 'user']
    source = pathlib.Path(s['markets'][0]['path']) / 'plugins/just-do-it'
    cache = root / ('cache-' + str(len(list(root.glob('cache-*')))))
    shutil.copytree(source, cache)
    s['plugins'] = [{'id': 'just-do-it@local-just-do-it', 'scope': 'user', 'installPath': str(cache)}]
elif key == 'uninstall':
    assert '--keep-data' in a
    s['plugins'] = []
else:
    raise AssertionError(a)
state_path.write_text(json.dumps(s))
if os.environ.get('JDI_FAIL_AFTER') == key and not (root / 'failed').exists():
    (root / 'failed').touch()
    print('fixture partial failure', file=sys.stderr); sys.exit(18)
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        for name in ('install.sh', 'install.py'):
            shutil.copy2(HERE / name, self.source / name)
        shutil.copytree(HERE / 'plugin', self.source / 'plugin',
                        ignore=shutil.ignore_patterns('runtime', '__pycache__'))
        self.market = self.root / 'market'
        self.dest = self.market / 'plugins/just-do-it'
        self.registry = self.root / 'registry.json'
        self.registry.write_text(json.dumps({'markets': [], 'plugins': []}))
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        fake = self.bin / 'claude'
        fake.write_text(FAKE)
        fake.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        JDI_FIXTURE=str(self.root), JDI_MARKET_DIR=str(self.market))
        # This fixture never invokes the native CLI or changes HOME/config/permissions.

    def run_install(self, *args, ok=True, **env):
        result = subprocess.run(['bash', str(self.source / 'install.sh'), *args],
                                env=dict(self.env, **env), text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def state(self):
        return json.loads(self.registry.read_text())

    def snapshot(self):
        return {str(p.relative_to(self.market)): p.read_bytes()
                for p in self.market.rglob('*') if p.is_file()}

    def calls(self):
        return [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]

    def backup(self, result):
        return result.stdout.split('Backup: ', 1)[1].splitlines()[0]

    def test_conflicting_marketplace_refused_without_writes(self):
        self.registry.write_text(json.dumps({'markets': [{'name': 'local-just-do-it',
            'source': 'directory', 'path': str(self.root / 'foreign')}], 'plugins': []}))
        before = self.registry.read_bytes()
        result = self.run_install(ok=False)
        self.assertIn('Conflicting marketplace', result.stderr)
        self.assertEqual(self.registry.read_bytes(), before)
        self.assertFalse(self.market.exists())

    def test_unowned_existing_files_refused(self):
        self.market.mkdir()
        (self.market / 'keep').write_text('original')
        before = self.snapshot()
        self.run_install(ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_symlink_destination_refused(self):
        foreign = self.root / 'foreign'
        foreign.mkdir()
        self.market.symlink_to(foreign, target_is_directory=True)
        self.run_install(ok=False)
        self.assertEqual(list(foreign.iterdir()), [])

    def test_failed_registration_is_fatal_and_restores_absence(self):
        result = self.run_install(ok=False, JDI_FAIL='marketplace add')
        self.assertIn('fixture injected failure', result.stderr)
        self.assertFalse(self.market.exists())
        self.assertEqual(self.state(), {'markets': [], 'plugins': []})
        self.assertFalse(any(c[0] == 'install' for c in self.calls()))

    def test_partial_registration_failure_is_removed(self):
        self.run_install(ok=False, JDI_FAIL_AFTER='marketplace add')
        self.assertFalse(self.market.exists())
        self.assertEqual(self.state(), {'markets': [], 'plugins': []})

    def test_partial_install_failure_is_removed(self):
        self.run_install(ok=False, JDI_FAIL_AFTER='install')
        self.assertFalse(self.market.exists())
        self.assertEqual(self.state(), {'markets': [], 'plugins': []})

    def test_update_preserves_unknown_files_source_and_cached_runtime(self):
        self.run_install()
        (self.dest / 'custom.txt').write_text('keep me')
        runtime = self.dest / 'runtime'
        runtime.mkdir()
        (runtime / 'source.json').write_text('source state')
        cache = Path(self.state()['plugins'][0]['installPath'])
        (cache / 'runtime').mkdir()
        (cache / 'runtime/session.json').write_text('cached state')
        (runtime / 'session.json').write_text('older source state')
        (self.source / 'plugin/new.txt').write_text('new payload')
        self.run_install('update')
        self.assertEqual((self.dest / 'custom.txt').read_text(), 'keep me')
        self.assertEqual((runtime / 'source.json').read_text(), 'source state')
        self.assertEqual((self.dest / 'new.txt').read_text(), 'new payload')
        updated = Path(self.state()['plugins'][0]['installPath'])
        self.assertEqual((updated / 'runtime/session.json').read_text(), 'cached state')
        self.assertEqual([c[0] for c in self.calls()].count('install'), 1)
        self.assertEqual([c[0] for c in self.calls()].count('update'), 1)

    def test_update_collision_refused(self):
        self.run_install()
        (self.dest / 'custom.txt').write_text('keep')
        (self.source / 'plugin/custom.txt').write_text('collision')
        before = self.snapshot()
        self.run_install('update', ok=False)
        self.assertEqual(self.snapshot(), before)

    def assert_preflight_refused(self):
        before = self.snapshot()
        registry = self.registry.read_bytes()
        entries = sorted(str(p.relative_to(self.market)) for p in self.market.rglob('*'))
        backups = sorted(self.root.glob('market.backup-*'))
        calls = len(self.calls())
        result = self.run_install('update', ok=False)
        self.assertNotIn('Backup: ', result.stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.registry.read_bytes(), registry)
        self.assertEqual(sorted(str(p.relative_to(self.market)) for p in self.market.rglob('*')), entries)
        self.assertEqual(sorted(self.root.glob('market.backup-*')), backups)
        self.assertTrue(all(c in (['marketplace', 'list', '--json'], ['list', '--json'])
                            for c in self.calls()[calls:]))

    def test_managed_file_replaced_by_directory_refused(self):
        self.run_install()
        target = self.dest / 'README.md'
        target.unlink()
        target.mkdir()
        (target / 'README.md').write_bytes(b'unowned nested bytes\x00')
        self.assert_preflight_refused()

    def test_managed_deletion_replaced_by_directory_refused(self):
        self.run_install()
        target = self.dest / 'README.md'
        target.unlink()
        target.mkdir()
        (target / 'README.md').write_bytes(b'unowned nested bytes\x00')
        (self.source / 'plugin/README.md').unlink()
        self.assert_preflight_refused()

    def test_payload_parent_file_collision_refused_before_mutations(self):
        self.run_install()
        (self.dest / 'extra').write_text('unowned parent')
        (self.source / 'plugin/extra').mkdir()
        (self.source / 'plugin/extra/new.txt').write_text('new payload')
        (self.source / 'plugin/README.md').unlink()
        self.assert_preflight_refused()

    def test_managed_deletion_parent_file_collision_refused(self):
        (self.source / 'plugin/extra').mkdir()
        (self.source / 'plugin/extra/old.txt').write_text('managed payload')
        self.run_install()
        (self.dest / 'extra/old.txt').unlink()
        (self.dest / 'extra').rmdir()
        (self.dest / 'extra').write_text('unowned replacement')
        (self.source / 'plugin/extra/old.txt').unlink()
        self.assert_preflight_refused()

    def test_payload_file_to_directory_change_refused(self):
        self.run_install()
        source = self.source / 'plugin/README.md'
        source.unlink()
        source.mkdir()
        (source / 'child.txt').write_text('new payload')
        self.assert_preflight_refused()

    def test_payload_directory_to_file_change_refused(self):
        (self.source / 'plugin/extra').mkdir()
        (self.source / 'plugin/extra/old.txt').write_text('managed payload')
        self.run_install()
        (self.source / 'plugin/extra/old.txt').unlink()
        (self.source / 'plugin/extra').rmdir()
        (self.source / 'plugin/extra').write_text('new payload')
        self.assert_preflight_refused()

    def test_marketplace_alias_contends_on_canonical_lock(self):
        self.run_install()
        before = self.snapshot()
        registry = self.registry.read_bytes()
        calls = self.calls()
        lock_path = Path(tempfile.gettempdir()) / ('ops-jdi-' + hashlib.sha256(
            str(self.market.resolve()).encode()).hexdigest() + '.lock')
        with lock_path.open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_install('update', ok=False,
                                      JDI_MARKET_DIR=str(self.market / '../market'))
        self.assertIn('Installer failed:', result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.registry.read_bytes(), registry)
        self.assertEqual(self.calls(), calls)

    def test_symlink_ancestor_refused_before_canonicalization(self):
        foreign = self.root / 'foreign'
        foreign.mkdir()
        alias = self.root / 'alias'
        alias.symlink_to(foreign, target_is_directory=True)
        for path in (alias / 'market', alias / '../market'):
            with self.subTest(path=path):
                result = self.run_install(ok=False, JDI_MARKET_DIR=str(path))
                self.assertIn('Symlink destination:', result.stderr)
        self.assertFalse(self.market.exists())
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertFalse((self.root / 'calls.jsonl').exists())

    def test_failed_update_restores_previous_files_and_cache(self):
        self.run_install()
        before = self.snapshot()
        old = (self.dest / 'README.md').read_bytes()
        (self.source / 'plugin/README.md').write_text('replacement')
        self.run_install('update', ok=False, JDI_FAIL_AFTER='update')
        self.assertEqual(self.snapshot(), before)
        cache = Path(self.state()['plugins'][0]['installPath'])
        self.assertEqual((cache / 'README.md').read_bytes(), old)

    def test_rollback_preserves_new_runtime_and_refuses_conflicts(self):
        self.run_install()
        old = (self.dest / 'README.md').read_bytes()
        (self.dest / 'custom.txt').write_text('unknown file')
        (self.source / 'plugin/README.md').write_text('replacement')
        result = self.run_install('update')
        backup = self.backup(result)
        (self.dest / 'runtime').mkdir()
        (self.dest / 'runtime/new.json').write_text('latest state')
        self.run_install('rollback', backup)
        self.assertEqual((self.dest / 'README.md').read_bytes(), old)
        self.assertEqual((self.dest / 'runtime/new.json').read_text(), 'latest state')
        result = self.run_install('update')
        (self.dest / 'README.md').write_text('concurrent edit')
        before = self.snapshot()
        self.run_install('rollback', self.backup(result), ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_uninstall_retains_source_and_runtime(self):
        self.run_install()
        cache = Path(self.state()['plugins'][0]['installPath'])
        (cache / 'runtime').mkdir()
        (cache / 'runtime/session.json').write_text('latest')
        self.run_install('uninstall')
        self.assertEqual(self.state(), {'markets': [], 'plugins': []})
        self.assertTrue((self.dest / 'README.md').exists())
        self.assertEqual((self.dest / 'runtime/session.json').read_text(), 'latest')

    def test_failed_uninstall_recovers_registration(self):
        self.run_install()
        before = self.snapshot()
        self.run_install('uninstall', ok=False, JDI_FAIL='marketplace remove')
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.state()['plugins']), 1)
        self.assertEqual(len(self.state()['markets']), 1)

    def test_changed_catalog_refused(self):
        self.run_install()
        catalog = self.market / '.claude-plugin/marketplace.json'
        catalog.write_text('{"name":"another-market"}')
        before = self.snapshot()
        self.run_install('update', ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_foreign_scope_refused(self):
        self.run_install()
        state = self.state()
        state['plugins'][0]['scope'] = 'project'
        self.registry.write_text(json.dumps(state))
        before = self.snapshot()
        self.run_install('update', ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_uninstall_newer_cached_runtime_wins(self):
        self.run_install()
        (self.dest / 'runtime').mkdir()
        (self.dest / 'runtime/session.json').write_text('older')
        cache = Path(self.state()['plugins'][0]['installPath'])
        (cache / 'runtime').mkdir()
        (cache / 'runtime/session.json').write_text('newest')
        self.run_install('uninstall')
        self.assertEqual((self.dest / 'runtime/session.json').read_text(), 'newest')

    def test_update_requires_existing_install(self):
        self.run_install('update', ok=False)
        self.assertFalse(self.market.exists())


if __name__ == '__main__':
    unittest.main()
