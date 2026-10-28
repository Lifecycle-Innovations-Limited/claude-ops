"""Exercise the OPS adapter through its real subprocess interface."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'mixforge-run.py'


class AdapterTests(unittest.TestCase):
    def run_adapter(self, env, *args):
        clean = {k: v for k, v in os.environ.items() if not k.startswith('MIXFORGE_')}
        clean.update(env)
        return subprocess.run([sys.executable, '-I', str(SCRIPT), *args], env=clean,
                              capture_output=True, text=True)

    def test_argv_preserves_metacharacters_and_exit_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = Path(tmp) / 'fake engine'
            engine.write_text('#!' + sys.executable + '\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(7)\n')
            engine.chmod(0o700)
            value = 'a file; $(touch sentinel) `id`.wav'
            result = self.run_adapter({'MIXFORGE_EXECUTABLE': str(engine)}, 'judge', value)
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['judge', value])
            self.assertFalse((Path(tmp) / 'sentinel').exists())

    def test_explicit_missing_engine_does_not_fallback(self):
        result = self.run_adapter({'MIXFORGE_EXECUTABLE': '/nonexistent/mixforge'}, '--help')
        self.assertEqual(result.returncode, 2)
        self.assertIn('MIXFORGE_EXECUTABLE', result.stderr)

    def test_source_path_uses_configured_interpreter(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'engine source'
            package = source / 'mixforge'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            (package / '__main__.py').write_text('import json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            result = self.run_adapter({'MIXFORGE_SOURCE': str(source), 'MIXFORGE_PYTHON': sys.executable},
                                      'project', 'brief with spaces.json')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['project', 'brief with spaces.json'])

    def test_bad_source_fails_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_adapter({'MIXFORGE_SOURCE': tmp}, '--help')
            self.assertEqual(result.returncode, 2)
            self.assertIn('MIXFORGE_SOURCE', result.stderr)

    def test_runtime_model_configuration_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = Path(tmp) / 'engine'
            engine.write_text('#!' + sys.executable + '\nimport os\nprint(os.environ["MIXFORGE_JUDGE_MODEL"])\n')
            engine.chmod(0o700)
            result = self.run_adapter({'MIXFORGE_EXECUTABLE': str(engine),
                                       'MIXFORGE_JUDGE_MODEL': 'runtime-selected-model'}, 'judge')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'runtime-selected-model')


class EvidenceHandoffTests(unittest.TestCase):
    def test_mix_route_selects_evidence_mode_with_matching_producer_contract(self):
        root = SCRIPT.parent.parent
        mix = (root / 'skills/ops-mix/SKILL.md').read_text()
        ar = (root / 'skills/ops-ar/SKILL.md').read_text()
        producer = (root / 'agents/ar-producer.md').read_text()
        self.assertIn('ops:ops-ar mix-evidence <judge-report.json> <mixbrief.json>', mix)
        mode = ar.split('### Mix evidence', 1)[1].split('### 1.', 1)[0]
        self.assertIn('takes precedence', mode)
        self.assertIn('mode: mix-evidence', mode)
        self.assertIn('No new audio analysis, uploads, paid calls', mode)
        self.assertIn('this mode uses Read only', mode)
        agent_mode = producer.split('## Mix evidence mode', 1)[1].split('## Your job', 1)[0]
        self.assertIn('replaces the full-pass analysis', agent_mode)
        self.assertIn('Do not run audio tools', agent_mode)
        self.assertIn('No hit score or signing decision', agent_mode)
        self.assertIn('COVERAGE', agent_mode)


if __name__ == '__main__':
    unittest.main()
