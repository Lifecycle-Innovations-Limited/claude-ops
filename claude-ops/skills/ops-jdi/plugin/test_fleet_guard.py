import copy
import importlib.util
import json
from pathlib import Path
import unittest
from typing import Any, Callable

SPEC = importlib.util.spec_from_file_location(
    'fleet_guard', Path(__file__).parent / 'hooks/fleet_guard.py'
)
assert SPEC is not None and SPEC.loader is not None
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)


def snapshot(sid='session-a') -> dict[str, Any]:
    return dict(
        schemaVersion=1,
        sessionId=sid,
        generation=1,
        contractHash='contract-a',
        evidenceSetHash='evidence-a',
        transcriptIdentity='transcript-a',
        observedAt=100,
        paused=False,
        stopped=False,
        approval='clear',
        owner=dict(state='known', sessionId=sid, refs=['message:request']),
        authority=dict(
            state='authorized', contractHash='contract-a', refs=['message:request']
        ),
        eligibility=dict(state='stalled', refs=['receipt:progress']),
        coverage=dict(
            complete=True,
            gaps=[],
            messageCount=2,
            receiptCount=1,
            transcriptIdentity='transcript-a',
            messageIds=['request', 'claim'],
            receiptIds=['progress'],
        ),
        messages=[
            dict(
                id='request',
                role='user',
                origin='human',
                text='Build a widget. Demonstrate its output.',
            ),
            dict(id='claim', role='assistant', text='The widget is complete.'),
        ],
        receipts=[dict(id='progress', text='Widget output was not produced.')],
    )


def judgment(s):
    return dict(
        schemaVersion=1,
        binding=g.binding(s),
        verdict='HIATEN',
        obligations=[
            dict(
                id='widget',
                text='Build a widget',
                sourceRefs=['message:request'],
                dod=[dict(text='Demonstrate output', refs=['message:request'])],
            )
        ],
        findings=[
            dict(
                obligationId='widget',
                assertion='The completion claim lacks output.',
                refs=['message:claim', 'receipt:progress'],
            )
        ],
        proposedNextAction=dict(
            kind='continue',
            ownerSessionId=s['sessionId'],
            obligationIds=['widget'],
            text='Produce and inspect widget output.',
        ),
        expiresAt=200,
        usage=dict(input_tokens=10, output_tokens=10),
        reviewerProvenance=dict(model='fixture-model', requestId='judge-a'),
    )


class MemoryState:
    """Test double only; production state must be durable and atomic."""

    def __init__(self, data=None):
        self.data = copy.deepcopy(data or {})

    async def get(self, key):
        return copy.deepcopy(self.data.get(key))

    async def reserve(self, key, record):
        if key in self.data:
            return False
        self.data[key] = copy.deepcopy(record)
        return True

    async def put(self, key, record):
        self.data[key] = copy.deepcopy(record)


class FakeHost:
    def __init__(self):
        self.s = snapshot()
        self.calls = []
        self.reads = 0
        self.change: Callable[[dict], Any] | None = None
        self.adjust_judge: Callable[[dict], Any] | None = None
        self.pages: dict[str | None, dict[str, Any]] = {
            None: dict(
                enumerationId='scan-a',
                sessions=['session-a'],
                nextCursor=None,
                complete=True,
                total=1,
                gaps=[],
            )
        }
        self.delivery = 'delivered'
        self.judge_error = False

    async def list_sessions(self, cursor):
        self.calls.append(('list', cursor))
        return copy.deepcopy(self.pages[cursor])

    async def read_snapshot(self, sid):
        self.calls.append(('read', sid))
        self.reads += 1
        s = copy.deepcopy(self.s)
        if sid != 'session-a':
            s['sessionId'] = sid
            s['owner']['sessionId'] = sid
        if self.reads > 1 and self.change:
            self.change(s)
        return s

    async def judge(self, s, instructions):
        self.calls.append(('judge', copy.deepcopy(s), instructions))
        if self.judge_error:
            raise RuntimeError('fixture judge failure')
        result = judgment(s)
        if self.adjust_judge:
            self.adjust_judge(result)
        return result

    async def nudge(self, sid, action, expected, idempotency_key):
        self.calls.append(
            ('nudge', sid, copy.deepcopy(action), expected, idempotency_key)
        )
        if self.delivery == 'exception':
            raise TimeoutError('delivery not observed')
        return dict(
            status=self.delivery,
            sessionId=sid,
            idempotencyKey=idempotency_key,
            receiptRef='native-receipt-a' if self.delivery == 'delivered' else None,
        )


class FleetGuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.host = FakeHost()
        self.state = MemoryState()

    async def run_guard(self, **kw):
        return await g.run_once(self.host, self.state, now=lambda: 110, **kw)

    def nudges(self):
        return [c for c in self.host.calls if c[0] == 'nudge']

    async def test_capture_judge_fresh_read_nudge_receipt(self):
        report = await self.run_guard()
        self.assertEqual(
            [c[0] for c in self.host.calls], ['list', 'read', 'judge', 'read', 'nudge']
        )
        row = report['sessions'][0]
        self.assertEqual(row['status'], 'nudged')
        self.assertEqual(row['receipt']['receiptRef'], 'native-receipt-a')
        self.assertEqual(
            self.nudges()[0][3], dict(g.binding(self.host.s), expiresAt=200)
        )
        self.assertIn('transcript', self.host.calls[2][2])
        self.assertEqual(row['judgment']['usage']['input_tokens'], 10)

    async def test_false_completion_is_eligible(self):
        self.host.s['eligibility']['state'] = 'false-completion'
        self.assertEqual((await self.run_guard())['sessions'][0]['status'], 'nudged')

    async def test_missing_dod_is_uncertain(self):
        self.host.adjust_judge = lambda r: r['obligations'][0].update(dod=[])
        self.assertEqual((await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER')
        self.assertFalse(self.nudges())

    async def test_invented_references_rejected(self):
        for location in ('finding', 'dod', 'source'):
            with self.subTest(location=location):
                self.state = MemoryState()

                def mutate(r):
                    if location == 'finding':
                        r['findings'][0]['refs'] = ['receipt:invented']
                    elif location == 'dod':
                        r['obligations'][0]['dod'][0]['refs'] = ['message:invented']
                    else:
                        r['obligations'][0]['sourceRefs'] = ['message:invented']

                self.host.adjust_judge = mutate
                self.assertEqual(
                    (await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER'
                )
        self.assertFalse(self.nudges())

    async def test_safety_states_block_nudges(self):
        changes = [
            lambda s: s.update(paused=True),
            lambda s: s.update(stopped=True),
            lambda s: s.update(approval='pending'),
            lambda s: s.update(approval='unknown'),
            lambda s: s['authority'].update(state='unknown'),
            lambda s: s['owner'].update(state='unknown'),
            lambda s: s['owner'].update(sessionId='other-session'),
            lambda s: s['eligibility'].update(state='busy'),
            lambda s: s['eligibility'].update(refs=[]),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.host = FakeHost()
                self.state = MemoryState()
                change(self.host.s)
                await self.run_guard()
                self.assertFalse(self.nudges())

    async def test_stale_scope_transcript_and_safety_changes_prevent_send(self):
        changes = [
            lambda s: s.update(generation=2),
            lambda s: s.update(contractHash='changed'),
            lambda s: s.update(evidenceSetHash='changed'),
            lambda s: s.update(transcriptIdentity='changed'),
            lambda s: s.update(paused=True),
            lambda s: s.update(stopped=True),
            lambda s: s.update(approval='pending'),
            lambda s: s['messages'][0].update(text='Changed scope'),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.host = FakeHost()
                self.state = MemoryState()
                self.host.change = change
                self.assertEqual(
                    (await self.run_guard())['sessions'][0]['status'], 'stale'
                )
                self.assertFalse(self.nudges())

    async def test_dedupe_survives_restart(self):
        await self.run_guard()
        self.state = MemoryState(json.loads(json.dumps(self.state.data)))
        self.host.reads = 0
        await self.run_guard()
        self.assertEqual(len([c for c in self.host.calls if c[0] == 'judge']), 1)
        self.assertEqual(len(self.nudges()), 1)
        self.host.s['generation'] = 2
        await self.run_guard()
        self.assertEqual(len([c for c in self.host.calls if c[0] == 'judge']), 2)

    async def test_observation_time_alone_does_not_trigger_another_judge(self):
        self.host.adjust_judge = lambda r: r.update(
            verdict='ONZEKER', proposedNextAction=None
        )
        await self.run_guard()
        self.host.s['observedAt'] = 105
        await self.run_guard()
        self.assertEqual(len([c for c in self.host.calls if c[0] == 'judge']), 1)

    async def test_pagination_enumerates_every_session_before_effects(self):
        self.host.pages = {
            None: dict(
                enumerationId='scan-a',
                sessions=['session-a'],
                nextCursor='page-b',
                complete=False,
                total=2,
                gaps=[],
            ),
            'page-b': dict(
                enumerationId='scan-a',
                sessions=['session-b'],
                nextCursor=None,
                complete=True,
                total=2,
                gaps=[],
            ),
        }
        result = await self.run_guard()
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(result['coverage']['sessionIds'], ['session-a', 'session-b'])
        self.assertEqual([c[0] for c in self.host.calls][:2], ['list', 'list'])
        self.assertEqual(len(self.nudges()), 2)

    async def test_pagination_gaps_no_effects(self):
        mutations = [
            lambda p: p.update(complete=False),
            lambda p: p.update(total=2),
            lambda p: p.update(gaps=['hidden session']),
            lambda p: p.update(nextCursor='loop'),
            lambda p: p.pop('complete'),
        ]
        for mutate in mutations:
            self.host = FakeHost()
            self.state = MemoryState()
            mutate(self.host.pages[None])
            self.host.pages['loop'] = self.host.pages[None]
            result = await self.run_guard()
            self.assertFalse(result['coverage']['complete'])
            self.assertTrue(result['gaps'])
            self.assertFalse(self.nudges())

    async def test_missing_snapshot_fields_and_coverage_uncertain(self):
        for field in snapshot():
            self.host = FakeHost()
            self.state = MemoryState()
            del self.host.s[field]
            result = await self.run_guard()
            self.assertEqual(result['sessions'][0]['verdict'], 'ONZEKER', field)
            self.assertFalse(self.nudges())

    async def test_partial_transcript_is_uncertain(self):
        self.host.s['coverage']['complete'] = False
        self.assertEqual((await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER')
        self.assertFalse(self.nudges())

    async def test_manifest_omission_and_peer_authority_are_uncertain(self):
        changes = [
            lambda s: s['coverage'].update(messageIds=['request']),
            lambda s: s['coverage'].update(receiptIds=[]),
            lambda s: s['messages'][0].update(origin='peer'),
            lambda s: s['messages'][0].pop('origin'),
        ]
        for change in changes:
            self.host = FakeHost()
            self.state = MemoryState()
            change(self.host.s)
            result = await self.run_guard()
            self.assertEqual(result['sessions'][0]['verdict'], 'ONZEKER')
            self.assertFalse(self.nudges())

    async def test_malformed_judge_never_retried_for_same_snapshot(self):
        for field in judgment(snapshot()):
            self.host = FakeHost()
            self.state = MemoryState()
            self.host.adjust_judge = lambda r: r.pop(field)
            await self.run_guard()
            await self.run_guard()
            self.assertFalse(self.nudges(), field)
            self.assertEqual(
                len([c for c in self.host.calls if c[0] == 'judge']), 1, field
            )

    async def test_ai_cannot_change_owner_or_bindings(self):
        for mutate in (
            lambda r: r['proposedNextAction'].update(ownerSessionId='other'),
            lambda r: r['binding'].update(generation=99),
            lambda r: r['proposedNextAction'].update(kind='grant-authority'),
        ):
            self.host = FakeHost()
            self.state = MemoryState()
            self.host.adjust_judge = mutate
            await self.run_guard()
            self.assertFalse(self.nudges())

    async def test_unknown_send_result_and_timeout_never_retried(self):
        for delivery in ('unknown', 'exception', 'malformed'):
            self.host = FakeHost()
            self.state = MemoryState()
            self.host.delivery = delivery
            result = await self.run_guard()
            self.assertEqual(result['sessions'][0]['status'], 'delivery-unknown')
            self.state = MemoryState(json.loads(json.dumps(self.state.data)))
            await self.run_guard()
            self.assertEqual(len(self.nudges()), 1)

    async def test_judge_exception_keeps_reservation(self):
        self.host.judge_error = True
        await self.run_guard()
        self.host.judge_error = False
        result = await self.run_guard()
        self.assertTrue(result['gaps'])
        self.assertEqual(len([c for c in self.host.calls if c[0] == 'judge']), 1)

    async def test_adequate_requires_receipts_and_never_nudges(self):
        self.host.adjust_judge = lambda r: r.update(
            verdict='ADEQUAAT', proposedNextAction=None
        )
        result = await self.run_guard()
        self.assertEqual(result['sessions'][0]['verdict'], 'ADEQUAAT')
        self.assertFalse(self.nudges())
        self.state = MemoryState()

        def no_receipt(r):
            r.update(verdict='ADEQUAAT', proposedNextAction=None)
            r['findings'][0]['refs'] = ['message:claim']

        self.host.adjust_judge = no_receipt
        self.assertEqual((await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER')

    async def test_adequacy_rechecks_scope_after_judgment(self):
        self.host.adjust_judge = lambda r: r.update(
            verdict='ADEQUAAT', proposedNextAction=None
        )
        self.host.change = lambda s: s.update(generation=2)
        row = (await self.run_guard())['sessions'][0]
        self.assertEqual(row['verdict'], 'ONZEKER')
        self.assertEqual(row['status'], 'stale')
        self.assertEqual(self.host.reads, 2)

    async def test_send_reservation_crossing_expiry_prevents_send(self):
        clock = [110]
        original = self.state.reserve

        async def reserve(key, record):
            result = await original(key, record)
            if ':nudge:' in key:
                clock[0] = 201
            return result

        self.state.reserve = reserve
        row = (await g.run_once(self.host, self.state, now=lambda: clock[0]))[
            'sessions'
        ][0]
        self.assertFalse(self.nudges())
        self.assertEqual(row['status'], 'stale')

    async def test_expired_uncertainty_refreshes_once_per_bounded_epoch(self):
        clock = [110]
        self.host.adjust_judge = lambda r: r.update(
            verdict='ONZEKER', proposedNextAction=None, expiresAt=clock[0] + 90
        )
        await g.run_once(self.host, self.state, now=lambda: clock[0])
        clock[0] = 201
        self.host.s['observedAt'] = 201
        await g.run_once(self.host, self.state, now=lambda: clock[0])
        self.host.s['observedAt'] = 202
        clock[0] = 202
        await g.run_once(self.host, self.state, now=lambda: clock[0])
        self.assertEqual(len([c for c in self.host.calls if c[0] == 'judge']), 2)

    async def test_expired_and_future_snapshots_or_decisions(self):
        self.host.s['observedAt'] = 1000
        self.assertEqual((await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER')
        self.host.s['observedAt'] = 1
        self.assertEqual(
            (await self.run_guard(max_snapshot_age=10))['sessions'][0]['verdict'],
            'ONZEKER',
        )
        self.host.s['observedAt'] = 100
        self.host.adjust_judge = lambda r: r.update(expiresAt=109)
        self.assertEqual((await self.run_guard())['sessions'][0]['verdict'], 'ONZEKER')
        self.assertFalse(self.nudges())


if __name__ == '__main__':
    unittest.main()
