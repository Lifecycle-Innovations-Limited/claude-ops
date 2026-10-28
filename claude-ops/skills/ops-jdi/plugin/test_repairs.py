"""TEAM-1 regressions: real bridge events, no model or network."""
import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('repair_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Repairs(unittest.TestCase):
    def setUp(self):
        self.s = b.fresh('repair')
        b.event(self.s, {'hook_event_name': 'UserPromptSubmit', 'prompt': 'Build'})
        self.g = self.s['generation']

    def control(self, action, **data):
        return b.control(self.s, action, dict(generation=self.s['generation'], **data))

    def task(self, key, deps=(), status='pending'):
        b.event(self.s, dict(hook_event_name='PostToolUse', tool_name='TaskUpdate',
                            tool_use_id=key+str(len(self.s['seen'])), tool_input=dict(taskId=key, status=status, addBlockedBy=list(deps)), tool_response={}))

    def contract(self):
        self.control('contract', issue='TEAM-1', outcomes=[dict(id='result', dod='Written result', owner='session')])

    def stop(self, message='Incomplete: need evidence', **extra):
        return b.event(self.s, dict(hook_event_name='Stop', last_assistant_message=message, **extra))

    def receipt(self, tool='Bash', response=None, inp=None, key='r'):
        response = response or {'exit_code': 0, 'stdout': 'hello'}
        b.event(self.s, dict(hook_event_name='PostToolUse', tool_use_id=key, tool_name=tool, tool_input=inp or {}, tool_response=response))
        return dict(type='transcript', tool=tool, tool_use_id=key, outputHash=b.digest(response))

    def test_stale_wait_reconciles_reactivated_task(self):
        self.task('a')
        self.control('wait', id='a', kind='approval', pointer='request:1')
        b.event(self.s, dict(hook_event_name='UserPromptSubmit', prompt='New request'))
        self.task('a', status='in_progress')
        self.assertEqual(self.stop().get('decision'), 'block')
        self.assertIn('reconcile', self.s['next'].lower())

    def test_explicit_release_is_not_approval(self):
        self.task('a')
        self.control('wait', id='a', kind='approval', pointer='request:1')
        self.control('release-wait', id='a', pointer='actual reply requires review')
        self.assertEqual(self.stop().get('decision'), 'block')
        self.assertIsNone(self.s['tasks']['a']['wait'])

    def test_outcome_wait_transitive_release_and_independent(self):
        self.control('contract', issue='TEAM-1', outcomes=[dict(id=k, dod=k, owner='session', dependencies=d) for k,d in [('a',[]),('b',['a']),('c',['b'])]])
        self.control('wait', collection='outcomes', id='a', kind='prerequisite', pointer='condition:1')
        self.assertEqual(self.stop(), {})
        self.task('independent')
        self.assertIn('independent', self.stop()['reason'])
        self.control('release-wait', collection='outcomes', id='a', pointer='condition changed; inspect')
        self.assertIn('outcome a', self.stop()['reason'])

    def test_colon_ids_still_honor_waits(self):
        self.control('contract', issue='TEAM-1', outcomes=[dict(id='release:prod', dod='ship', owner='session')])
        self.control('wait', collection='outcomes', id='release:prod', kind='approval', pointer='request:2')
        self.assertEqual(self.stop(), {})
        self.task('deploy:eu')
        self.control('wait', id='deploy:eu', kind='approval', pointer='request:3')
        self.assertEqual(self.stop(), {})

    def test_exhaustion_requires_diagnostic_then_delivered_handoff(self):
        self.contract()
        self.stop(); self.stop()
        result = self.stop()
        self.assertEqual(result.get('decision'), 'block')
        self.assertIn('diagnos', result['reason'].lower())
        self.assertIsNone(self.s.get('handoff'))
        result = self.stop(stop_hook_active=True)
        self.assertEqual(self.s['phase'], 'incomplete; native loop ceiling')
        self.assertIn('incomplete', self.s['next'].lower())
        self.assertNotEqual(self.s['phase'], 'complete')

    def test_handoff_requires_real_transcript_and_generation(self):
        self.contract()
        self.stop()
        with self.assertRaises(ValueError):
            self.control('handoff', blocker='Missing evidence', pointer='/nonexistent', messageHash=b.digest('invented'))
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'transcript.jsonl'
            text = 'Incomplete: missing artifact; owner session; next inspect artifact'
            path.write_text(json.dumps(dict(type='assistant', uuid='m1', message=dict(content=[dict(type='text', text=text)])))+'\n')
            self.stop(text, transcript_path=str(path))
            self.control('handoff', blocker='Missing artifact', pointer=dict(type='transcript-message', path=str(path), message_id='m1', messageHash=b.digest(text)))
            self.assertEqual(self.s['handoff']['generation'], self.s['generation'])
            self.assertEqual(self.stop(text, transcript_path=str(path)), {})
            b.event(self.s, dict(hook_event_name='UserPromptSubmit', prompt='Change'))
            self.assertIsNone(self.s['handoff'])

    def test_nonexistent_untyped_and_wrong_receipt_rejected(self):
        self.contract()
        pointer = self.receipt()
        for bad in ('/nonexistent', dict(type='file', path='/nonexistent', sha256='a'*64), dict(pointer, tool='Read'), dict(pointer, outputHash='a'*64)):
            with self.subTest(pointer=bad), self.assertRaises(ValueError):
                self.control('evidence', id='result', receipt='r', pointer=bad, inspection='looked')
        self.assertTrue(b.pending(self.s))
        self.control('evidence', id='result', receipt='r', pointer=pointer, inspection='hello only, not semantic proof')
        self.assertFalse(b.pending(self.s))
        self.assertNotIn('stdout', self.s['receipts']['r'])

    def test_file_evidence_read_hash_and_later_mutation(self):
        self.contract()
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'result'; p.write_text('result')
            pointer = dict(type='file', path=str(p), sha256=hashlib.sha256(p.read_bytes()).hexdigest())
            self.receipt('Read', {'content': 'result'}, {'file_path': str(p)})
            self.control('evidence', id='result', receipt='r', pointer=pointer, inspection='actual file')
            self.assertFalse(b.pending(self.s))
            p.write_text('changed')
            self.assertTrue(b.pending(self.s))
            with self.assertRaises(ValueError):
                self.control('evidence', id='result', receipt='r', pointer=pointer, inspection='stale')

    def test_incident_forged_files_cannot_resolve(self):
        b.incident(self.s, 'fixture', 'actual failure')
        key = next(iter(self.s['incidents']))
        pointer = self.receipt()
        self.control('evidence', collection='incidents', id=key, receipt='r', pointer=pointer, inspection='hello')
        with self.assertRaises(ValueError):
            self.control('resolve-incident', id=key, receipt='r', backup='/nonexistent', source='/nonexistent', preHash='a'*64, postHash='b'*64, validation='hello', rollback='asserted')

    def test_forged_file_hash_and_wrong_read_path(self):
        self.contract()
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'result'; p.write_text('result')
            self.receipt('Read', {'content': 'result'}, {'file_path': str(p)})
            for path, sha in [(str(p), 'a'*64), (str(Path(td)/'other'), b.file_hash(str(p)))]:
                with self.assertRaises(ValueError):
                    self.control('evidence', id='result', receipt='r', pointer=dict(type='file', path=path, sha256=sha), inspection='wrong')

    def test_transitive_evidence_dependencies_stay_pending(self):
        self.control('contract', issue='TEAM-1', outcomes=[dict(id=k, dod=k, owner='session', dependencies=d) for k,d in [('a',[]),('b',['a']),('c',['b'])]])
        pointer = self.receipt()
        for key in ('b','c'):
            self.control('evidence', id=key, receipt='r', pointer=pointer, inspection='index only')
        self.assertIn('outcome c: c', b.pending(self.s))

    def test_smoke_refuses_without_explicit_opt_in_and_budget(self):
        smoke = str(Path(__file__).parent / 'smoke.py')
        for extra in ([], ['--run-paid-smoke'], ['--max-budget-usd', '0.5'], ['--run-paid-smoke', '--max-budget-usd', '5']):
            result = subprocess.run(['python3', '-I', smoke] + extra, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, extra)

    def test_relocated_copy_and_auditor_contract(self):
        root = Path(__file__).parent
        with tempfile.TemporaryDirectory() as td:
            relocated = Path(td)/'plugin'; shutil.copytree(root/'hooks', relocated/'hooks')
            config = json.loads((relocated/'hooks/hooks.json').read_text())
            stop_hooks = config['hooks']['Stop'][0]['hooks']
            self.assertEqual([h['type'] for h in stop_hooks], ['command'])
            self.assertNotIn(str(root), stop_hooks[0]['command'])
            self.assertIn('CLAUDE_PLUGIN_ROOT', stop_hooks[0]['command'])
            self.assertNotIn('prompt', stop_hooks[0])
            self.assertNotIn('model', stop_hooks[0])
            result = subprocess.run(['python3', '-I', str(relocated/'hooks/bridge.py')],
                input=json.dumps(dict(hook_event_name='UserPromptSubmit', session_id='relocated', prompt='test')),
                text=True, capture_output=True, check=True)
            context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
            self.assertIn(str(relocated/'hooks/bridge.py'), context)
            self.assertTrue((relocated/'runtime/relocated.json').is_file())
            state = json.loads((relocated/'runtime/relocated.json').read_text())
            self.assertEqual(state['generation'], 1)
            result = subprocess.run(['python3', '-I', str(relocated/'hooks/bridge.py'), 'pause', '--session', 'relocated'],
                text=True, capture_output=True, check=True)
            self.assertTrue(json.loads(result.stdout)['paused'])


class SmokeRecipe(unittest.TestCase):
    def test_recipe_never_passes_stale_revision_to_bridge(self):
        # Live smoke failed twice on revision conflicts: every tool call bumps the revision.
        text = (Path(__file__).parent / 'smoke.py').read_text()
        self.assertNotIn('"revision":<revision>', text)
        self.assertIn('Never include a revision field', text)


if __name__ == '__main__':
    unittest.main()
