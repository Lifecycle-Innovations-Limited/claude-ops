import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[1] / 'scripts/lib'
spec = importlib.util.spec_from_file_location('headless', LIB / 'headless-settings.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class CrashTests(unittest.TestCase):
    def test_foreground_secret_write_already_has_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config'
            real_dump = json.dump
            def inspect(value, target, *args, **kwargs):
                if value.get('env', {}).get('KEY') == 'synthetic':
                    records = list((config / 'foreground-settings').glob('*.json'))
                    self.assertTrue(records, 'durable intent must exist before secret bytes')
                return real_dump(value, target, *args, **kwargs)
            with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(config)}):
                with patch.object(helper.json, 'dump', inspect):
                    # The public creation function is shared by foreground and
                    # background writers after the transaction repair.
                    if hasattr(helper._store, 'create_document'):
                        helper._store.create_document(config / 'foreground-settings', {'env': {'KEY': 'synthetic'}}, os.getpid(), helper.identity(os.getpid()))
                    else:
                        root = config / 'foreground-settings'
                        helper.recover(root)
                        fd, path = tempfile.mkstemp(dir=root / 'documents')
                        with os.fdopen(fd, 'w') as target:
                            helper.json.dump({'env': {'KEY': 'synthetic'}}, target)

    def test_background_secret_write_already_has_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'job-settings'
            real_dump = json.dump
            def inspect(value, target, *args, **kwargs):
                if value.get('env', {}).get('KEY') == 'synthetic':
                    self.assertTrue(list(config.glob('*.json')), 'background intent must precede secret bytes')
                return real_dump(value, target, *args, **kwargs)
            with patch.object(helper.json, 'dump', inspect):
                if hasattr(helper._store, 'create_document'):
                    helper._store.create_document(config, {'env': {'KEY': 'synthetic'}}, os.getpid(), helper.identity(os.getpid()), background=True)
                else:
                    helper._store.directory(config / 'documents', True)
                    with (config / 'documents/orphan.json').open('w') as target:
                        helper.json.dump({'env': {'KEY': 'synthetic'}}, target)

unittest.main()
