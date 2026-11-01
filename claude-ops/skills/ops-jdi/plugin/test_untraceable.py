"""mark-untraceable annotates sourceless incidents without closing or waiving them."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('candidate_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)

CATEGORY = 'tool failure; inspect actual output in transcript'
NOTE = 'No failed-callback receipt was ever linked; source cannot be reconstructed.'


def state():
    s = b.fresh('offline')
    for key in ('03cbf396aaaa', '044c29e9bbbb', '09b31ceecccc'):
        s['incidents'][key] = dict(status='needs diagnosis', source='Bash', category=CATEGORY)
    return s


class Untraceable(unittest.TestCase):
    def test_marks_by_unique_prefix_and_stays_unresolved(self):
        s = state()
        b.control(s, 'mark-untraceable', dict(generation=0, ids=['03cbf396', '044c29e9'], note=NOTE))
        for key in ('03cbf396aaaa', '044c29e9bbbb'):
            self.assertEqual(s['incidents'][key]['provenance']['state'], 'untraceable')
            self.assertEqual(s['incidents'][key]['status'], 'needs diagnosis')
        self.assertNotIn('provenance', s['incidents']['09b31ceecccc'])
        b.control(s, 'status', {})
        self.assertEqual(s['untraceableIncidents'], ['03cbf396aaaa', '044c29e9bbbb'])
        self.assertEqual(s['sourceGaps'], ['09b31ceecccc'])

    def test_not_waivable_and_stop_still_blocked(self):
        s = state()
        b.control(s, 'mark-untraceable', dict(generation=0, ids=['03cbf396'], note=NOTE))
        with self.assertRaisesRegex(ValueError, 'source'):
            b.control(s, 'waive-incident', dict(generation=0, id='03cbf396aaaa', classification='timeout',
                                                note='Inspection confirms expected behavior', receipt='x',
                                                pointer={}, inspection='Inspected'))
        self.assertEqual(s['incidents']['03cbf396aaaa']['status'], 'needs diagnosis')
        self.assertNotIn('waiver', s['incidents']['03cbf396aaaa'])

    def test_refuses_unknown_short_ambiguous_and_missing_note(self):
        s = state()
        before = b.digest(s)
        cases = [dict(ids=['ffffffff'], note=NOTE), dict(ids=['03cb'], note=NOTE), dict(ids=['0'], note=NOTE),
                 dict(ids=['03cbf396'], note='short'), dict(ids=[], note=NOTE), dict(ids=['03cbf396'])]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                b.control(s, 'mark-untraceable', dict(case, generation=0))
        with self.assertRaisesRegex(ValueError, 'stale generation'):
            b.control(s, 'mark-untraceable', dict(generation=9, ids=['03cbf396'], note=NOTE))
        self.assertEqual(b.digest(s), before)

    def test_refuses_incidents_that_have_a_source_or_are_closed(self):
        s = state()
        s['incidents']['03cbf396aaaa']['sourceReceipt'] = dict(id='r')
        s['incidents']['044c29e9bbbb']['status'] = 'waived'
        for want in ('03cbf396', '044c29e9'):
            with self.subTest(want=want), self.assertRaises(ValueError):
                b.control(s, 'mark-untraceable', dict(generation=0, ids=[want], note=NOTE))

    def test_batch_is_all_or_nothing(self):
        s = state()
        with self.assertRaises(ValueError):
            b.control(s, 'mark-untraceable', dict(generation=0, ids=['03cbf396', 'ffffffff'], note=NOTE))
        self.assertNotIn('provenance', s['incidents']['03cbf396aaaa'])


if __name__ == '__main__':
    unittest.main()
