#!/usr/bin/env python3
"""Offline repair/backup/validation/rollback exercise; touches a fresh temporary fixture only."""
import hashlib
import json
from pathlib import Path
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repair(path, backup):
    before = sha(path)
    if path.read_bytes() == b'{"fixture":true}\n':
        return before, before
    if not backup.exists():
        backup.write_bytes(path.read_bytes())
    if sha(path) != before:
        raise ValueError('concurrent source edit')
    path.write_bytes(b'{"fixture":true}\n')
    assert json.loads(path.read_text()) == {'fixture': True}
    return before, sha(path)


def rollback(path, backup, expected):
    if sha(path) != expected:
        raise ValueError('concurrent rollback edit')
    path.write_bytes(backup.read_bytes())


def main():
    with tempfile.TemporaryDirectory(prefix='jdi-repair-fixture-') as tmp:
        target, backup = Path(tmp) / 'fixture.json', Path(tmp) / 'fixture.backup'
        target.write_bytes(b'{broken\n')
        try:
            json.loads(target.read_text())
            raise AssertionError('fixture must reproduce parse failure')
        except json.JSONDecodeError:
            pass
        pre, post = repair(target, backup)
        assert sha(backup) == pre
        assert repair(target, backup) == (post, post)
        target.write_bytes(b'concurrent edit')
        try:
            rollback(target, backup, post)
            raise AssertionError('rollback must reject conflict')
        except ValueError:
            assert target.read_bytes() == b'concurrent edit'
        target.write_bytes(b'{"fixture":true}\n')
        rollback(target, backup, post)
        assert sha(target) == pre
        print(json.dumps({'fixtureOnly': True, 'preHash': pre, 'postHash': post,
                          'validation': 'parse failure reproduced; repair parsed; idempotent; conflict preserved; rollback hash matched',
                          'backup': str(backup), 'temporaryFixtureRemovedOnExit': True}))


if __name__ == '__main__':
    main()
