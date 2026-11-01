"""Unbound native observations invalidate recognition without conferring authority."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('barrier_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class DeliveryBarrier(unittest.TestCase):
    def ready(self):
        s = b.fresh('barrier')
        b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Required result', owner='session')]))
        b.event(s, dict(hook_event_name='PostToolUse', tool_name='Bash', tool_use_id='proof', tool_response={'result': 'actual'}))
        r = s['receipts']['proof']
        self.evidence = dict(generation=0, id='x', receipt='proof', inspection='Inspected actual result',
                             pointer=dict(type='transcript', tool='Bash', tool_use_id='proof', outputHash=r['outputHash']))
        b.control(s, 'evidence', self.evidence)
        b.control(s, 'deliver', dict(generation=0, outcomes=['x'], text='Old final'))
        self.assertEqual(b.event(s, dict(hook_event_name='Stop', last_assistant_message='Old final')), {})
        self.assertTrue(s['phase'].startswith('delivered;'))
        return s

    def test_unknown_peer_and_human_claims_cannot_replay_old_delivery(self):
        for fields in ({}, {'source': 'unknown'}, {'source': 'system', 'origin': {'kind': 'peer'}, 'isMeta': True},
                       {'source': 'user', 'origin': {'kind': 'composer'}, 'authenticated': True}):
            with self.subTest(fields=fields):
                s = self.ready()
                preserved = {k: b.digest(s[k]) for k in ('generation', 'outcomes', 'receipts', 'deliveries')}
                s['audit'] = dict(generation=0, requests=1, stale=False)
                b.event(s, dict(hook_event_name='UserPromptSubmit', prompt='Different request', **fields))
                self.assertEqual({k: b.digest(s[k]) for k in preserved}, preserved)
                b.event(s, dict(hook_event_name='Stop', last_assistant_message='Old final'))
                self.assertFalse(s['phase'].startswith('delivered;'), 'Old delivery survived a different unbound request')
                self.assertEqual(s['observationRevision'], 1)
                self.assertTrue(s['promptBindingPending'])
                self.assertTrue(s['audit']['stale'])
                self.assertFalse(b.has_evidence(s, s['outcomes']['x']))
                b.event(s, dict(hook_event_name='Stop', last_assistant_message='Old final'))
                self.assertFalse(s['phase'].startswith('delivered;'))
                self.assertIn('binding', s['next'])

    def test_cli_refresh_cannot_clear_unresolved_binding(self):
        s = self.ready()
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='Different request'))
        # Reinspection and a newly recorded candidate are allowed as observations,
        # but neither is an authority channel or a resolution of the binding gap.
        b.control(s, 'evidence', self.evidence)
        self.assertTrue(b.has_evidence(s, s['outcomes']['x']))
        b.control(s, 'deliver', dict(generation=0, outcomes=['x'], text='New final',
                                   authenticated=True, promptBindingPending=False, observationRevision=0))
        b.control(s, 'audit-record', dict(generation=0, verdict='ADEQUAAT'))
        b.event(s, dict(hook_event_name='Stop', last_assistant_message='New final'))
        self.assertTrue(s['promptBindingPending'])
        self.assertFalse(s['phase'].startswith('delivered;'))
        self.assertIn('binding', s['next'])
        b.control(s, 'pause', {})
        b.control(s, 'resume', {})
        self.assertTrue(s['promptBindingPending'])

    def test_waits_and_background_notifications_survive_barrier(self):
        for kind in ('approval', 'prerequisite', 'background'):
            s = self.ready()
            b.control(s, 'wait', dict(generation=0, collection='outcomes', id='x', kind=kind, pointer='Actual prerequisite'))
            before = b.digest(s['outcomes']['x']['wait'])
            b.event(s, dict(hook_event_name='UserPromptSubmit', source='system', prompt='Peer finished'))
            self.assertEqual(b.digest(s['outcomes']['x']['wait']), before)
            self.assertEqual(b.event(s, dict(hook_event_name='Stop', last_assistant_message='Waiting')), {})
            self.assertEqual(s['phase'], 'waiting prerequisite')
            self.assertTrue(s['promptBindingPending'])
        s = b.fresh('background')
        b.event(s, dict(hook_event_name='UserPromptSubmit', prompt='Notification'))
        self.assertEqual(b.event(s, dict(hook_event_name='Stop', background_tasks=[dict(status='running')])), {})
        self.assertEqual(s['phase'], 'waiting background notification')

    def test_status_question_yields_without_claiming_delivery_or_dropping_work(self):
        s = self.ready()
        b.event(s, dict(hook_event_name='UserPromptSubmit', prompt='What is the status?'))
        self.assertEqual(b.event(s, dict(hook_event_name='Stop', last_assistant_message='Status only')), {})
        self.assertEqual(s['phase'], 'question answered; prompt binding unresolved')
        self.assertIn('x', s['outcomes'])
        self.assertTrue(s['promptBindingPending'])

    def test_each_observation_stales_reinspection_and_mechanical_checks(self):
        s = self.ready()
        for revision in (1, 2):
            b.event(s, dict(hook_event_name='UserPromptSubmit', prompt='Same text'))
            self.assertEqual(s['observationRevision'], revision)
            self.assertFalse(b.has_evidence(s, s['outcomes']['x']))
            b.control(s, 'evidence', self.evidence)
            self.assertTrue(b.has_evidence(s, s['outcomes']['x']))
        with tempfile.TemporaryDirectory() as td:
            path = Path(td).resolve() / 'result'
            path.write_text('actual bytes')
            s['outcomes']['x']['criteria'] = [dict(id='bytes', kind='file-sha256', path=str(path), sha256=b.file_hash(str(path)))]
            b.control(s, 'check-outcome', dict(generation=0, id='x'))
            self.assertTrue(b.mechanical_ready(s, s['outcomes']['x']))
            b.event(s, dict(hook_event_name='UserPromptSubmit', prompt='Another observation'))
            self.assertFalse(b.mechanical_ready(s, s['outcomes']['x']))
            b.control(s, 'check-outcome', dict(generation=0, id='x'))
            self.assertTrue(b.mechanical_ready(s, s['outcomes']['x']))
            self.assertTrue(s['promptBindingPending'])

    def test_legacy_cache_migration_preserves_history_and_barrier_persists(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / 'state'
            s = self.ready()
            s.pop('observationRevision', None)
            s.pop('promptBindingPending', None)
            with b.store('barrier', root) as saved:
                saved.update(s)
            with b.store('barrier', root) as saved:
                b.event(saved, dict(hook_event_name='UserPromptSubmit', prompt='Different request'))
            with b.store('barrier', root) as saved:
                self.assertTrue(saved['promptBindingPending'])
                self.assertEqual(saved['observationRevision'], 1)
                self.assertIn('proof', saved['receipts'])
                b.event(saved, dict(hook_event_name='Stop', last_assistant_message='Old final', stop_hook_active=True))
                self.assertTrue(saved['phase'].startswith('incomplete;'))


if __name__ == '__main__':
    unittest.main()
