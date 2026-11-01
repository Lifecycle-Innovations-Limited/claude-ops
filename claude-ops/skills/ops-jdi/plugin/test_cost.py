"""TEAM-1 free evidence that a Stop costs no model call.

This proves the Stop hook is a local script: it imports no network, model or process-spawning module, and it
runs in milliseconds. It is NOT a billed measurement; nothing here talks to a provider or reads an invoice.
"""
import ast
import json
from pathlib import Path
import os
import re
import resource
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / 'hooks/bridge.py'
ALLOWED_IMPORTS = {'argparse', 'contextlib', 'fcntl', 'hashlib', 'json', 'os', 'pathlib', 're', 'shlex', 'stat', 'sys', 'tempfile', 'time'}
FORBIDDEN_OS_CALLS = {'system', 'popen', 'fork', 'forkpty', 'posix_spawn', 'posix_spawnp', 'startfile'}
FORBIDDEN_NAMES = {'__import__', 'eval', 'exec', 'compile', 'importlib', 'subprocess', 'socket'}
STOP_RUNS = 50
STOP_BUDGET_MS = 250


class StaticCostTests(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(BRIDGE.read_text())

    def test_imports_are_a_closed_local_only_allowlist(self):
        imported = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                imported |= {a.name.split('.')[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, 'relative import')
                imported.add((node.module or '').split('.')[0])
        self.assertLessEqual(imported, ALLOWED_IMPORTS, 'new import needs an explicit cost review: ' + str(sorted(imported - ALLOWED_IMPORTS)))

    def test_no_dynamic_import_exec_or_process_spawn(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Name):
                self.assertNotIn(node.id, FORBIDDEN_NAMES, 'line %d' % node.lineno)
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'os':
                self.assertNotIn(node.attr, FORBIDDEN_OS_CALLS, 'line %d' % node.lineno)
                self.assertFalse(node.attr.startswith(('exec', 'spawn')), 'line %d' % node.lineno)

    def test_no_string_that_launches_a_model_cli_or_names_a_provider(self):
        cli = re.compile(r'(^|[\s/])claude(\s+(-p|--print)\b|\s*$)')
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                self.assertIsNone(cli.search(node.value), 'line %d' % node.lineno)
                self.assertNotIn('anthropic', node.value.lower(), 'line %d' % node.lineno)
                self.assertNotRegex(node.value, r'https?://', 'line %d' % node.lineno)

    def test_every_registered_hook_is_the_same_local_command(self):
        config = json.loads((HERE / 'hooks/hooks.json').read_text())
        commands = {h['command'] for groups in config['hooks'].values() for g in groups for h in g['hooks'] if h['type'] == 'command'}
        kinds = {h['type'] for groups in config['hooks'].values() for g in groups for h in g['hooks']}
        self.assertEqual(kinds, {'command'})
        self.assertEqual(commands, {'python3 -I "${CLAUDE_PLUGIN_ROOT}/hooks/bridge.py"'})
        self.assertEqual(len(config['hooks']['Stop'][0]['hooks']), 1)


class StopPathTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.plugin = Path(self._tmp.name) / 'plugin'
        (self.plugin / 'hooks').mkdir(parents=True)
        shutil.copy(BRIDGE, self.plugin / 'hooks/bridge.py')

    def run_hook(self, payload):
        """Return (completed process, wall ms, child CPU ms). CPU time is immune to a loaded machine."""
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.perf_counter_ns()
        done = subprocess.run([sys.executable, '-I', str(self.plugin / 'hooks/bridge.py')], input=json.dumps(payload),
                              capture_output=True, text=True, timeout=60)
        wall = (time.perf_counter_ns() - started) / 1e6
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        return done, wall, ((after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)) * 1000

    def test_stop_in_process_makes_no_network_or_process_call(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('bridge_cost', BRIDGE)
        b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b)
        state = b.fresh('cost')
        b.event(state, dict(hook_event_name='UserPromptSubmit', prompt='work'))
        tripwire = AssertionError('Stop reached for network or process')
        with mock.patch.object(socket, 'socket', side_effect=tripwire), mock.patch.object(socket, 'create_connection', side_effect=tripwire), \
                mock.patch.object(subprocess, 'Popen', side_effect=tripwire), mock.patch('os.system', side_effect=tripwire):
            result = b.event(state, dict(hook_event_name='Stop', last_assistant_message='done'))
        self.assertEqual(result, {})
        self.assertEqual(state['stopInvocations'], 1)

    def test_stop_latency_over_50_real_invocations(self):
        session = 'cost-timing'
        for payload in (dict(hook_event_name='SessionStart', session_id=session),
                        dict(hook_event_name='UserPromptSubmit', session_id=session, prompt='measure the stop path'),
                        dict(hook_event_name='PostToolUse', session_id=session, tool_name='Bash', tool_use_id='t1',
                             tool_input={'command': 'true'}, tool_response={'exit_code': 0})):
            done, _, _ = self.run_hook(payload)
            self.assertEqual(done.returncode, 0, done.stderr)
        self.run_hook(dict(hook_event_name='Stop', session_id=session, last_assistant_message='warm'))  # warm file cache
        wall, cpu = [], []
        for n in range(STOP_RUNS):
            done, wall_ms, cpu_ms = self.run_hook(dict(hook_event_name='Stop', session_id=session, stop_hook_active=bool(n % 2),
                                                       last_assistant_message='Result %d' % n))
            self.assertEqual(done.returncode, 0, done.stderr)
            json.loads(done.stdout)
            wall.append(wall_ms)
            cpu.append(cpu_ms)
        wall.sort()
        cpu.sort()
        load = os.getloadavg()[0]
        saturated = load > (os.cpu_count() or 1)
        print('\nSTOP_TIMING runs=%d cpu_median_ms=%.1f cpu_max_ms=%.1f wall_median_ms=%.1f wall_p95_ms=%.1f wall_max_ms=%.1f '
              'budget_ms=%d load1=%.1f cpus=%s wall_assert=%s (interpreter start included; local script, not a billed measurement)'
              % (len(wall), statistics.median(cpu), cpu[-1], statistics.median(wall), wall[int(len(wall) * 0.95) - 1], wall[-1],
                 STOP_BUDGET_MS, load, os.cpu_count(), 'skipped: machine saturated' if saturated else 'enforced'))
        self.assertEqual(len(wall), STOP_RUNS)
        self.assertLess(statistics.median(cpu), STOP_BUDGET_MS)
        if not saturated:
            self.assertLess(statistics.median(wall), STOP_BUDGET_MS)


if __name__ == '__main__':
    unittest.main()
