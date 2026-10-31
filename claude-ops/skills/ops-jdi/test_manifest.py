import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).parent / 'install.py')
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)


class ManifestTests(unittest.TestCase):
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
