import ast
import pathlib
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/ops-cron-pocket-executor.py'

class ContextTests(unittest.TestCase):
    def test_reconciliation_matches_restricted_dispatch(self):
        tree = ast.parse(SOURCE.read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_reconcile_job_settings')
        module = ast.Module(body=[fn], type_ignores=[])
        import os, subprocess
        scope = dict(Path=pathlib.Path, __file__=str(SOURCE), os=os, subprocess=subprocess, WORKER_USER='synthetic-worker', WORKER_CLAUDE_CONFIG_DIR='/tmp/synthetic-worker-config')
        exec(compile(module, str(SOURCE), 'exec'), scope)
        with patch.dict(os.environ, {'USER':'synthetic-executor'}), patch.object(subprocess, 'run') as run:
            scope['_reconcile_job_settings']()
        args, kw = run.call_args
        self.assertEqual(kw.get('env',{}).get('CLAUDE_CONFIG_DIR'), '/tmp/synthetic-worker-config')
        self.assertEqual(args[0][:5], ['sudo','-n','-H','-u','synthetic-worker'])
        self.assertIn('--preserve-env=PATH,CLAUDE_CONFIG_DIR', args[0])

unittest.main()
