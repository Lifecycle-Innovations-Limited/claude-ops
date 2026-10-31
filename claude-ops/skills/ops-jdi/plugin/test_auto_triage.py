"""Failures whose own error text proves nothing ran are triaged by default; all else stays open."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('triage_bridge', Path(__file__).parent / 'hooks/bridge.py')
assert spec is not None and spec.loader is not None
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def fail(s, tool, error, call='c1', tool_input=None):
    b.event(s, dict(hook_event_name='PostToolUseFailure', tool_name=tool, tool_use_id=call,
                    tool_input=tool_input or {'command': 'x'}, error=error, is_interrupt=False))
    return list(s['incidents'].values())[-1]


class AutoTriage(unittest.TestCase):
    def test_guard_refusal_is_waived_by_default(self):
        s = b.fresh('t')
        i = fail(s, 'Bash', 'This session is isolated in the worktree /w, but this command is too complex. Refusing to run it')
        self.assertEqual((i['status'], i['waiver']['classification'], i['effect']), ('waived', 'pretooluse-refusal', 'not-started'))
        self.assertTrue(i['waiver']['auto'])

    def test_resource_admission_refusal_and_missing_command_and_path(self):
        for tool, text, cls, effect in (
            ('Bash', 'PreToolUse:Bash hook error: Resource admission: run one heavy job through: x', 'pretooluse-refusal', 'not-started'),
            ('Bash', 'Exit code 127\n(eval):1: command not found: argot', 'agent-input-error', 'not-started'),
            ('Read', 'File does not exist. Note: your current working directory is /w.', 'agent-input-error', 'confirmed-no-effect'),
        ):
            s = b.fresh('t')
            i = fail(s, tool, text)
            self.assertEqual((i['status'], i['waiver']['classification'], i['effect']), ('waived', cls, effect), text)

    def test_ambiguous_failures_stay_open(self):
        for tool, text in (('Bash', 'Exit code 1'), ('Bash', 'Exit code 1\nTraceback (most recent call last):'),
                           ('Bash', 'timed out after 60000ms'), ('Bash', ''), ('Read', 'Permission denied')):
            s = b.fresh('t')
            i = fail(s, tool, text)
            self.assertEqual(i['status'], 'needs diagnosis', text)
            self.assertNotIn('waiver', i)

    def test_writes_are_never_triaged_and_text_is_not_stored(self):
        s = b.fresh('t')
        i = fail(s, 'Edit', 'File does not exist. secret-marker-123')
        self.assertEqual(i['status'], 'needs diagnosis')
        s = b.fresh('t')
        i = fail(s, 'Read', 'File does not exist. secret-marker-123')
        self.assertNotIn('secret-marker-123', repr(i))


if __name__ == '__main__':
    unittest.main()
