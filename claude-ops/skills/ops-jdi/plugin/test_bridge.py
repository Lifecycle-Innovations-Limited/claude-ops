import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import unittest.mock

SPEC = importlib.util.spec_from_file_location('bridge', Path(__file__).parent / 'hooks/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.s = b.fresh('fixture')
        self.prompt('Build both outcomes')

    def prompt(self, text):
        return b.event(self.s, dict(hook_event_name='UserPromptSubmit', prompt=text))

    def contract(self):
        b.control(self.s, 'contract', dict(generation=self.s['generation'], issue='TEAM-1',
            outcomes=[dict(id='result', dod='Required actual result', owner='session')]))

    def tool(self, name='Bash', response=None, tid='tool-1', inp=None, failure=False):
        return b.event(self.s, dict(hook_event_name='PostToolUseFailure' if failure else 'PostToolUse',
            tool_name=name, tool_use_id=tid, tool_input=inp or {}, tool_response=response or {}))

    def stop(self, **kw):
        return b.event(self.s, dict(hook_event_name='Stop', last_assistant_message='Result delivered', **kw))

    def evidence(self, collection='outcomes', target='result'):
        return b.control(self.s, 'evidence', dict(generation=self.s['generation'], collection=collection,
            id=target, receipt='tool-1', pointer=dict(type='transcript', tool=self.s['receipts']['tool-1']['tool'],
                tool_use_id='tool-1', outputHash=self.s['receipts']['tool-1']['outputHash']), inspection='Read actual output and checked assertions'))

    def test_missing_outcome_blocks(self):
        self.contract()
        self.assertEqual(self.stop()['decision'], 'block')

    def test_completed_label_without_evidence_blocks(self):
        self.contract()
        self.tool('TaskUpdate', inp=dict(taskId='1', status='completed'))
        self.assertIn('task 1', self.stop()['reason'])

    def test_failed_evidence_rejected(self):
        self.contract()
        self.tool(response={'is_error': True})
        with self.assertRaises(ValueError):
            self.evidence()
        self.assertTrue(self.s['incidents'])

    def test_error_spellings(self):
        for response in ({'isError': True}, {'is_error': True}, {'exit_code': 2}, {'status': 'failed'}):
            self.assertTrue(b.failed(response))

    def test_evidence_alone_is_not_acceptance_without_delivery_record(self):
        self.contract()
        self.tool()
        self.evidence()
        result = self.stop()
        self.assertEqual(result['decision'], 'block')
        self.assertIn('record delivery for outcome result', result['reason'])
        self.assertIn('semantic audit advised', self.s['phase'])
        self.assertIn('/just-do-it audit', result['reason'])
        self.assertTrue(self.s['delivery']['present'])

    def deliver(self, text='Result delivered', outcomes=('result',), **extra):
        return b.control(self.s, 'deliver', dict(generation=self.s['generation'], text=text, outcomes=list(outcomes), **extra))

    def verified(self):
        self.contract()
        self.tool()
        self.evidence()

    def test_delivery_matching_actual_message_is_accepted(self):
        self.verified()
        self.assertEqual(self.stop()['decision'], 'block')
        self.deliver()
        self.assertEqual(self.stop(), {})
        self.assertTrue(self.s['phase'].startswith('accepted; verified and delivered'))
        self.assertIn('semantic audit advised', self.s['phase'])

    def test_delivery_by_observed_hash_is_accepted(self):
        self.verified()
        b.control(self.s, 'deliver', dict(generation=self.s['generation'], messageHash=b.digest('Result delivered'), outcomes=['result']))
        self.assertEqual(self.stop(), {})

    def test_delivery_hash_mismatch_is_explicit_blocker(self):
        self.verified()
        self.deliver(text='A different promised message')
        result = self.stop()
        self.assertEqual(result['decision'], 'block')
        self.assertIn('delivery mismatch', result['reason'])
        self.assertIn('delivery mismatch', self.s['phase'])
        self.assertNotIn('accepted', self.s['phase'])

    def test_delivery_must_reference_every_due_outcome(self):
        b.control(self.s, 'contract', dict(generation=self.s['generation'], issue='TEAM-1',
            outcomes=[dict(id='a', dod='A', owner='session'), dict(id='b', dod='B', owner='session')]))
        self.tool()
        for target in ('a', 'b'):
            self.evidence(target=target)
            self.s['seen'] = []
        self.deliver(outcomes=['a'])
        result = self.stop()
        self.assertEqual(result['decision'], 'block')
        self.assertIn('delivery omits outcome b', result['reason'])
        self.deliver(outcomes=['a', 'b'])
        self.assertEqual(self.stop(), {})

    def test_delivery_unknown_outcome_rejected(self):
        self.verified()
        with self.assertRaises(ValueError):
            self.deliver(outcomes=['invented'])
        self.assertFalse(self.s['deliveries'])

    def test_delivery_requires_exactly_text_or_hash(self):
        self.verified()
        for extra in (dict(text=None), dict(messageHash=b.digest('x')), dict(text=None, messageHash='nothex')):
            with self.assertRaises(ValueError):
                b.control(self.s, 'deliver', dict(dict(generation=self.s['generation'], text='x', outcomes=['result']), **extra))

    def test_delivery_from_older_generation_is_stale(self):
        self.verified()
        old = self.s['generation']
        self.deliver()
        self.prompt('Also include the second result')
        self.assertFalse(self.s['deliveries'])
        with self.assertRaises(ValueError):
            b.control(self.s, 'deliver', dict(generation=old, text='Result delivered', outcomes=['result']))
        self.contract()
        self.tool(tid='tool-2')
        b.control(self.s, 'evidence', dict(generation=self.s['generation'], collection='outcomes', id='result', receipt='tool-2',
            pointer=dict(type='transcript', tool='Bash', tool_use_id='tool-2', outputHash=self.s['receipts']['tool-2']['outputHash']), inspection='fresh'))
        self.assertEqual(self.stop()['decision'], 'block')

    def test_delivery_never_overrides_missing_evidence(self):
        self.contract()
        self.deliver()
        self.assertIn('outcome result', self.stop()['reason'])
        self.assertEqual(self.stop()['decision'], 'block')

    def test_repeated_delivery_gap_escalates_not_accepts(self):
        self.verified()
        self.assertEqual(self.stop()['decision'], 'block')
        self.assertEqual(self.stop()['decision'], 'block')
        self.assertEqual(self.stop()['decision'], 'block')
        self.assertEqual(self.s['phase'], 'diagnosis; no progress')

    def test_empty_final_message_cannot_be_delivered(self):
        self.verified()
        self.deliver()
        result = b.event(self.s, dict(hook_event_name='Stop', last_assistant_message='   '))
        self.assertEqual(result['decision'], 'block')

    def test_audit_record_is_advisory_and_keeps_acceptance_untouched(self):
        self.verified()
        before = {k: b.digest(self.s[k]) for k in ('outcomes', 'tasks', 'deliveries', 'incidents', 'receipts')}
        b.control(self.s, 'audit-record', dict(generation=self.s['generation'], verdict='Looks adequate', usage=dict(input_tokens=3, output_tokens=2)))
        self.assertEqual(self.s['audit']['requests'], 1)
        self.assertEqual(self.s['audit']['acceptance'], 'none')
        self.assertEqual(before, {k: b.digest(self.s[k]) for k in before})
        self.assertEqual(self.stop()['decision'], 'block')
        self.assertIn('semantic audit recorded', self.s['phase'])
        self.tool(tid='later')
        self.assertEqual(self.s['audit']['requests'], 1)
        self.assertTrue(self.s['audit']['stale'])

    def test_audit_record_rejects_stale_generation(self):
        with self.assertRaises(ValueError):
            b.control(self.s, 'audit-record', dict(generation=self.s['generation'] + 5))

    def test_no_model_or_network_surface_in_ordinary_handling(self):
        source = (Path(__file__).parent / 'hooks/bridge.py').read_text()
        imports = [line.split()[1].split('.')[0] for line in source.splitlines() if line.startswith(('import ', 'from '))]
        for module in ('subprocess', 'urllib', 'socket', 'http', 'requests', 'anthropic', 'asyncio', 'ssl'):
            self.assertNotIn(module, imports)
        self.assertFalse(any(token in source for token in ('anthropic', 'claude -p', 'os.system', 'Popen')))
        config = json.loads((Path(__file__).parent / 'hooks/hooks.json').read_text())
        kinds = [h['type'] for groups in config['hooks'].values() for g in groups for h in g['hooks']]
        self.assertEqual(set(kinds), {'command'})
        self.assertEqual(len(config['hooks']['Stop'][0]['hooks']), 1)

    def test_old_state_without_deliveries_migrates_open_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root) as state:
                state['paused'] = False
            path = root / 's.json'
            old = json.loads(path.read_text())
            del old['deliveries']
            old['outcomes']['x'] = dict(dod='d', owner='o', issue='TEAM-1', generation=0, dependencies=[], evidence=[], wait=None)
            path.write_text(json.dumps(old))
            with b.store('s', root) as state:
                self.assertEqual(state['deliveries'], {})
                self.assertIn('x', state['outcomes'])
                self.assertFalse(state['phase'] == 'diagnosis')

    def test_no_ledger_conversation_no_loop(self):
        self.assertEqual(self.stop(), {})
        self.assertEqual(self.s['phase'], 'semantic review required')

    def test_generation_stales_evidence(self):
        self.contract()
        self.tool()
        self.evidence()
        old = self.s['generation']
        self.prompt('Also include the second result')
        self.assertFalse(self.s['outcomes']['result']['evidence'])
        with self.assertRaises(ValueError):
            b.control(self.s, 'contract', {'generation': old})
        with self.assertRaises(ValueError):
            self.evidence()

    def test_pause_resume_interrupt_invalidate(self):
        self.contract()
        for action in ('pause', 'interrupt'):
            old = self.s['generation']
            b.control(self.s, action, {})
            self.assertGreater(self.s['generation'], old)
            self.assertEqual(self.stop(), {})
            b.control(self.s, 'resume', {})
            self.assertFalse(self.s['paused'])

    def test_plain_stop_pauses_new_generation(self):
        self.contract()
        self.prompt('stop')
        self.assertTrue(self.s['paused'])
        self.assertEqual(self.stop(), {})

    def test_duplicate_callback_idempotent(self):
        self.tool(failure=True)
        self.tool(failure=True)
        self.assertEqual(len(self.s['receipts']), 1)
        self.assertEqual(len(self.s['incidents']), 1)

    def test_distinct_tool_failures_get_distinct_incidents(self):
        self.tool(failure=True, tid='a', inp={'command': 'make a'}, response={'stderr': 'boom a'})
        self.tool(failure=True, tid='b', inp={'command': 'make b'}, response={'stderr': 'boom b'})
        self.tool(failure=True, tid='c', inp={'command': 'make a'}, response={'stderr': 'boom a'})
        self.assertEqual(len(self.s['incidents']), 2)

    def test_wait_has_concrete_pointer(self):
        self.tool('TaskUpdate', inp={'taskId': '1', 'status': 'pending'})
        with self.assertRaises(ValueError):
            b.control(self.s, 'wait', dict(generation=1, id='1', kind='approval'))
        b.control(self.s, 'wait', dict(generation=1, id='1', kind='approval', pointer='approval:request-1'))
        self.assertEqual(self.stop(), {})
        self.assertEqual(self.s['phase'], 'waiting prerequisite')

    def test_background_notification_without_polling(self):
        self.assertEqual(self.stop(background_tasks=[dict(id='bg', status='running')]), {})
        self.assertEqual(self.s['phase'], 'waiting background notification')

    def test_background_does_not_hide_independent_work(self):
        self.contract()
        self.assertEqual(self.stop(background_tasks=[dict(status='running')])['decision'], 'block')

    def test_bounded_no_progress_not_success(self):
        self.contract()
        self.assertEqual(self.stop()['decision'], 'block')
        self.tool(tid='unrelated-1')
        self.assertEqual(self.stop()['decision'], 'block')
        self.tool(tid='unrelated-2')
        self.assertEqual(self.stop()['decision'], 'block')
        self.assertEqual(self.s['phase'], 'diagnosis; no progress')

    def test_warning_and_policy_notice_no_selfwake(self):
        for source in ('same policy skipped notice', 'hook warning'):
            with self.assertRaises(ValueError):
                b.control(self.s, 'incident', dict(generation=1, source=source, category='warning'))
        self.assertFalse(self.s['incidents'])
        self.assertEqual(b.event(self.s, {'hook_event_name': 'Notification'}), {})

    def test_task_list_dependencies_preserved(self):
        self.tool('TaskList', response={'tasks': [{'id': '1', 'status': 'pending', 'blockedBy': ['2']}]})
        self.assertEqual(self.s['tasks']['1']['dependencies'], ['2'])
        self.assertIn('task 1', b.pending(self.s)[0])

    def test_task_only_pending_still_blocks(self):
        self.tool('TaskUpdate', inp={'taskId': '1', 'status': 'pending'})
        self.assertEqual(self.stop()['decision'], 'block')

    def test_resume_invalidates_receipt_references(self):
        self.contract()
        self.tool()
        self.evidence()
        b.control(self.s, 'pause', {})
        b.control(self.s, 'resume', {})
        self.assertEqual(self.stop()['decision'], 'block')

    def test_dependencies_need_evidence(self):
        self.contract()
        self.tool()
        self.evidence()
        self.s['outcomes']['result']['dependencies'] = ['missing']
        self.assertEqual(self.stop()['decision'], 'block')

    def test_task_metadata_cannot_certify_outcome(self):
        self.contract()
        self.tool('TaskUpdate', inp={'taskId': '1', 'status': 'completed'})
        with self.assertRaises(ValueError):
            self.evidence()

    def test_evidence_cannot_target_arbitrary_state(self):
        self.tool()
        with self.assertRaises(ValueError):
            self.evidence('receipts', 'tool-1')

    def test_wait_propagates_transitively_but_independent_work_continues(self):
        for tid, deps in [('a', []), ('b', ['a']), ('c', ['b'])]:
            self.tool('TaskUpdate', inp={'taskId': tid, 'addBlockedBy': deps}, tid=tid)
        b.control(self.s, 'wait', dict(generation=1, id='a', kind='approval', pointer='approval:1'))
        self.assertEqual(self.stop(), {})
        self.tool('TaskUpdate', inp={'taskId': 'independent'}, tid='independent')
        result = self.stop()
        self.assertIn('task independent', result['reason'])
        self.assertNotIn('task b:', result['reason'])
        self.assertNotIn('task c:', result['reason'])

    def test_new_question_preserves_old_work_without_forcing_it(self):
        self.contract()
        self.prompt('What does DoD mean?')
        self.assertIn('result', self.s['outcomes'])
        self.assertTrue(self.s['outcomes']['result']['needsReconciliation'])
        self.assertEqual(self.stop(), {})

    def test_multiline_error_content_and_metadata(self):
        self.assertTrue(b.failed({'content': [{'type': 'text', 'text': 'line 1\nline 2', 'is_error': True}]}))
        self.assertFalse(b.failed({'content': [{'type': 'text', 'text': 'example error message'}]}))
        self.contract()
        for tool in ('TaskGet', 'mcp__linear__get_issue', 'mcp__linear__create_comment'):
            self.tool(tool)
            with self.assertRaises(ValueError):
                self.evidence()
            self.s['seen'] = []

    def test_native_multiline_task_contract_shape(self):
        payload = {'content': [{'type': 'text', 'text': json.dumps({'task': {'id': 'nested'}}, indent=2)}]}
        self.tool('TaskCreate', response=payload)
        self.assertIn('nested', self.s['tasks'])
        error = {'content': [{'type': 'text', 'text': json.dumps({'is_error': True}, indent=2)}]}
        self.tool('TaskCreate', response=error, tid='bad')
        self.assertFalse(self.s['receipts']['bad']['ok'])

    def test_incident_needs_validated_resolution(self):
        self.tool(failure=True)
        key = next(iter(self.s['incidents']))
        self.assertIn('incident ' + key, self.stop()['reason'])
        with self.assertRaises(ValueError):
            b.control(self.s, 'resolve-incident', dict(generation=1, id=key))
        source = Path(__file__).parent / 'repair_fixture.py'
        with tempfile.TemporaryDirectory() as td:
            backup = Path(td) / 'fixture.backup'
            backup.write_bytes(source.read_bytes())
            for rid, path in [('source-read', source), ('backup-read', backup)]:
                self.tool('Read', tid=rid, inp={'file_path': str(path)}, response={'content': 'readback'})
            self.tool(tid='repair', response={'exit_code': 0, 'stdout': 'fixture validation passed'})
            b.control(self.s, 'evidence', dict(generation=1, collection='incidents', id=key,
                receipt='repair', pointer=dict(type='transcript', tool='Bash', tool_use_id='repair',
                outputHash=self.s['receipts']['repair']['outputHash']), inspection='actual validation readback'))
            data = dict(generation=1, id=key, receipt='repair', source=str(source), backup=str(backup),
                        preHash=b.file_hash(str(backup)), postHash=b.file_hash(str(source)),
                        validation='original failure rerun', rollback='compare postHash before restore')
            b.control(self.s, 'resolve-incident', data)
            self.assertEqual(self.s['incidents'][key]['status'], 'resolved')
            self.assertEqual(self.stop(), {})

    def test_waived_tool_failure_closes_without_a_fabricated_repair(self):
        # A PreToolUse refusal or an empty grep produced no wrong output: there is
        # no source to repair, so resolve-incident cannot honestly close it.
        self.tool(failure=True, inp={'command': 'grep -l x /tmp'})
        key = next(iter(self.s['incidents']))
        self.assertIn('incident ' + key, self.stop()['reason'])
        self.tool(tid='inspect', response={'exit_code': 0, 'stdout': 'guard refused the call'})
        pointer = dict(type='transcript', tool='Bash', tool_use_id='inspect',
                       outputHash=self.s['receipts']['inspect']['outputHash'])
        b.control(self.s, 'evidence', dict(generation=1, collection='incidents', id=key,
            receipt='inspect', pointer=pointer, inspection='read the guard refusal output'))
        # Without an explicit classification the waiver is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                pointer=pointer, inspection='read the refusal'))
        # An unknown classification is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification='looks-fine-to-me', note='this was only a guard refusal',
                pointer=pointer, inspection='read the refusal'))
        # A thin note is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification='pretooluse-refusal', note='ok',
                pointer=pointer, inspection='read the refusal'))
        # A stale generation is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=0, id=key, receipt='inspect',
                classification='pretooluse-refusal', note='the guard refused the call before it ran',
                pointer=pointer, inspection='read the refusal'))
        b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
            classification='pretooluse-refusal', note='the guard refused the call before it ran',
            pointer=pointer, inspection='read the refusal'))
        item = self.s['incidents'][key]
        self.assertEqual(item['status'], 'waived')
        self.assertEqual(item['waiver']['classification'], 'pretooluse-refusal')
        # The incident stays visible in the state history.
        self.assertIn(key, self.s['incidents'])
        self.assertNotIn('incident ' + key, self.stop().get('reason', ''))

    def test_waiver_needs_evidence_and_cannot_repeat(self):
        self.tool(failure=True)
        key = next(iter(self.s['incidents']))
        self.tool(tid='inspect', response={'exit_code': 0, 'stdout': 'guard refused the call'})
        pointer = dict(type='transcript', tool='Bash', tool_use_id='inspect',
                       outputHash=self.s['receipts']['inspect']['outputHash'])
        # Without inspected evidence on the incident the waiver is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification='pretooluse-refusal', note='the guard refused the call before it ran',
                pointer=pointer, inspection='read the refusal'))
        b.control(self.s, 'evidence', dict(generation=1, collection='incidents', id=key,
            receipt='inspect', pointer=pointer, inspection='read the guard refusal output'))
        b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
            classification='pretooluse-refusal', note='the guard refused the call before it ran',
            pointer=pointer, inspection='read the refusal'))
        # A second waiver on the same incident is refused.
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification='pretooluse-refusal', note='the guard refused the call before it ran',
                pointer=pointer, inspection='read the refusal'))

    def test_every_waiver_class_is_accepted(self):
        for classification in sorted(b.WAIVER_CLASSES):
            self.setUp()
            self.tool(failure=True)
            key = next(iter(self.s['incidents']))
            self.tool(tid='inspect', response={'exit_code': 0, 'stdout': 'read the failure output'})
            pointer = dict(type='transcript', tool='Bash', tool_use_id='inspect',
                           outputHash=self.s['receipts']['inspect']['outputHash'])
            b.control(self.s, 'evidence', dict(generation=1, collection='incidents', id=key,
                receipt='inspect', pointer=pointer, inspection='read the failure output'))
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification=classification, note='the failing call produced no wrong output',
                pointer=pointer, inspection='read the failure output'))
            self.assertEqual(self.s['incidents'][key]['status'], 'waived')

    def test_waiver_never_closes_a_plugin_owned_incident(self):
        # Plugin-owned incidents (own files unreadable) are real defects and must
        # keep needing resolve-incident; a waiver must not touch them.
        b.incident(self.s, 'hooks/bridge.py', 'actual failure')
        key = next(k for k, v in self.s['incidents'].items() if v['category'] == 'actual failure')
        self.tool(tid='inspect', response={'exit_code': 0, 'stdout': 'read back'})
        pointer = dict(type='transcript', tool='Bash', tool_use_id='inspect',
                       outputHash=self.s['receipts']['inspect']['outputHash'])
        b.control(self.s, 'evidence', dict(generation=1, collection='incidents', id=key,
            receipt='inspect', pointer=pointer, inspection='read the plugin file failure'))
        with self.assertRaises(ValueError):
            b.control(self.s, 'waive-incident', dict(generation=1, id=key, receipt='inspect',
                classification='not-a-defect', note='the plugin file could not be read at all',
                pointer=pointer, inspection='read the failure'))
        self.assertEqual(self.s['incidents'][key]['status'], 'needs diagnosis')

    def test_integration_indicator_reports_the_real_stop_hook(self):
        # The pane must never show a dead indicator: before any Stop the state says
        # 'not run', and after a real Stop event it must name the observed dispatch.
        self.assertEqual(self.s['integration'], 'not run')
        self.stop()
        self.assertNotEqual(self.s['integration'], 'not run')
        self.assertIn('Stop', self.s['integration'])

    def test_fixture_repair_executes_without_paid_action(self):
        result = subprocess.run(['python3', '-I', str(Path(__file__).parent / 'repair_fixture.py')],
                                capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        self.assertTrue(report['fixtureOnly'])
        self.assertNotEqual(report['preHash'], report['postHash'])

    def test_revision_conflict(self):
        with self.assertRaises(ValueError):
            b.control(self.s, 'contract', dict(generation=1, revision=99))

    def test_private_atomic_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root) as state:
                state['paused'] = True
            with b.store('s', root) as state:
                self.assertTrue(state['paused'])
                self.assertEqual(state['revision'], 1)
            self.assertEqual((root / 's.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)

    def test_crash_does_not_commit_partial_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root):
                pass
            with self.assertRaises(RuntimeError):
                with b.store('s', root) as state:
                    state['paused'] = True
                    raise RuntimeError('crash')
            with b.store('s', root) as state:
                self.assertFalse(state['paused'])

    def test_corrupt_bytes_preserved_and_paused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root):
                pass
            path = root / 's.json'
            path.write_text('{bad')
            with b.store('s', root) as state:
                self.assertTrue(state['paused'])
                self.assertEqual(state['phase'], 'diagnosis')
            self.assertEqual(path.read_text(), '{bad')

    def test_bad_shapes_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            with b.store('s', root):
                pass
            path = root / 's.json'
            path.write_text(json.dumps({'schemaVersion': 999}))
            with b.store('s', root) as state:
                self.assertTrue(state['paused'])

    def test_paths_symlinks_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            for sid in ('../escape', '', 'a/b'):
                with self.assertRaises(ValueError):
                    with b.store(sid, root):
                        pass
            b.private_dir(root)
            (root / 's.json').symlink_to(Path(tmp) / 'victim')
            with self.assertRaises(ValueError):
                with b.store('s', root):
                    pass
            real = root.lstat()
            widened = os.stat_result((real.st_mode | 0o010,) + tuple(real)[1:])  # simulated group bit; no chmod needed
            with unittest.mock.patch.object(Path, 'lstat', return_value=widened):
                with self.assertRaises(ValueError):
                    b.private_dir(root)

    def test_every_hook_is_a_model_free_command(self):
        import ast
        root = Path(__file__).parent
        hooks = json.loads((root / 'hooks/hooks.json').read_text())['hooks']
        for event, groups in hooks.items():
            for group in groups:
                for hook in group['hooks']:
                    self.assertEqual(hook['type'], 'command', event)
        tree = ast.parse((root / 'hooks/bridge.py').read_text())
        imported = {a.name.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        self.assertFalse(imported & {'subprocess', 'socket', 'urllib', 'http', 'requests', 'anthropic', 'asyncio', 'ssl'})

    def test_state_survives_separate_processes(self):
        sid = 'resume-' + os.urandom(6).hex()
        for suffix in ('.json', '.lock'):
            self.addCleanup(lambda s=suffix: (b.ROOT / (sid + s)).unlink(missing_ok=True))
        with tempfile.TemporaryDirectory() as tmp:
            script = str(Path(__file__).parent / 'hooks/bridge.py')
            def run(*a, data=''):
                return subprocess.run(['python3', '-I', script, *a, '--session', sid], input=data,
                                      capture_output=True, text=True, cwd=tmp)
            run('hook', data=json.dumps(dict(hook_event_name='UserPromptSubmit', prompt='Build it')))
            first = json.loads(run('status').stdout)
            run('hook', data=json.dumps(dict(hook_event_name='PostToolUseFailure', tool_name='Bash', tool_use_id='x',
                                              tool_input={'command': 'a'}, tool_response={'stderr': 'e'})))
            second = json.loads(run('status').stdout)
            self.assertEqual(second['generation'], first['generation'])
            self.assertEqual(len(second['incidents']), 1)

    def test_native_payload_fixture_receipts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'state'
            payloads = [dict(hook_event_name='SessionStart', session_id='fixture'),
                        dict(hook_event_name='UserPromptSubmit', session_id='fixture', prompt='Test'),
                        dict(hook_event_name='PostToolUse', session_id='fixture', tool_name='Bash',
                             tool_use_id='native', tool_input={'command': 'true'}, tool_response={'exit_code': 0}),
                        dict(hook_event_name='Stop', session_id='fixture', stop_hook_active=False,
                             last_assistant_message='Output')]
            for p in payloads:
                with b.store('fixture', root) as s:
                    b.event(s, p)
            with b.store('fixture', root) as s:
                self.assertEqual(s['stopInvocations'], 1)
                self.assertTrue(s['receipts']['native']['ok'])
                self.assertEqual(s['delivery']['generation'], 1)


if __name__ == '__main__':
    unittest.main()
