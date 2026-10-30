import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).parent / 'install.py')
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)


class ManifestTests(unittest.TestCase):
    def test_optional_fleet_config_and_core_hook_preservation(self):
        plugin = Path(__file__).parent / 'plugin'
        manifest = json.loads((plugin / '.claude-plugin/plugin.json').read_text())
        self.assertEqual(manifest['userConfig']['fleetConfigPath'], dict(
            type='file', title='Fleet configuration',
            description='Optional absolute path to a private fleet configuration. Empty disables fleet inspection.',
            required=False, default=''))
        hooks = json.loads((plugin / 'hooks/hooks.json').read_text())
        self.assertEqual(hooks['modules'], ['./register.tsx', './fleet-entry.ts'])
        self.assertEqual(set(hooks['hooks']), {
            'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'})
        expected = [dict(hooks=[dict(type='command',
            command='python3 -I "${CLAUDE_PLUGIN_ROOT}/hooks/bridge.py"', timeout=10)])]
        for event, groups in hooks['hooks'].items():
            self.assertEqual(groups, expected, event)

    def test_runtime_manifest_tracks_every_fleet_dependency_and_detects_changes(self):
        plugin = Path(__file__).parent / 'plugin'
        fleet = {'hooks/fleet_guard.py', 'hooks/fleet.ts', 'hooks/fleet-source.py',
                 'hooks/fleet-runtime.ts', 'hooks/fleet-entry.ts'}
        self.assertTrue(fleet <= i.runtime_manifest(plugin).keys())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root / 'source', root / 'target'
            for base in (source, target):
                (base / 'hooks').mkdir(parents=True)
                for rel in fleet:
                    (base / rel).write_text('original')
            (target / 'hooks/fleet-source.py').write_text('changed dependency')
            (target / 'hooks/fleet-entry.ts').unlink()
            report = i.compare_runtime(source, target)
            self.assertEqual(report['changed'], ['hooks/fleet-source.py'])
            self.assertEqual(report['missing'], ['hooks/fleet-entry.ts'])

    def test_runtime_manifest_excludes_state_host_types_and_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in ('hooks/bridge.py', 'hooks/register.tsx', 'runtime/a.json', '.claude-plugin/types/claude-code/index.d.ts', 'test_bridge.py', 'unknown.txt'):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('bytes')
            manifest = i.runtime_manifest(root)
            self.assertEqual(set(manifest), {'hooks/bridge.py', 'hooks/register.tsx'})
            self.assertEqual(len(manifest['hooks/bridge.py']), 64)

    def test_comparison_is_read_only_and_reports_unknown_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, dest = root / 'source', root / 'dest'
            for base, text in ((source, 'new'), (dest, 'local')):
                (base / 'hooks').mkdir(parents=True)
                (base / 'hooks/bridge.py').write_text(text)
            (dest / 'unknown.txt').write_text('preserve')
            report = i.compare_runtime(source, dest)
            self.assertEqual(report['changed'], ['hooks/bridge.py'])
            self.assertIn('unknown.txt', report['preserved'])
            self.assertEqual((dest / 'hooks/bridge.py').read_text(), 'local')
            self.assertEqual((dest / 'unknown.txt').read_text(), 'preserve')

if __name__ == '__main__':
    unittest.main()
