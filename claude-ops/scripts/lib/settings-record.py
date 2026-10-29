#!/usr/bin/env python3
"""Private invocation settings ownership; flock releases on process death."""
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import uuid
import subprocess


def create_document(root, value, pid, start, background=False):
    root = Path(root)
    documents = root / 'documents'
    if not directory(root, True) or not directory(documents, True):
        raise ValueError('invalid document ownership')
    token = uuid.uuid4().hex
    path = documents / (token + '.json')
    record = root / (token + '.json')
    row = {'path': str(path), 'pid': pid, 'start': start, 'phase': 'intent'}
    if background:
        row.update({'sessionId': None, 'owner': os.environ.get('POCKET_WORKER_ID') or os.environ.get('POCKET_RECORDING_ID')})
    # Publish and sync ownership BEFORE exclusive creation of secret bytes.
    atomic(record, row)
    parent_fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as target:
        json.dump(value, target, separators=(',', ':'))
        target.flush()
        os.fsync(target.fileno())
    atomic(record, {**row, 'phase': 'ready'})
    return str(path), str(record)


def directory(path, create=False):
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            if not create:
                return False
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            mode = current.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            return False
    info = path.stat()
    return info.st_uid == os.getuid() and not info.st_mode & 0o077


def owned(path, parent, absent=False):
    path, parent = Path(path), Path(parent)
    if Path(os.path.abspath(path)).parent != Path(os.path.abspath(parent)) or not directory(parent):
        return False
    try:
        info = path.lstat()
    except FileNotFoundError:
        return absent
    return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077


def atomic(path, row):
    fd, tmp = tempfile.mkstemp(prefix='.record-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(row, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def transition(root, record, op, session=None):
    if not owned(record, root):
        return False
    locks = root / 'locks'
    if not directory(locks, True):
        return False
    lock = locks / record.name
    flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
    fd = os.open(lock, flags, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        if not owned(record, root):
            return False
        row = json.loads(record.read_text())
        if row.get('phase') == 'intent':
            # Dispatch cannot begin until create_document returns ready. A dead
            # creator's incomplete intent therefore has no restart consumer.
            probe = subprocess.run(['ps', '-p', str(row.get('pid', 0)), '-o', 'lstart='], capture_output=True, text=True)
            if probe.returncode == 0 and probe.stdout.strip() == row.get('start'):
                return False
            document = Path(row.get('path', ''))
            if not owned(document, root / 'documents', absent=True):
                return False
            document.unlink(missing_ok=True)
            record.unlink(missing_ok=True)
            return True
        if op == 'bind':
            if row.get('removed'):
                return False
            atomic(record, {**row, 'sessionId': session})
            return True
        removed = row.get('removed')
        receipts = root / 'removals'
        sid = row.get('sessionId')
        receipt = receipts / (str(sid) + '.json')
        if not removed and sid and owned(receipt, receipts):
            proof = json.loads(receipt.read_text())
            if proof.get('removed') == sid:
                removed = sid
                atomic(record, {**row, 'removed': sid})
        if not removed:
            return False
        document = Path(row.get('path', ''))
        if not owned(document, root / 'documents', absent=True):
            return False
        document.unlink(missing_ok=True)
        record.unlink(missing_ok=True)
        return True
    finally:
        os.close(fd)


def main():
    request = json.load(sys.stdin)
    root = Path(request['root'])
    if not directory(root, True):
        raise ValueError('invalid registry ownership')
    op = request['op']
    if op == 'receipt':
        receipts = root / 'removals'
        if not directory(receipts, True):
            raise ValueError('invalid receipt ownership')
        session = request['session']
        if not session or any(c not in '0123456789abcdef' for c in session):
            raise ValueError('invalid session')
        atomic(receipts / (session + '.json'), {'removed': session})
        result = True
    else:
        result = transition(root, Path(request['record']), op, request.get('session'))
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print('settings record operation deferred', file=sys.stderr)
        sys.exit(2)
