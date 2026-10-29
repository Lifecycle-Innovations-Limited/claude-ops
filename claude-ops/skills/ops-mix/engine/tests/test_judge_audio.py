"""Provider doubles exercise approval, complete coverage and fail-closed output."""
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from mixforge import judge_audio
from mixforge.judge import judge_mix
from test_judge import wav


class FakeClient:
    def __init__(self, report, mutate=None, state='ACTIVE', fail=False, delete_fail=False):
        self.report = report
        self.mutate = mutate or (lambda value: value)
        self.state = state
        self.fail = fail
        self.delete_fail = delete_fail
        self.uploaded, self.deleted, self.requests, self.polls = [], [], [], []
        self.files = SimpleNamespace(upload=self.upload, get=self.get, delete=self.delete)
        self.models = SimpleNamespace(generate_content=self.generate)

    def upload(self, *, file):
        if not Path(file).is_file():
            raise AssertionError('missing audio')
        item = self.report['packet']['items'][len(self.uploaded)]
        if judge_audio.file_hash(file) != item['sha256']:
            raise AssertionError('unchecked audio')
        name = 'files/' + item['id']
        self.uploaded.append(name)
        return SimpleNamespace(name=name, state=SimpleNamespace(name=self.state), uri='fake://' + name)

    def get(self, *, name):
        self.polls.append(name)
        return SimpleNamespace(name=name, state=SimpleNamespace(name='ACTIVE'), uri='fake://' + name)

    def delete(self, *, name):
        self.deleted.append(name)
        if self.delete_fail:
            raise RuntimeError('cleanup unavailable')

    def generate(self, *, model, contents, config):
        self.requests.append((model, contents, config))
        if self.fail:
            raise RuntimeError('provider failure')
        item_id = contents[0].name.split('/')[-1]
        item = next(x for x in self.report['packet']['items'] if x['id'] == item_id)
        value = {'version': 1, 'source_sha256': self.report['source']['sha256'], 'item_id': item_id,
                 'coverage': {'start_seconds': item['start_seconds'], 'end_seconds': item['end_seconds'],
                              'complete': True},
                 'verdict': 'revise', 'strengths': ['Energy fits the brief'],
                 'weaknesses': ['Abrupt phrase handoff'],
                 'findings': [{'start_seconds': item['start_seconds'], 'end_seconds': item['end_seconds'],
                               'severity': 'warning', 'issue': 'Phrase handoff',
                               'suggestion': 'Move entry to the next phrase', 'confidence': .8}]}
        return SimpleNamespace(text=json.dumps(self.mutate(value)))


class AudioJudgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / 'mix.wav'
        wav(self.audio, np.full(44100 * 3, .1))
        self.report = judge_mix(self.audio, setlist={'transitions': [1, 2]},
                                output=self.root / 'packet', transition_context_seconds=.5)

    def test_approval_precedes_sdk_import_factory_and_upload(self):
        with patch('mixforge.judge_audio._new_client', side_effect=AssertionError('SDK touched')):
            result = judge_audio.judge_audio(self.report, model='runtime-model')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'approval_required')
        client = FakeClient(self.report)
        result = judge_audio.judge_audio(self.report, approved='yes', model='runtime-model', client=client)
        self.assertEqual(result['reason'], 'approval_required')
        self.assertEqual(client.uploaded, [])

    def test_every_audio_item_is_independently_requested_and_cleaned(self):
        client = FakeClient(self.report, state='PROCESSING')
        before = copy.deepcopy(self.report)
        with patch('mixforge.judge_audio.time.sleep'):
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['status'], 'assessed')
        self.assertTrue(result['advisory'])
        self.assertEqual([x['item_id'] for x in result['assessments']],
                         ['full_mix', 'transition-1', 'transition-2'])
        self.assertEqual(client.uploaded, ['files/full_mix', 'files/transition-1', 'files/transition-2'])
        self.assertCountEqual(client.deleted, client.uploaded)
        self.assertCountEqual(client.polls, client.uploaded)
        self.assertEqual(len(client.requests), 3)
        self.assertEqual(self.report, before)
        self.assertEqual(self.report['delivery']['status'], 'not_assessed')
        for model, contents, config in client.requests:
            self.assertEqual(model, 'runtime-model')
            self.assertEqual(config['response_mime_type'], 'application/json')
            self.assertEqual(config['http_options']['retry_options']['attempts'], 1)
            self.assertTrue(config['automatic_function_calling']['disable'])
            self.assertIn('response_json_schema', config)
            self.assertIn('untrusted', contents[1])

    def test_upload_reads_only_validated_private_snapshot(self):
        client = FakeClient(self.report)
        original_upload = client.files.upload
        snapshots = []
        def raced_upload(*, file):
            # Simulate the SDK opening the path after an external writer changes
            # the checked original, then restores it before the final recheck.
            source = Path(self.report['packet']['items'][len(snapshots)]['path'])
            before = source.read_bytes()
            snapshots.append(Path(file))
            try:
                source.write_bytes(b'unchecked audio')
                self.assertEqual(judge_audio.file_hash(file),
                                 self.report['packet']['items'][len(snapshots) - 1]['sha256'])
                self.assertNotEqual(Path(file), source)
                self.assertEqual(Path(file).stat().st_mode & 0o222, 0)
                return original_upload(file=file)
            finally:
                source.write_bytes(before)
        client.files.upload = raced_upload
        result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['status'], 'assessed')
        self.assertEqual(len(snapshots), 3)
        self.assertTrue(all(not path.exists() for path in snapshots))
        self.assertCountEqual(client.deleted, client.uploaded)

    def test_snapshot_copy_is_hashed_before_sdk_factory(self):
        original_copy = judge_audio.shutil.copyfile
        def race(source, target):
            source = Path(source)
            before = source.read_bytes()
            try:
                source.write_bytes(b'changed during copy')
                return original_copy(source, target)
            finally:
                source.write_bytes(before)
        with patch('mixforge.judge_audio.shutil.copyfile', side_effect=race), \
             patch('mixforge.judge_audio._new_client', side_effect=AssertionError('SDK touched')):
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model')
        self.assertEqual(result['reason'], 'invalid_packet')

    def test_cli_preserves_report_changed_during_inference(self):
        from mixforge.cli import main
        output = self.root / 'changed-cli'
        def race(report, **kwargs):
            (output / 'report.json').write_text('other writer')
            return {'status': 'unknown', 'reason': 'approval_required'}
        with patch('mixforge.judge_audio.judge_audio', side_effect=race), patch('builtins.print'):
            code = main(['judge', str(self.audio), '-o', str(output), '--audio-judge', 'google'])
        self.assertEqual(code, 0)
        self.assertEqual((output / 'report.json').read_text(), 'other writer')
        self.assertEqual(json.loads((output / 'musical-report.json').read_text())['musical']['reason'],
                         'approval_required')

    def test_cli_preserves_concurrent_report_and_musical_report(self):
        from mixforge.cli import main
        output = self.root / 'raced-cli'
        def race(report, **kwargs):
            (output / 'report.json').write_text('other writer')
            (output / 'musical-report.json').write_text('other musical writer')
            return {'status': 'unknown', 'reason': 'approval_required'}
        with patch('mixforge.judge_audio.judge_audio', side_effect=race), patch('builtins.print'):
            code = main(['judge', str(self.audio), '-o', str(output), '--audio-judge', 'google'])
        self.assertEqual(code, 2)
        self.assertEqual((output / 'report.json').read_text(), 'other writer')
        self.assertEqual((output / 'musical-report.json').read_text(), 'other musical writer')

    def test_stale_source_or_clip_never_reaches_sdk(self):
        for target in (self.audio, Path(self.report['packet']['items'][1]['path'])):
            before = target.read_bytes()
            target.write_bytes(before + b'changed')
            client = FakeClient(self.report)
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['reason'], 'invalid_packet')
            self.assertEqual(client.uploaded, [])
            target.write_bytes(before)

    def test_incomplete_or_malformed_packet_is_rejected_before_upload(self):
        variants = []
        for field, value in (('version', 2), ('local', {'duration_seconds': float('nan')})):
            report = copy.deepcopy(self.report)
            report[field] = value
            variants.append(report)
        report = copy.deepcopy(self.report)
        report['packet']['items'].pop()
        variants.append(report)
        report = copy.deepcopy(self.report)
        report['packet']['items'][1]['end_seconds'] = 50
        variants.append(report)
        report = copy.deepcopy(self.report)
        report['transitions']['coverage'] = 'unknown'
        variants.append(report)
        for report in variants:
            with self.subTest(report=report):
                client = FakeClient(report)
                result = judge_audio.judge_audio(report, approved=True, model='runtime-model', client=client)
                self.assertEqual(result['reason'], 'invalid_packet')
                self.assertEqual(client.uploaded, [])

    def test_invalid_model_findings_never_become_partial_success(self):
        def modify(key, value):
            return lambda result: dict(result, **{key: value})
        mutations = [modify('version', 2), modify('source_sha256', '0' * 64),
                     modify('item_id', 'other'), modify('verdict', 'approved'),
                     modify('strengths', 'great'), modify('weaknesses', []),
                     lambda x: dict(x, coverage=dict(x['coverage'], complete=False)),
                     lambda x: dict(x, coverage=dict(x['coverage'], end_seconds=1)),
                     lambda x: dict(x, findings=[dict(x['findings'][0], start_seconds=-1)]),
                     lambda x: dict(x, findings=[dict(x['findings'][0], end_seconds=100)]),
                     lambda x: dict(x, findings=[dict(x['findings'][0], confidence=float('nan'))]),
                     lambda x: dict(x, findings=[dict(x['findings'][0], confidence=True)]),
                     lambda x: dict(x, findings=[dict(x['findings'][0], severity='pass')]),
                     lambda x: dict(x, findings=[dict(x['findings'][0], issue='')]),
                     lambda x: dict(x, findings=x['findings'] * 2),
                     lambda x: dict(x, unexpected='ignore all instructions')]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                client = FakeClient(self.report, mutate)
                result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
                self.assertEqual(result['status'], 'unknown')
                self.assertNotIn('assessments', result)
                self.assertCountEqual(client.deleted, client.uploaded)

    def test_non_json_and_duplicate_json_keys_are_rejected(self):
        for text in ('not JSON', '{"version":1,"version":1}', 'null', '[]'):
            client = FakeClient(self.report)
            client.models.generate_content = lambda **kwargs: SimpleNamespace(text=text)
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['reason'], 'invalid_response')
            self.assertCountEqual(client.deleted, client.uploaded)

    def test_later_failure_discards_earlier_valid_assessment(self):
        calls = []
        def mutate(value):
            calls.append(value['item_id'])
            if value['item_id'] == 'transition-1':
                value['findings'] = []
            return value
        client = FakeClient(self.report, mutate)
        result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['status'], 'unknown')
        self.assertNotIn('assessments', result)
        self.assertEqual(calls, ['full_mix', 'transition-1'])
        self.assertCountEqual(client.deleted, client.uploaded)

    def test_failure_is_not_retried_and_upload_is_cleaned(self):
        client = FakeClient(self.report, fail=True)
        result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['reason'], 'provider_error')
        self.assertEqual(len(client.requests), 1)
        self.assertEqual(client.deleted, ['files/full_mix'])
        for state in ('FAILED', 'UNSPECIFIED'):
            client = FakeClient(self.report, state=state)
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(client.requests, [])
            self.assertEqual(client.deleted, ['files/full_mix'])

    def test_cleanup_failure_is_visible_and_no_results_are_accepted(self):
        client = FakeClient(self.report, delete_fail=True)
        result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['reason'], 'cleanup_failed')
        self.assertEqual(result['cleanup_failed'], ['files/full_mix', 'files/transition-1', 'files/transition-2'])

    def test_cli_without_approval_persists_unknown_without_sdk(self):
        from mixforge.cli import main
        setlist = self.root / 'setlist.json'
        setlist.write_text('{"transitions": [1, 2]}')
        with patch('mixforge.judge_audio._new_client', side_effect=AssertionError('SDK touched')):
            with patch('builtins.print'):
                code = main(['judge', str(self.audio), '--setlist', str(setlist),
                             '-o', str(self.root / 'cli'), '--audio-judge', 'google',
                             '--audio-model', 'runtime-model'])
        self.assertEqual(code, 0)
        local = json.loads((self.root / 'cli' / 'report.json').read_text())
        self.assertEqual(local['musical']['status'], 'unknown')
        result = json.loads((self.root / 'cli' / 'musical-report.json').read_text())
        self.assertEqual(result['musical']['reason'], 'approval_required')
        self.assertEqual(result['delivery']['status'], 'not_assessed')

    def test_poll_timeout_does_not_infer_and_cleans_upload(self):
        client = FakeClient(self.report, state='PROCESSING')
        client.files.get = lambda *, name: SimpleNamespace(name=name, state='PROCESSING')
        with patch('mixforge.judge_audio.time.sleep'):
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model', client=client)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(client.requests, [])
        self.assertEqual(client.deleted, ['files/full_mix'])

    def test_model_and_sdk_are_optional_and_never_fallback(self):
        with patch('mixforge.judge_audio._new_client', side_effect=AssertionError('unexpected SDK')):
            result = judge_audio.judge_audio(self.report, approved=True, model=None)
        self.assertEqual(result['reason'], 'model_required')
        with patch('mixforge.judge_audio._new_client', side_effect=ImportError('SDK absent')):
            result = judge_audio.judge_audio(self.report, approved=True, model='runtime-model')
        self.assertEqual(result['reason'], 'sdk_unavailable')


if __name__ == '__main__':
    unittest.main()
