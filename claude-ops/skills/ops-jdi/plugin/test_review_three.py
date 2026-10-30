"""TEST-1 regressions for contract continuity and bounded own diagnosis."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('review_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


class ReviewThree(unittest.TestCase):
    def state(self):
        s = b.fresh('review')
        rows = [dict(id=k, dod=k, owner='session') for k in ('x', 'y')]
        b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=rows))
        b.invalidate(s)  # seed a stale-generation obligation independently of untrusted ingress
        for item in s['outcomes'].values():
            item['needsReconciliation'] = True
        return s, rows

    def test_redeclare_cannot_clear_stale_obligations(self):
        s, rows = self.state()
        before = b.digest(s)
        try:
            b.control(s, 'contract', dict(generation=1, issue='TEAM-1', outcomes=rows))
        except ValueError:
            pass
        self.assertEqual(b.digest(s), before)
        with self.assertRaisesRegex(ValueError, 'every'):
            b.control(s, 'reconcile', dict(generation=1, items=[dict(id='x', disposition='retain')]))
        self.assertEqual(b.digest(s), before)
        self.assertIn('outcome y', '\n'.join(b.pending(s)))

    def test_contract_rejects_owner_dod_criteria_or_issue_mutation(self):
        for change in (dict(owner='peer'), dict(dod='new'), dict(criteria=[dict(id='meaning', kind='semantic')]), dict(issue='TEAM-2')):
            s, rows = self.state()
            row = dict(rows[0], **{k: v for k, v in change.items() if k != 'issue'})
            before = b.digest(s)
            with self.assertRaises(ValueError):
                b.control(s, 'contract', dict(generation=1, issue=change.get('issue', 'TEAM-1'), outcomes=[row]))
            self.assertEqual(b.digest(s), before)

    def test_reconcile_covers_same_generation_obligations(self):
        s, _ = self.state()
        s['outcomes']['y']['generation'] = 1
        before = b.digest(s)
        with self.assertRaisesRegex(ValueError, 'every'):
            b.control(s, 'reconcile', dict(generation=1, items=[dict(id='x', disposition='retain')]))
        self.assertEqual(b.digest(s), before)

    def test_add_requires_valid_or_explicitly_inherited_issue(self):
        for issue in (None, '', 'arbitrary', 123):
            s, _ = self.state()
            before = b.digest(s)
            rows = [dict(id=k, disposition='retain') for k in ('x', 'y')]
            rows.append(dict(id='z', disposition='add', quote='add z', dod='z', owner='peer'))
            with self.assertRaises(ValueError):
                b.control(s, 'reconcile', dict(generation=1, issue=issue, items=rows))
            self.assertEqual(b.digest(s), before)
        for issue in ('TEAM-2', 'inherit'):
            s, _ = self.state()
            rows = [dict(id='x', disposition='amend', quote='amend x', dod='updated'), dict(id='y', disposition='cancel', quote='cancel y'), dict(id='z', disposition='add', quote='add z', dod='z', owner='peer')]
            data = dict(generation=1, items=rows)
            data.update(dict(inheritIssueFrom='x') if issue == 'inherit' else dict(issue=issue))
            before = b.digest(s)
            with self.assertRaisesRegex(ValueError, 'protected human provenance'):
                b.control(s, 'reconcile', data)
            self.assertEqual(b.digest(s), before)

    def test_question_retains_pending_work_without_forcing_execution(self):
        s, _ = self.state()
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='What is the status?'))
        before = b.digest(s['outcomes'])
        self.assertEqual(b.event(s, dict(hook_event_name='Stop', last_assistant_message='Work remains open')), {})
        self.assertEqual(b.digest(s['outcomes']), before)
        self.assertIn('outcome x', s['next'])
        self.assertIn('outcome y', s['next'])
        self.assertEqual(len(b.pending(s)), 2)

    def test_own_diagnosis_never_probes_declared_outside_paths(self):
        for declaration in ('/outside/private.py', '../../outside.py', 'unknown.py', None, {}, 42):
            with self.subTest(declaration=declaration), tempfile.TemporaryDirectory() as temp:
                base = Path(temp).resolve()
                (base / '.claude-plugin').mkdir()
                (base / 'hooks').mkdir()
                (base / '.claude-plugin/plugin.json').write_text(json.dumps(dict(types=declaration)))
                command = 'python3 ' + (declaration if isinstance(declaration, str) else '/outside/private.py')
                (base / 'hooks/hooks.json').write_text(json.dumps(dict(modules=[declaration], hooks=dict(Stop=[dict(hooks=[dict(command=command)])]))))
                with patch.object(b, 'script_problem', side_effect=AssertionError('unbounded script probe')), patch.object(Path, 'exists', side_effect=AssertionError('unbounded exists probe')), patch.object(b, 'on_path', side_effect=AssertionError('PATH probe')):
                    b.diagnose_config(base=base, own_only=True)

    def test_normal_owned_relative_declarations_remain_supported(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            for directory in ('.claude-plugin', 'hooks', 'types'):
                (base / directory).mkdir()
            (base / '.claude-plugin/plugin.json').write_text(json.dumps(dict(types='./types/index.d.ts')))
            (base / 'hooks/hooks.json').write_text(json.dumps(dict(modules=['./register.tsx'])))
            (base / 'types/index.d.ts').write_text('// types')
            (base / 'hooks/register.tsx').write_text('// module')
            self.assertEqual(b.diagnose_config(base=base, own_only=True), [])

    def test_own_symlinks_never_open_outside_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            base = root / 'plugin'
            base.mkdir()
            (base / '.claude-plugin').mkdir()
            outside = root / 'outside'
            outside.mkdir()
            (base / 'hooks').symlink_to(outside, target_is_directory=True)
            (base / '.claude-plugin/plugin.json').write_text(json.dumps(dict(types='types/index.d.ts')))
            (base / 'types').symlink_to(outside, target_is_directory=True)
            original = b.os.open
            def watch(path, flags, *args, **kwargs):
                self.assertFalse(str(path).startswith(str(outside)))
                if str(path) in ('hooks', 'types'):
                    self.assertTrue(flags & b.os.O_NOFOLLOW)
                return original(path, flags, *args, **kwargs)
            with patch.object(b.os, 'open', side_effect=watch), patch.object(Path, 'exists', side_effect=AssertionError('following exists')):
                b.diagnose_config(base=base, own_only=True)


if __name__ == '__main__':
    unittest.main()
