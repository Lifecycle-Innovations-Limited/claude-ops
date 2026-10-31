"""Offline acceptance regressions; no model, installed plugin or real HOME writes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('candidate_bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


class Acceptance(unittest.TestCase):
    def state(self):
        s = b.fresh('offline')
        b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Required effect', owner='session')]))
        b.event(s, dict(hook_event_name='PostToolUse', tool_name='Bash', tool_use_id='ok', tool_response={'exit_code': 0}))
        r = s['receipts']['ok']
        b.control(s, 'evidence', dict(generation=0, id='x', receipt='ok', pointer=dict(type='transcript', tool='Bash', tool_use_id='ok', outputHash=r['outputHash']), inspection='Inspected output'))
        b.control(s, 'deliver', dict(generation=0, text='Delivered', outcomes=['x']))
        return s

    def test_agent_audit_cannot_certify_independent_completion(self):
        for verdict in ('ADEQUAAT', 'ADEQUAAT but gaps remain', 'HIATEN', 'ONZEKER', ''):
            with self.subTest(verdict=verdict):
                s = self.state()
                b.control(s, 'audit-record', dict(generation=0, verdict=verdict, provenance='independent'))
                b.event(s, dict(hook_event_name='Stop', last_assistant_message='Delivered'))
                self.assertNotIn('accepted', s['phase'])
                self.assertNotIn('verified', s['phase'])
                self.assertIn('semantic review pending', s['phase'])
                self.assertEqual(s['audit']['acceptance'], 'none')

    def test_failed_callback_links_exact_receipt_and_is_idempotent(self):
        s = b.fresh('offline')
        payload = dict(hook_event_name='PostToolUseFailure', tool_name='Bash', tool_use_id='failed', tool_input={'command': 'write'}, tool_response={})
        b.event(s, payload)
        receipt = s['receipts']['failed']
        item = next(iter(s['incidents'].values()))
        self.assertEqual(item['sourceReceipt'], dict(id='failed', generation=0, inputHash=receipt['inputHash'], outputHash=receipt['outputHash']))
        self.assertEqual(item['effect'], 'unknown')
        before = b.digest(s)
        b.event(s, dict(payload, hook_event_name='PostToolUse'))
        self.assertEqual(b.digest(s), before)

    def test_status_downgrades_legacy_acceptance_without_rewriting_incidents(self):
        s = b.fresh('offline')
        s['phase'] = 'accepted; verified and delivered; semantic audit recorded'
        s['incidents']['legacy'] = dict(status='needs diagnosis', source='Bash', category='tool failure; inspect actual output in transcript')
        before = b.digest(s['incidents'])
        b.control(s, 'status', {})
        self.assertIn('semantic review pending', s['phase'])
        self.assertEqual(s['sourceGaps'], ['legacy'])
        self.assertEqual(b.digest(s['incidents']), before)

    def test_unknown_effect_cannot_be_waived_by_classification_alone(self):
        s = self.state()
        b.event(s, dict(hook_event_name='PostToolUseFailure', tool_name='Bash', tool_use_id='failed', tool_response={}))
        key = next(iter(s['incidents']))
        r = s['receipts']['ok']
        pointer = dict(type='transcript', tool='Bash', tool_use_id='ok', outputHash=r['outputHash'])
        b.control(s, 'evidence', dict(generation=0, collection='incidents', id=key, receipt='ok', pointer=pointer, inspection='Read back target'))
        with self.assertRaisesRegex(ValueError, 'effect unknown'):
            b.control(s, 'waive-incident', dict(generation=0, id=key, classification='timeout', note='Inspected target after timeout', receipt='ok', pointer=pointer, inspection='Read back target'))
        self.assertEqual(s['incidents'][key]['status'], 'needs diagnosis')

    def test_conflicting_callback_preserves_original_receipt(self):
        s = b.fresh('offline')
        p = dict(hook_event_name='PostToolUseFailure', tool_name='Bash', tool_use_id='failed', tool_input={}, tool_response={})
        b.event(s, p)
        original = dict(s['receipts']['failed'])
        b.event(s, dict(p, tool_response={'exit_code': 1}))
        self.assertEqual(s['receipts']['failed'], original)
        self.assertTrue(any(i['category'] == 'callback provenance conflict' for i in s['incidents'].values()))

    def test_legacy_unresolved_incident_cannot_be_waived(self):
        s = self.state()
        s['incidents']['legacy'] = dict(source='Bash', category='tool failure; inspect actual output in transcript', status='needs diagnosis', evidence=s['outcomes']['x']['evidence'])
        r = s['receipts']['ok']
        before = b.digest(s['incidents']['legacy'])
        with self.assertRaisesRegex(ValueError, 'source'):
            b.control(s, 'waive-incident', dict(generation=0, id='legacy', classification='timeout', note='Inspection confirms expected behavior', receipt='ok', pointer=dict(type='transcript', tool='Bash', tool_use_id='ok', outputHash=r['outputHash']), inspection='Inspected'))
        self.assertEqual(b.digest(s['incidents']['legacy']), before)

    def test_prompt_preserves_evidence_history_and_reconcile_requires_quote(self):
        s = self.state()
        old = list(s['outcomes']['x']['evidence'])
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='Please pause the required effect'))
        self.assertEqual(s['outcomes']['x']['evidence'], old)
        before = b.digest(s['outcomes'])
        for quote in ('cancel it', 'pause the required effect'):
            with self.assertRaisesRegex(ValueError, 'protected human provenance'):
                b.control(s, 'reconcile', dict(generation=0, items=[dict(id='x', disposition='pause', quote=quote)]))
        self.assertEqual(b.digest(s['outcomes']), before)

    def test_native_failure_identity_and_conflict(self):
        s = b.fresh('offline')
        p = dict(hook_event_name='PostToolUseFailure', tool_name='Bash', tool_use_id='native',
                 tool_input={'command': 'write'}, error='private failure alpha', is_interrupt=True)
        b.event(s, p)
        original = dict(s['receipts']['native'])
        self.assertEqual(original['outputHash'], b.digest({'error': p['error'], 'is_interrupt': True}))
        self.assertNotIn(p['error'], json.dumps(s))
        source = next(iter(s['incidents'].values()))['sourceReceipt']
        self.assertEqual(source['outputHash'], original['outputHash'])
        b.event(s, dict(p, error='private failure beta'))
        self.assertEqual(s['receipts']['native'], original)
        self.assertTrue(any(i['category'] == 'callback provenance conflict' for i in s['incidents'].values()))

    def test_contract_redeclare_preserves_history_and_disposition(self):
        s = self.state()
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='Please pause the required effect'))
        s['outcomes']['x'].update(disposition=dict(value='pause'), history=list(s['outcomes']['x']['evidence']), needsReconciliation=True)
        previous = dict(s['outcomes']['x'])
        before = b.digest(s)
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Changed effect', owner='peer')]))
        self.assertEqual(b.digest(s), before)
        item = s['outcomes']['x']
        self.assertEqual(item['history'], previous['history'])
        self.assertEqual(item['disposition'], previous['disposition'])
        self.assertTrue(item['needsReconciliation'])
        self.assertEqual(item['owner'], 'session')
        self.assertFalse(b.has_evidence(s, item))  # Records survive; the observation barrier stales verification.
        self.assertEqual(item['evidence'], previous['evidence'])
        self.assertEqual(s['generation'], 0)

    def test_reconcile_all_dispositions_preserve_source_owner_and_history(self):
        s = self.state()
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='Keep x, amend y, add z, replace old with new'))
        before = b.digest(s)
        for disposition in ('retain', 'amend', 'add', 'pause', 'cancel', 'supersede'):
            with self.assertRaisesRegex(ValueError, 'protected human provenance'):
                b.control(s, 'reconcile', dict(generation=0, inheritIssueFrom='x', items=[dict(id='x', disposition=disposition, quote='amend y', dod='Updated effect', replacement='z')]))
            self.assertEqual(b.digest(s), before)
        self.assertEqual(s['outcomes']['x']['owner'], 'session')
        self.assertNotIn('accepted', s['phase'])

    def test_reconciliation_and_contract_validation_are_transactional(self):
        s = self.state()
        before = b.digest(s)
        with self.assertRaises(ValueError):
            b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Changed', owner='peer'), dict(id='bad')]))
        self.assertEqual(b.digest(s), before)
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='cancel x and retain other'))
        before = b.digest(s)
        with self.assertRaises(ValueError):
            b.control(s, 'reconcile', dict(generation=1, items=[dict(id='x', disposition='cancel', quote='cancel x'), dict(id='missing', disposition='retain')]))
        self.assertEqual(b.digest(s), before)
        with self.assertRaises(ValueError):
            b.control(s, 'reconcile', dict(generation=1, items=[dict(id='x', disposition='supersede', quote='cancel x', replacement='missing')]))
        self.assertEqual(b.digest(s), before)

    def test_reconcile_requires_all_stale_outcomes_and_user_provenance(self):
        s = self.state()
        b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='y', dod='Other effect', owner='peer')]))
        b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='Keep both results'))
        before = b.digest(s)
        with self.assertRaisesRegex(ValueError, 'protected human provenance'):
            b.control(s, 'reconcile', dict(generation=0, items=[dict(id='x', disposition='retain')]))
        self.assertEqual(b.digest(s), before)
        legacy = self.state()
        with self.assertRaisesRegex(ValueError, 'protected human provenance'):
            b.control(legacy, 'reconcile', dict(generation=0, items=[dict(id='x', disposition='cancel', quote='cancel')]))
        self.assertEqual(legacy['outcomes']['x']['owner'], 'session')

    def test_mechanical_file_criterion_requires_exact_bound_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'result'
            path.write_text('actual')
            s = b.fresh('offline')
            criterion = dict(id='bytes', kind='file-sha256', path=str(path), sha256=b.file_hash(str(path)))
            b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Exact bytes', owner='session', criteria=[criterion])]))
            b.control(s, 'check-outcome', dict(generation=0, id='x'))
            self.assertTrue(s['outcomes']['x']['checks']['passed'])
            self.assertEqual(s['outcomes']['x']['checks']['acceptance'], 'none')
            path.write_text('different')
            self.assertFalse(b.mechanical_ready(s, s['outcomes']['x']))
            b.control(s, 'check-outcome', dict(generation=0, id='x'))
            self.assertFalse(s['outcomes']['x']['checks']['passed'])
            self.assertIn('x', '\n'.join(b.pending(s)))

    def test_unsupported_criteria_never_execute_or_mutate_contract(self):
        s = self.state()
        before = b.digest(s)
        with self.assertRaisesRegex(ValueError, 'criterion'):
            b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Semantic', owner='session', criteria=[dict(id='bad', kind='command', command='true')])]))
        self.assertEqual(b.digest(s), before)

    def transcript(self, path, text='Delivered', mid='message'):
        row = dict(type='assistant', uuid=mid, message=dict(content=text))
        path.write_text(json.dumps(row) + '\n')
        s = b.fresh('offline')
        s['delivery'] = dict(transcript=str(path), messageHash=b.digest(text))
        pointer = dict(type='transcript-message', path=str(path), message_id=mid, messageHash=b.digest(text))
        return s, pointer

    def test_large_transcript_streams_without_general_hash_limit_change(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            s, pointer = self.transcript(path)
            target = path.read_bytes()
            with path.open('wb') as out:
                for _ in range(17000):
                    out.write(json.dumps(dict(type='user', text='x' * 1000)).encode() + b'\n')
                out.write(target)
            with self.assertRaisesRegex(ValueError, 'too large'):
                b.file_hash(str(path))
            b.transcript_message(s, pointer)

    def test_transcript_rejects_wrong_identity_hash_and_oversized_records(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            s, pointer = self.transcript(path)
            for change in (dict(message_id='wrong'), dict(messageHash=b.digest('wrong'))):
                with self.assertRaises(ValueError):
                    b.transcript_message(s, dict(pointer, **change))
            path.write_text(json.dumps(dict(type='assistant', uuid='message', message=dict(content='x' * 1_100_000))) + '\n')
            with self.assertRaisesRegex(ValueError, 'record.*budget'):
                b.transcript_message(s, pointer)

    def test_transcript_secure_path_owner_and_scan_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            s, pointer = self.transcript(path)
            link = Path(temp) / 'link'
            link.symlink_to(path)
            for candidate in (link, Path('relative.jsonl'), Path(temp)):
                s['delivery']['transcript'] = str(candidate)
                with self.assertRaises(ValueError):
                    b.transcript_message(s, dict(pointer, path=str(candidate)))
            s['delivery']['transcript'] = str(path)
            with patch.object(b.os, 'getuid', return_value=os.getuid() + 1):
                with self.assertRaises(ValueError):
                    b.transcript_message(s, pointer)
            with patch.object(b, 'MAX_TRANSCRIPT_SCAN_BYTES', 10, create=True):
                with self.assertRaisesRegex(ValueError, 'budget.*pending'):
                    b.transcript_message(s, pointer)
            self.assertIsNone(s['handoff'])

    def test_contract_changed_in_same_generation_invalidates_evidence(self):
        s = self.state()
        evidence = list(s['outcomes']['x']['evidence'])
        before = b.digest(s)
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            b.control(s, 'contract', dict(generation=0, issue='TEAM-1', outcomes=[dict(id='x', dod='Changed effect', owner='peer')]))
        self.assertEqual(b.digest(s), before)
        self.assertEqual(s['outcomes']['x']['evidence'], evidence)

    def test_transcript_invalid_record_and_time_budget_remain_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            s, pointer = self.transcript(path)
            with patch.object(b.time, 'monotonic', side_effect=[0, 6]):
                with self.assertRaisesRegex(ValueError, 'time budget.*pending'):
                    b.transcript_message(s, pointer)
            path.write_text('{invalid target record}\n')
            with self.assertRaisesRegex(ValueError, 'invalid transcript record.*pending'):
                b.transcript_message(s, pointer)
            self.assertIsNone(s['handoff'])

    def test_transcript_parent_swap_before_leaf_open_is_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            parent, outside = root / 'parent', root / 'outside'
            parent.mkdir()
            outside.mkdir()
            path = parent / 'session.jsonl'
            s, pointer = self.transcript(path)
            self.transcript(outside / path.name)
            original = b.os.open
            swapped = False
            def swap_before_open(name, flags, *args, **kwargs):
                nonlocal swapped
                if Path(name).name == path.name and not swapped:
                    swapped = True
                    parent.rename(root / 'held-parent')
                    parent.symlink_to(outside, target_is_directory=True)
                return original(name, flags, *args, **kwargs)
            with patch.object(b.os, 'open', side_effect=swap_before_open):
                with self.assertRaises(ValueError):
                    b.transcript_message(s, pointer)
            self.assertTrue(swapped)
            self.assertIsNone(s['handoff'])

    def test_transcript_missing_secure_platform_support_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            s, pointer = self.transcript(Path(temp) / 'session.jsonl')
            with patch.object(b, 'SECURE_TRANSCRIPT_OPEN', False):
                with self.assertRaisesRegex(ValueError, 'unavailable.*pending'):
                    b.transcript_message(s, pointer)

    @unittest.skipUnless(b.sys.platform == 'darwin', 'macOS system aliases')
    def test_transcript_mac_system_alias_and_canonical_path(self):
        with tempfile.TemporaryDirectory(dir='/var/tmp') as temp:
            canonical = Path(temp).resolve() / 'session.jsonl'
            s, pointer = self.transcript(canonical)
            b.transcript_message(s, pointer)
            self.assertTrue(str(canonical).startswith('/private/var/'))
            alias = str(canonical).removeprefix('/private')
            s['delivery']['transcript'] = alias
            b.transcript_message(s, dict(pointer, path=alias))
            with patch.object(b.os, 'readlink', return_value='private/wrong'):
                with self.assertRaisesRegex(ValueError, 'untrusted platform'):
                    b.transcript_message(s, dict(pointer, path=alias))

    def test_transcript_symlink_ancestor_is_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            real = root / 'real'
            real.mkdir()
            s, pointer = self.transcript(real / 'session.jsonl')
            (root / 'alias').symlink_to(real, target_is_directory=True)
            candidate = str(root / 'alias/session.jsonl')
            s['delivery']['transcript'] = candidate
            with self.assertRaises(ValueError):
                b.transcript_message(s, dict(pointer, path=candidate))

    def test_transcript_concurrent_append_is_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            s, pointer = self.transcript(path)
            original = b.os.fstat
            calls = 0
            def append_on_check(fd):
                nonlocal calls
                info = original(fd)
                if not b.stat.S_ISREG(info.st_mode):
                    return info
                calls += 1
                if calls == 2:
                    with path.open('a') as out:
                        out.write('{}\n')
                return original(fd)
            with patch.object(b.os, 'fstat', side_effect=append_on_check):
                with self.assertRaisesRegex(ValueError, 'changed.*pending'):
                    b.transcript_message(s, pointer)

    def fixture(self, base):
        (base / '.claude-plugin').mkdir()
        (base / 'hooks').mkdir()
        (base / '.claude-plugin/plugin.json').write_text(json.dumps({'name': 'just-do-it'}))
        (base / 'hooks/hooks.json').write_text('{}')
        for rel in b.OWN_SCRIPTS:
            p = base / rel
            p.write_text('# fixture\n')
            p.chmod(0o600)

    def test_session_start_repairs_only_owned_scripts_and_can_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.fixture(base)
            s = b.fresh('offline')
            with patch.object(b, 'PLUGIN_BASE', base), patch.object(b, 'read_json_file', wraps=b.read_json_file) as reads:
                b.event(s, dict(hook_event_name='SessionStart'))
                self.assertEqual(len(s['fixes']), 3)
                self.assertTrue(all(Path(call.args[0]).is_relative_to(base) for call in reads.call_args_list))
                b.event(s, dict(hook_event_name='SessionStart'))
                self.assertEqual(len(s['fixes']), 3)
                for fix in s['fixes']:
                    self.assertTrue(fix['validated'])
                    self.assertEqual(b.rollback_fix(s, fix['fixId'], base)['status'], 'rolled-back')

    def test_config_changes_and_own_failures_trigger_bounded_maintenance(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.fixture(base)
            s = b.fresh('offline')
            with patch.object(b, 'PLUGIN_BASE', base), patch.object(b.time, 'time', return_value=1000):
                b.event(s, dict(hook_event_name='SessionStart'))
                initial = s['maintenance']['signature']
                (base / 'hooks/hooks.json').write_text('{bad')
                b.event(s, dict(hook_event_name='PostToolUse', tool_name='Write', tool_use_id='config', tool_input={'file_path': str(base / 'hooks/hooks.json')}, tool_response={}))
                self.assertNotEqual(s['maintenance']['signature'], initial)
                self.assertTrue(s['maintenance']['queued'])
            with patch.object(b, 'PLUGIN_BASE', base), patch.object(b.time, 'time', return_value=1031):
                b.event(s, dict(hook_event_name='UserPromptSubmit', source='user', prompt='inspect'))
                self.assertFalse(s['maintenance']['queued'])
                self.assertTrue(any(i['source'].endswith('hooks/hooks.json') for i in s['incidents'].values()))
                before = b.digest(s['maintenance'])
                b.event(s, dict(hook_event_name='PostToolUseFailure', tool_name='Read', tool_use_id='external', tool_input={'file_path': '/unrelated'}, tool_response={}))
                self.assertEqual(b.digest(s['maintenance']), before)
                b.event(s, dict(hook_event_name='PostToolUseFailure', tool_name='Read', tool_use_id='own', tool_input={'file_path': str(base / 'hooks/bridge.py')}, tool_response={}))
                self.assertTrue(s['maintenance']['queued'])

    def test_paused_or_foreign_manifest_never_auto_repairs(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.fixture(base)
            for paused, name in ((True, 'just-do-it'), (False, 'other')):
                (base / '.claude-plugin/plugin.json').write_text(json.dumps({'name': name}))
                s = b.fresh('offline')
                s['paused'] = paused
                with patch.object(b, 'PLUGIN_BASE', base):
                    b.event(s, dict(hook_event_name='SessionStart'))
                self.assertEqual(s['fixes'], [])
                self.assertEqual((base / 'hooks/bridge.py').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
