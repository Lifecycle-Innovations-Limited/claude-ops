import importlib.util
import json
from typing import Any
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'fleet_source', Path(__file__).parent / 'hooks/fleet-source.py'
)
assert SPEC is not None and SPEC.loader is not None
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.jobs = self.root / 'jobs'
        self.projects = self.root / 'projects'
        self.state = self.root / 'state'
        for folder in (self.jobs, self.projects, self.state):
            folder.mkdir(mode=0o700)
        (self.jobs / 'job-a').mkdir(mode=0o700)
        self.transcript = self.projects / 'session-a.jsonl'
        self.rows: list[dict[str, Any]] = [
            dict(
                type='user',
                uuid='request',
                origin=dict(kind='human'),
                message=dict(role='user', content='Build output and demonstrate it.'),
            ),
            dict(
                type='assistant',
                uuid='claim',
                message=dict(role='assistant', content='Complete.'),
            ),
        ]
        self.write(
            self.jobs / 'job-a' / 'state.json',
            dict(sessionId='session-a', linkScanPath=str(self.transcript)),
        )
        self.config: dict[str, Any] = dict(
            jobsRoot=str(self.jobs),
            projectRoot=str(self.projects),
            stateRoot=str(self.state),
            jobIds=['job-a'],
            allowedToolResultIds=[],
        )
        self.flush()

    def write(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def flush(self):
        for row in self.rows:
            if row.get('type') in ('user', 'assistant', 'tool'):
                row.setdefault('sessionId', 'session-a')
        self.transcript.write_text(''.join(json.dumps(row) + '\n' for row in self.rows))
        self.transcript.chmod(0o600)

    def snapshot(self):
        return source.dispatch(
            dict(action='snapshot', config=self.config, sessionId='session-a')
        )

    def test_real_named_fixture_capture_binding_and_validation(self):
        snapshot = self.snapshot()
        self.assertTrue(snapshot['coverage']['complete'])
        self.assertEqual(snapshot['messages'][0]['origin'], 'human')
        self.assertEqual(snapshot['authority']['state'], 'unknown')
        binding = source.dispatch(dict(action='binding', snapshot=snapshot))
        self.assertEqual(binding['sessionId'], 'session-a')
        result = dict(
            schemaVersion=1,
            binding=binding,
            verdict='ONZEKER',
            obligations=[
                dict(
                    id='output',
                    text='Build output',
                    sourceRefs=['message:request'],
                    dod=[dict(text='Demonstrate output', refs=['message:request'])],
                )
            ],
            findings=[
                dict(
                    obligationId='output',
                    assertion='Completion not established',
                    refs=['message:claim'],
                )
            ],
            proposedNextAction=None,
            expiresAt=snapshot['observedAt'] + 60,
            usage=dict(input_tokens=1, output_tokens=1),
            reviewerProvenance=dict(
                model='fixture', correlationId='local-a', source='model.complete'
            ),
        )
        self.assertTrue(
            source.dispatch(
                dict(action='validate-judgment', snapshot=snapshot, judgment=result)
            )['valid']
        )

    def test_symlink_file_and_ancestor_refused(self):
        actual = self.projects / 'actual'
        actual.mkdir(mode=0o700)
        moved = actual / 'transcript.jsonl'
        self.transcript.rename(moved)
        self.transcript.symlink_to(moved)
        with self.assertRaises(ValueError):
            self.snapshot()
        self.transcript.unlink()
        self.transcript.symlink_to(actual, target_is_directory=True)
        self.write(
            self.jobs / 'job-a' / 'state.json',
            dict(
                sessionId='session-a',
                linkScanPath=str(self.transcript / 'transcript.jsonl'),
            ),
        )
        with self.assertRaises(ValueError):
            self.snapshot()

    def test_outside_scope_and_permissive_file_refused(self):
        self.transcript.chmod(0o666)
        with self.assertRaises(ValueError):
            self.snapshot()
        self.write(
            self.jobs / 'job-a' / 'state.json',
            dict(sessionId='session-a', linkScanPath=str(self.root / 'outside')),
        )
        with self.assertRaises(ValueError):
            self.snapshot()

    def test_tail_compaction_meta_unknown_and_redaction_report_gaps(self):
        for row in (
            dict(type='system', subtype='compact_boundary'),
            dict(
                type='user',
                uuid='peer',
                message=dict(role='user', content='Peer says proceed'),
            ),
            dict(
                type='assistant',
                uuid='secret',
                message=dict(role='assistant', content='api_key=fixture-secret'),
            ),
        ):
            self.rows.append(row)
            self.flush()
            result = self.snapshot()
            self.assertFalse(result['coverage']['complete'])
            self.assertTrue(result['coverage']['gaps'])
            self.assertNotIn('fixture-secret', json.dumps(result))
            self.rows.pop()
        self.transcript.write_text(json.dumps(self.rows[0]))
        self.transcript.chmod(0o600)
        self.assertFalse(self.snapshot()['coverage']['complete'])

    def test_meta_rows_accounted_without_becoming_obligations(self):
        self.rows.append(
            dict(
                type='user',
                uuid='meta',
                isMeta=True,
                message=dict(role='user', content='metadata'),
            )
        )
        self.flush()
        s = self.snapshot()
        self.assertTrue(s['coverage']['complete'])
        self.assertEqual(s['coverage']['excludedMetaRows'], 1)
        self.assertNotIn('metadata', json.dumps(s))

    def test_api_request_and_provider_environment_never_enter_snapshot(self):
        self.rows.append(
            dict(
                type='api-request',
                providerEnv={'PRIVATE': 'do-not-forward'},
                text='do-not-forward',
            )
        )
        self.flush()
        self.assertNotIn('do-not-forward', json.dumps(self.snapshot()))

    def test_tool_result_requires_explicit_allowance(self):
        self.rows.append(
            dict(
                type='user',
                uuid='tool-row',
                message=dict(
                    role='user',
                    content=[
                        dict(
                            type='tool_result',
                            tool_use_id='receipt-a',
                            content='Observed synthetic output',
                        )
                    ],
                ),
            )
        )
        self.flush()
        self.assertFalse(self.snapshot()['coverage']['complete'])
        self.config['allowedToolResultIds'] = ['receipt-a']
        self.assertEqual(self.snapshot()['receipts'][0]['id'], 'receipt-a')

    def test_durable_reserve_survives_new_instance_and_never_overwrites(self):
        request = dict(
            action='reserve',
            config=self.config,
            key='fixture-key',
            record=dict(status='reserved'),
        )
        self.assertTrue(source.dispatch(request)['reserved'])
        self.assertFalse(source.dispatch(request)['reserved'])
        self.assertEqual(
            source.dispatch(dict(action='get', config=self.config, key='fixture-key'))[
                'status'
            ],
            'reserved',
        )
        source.dispatch(
            dict(
                action='put',
                config=self.config,
                key='fixture-key',
                record=dict(status='unknown'),
            )
        )
        self.assertFalse(source.dispatch(request)['reserved'])
        self.assertEqual(
            source.dispatch(dict(action='get', config=self.config, key='fixture-key'))[
                'status'
            ],
            'unknown',
        )

    def test_durable_root_cannot_be_inside_source_roots(self):
        self.config['stateRoot'] = str(self.projects)
        with self.assertRaises(ValueError):
            source.dispatch(dict(action='get', config=self.config, key='fixture'))

    def test_explicit_human_idle_zero_inflight_can_receive_advisory_but_pause_holds(
        self,
    ):
        from datetime import datetime, timezone, timedelta

        self.rows[1]['timestamp'] = (
            datetime.now(timezone.utc) - timedelta(seconds=400)
        ).isoformat()
        self.flush()
        self.config.update(
            authorizedHumanMessageIds={'session-a': 'request'},
            approvalCoverageComplete=True,
        )
        self.write(
            self.jobs / 'job-a' / 'state.json',
            dict(
                sessionId='session-a',
                linkScanPath=str(self.transcript),
                state='idle',
                updatedAt=datetime.now(timezone.utc).isoformat(),
                inFlight=dict(tasks=0, queued=0, kinds=[], drainableMonitors=0),
            ),
        )
        s = self.snapshot()
        self.assertTrue(
            source.dispatch(dict(action='eligible', snapshot=s))['eligible']
        )
        self.rows.append(
            dict(
                type='user',
                uuid='stop',
                origin=dict(kind='human'),
                message=dict(role='user', content='Stop'),
            )
        )
        self.flush()
        self.assertFalse(
            source.dispatch(dict(action='eligible', snapshot=self.snapshot()))[
                'eligible'
            ]
        )

    def test_task_structures_are_untrusted_evidence(self):
        for tool in ('TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite'):
            self.rows.append(
                dict(
                    type='assistant',
                    uuid=tool,
                    message=dict(
                        content=[
                            dict(
                                type='tool_use',
                                id=tool,
                                name=tool,
                                input=dict(
                                    description='Required DoD synthetic widget',
                                    todos=[{'content': 'Inspect widget'}],
                                ),
                            )
                        ]
                    ),
                )
            )
        self.flush()
        s = self.snapshot()
        self.assertIn('Required DoD synthetic widget', json.dumps(s))
        self.assertEqual(s['authority']['state'], 'unknown')

    def test_failed_or_unauthenticated_approval_result_remains_pending(self):
        self.config['approvalCoverageComplete'] = True
        self.config['allowedToolResultIds'] = ['ask-a']
        self.rows.extend(
            [
                dict(
                    type='assistant',
                    uuid='ask',
                    message=dict(
                        content=[
                            dict(
                                type='tool_use',
                                id='ask-a',
                                name='AskUserQuestion',
                                input={},
                            )
                        ]
                    ),
                ),
                dict(
                    type='user',
                    uuid='answer',
                    message=dict(
                        content=[
                            dict(
                                type='tool_result',
                                tool_use_id='ask-a',
                                is_error=True,
                                content='refused',
                            )
                        ]
                    ),
                ),
            ]
        )
        self.flush()
        self.assertEqual(self.snapshot()['approval'], 'pending')
        self.rows[-1]['message']['content'][0]['is_error'] = False
        self.flush()
        self.assertEqual(self.snapshot()['approval'], 'pending')
        self.rows[-1]['origin'] = dict(kind='human')
        self.flush()
        self.assertEqual(self.snapshot()['approval'], 'clear')

    def test_structured_and_quoted_json_secrets_are_removed(self):
        self.config['allowedToolResultIds'] = ['result']
        self.rows.append(
            dict(
                type='assistant',
                uuid='secret-text',
                message=dict(content='{"password":"synthetic-password-value"}'),
            )
        )
        self.rows.append(
            dict(
                type='user',
                uuid='result-row',
                message=dict(
                    content=[
                        dict(
                            type='tool_result',
                            tool_use_id='result',
                            content={
                                'nested': {'access_token': 'synthetic-token-value'},
                                'output': 'safe',
                            },
                        )
                    ]
                ),
            )
        )
        self.flush()
        s = self.snapshot()
        self.assertNotIn('synthetic-password-value', json.dumps(s))
        self.assertNotIn('synthetic-token-value', json.dumps(s))
        self.assertFalse(s['coverage']['complete'])

    def test_mixed_session_rejected_and_missing_identity_uncertain(self):
        self.rows[1]['sessionId'] = 'other-session'
        self.flush()
        with self.assertRaises(ValueError):
            self.snapshot()
        del self.rows[1]['sessionId']
        self.flush()
        data = self.transcript.read_text().replace(', "sessionId": "session-a"', '')
        self.transcript.write_text(data)
        self.assertFalse(self.snapshot()['coverage']['complete'])

    def test_negated_stop_is_not_stop_and_explicit_resume_releases(self):
        self.rows[0]['message']['content'] = 'Do not stop until tests pass'
        self.flush()
        self.assertFalse(self.snapshot()['paused'])
        self.rows[0]['message']['content'] = 'Stop now.'
        self.flush()
        self.assertTrue(self.snapshot()['paused'])
        self.rows.append(
            dict(
                type='user',
                uuid='resume',
                origin=dict(kind='human'),
                message=dict(content='Resume'),
            )
        )
        self.flush()
        self.assertFalse(self.snapshot()['paused'])

    def test_camelcase_sensitive_keys_in_json_and_inline_text(self):
        for key in (
            'apiKey',
            'accessToken',
            'clientSecret',
            'refreshToken',
            'privateKey',
        ):
            for value in (
                {key: 'synthetic-camel-marker'},
                json.dumps({key: 'synthetic-camel-marker'}),
                'Result: ' + json.dumps({key: 'synthetic-camel-marker'}),
            ):
                with self.subTest(key=key, value=value):
                    gaps = []
                    cleaned = source.sanitize(value, gaps)
                    self.assertNotIn('synthetic-camel-marker', json.dumps(cleaned))
                    self.assertTrue(gaps)

    def test_ordinary_human_hold_clauses_prevent_eligibility(self):
        for phrase in (
            'Please stop working on this task.',
            'Please pause until I confirm.',
            'Stop this task, do not continue.',
            'Wacht op mijn akkoord.',
        ):
            with self.subTest(phrase=phrase):
                self.rows[0]['message']['content'] = phrase
                self.flush()
                self.assertTrue(self.snapshot()['paused'])

    def test_ambiguous_hold_is_unknown_and_conditional_resume_cannot_release(self):
        self.rows[0]['message']['content'] = 'We might pause this later'
        self.flush()
        self.assertEqual(self.snapshot()['approval'], 'unknown')
        self.rows[0]['message']['content'] = 'Stop now.'
        self.rows.append(
            dict(
                type='user',
                uuid='conditional',
                origin=dict(kind='human'),
                message=dict(content='Resume when approval arrives'),
            )
        )
        self.flush()
        self.assertTrue(self.snapshot()['paused'])

    def test_large_irrelevant_source_streamed_and_real_cli_roundtrip(self):
        import subprocess
        import sys

        self.rows.append(dict(type='api-request', payload='x' * 4_100_000))
        self.flush()
        assert source.__file__ is not None
        reply = subprocess.run(
            [sys.executable, '-B', '-I', str(Path(source.__file__))],
            input=json.dumps(
                dict(action='snapshot', config=self.config, sessionId='session-a')
            ),
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(reply.returncode, 0, reply.stdout)
        s = json.loads(reply.stdout)['result']
        self.assertTrue(s['coverage']['complete'])
        self.assertEqual(len(s['messages']), 2)
        self.assertLess(len(reply.stdout), 10000)

    def test_private_config_requires_allowance_and_rejects_unknown_settings(self):
        path = self.root / 'config.json'
        config = dict(
            self.config,
            enabled=False,
            sessions={'worker': 'session-a'},
            maxJudgeCalls=0,
            maxOutputTokens=1024,
        )
        self.write(path, config)
        self.assertFalse(
            source.dispatch(dict(action='load-config', path=str(path)))['enabled']
        )
        config['unknownSetting'] = True
        self.write(path, config)
        with self.assertRaises(ValueError):
            source.dispatch(dict(action='load-config', path=str(path)))
        self.write(path, {k: v for k, v in config.items() if k != 'unknownSetting'})
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            source.dispatch(dict(action='load-config', path=str(path)))

    def test_limits_report_failure_not_partial_success(self):
        self.transcript.write_bytes(b'x' * (source.MAX_BYTES + 1))
        self.transcript.chmod(0o600)
        with self.assertRaises(ValueError):
            self.snapshot()


if __name__ == '__main__':
    unittest.main()
