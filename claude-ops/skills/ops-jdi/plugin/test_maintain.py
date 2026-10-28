"""TEAM-1 maintain: diagnose-config, apply-fix and rollback-fix. Temp fixtures only, never the real HOME or runtime."""
import builtins
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('bridge', HERE / 'hooks/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)

DAY = 86400
SENTINELS = ('sk-SENTINEL-env', 'sk-SENTINEL-assign', 'sk-SENTINEL-arg', 'sk-SENTINEL-state')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Fixture:
    def __init__(self, tmp):
        self.tmp = Path(tmp)
        self.base = self.tmp / 'plugin'
        self.home = self.tmp / 'home'
        for rel in ('.claude-plugin', 'hooks', 'types'):
            (self.base / rel).mkdir(parents=True)
        (self.base / 'runtime').mkdir(mode=0o700)
        os.chmod(self.base / 'runtime', 0o700)
        (self.base / '.claude-plugin/plugin.json').write_text(json.dumps(
            {'name': 'fx', 'version': '1', 'types': './types/index.d.ts'}))
        (self.base / 'types/index.d.ts').write_text('export {}\n')
        (self.base / 'hooks/register.tsx').write_text('export {}\n')
        (self.base / 'hooks/bridge.py').write_text('#!/usr/bin/env python3\nprint(1)\n')
        os.chmod(self.base / 'hooks/bridge.py', 0o755)
        (self.base / 'hooks/hooks.json').write_text(json.dumps({'modules': ['./register.tsx'], 'hooks': {'Stop': [
            {'hooks': [{'type': 'command', 'command': 'python3 -I "${CLAUDE_PLUGIN_ROOT}/hooks/bridge.py"'}]}]}}))
        (self.home / '.claude/plugins').mkdir(parents=True)
        self.script = self.home / '.claude/guard.py'
        self.script.write_text('print(1)\n')
        self.install = self.home / 'installed/good'
        self.install.mkdir(parents=True)
        self.settings({'PreToolUse': [{'matcher': 'Bash', 'hooks': [
            {'type': 'command', 'command': 'python3 -I %s' % self.script}]}]})
        self.installed({'good@m': [{'scope': 'user', 'installPath': str(self.install)}]})

    def settings(self, hooks, **extra):
        (self.home / '.claude/settings.json').write_text(json.dumps(dict(hooks=hooks, **extra)))

    def installed(self, plugins):
        (self.home / '.claude/plugins/installed_plugins.json').write_text(json.dumps({'version': 2, 'plugins': plugins}))

    def state(self, name, age_days, content=None):
        path = self.base / 'runtime' / name
        path.write_text(content if content is not None else json.dumps({'schemaVersion': 1, 'session_id': name[:-5]}))
        os.chmod(path, 0o600)
        stamp = time.time() - age_days * DAY
        os.utime(path, (stamp, stamp))
        return path

    def diagnose(self, **kw):
        return b.diagnose_config(base=self.base, home=self.home, **kw)

    def apply(self, s, ids):
        return b.apply_fix(s, ids, base=self.base, home=self.home)

    def rollback(self, s, fix_id):
        return b.rollback_fix(s, fix_id, base=self.base)


def ids(findings):
    return {f['id'] for f in findings}


class DiagnoseTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(self._tmp.name)

    def test_clean_fixture_has_no_findings(self):
        self.assertEqual(self.fx.diagnose(), [])

    def test_finding_shape(self):
        os.chmod(self.fx.base / 'hooks/bridge.py', 0o644)
        (finding,) = self.fx.diagnose()
        self.assertEqual(set(finding), {'id', 'severity', 'source', 'evidence', 'proposedFix', 'autoFixable', 'patch'})
        self.assertIn(finding['severity'], ('high', 'medium', 'low'))

    def test_own_hook_script_missing_is_high_and_not_autofixable(self):
        (self.fx.base / 'hooks/bridge.py').unlink()
        found = {f['id']: f for f in self.fx.diagnose()}
        self.assertEqual(found['hooks-script-missing:hooks/bridge.py']['severity'], 'high')
        self.assertFalse(found['hooks-script-missing:hooks/bridge.py']['autoFixable'])

    def test_own_hooks_json_and_manifest_unparsable(self):
        (self.fx.base / 'hooks/hooks.json').write_text('{broken')
        (self.fx.base / '.claude-plugin/plugin.json').write_text('[1]')
        found = self.fx.diagnose()
        self.assertIn('hooks-json-unparsable', ids(found))
        self.assertIn('manifest-unparsable', ids(found))
        self.assertTrue(all(not f['autoFixable'] for f in found))

    def test_manifest_types_and_module_missing(self):
        (self.fx.base / 'types/index.d.ts').unlink()
        (self.fx.base / 'hooks/register.tsx').unlink()
        found = ids(self.fx.diagnose())
        self.assertIn('manifest-types-missing', found)
        self.assertIn('hooks-module-missing:./register.tsx', found)

    def test_python3_must_resolve(self):
        empty = self.fx.tmp / 'emptybin'
        empty.mkdir()
        with mock.patch.dict(os.environ, {'PATH': str(empty)}):
            self.assertIn('python3-unresolvable', ids(self.fx.diagnose()))
        self.assertNotIn('python3-unresolvable', ids(self.fx.diagnose()))

    def test_settings_missing_hook_script_reports_exact_patch_without_secrets(self):
        self.fx.settings({'Stop': [{'hooks': [{'type': 'command',
            'command': 'API_KEY=sk-SENTINEL-assign /nonexistent/guard.py --token sk-SENTINEL-arg'}]}]},
            env={'SECRET_TOKEN': 'sk-SENTINEL-env'})
        found = self.fx.diagnose()
        (item,) = [f for f in found if f['id'] == 'settings-hook-missing:Stop/0/0']
        self.assertFalse(item['autoFixable'])
        self.assertIn('/nonexistent/guard.py', item['evidence'])
        self.assertEqual(item['patch'][0]['path'], '/hooks/Stop/0/hooks/0')
        self.assertIn('guard', item['proposedFix'].lower())
        blob = json.dumps(found)
        for secret in SENTINELS:
            self.assertNotIn(secret, blob)

    def test_settings_unparsable_and_existing_script_ok(self):
        (self.fx.home / '.claude/settings.json').write_text('{nope')
        self.assertIn('settings-unparsable', ids(self.fx.diagnose()))

    def test_installed_plugin_with_missing_install_path(self):
        self.fx.installed({'good@m': [{'installPath': str(self.fx.install)},
                                      {'installPath': str(self.fx.tmp / 'gone')}], 'a/b@m': [{'installPath': str(self.fx.tmp / 'gone2')}]})
        found = {f['id']: f for f in self.fx.diagnose()}
        self.assertEqual(set(found), {'plugin-install-missing:good@m/1', 'plugin-install-missing:a/b@m/0'})
        self.assertEqual(found['plugin-install-missing:a/b@m/0']['patch'][0]['path'], '/plugins/a~1b@m/0')
        self.assertTrue(all(not f['autoFixable'] for f in found.values()))

    def test_exec_bit_on_own_scripts_is_low_and_autofixable(self):
        os.chmod(self.fx.base / 'hooks/bridge.py', 0o644)
        (item,) = self.fx.diagnose()
        self.assertEqual((item['id'], item['severity'], item['autoFixable']), ('exec-bit:hooks/bridge.py', 'low', True))

    def test_runtime_state_age_and_corruption(self):
        self.fx.state('fresh.json', 1)
        self.fx.state('old.json', 8)
        self.fx.state('oldbad.json', 9, '{broken')
        self.fx.state('freshbad.json', 1, '{broken')
        self.fx.state('active.json', 30)
        found = {f['id']: f for f in self.fx.diagnose(active_sid='active')}
        self.assertEqual(set(found), {'runtime-stale:old.json', 'runtime-corrupt:oldbad.json', 'runtime-corrupt-recent:freshbad.json'})
        self.assertTrue(found['runtime-stale:old.json']['autoFixable'])
        self.assertTrue(found['runtime-corrupt:oldbad.json']['autoFixable'])
        self.assertFalse(found['runtime-corrupt-recent:freshbad.json']['autoFixable'])
        self.assertTrue(all(f['severity'] == 'low' for f in found.values()))

    def test_runtime_symlink_reported_never_autofixable(self):
        victim = self.fx.tmp / 'victim.json'
        victim.write_text('{}')
        link = self.fx.base / 'runtime/link.json'
        link.symlink_to(victim)
        (item,) = self.fx.diagnose()
        self.assertEqual((item['id'], item['autoFixable'], item['severity']), ('runtime-symlink:link.json', False, 'medium'))

    def test_reads_only_named_files(self):
        decoy = self.fx.home / '.claude/secret.env'
        decoy.write_text('TOKEN=sk-SENTINEL-env\n')
        (self.fx.home / '.ssh').mkdir()
        (self.fx.home / '.ssh/id').write_text('sk-SENTINEL-env')
        self.fx.state('old.json', 8)
        opened = []
        real_open, real_io_open = builtins.open, io.open

        def spy(path, *a, **k):
            opened.append(Path(path).resolve() if not isinstance(path, int) else None)
            return real_open(path, *a, **k)

        def spy_io(path, *a, **k):
            opened.append(Path(path).resolve() if not isinstance(path, int) else None)
            return real_io_open(path, *a, **k)

        with mock.patch.object(builtins, 'open', spy), mock.patch.object(io, 'open', spy_io):
            self.fx.diagnose()
        allowed = {(self.fx.home / '.claude/settings.json').resolve(), (self.fx.home / '.claude/plugins/installed_plugins.json').resolve(),
                   (self.fx.base / '.claude-plugin/plugin.json').resolve(), (self.fx.base / 'hooks/hooks.json').resolve(),
                   (self.fx.base / 'runtime/old.json').resolve()}
        self.assertTrue(opened)
        self.assertLessEqual({p for p in opened if p is not None}, allowed)

    def test_diagnose_is_idempotent_and_read_only(self):
        self.fx.state('old.json', 8)
        os.chmod(self.fx.base / 'hooks/bridge.py', 0o644)
        before = {p: (p.stat().st_mode, sha(p)) for p in self.fx.tmp.rglob('*') if p.is_file()}
        first = self.fx.diagnose()
        second = self.fx.diagnose()
        self.assertEqual(first, second)
        after = {p: (p.stat().st_mode, sha(p)) for p in self.fx.tmp.rglob('*') if p.is_file()}
        self.assertEqual(before, after)


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(self._tmp.name)
        self.s = b.fresh('fixture')
        self.patches = [mock.patch.object(b, 'PLUGIN_BASE', self.fx.base), mock.patch.dict(os.environ, {'HOME': str(self.fx.home)})]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def diagnose(self, **extra):
        return b.control(self.s, 'diagnose-config', dict(generation=0, **extra))

    def test_high_findings_become_deterministic_incidents_low_do_not(self):
        (self.fx.base / 'hooks/bridge.py').unlink()
        self.fx.state('old.json', 8)
        result = self.diagnose()
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['session_id'], 'fixture')
        self.assertIn('runtime-stale:old.json', ids(result['findings']))
        self.assertEqual(result['recorded'], 1)
        keys = set(self.s['incidents'])
        self.assertEqual(len(keys), 1)
        again = self.diagnose()
        self.assertEqual(again['recorded'], 0)
        self.assertEqual(set(self.s['incidents']), keys)
        self.assertEqual(next(iter(self.s['incidents'].values()))['category'], 'actual failure')

    def test_record_false_leaves_state_untouched(self):
        (self.fx.base / 'hooks/bridge.py').unlink()
        before = b.digest(self.s)
        result = self.diagnose(record=False)
        self.assertEqual(result['recorded'], 0)
        self.assertEqual(b.digest(self.s), before)
        self.assertTrue(result['findings'])

    def test_stop_gate_sees_recorded_finding(self):
        (self.fx.base / 'hooks/bridge.py').unlink()
        self.diagnose()
        stop = b.event(self.s, dict(hook_event_name='Stop', last_assistant_message='x'))
        self.assertEqual(stop['decision'], 'block')
        self.assertIn('incident', stop['reason'])

    def test_stale_generation_refused(self):
        with self.assertRaises(ValueError):
            b.control(self.s, 'diagnose-config', dict(generation=7))

    def test_active_session_runtime_file_never_flagged(self):
        self.fx.state('fixture.json', 40)
        self.assertNotIn('runtime-stale:fixture.json', ids(self.diagnose()['findings']))

    def test_cli_end_to_end_in_isolated_copy(self):
        plugin = self.fx.base
        (plugin / 'hooks/bridge.py').write_bytes((HERE / 'hooks/bridge.py').read_bytes())
        os.chmod(plugin / 'hooks/bridge.py', 0o755)
        self.fx.state('old.json', 8)
        env = dict(os.environ, HOME=str(self.fx.home))
        run = lambda *args, stdin='': subprocess.run([sys.executable, '-I', str(plugin / 'hooks/bridge.py'), *args, '--session', 'cli'],
                                                      input=stdin, capture_output=True, text=True, env=env, timeout=30)
        diag = run('diagnose-config', stdin='{"generation":0,"record":false}')
        self.assertEqual(diag.returncode, 0, diag.stderr)
        out = json.loads(diag.stdout)
        self.assertEqual(ids(out['findings']), {'runtime-stale:old.json'})
        fix = run('apply-fix', stdin='{"generation":0,"ids":["runtime-stale:old.json"]}')
        self.assertEqual(fix.returncode, 0, fix.stderr)
        self.assertEqual(json.loads(fix.stdout)['results'][0]['status'], 'applied')
        self.assertFalse((plugin / 'runtime/old.json').exists())
        bad = run('apply-fix', stdin='{"generation":9,"ids":[]}')
        self.assertEqual(bad.returncode, 1)


class ApplyFixTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(self._tmp.name)
        self.s = b.fresh('fixture')

    def test_stale_state_archived_with_backup_hashes_validation_and_rollback(self):
        path = self.fx.state('old.json', 8, json.dumps({'schemaVersion': 1, 'session_id': 'old', 'note': 'keep-me'}))
        pre = sha(path)
        (result,) = self.fx.apply(self.s, ['runtime-stale:old.json'])
        self.assertEqual(result['status'], 'applied')
        self.assertFalse(path.exists())
        archived = Path(result['backup'])
        self.assertTrue(str(archived.resolve()).startswith(str((self.fx.base / 'runtime/archive').resolve())))
        self.assertEqual((result['preHash'], result['postHash'], sha(archived)), (pre, pre, pre))
        self.assertTrue(result['validated'])
        self.assertIn('runtime-stale:old.json', result['validation'])
        self.assertTrue(result['rollback'])
        self.assertEqual(len(self.s['fixes']), 1)
        self.assertEqual(stat_mode(archived), 0o600)
        # Rollback restores byte-identical content and is idempotent.
        done = self.fx.rollback(self.s, result['fixId'])
        self.assertEqual(done['status'], 'rolled-back')
        self.assertEqual(sha(path), pre)
        self.assertEqual(self.fx.rollback(self.s, result['fixId'])['status'], 'noop')

    def test_apply_is_idempotent(self):
        self.fx.state('old.json', 8)
        first = self.fx.apply(self.s, ['runtime-stale:old.json'])
        second = self.fx.apply(self.s, ['runtime-stale:old.json'])
        self.assertEqual(first[0]['status'], 'applied')
        self.assertEqual(second[0]['status'], 'noop')
        self.assertEqual(len(self.s['fixes']), 1)

    def test_rollback_conflict_preserves_both_versions(self):
        path = self.fx.state('old.json', 8)
        (result,) = self.fx.apply(self.s, ['runtime-stale:old.json'])
        path.write_text('concurrent new content')
        conflict = self.fx.rollback(self.s, result['fixId'])
        self.assertEqual(conflict['status'], 'conflict')
        self.assertIn('both preserved', conflict['reason'])
        self.assertEqual(path.read_text(), 'concurrent new content')
        self.assertEqual(sha(result['backup']), result['preHash'])
        self.assertTrue(self.s['fixes'][0].get('conflict'))

    def test_exec_bit_fix_backup_hashes_and_mode_rollback(self):
        script = self.fx.base / 'hooks/bridge.py'
        os.chmod(script, 0o644)
        pre = sha(script)
        (result,) = self.fx.apply(self.s, ['exec-bit:hooks/bridge.py'])
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(stat_mode(script), 0o744)
        self.assertEqual((result['preHash'], result['postHash'], sha(result['backup'])), (pre, pre, pre))
        self.assertTrue(result['validated'])
        self.assertEqual(self.fx.diagnose(), [])
        self.assertEqual(self.fx.rollback(self.s, result['fixId'])['status'], 'rolled-back')
        self.assertEqual(stat_mode(script), 0o644)

    def test_exec_bit_rollback_conflict_when_mode_changed_again(self):
        script = self.fx.base / 'hooks/bridge.py'
        os.chmod(script, 0o644)
        (result,) = self.fx.apply(self.s, ['exec-bit:hooks/bridge.py'])
        os.chmod(script, 0o700)
        self.assertEqual(self.fx.rollback(self.s, result['fixId'])['status'], 'conflict')
        self.assertEqual(stat_mode(script), 0o700)

    def test_exec_bit_rollback_conflict_when_bytes_changed(self):
        script = self.fx.base / 'hooks/bridge.py'
        os.chmod(script, 0o644)
        (result,) = self.fx.apply(self.s, ['exec-bit:hooks/bridge.py'])
        script.write_text('#!/usr/bin/env python3\nprint(2)\n')
        self.assertEqual(self.fx.rollback(self.s, result['fixId'])['status'], 'conflict')
        self.assertIn('print(2)', script.read_text())

    def test_apply_resolution_satisfies_resolve_incident_contract(self):
        script = self.fx.base / 'hooks/bridge.py'
        os.chmod(script, 0o644)
        (result,) = self.fx.apply(self.s, ['exec-bit:hooks/bridge.py'])
        resolution = result['resolution']
        self.assertEqual(set(resolution), {'source', 'backup', 'validation', 'rollback', 'preHash', 'postHash'})
        gen = self.s['generation']
        for path in (resolution['source'], resolution['backup']):
            self.s['receipts']['read-' + Path(path).name + str(len(self.s['receipts']))] = dict(
                id='r', tool='Read', ok=True, generation=gen, inspected=True, file=path, fileHash=sha(path), outputHash='h')
        keep = next(k for k, v in self.s['receipts'].items() if v['file'] == resolution['source'])
        self.s['receipts'][keep]['id'] = keep
        b.incident(self.s, 'hooks/bridge.py', 'actual failure', 'x')
        incident_key = next(iter(self.s['incidents']))
        self.s['incidents'][incident_key]['evidence'] = [dict(receipt=keep, pointer=dict(type='file', path=resolution['source'], sha256=sha(resolution['source'])))]
        with mock.patch.object(b, 'PLUGIN_BASE', self.fx.base), mock.patch.object(b, '__file__', str(self.fx.base / 'hooks/bridge.py')):
            b.control(self.s, 'resolve-incident', dict(generation=gen, id=incident_key, receipt=keep, **resolution))
        self.assertEqual(self.s['incidents'][incident_key]['status'], 'resolved')

    def test_settings_and_plugin_findings_are_never_applied(self):
        self.fx.settings({'Stop': [{'hooks': [{'type': 'command', 'command': '/nonexistent/guard.py'}]}]})
        self.fx.installed({'gone@m': [{'installPath': str(self.fx.tmp / 'gone')}]})
        settings_before = sha(self.fx.home / '.claude/settings.json')
        installed_before = sha(self.fx.home / '.claude/plugins/installed_plugins.json')
        results = self.fx.apply(self.s, ['settings-hook-missing:Stop/0/0', 'plugin-install-missing:gone@m/0'])
        self.assertEqual([r['status'] for r in results], ['refused', 'refused'])
        self.assertIn('/hooks/Stop/0/hooks/0', json.dumps(results[0]['patch']))
        self.assertIn('Sam', results[0]['reason'])
        self.assertEqual(sha(self.fx.home / '.claude/settings.json'), settings_before)
        self.assertEqual(sha(self.fx.home / '.claude/plugins/installed_plugins.json'), installed_before)
        self.assertEqual(self.s['fixes'], [])

    def test_path_traversal_and_foreign_ids_touch_nothing(self):
        outside = self.fx.tmp / 'outside.json'
        outside.write_text('{}')
        stamp = time.time() - 30 * DAY
        os.utime(outside, (stamp, stamp))
        results = self.fx.apply(self.s, ['runtime-stale:../../outside.json', 'runtime-stale:' + str(outside),
                                         'exec-bit:../../outside.json', 'exec-bit:' + str(outside), 'nonsense'])
        self.assertTrue(all(r['status'] in ('noop', 'refused') for r in results))
        self.assertTrue(outside.exists())
        self.assertEqual(outside.read_text(), '{}')
        self.assertEqual(self.s['fixes'], [])

    def test_symlink_in_runtime_is_never_moved(self):
        victim = self.fx.tmp / 'victim.json'
        victim.write_text('{}')
        link = self.fx.base / 'runtime/old.json'
        link.symlink_to(victim)
        stamp = time.time() - 30 * DAY
        os.utime(victim, (stamp, stamp))
        results = self.fx.apply(self.s, ['runtime-stale:old.json', 'runtime-symlink:old.json'])
        self.assertTrue(all(r['status'] in ('noop', 'refused') for r in results))
        self.assertTrue(link.is_symlink())
        self.assertEqual(victim.read_text(), '{}')

    def test_state_in_use_is_not_archived(self):
        self.fx.state('old.json', 8)
        import fcntl
        lock = self.fx.base / 'runtime/old.lock'
        lock.write_text('')
        with open(lock, 'r+') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            (result,) = self.fx.apply(self.s, ['runtime-stale:old.json'])
        self.assertEqual(result['status'], 'refused')
        self.assertIn('in use', result['reason'])
        self.assertTrue((self.fx.base / 'runtime/old.json').exists())

    def test_fixed_tree_diagnosis_is_clean_afterwards(self):
        self.fx.state('old.json', 8)
        self.fx.state('bad.json', 12, '{broken')
        self.fx.apply(self.s, ['runtime-stale:old.json', 'runtime-corrupt:bad.json'])
        self.assertEqual(self.fx.diagnose(), [])
        self.assertEqual(len(list((self.fx.base / 'runtime/archive').rglob('*.json'))), 2)

    def test_no_secret_values_in_any_output(self):
        self.fx.settings({'Stop': [{'hooks': [{'type': 'command', 'command': 'TOKEN=sk-SENTINEL-assign /nonexistent/g.py sk-SENTINEL-arg'}]}]},
                         env={'K': 'sk-SENTINEL-env'})
        self.fx.state('old.json', 8, json.dumps({'schemaVersion': 1, 'session_id': 'old', 'secret': 'sk-SENTINEL-state'}))
        out = json.dumps([self.fx.diagnose(), self.fx.apply(self.s, ['runtime-stale:old.json', 'settings-hook-missing:Stop/0/0']),
                          self.s['fixes']])
        for secret in SENTINELS:
            self.assertNotIn(secret, out)

    def test_state_schema_migrates_fixes_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root) as state:
                state['paused'] = False
            path = root / 's.json'
            old = json.loads(path.read_text())
            del old['fixes']
            old['outcomes']['x'] = dict(dod='d', owner='o', issue='TEAM-1', generation=0, dependencies=[], evidence=[], wait=None)
            path.write_text(json.dumps(old))
            with b.store('s', root) as state:
                self.assertEqual(state['fixes'], [])
                self.assertIn('x', state['outcomes'])
                self.assertNotEqual(state['phase'], 'diagnosis')


def stat_mode(path):
    return os.stat(path).st_mode & 0o777


if __name__ == '__main__':
    unittest.main()
