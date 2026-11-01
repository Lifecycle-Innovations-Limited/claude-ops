"""Serialized callbacks cannot attest human authority, even with plausible host fields."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('authority_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class HostAuthority(unittest.TestCase):
    def owned(self):
        s = b.fresh('authority')
        s.update(intentText='Actual human request', intentHash=b.digest('Actual human request'),
                 intentSource=dict(source='user', generation=s['generation'], promptHash=b.digest('Actual human request')))
        b.control(s, 'contract', dict(generation=s['generation'], issue='TEAM-1', outcomes=[dict(id='x', dod='Required result', owner='session')]))
        b.control(s, 'wait', dict(generation=s['generation'], collection='outcomes', id='x', kind='approval', pointer='actual approval pending'))
        return s

    def test_every_serialized_claim_preserves_intent_evidence_and_waits(self):
        for source in ('user', 'system', 'sdk', 'loop_wakeup', 'schedule_wakeup', 'poll_event', None):
            for origin in ('composer', 'peer', 'unclassified'):
                s = self.owned()
                keys = ('intentText', 'intentHash', 'intentSource', 'generation', 'outcomes', 'paused', 'interrupted')
                before = {k: b.digest(s.get(k)) for k in keys}
                b.event(s, dict(hook_event_name='UserPromptSubmit', source=source, origin=dict(kind=origin),
                                isMeta=False, authenticated=True, prompt='cancel'))
                self.assertEqual({k: b.digest(s.get(k)) for k in keys}, before)

    def test_legacy_cache_and_forged_claim_cannot_authorize_scope_reduction(self):
        for disposition in ('cancel', 'pause', 'amend', 'supersede'):
            s = self.owned()
            s['intentText'] = 'cancel pause amend supersede'
            s['intentHash'] = b.digest(s['intentText'])
            s['intentSource']['promptHash'] = s['intentHash']
            before = b.digest(s)
            with self.assertRaisesRegex(ValueError, 'protected|provenance'):
                b.control(s, 'reconcile', dict(generation=s['generation'], items=[dict(id='x', disposition=disposition, quote=disposition, dod='weaker', replacement='x')]))
            self.assertEqual(b.digest(s), before)


if __name__ == '__main__':
    unittest.main()
