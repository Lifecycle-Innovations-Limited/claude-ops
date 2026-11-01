#!/usr/bin/env python3
"""Compose invocation-only settings without changing installed configuration."""
import json
import sys
import os
import tempfile
import subprocess
from pathlib import Path
import importlib.util

_spec = importlib.util.spec_from_file_location('settings_record', Path(__file__).with_name('settings-record.py'))
_store = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_store)


def identity(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def foreground_root():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude') / 'foreground-settings'


def recover(root):
    if not _store.directory(root, True):
        raise ValueError('invalid foreground registry')
    documents = root / 'documents'
    if not _store.directory(documents, True):
        raise ValueError('invalid foreground documents')
    for record in root.glob('*.json'):
        if not _store.owned(record, root):
            continue
        try:
            row = json.loads(record.read_text())
            current = identity(row['pid'])
            if current == row['start']:
                continue
            # Missing PID or reused PID proves this recorded owner is gone.
            path = Path(row['path'])
            if not _store.owned(path, documents, absent=True):
                continue
            path.unlink(missing_ok=True)
            record.unlink()
        except (OSError, ValueError, KeyError):
            continue


def compose(documents):
    merged = {}
    for document in documents:
        if document.lstrip().startswith('{'):
            value = json.loads(document)
        else:
            with open(document, encoding='utf-8') as source:
                value = json.load(source)
        if not isinstance(value, dict):
            raise ValueError('settings must be a JSON object')
        # Claude accepts one additional document: the last caller document wins.
        merged = value
    plugins = merged.get('enabledPlugins', {})
    if not isinstance(plugins, dict):
        raise ValueError('enabledPlugins must be a JSON object')
    merged['enabledPlugins'] = {**plugins, 'telegram@claude-plugins-official': False}
    return merged


if __name__ == '__main__':
    try:
        root = foreground_root()
        recover(root)
        content = sys.stdin.read()
        value = json.loads(content) if sys.argv[1:] in (['--document'], ['--background']) else compose(content.rstrip('\0').split('\0'))
        owner = int(os.environ.get('CLAUDE_SETTINGS_OWNER_PID', os.getppid()))
        started = identity(owner)
        if not started:
            raise ValueError('foreground owner unavailable')
        background = sys.argv[1:] == ['--background']
        if background:
            root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude') / 'job-settings'
        path, record = _store.create_document(root, value, owner, started, background)
        print(json.dumps({'path': path, 'record': record}) if background else path)
    except (OSError, ValueError):
        print('headless settings composition failed', file=sys.stderr)
        sys.exit(2)
