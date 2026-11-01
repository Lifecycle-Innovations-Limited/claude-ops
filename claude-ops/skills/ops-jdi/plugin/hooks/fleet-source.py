"""Named-source CLI for the opt-in fleet runtime; no discovery outside explicit roots."""

import contextlib
from datetime import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

SPEC = importlib.util.spec_from_file_location(
    'fleet_guard', Path(__file__).with_name('fleet_guard.py')
)
assert SPEC is not None and SPEC.loader is not None
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
MAX_BYTES = 4_000_000
MAX_ROWS = 100000
MAX_SOURCE_BYTES = 128_000_000
MAX_LINE_BYTES = 16_000_000
MAX_SECONDS = 15
SECRET = re.compile(
    r'(?i)(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*\S+|(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN [^-]*PRIVATE KEY-----'
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


@contextlib.contextmanager
def directory(path):
    """Walk from root using directory fds; no symlink component is followed."""
    path = Path(path)
    require(
        path.is_absolute() and '..' not in path.parts,
        'absolute canonical root required',
    )
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
            )
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            require(
                info.st_uid in (0, os.getuid())
                and (not info.st_mode & 0o022 or bool(info.st_mode & stat.S_ISVTX)),
                'unsafe directory ownership/mode',
            )
        require(
            os.fstat(fd).st_uid == os.getuid(), 'root must be owned by current user'
        )
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def open_named(root, path, limit=MAX_BYTES):
    root, path = Path(root), Path(path)
    require(
        path.is_absolute() and '..' not in path.parts and path.is_relative_to(root),
        'source outside explicit root',
    )
    relative = path.relative_to(root)
    require(bool(relative.parts), 'source must be a regular file')
    with directory(root) as root_fd:
        fd = os.dup(root_fd)
        try:
            for part in relative.parts[:-1]:
                child = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
                os.close(fd)
                fd = child
                info = os.fstat(fd)
                require(
                    info.st_uid == os.getuid() and not info.st_mode & 0o022,
                    'unsafe source ancestor',
                )
            handle = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                before = os.fstat(handle)
                require(
                    stat.S_ISREG(before.st_mode)
                    and before.st_uid == os.getuid()
                    and not before.st_mode & 0o022
                    and before.st_size <= limit,
                    'unsafe or oversized source',
                )
                yield handle
                after = os.fstat(handle)
                require(
                    (before.st_size, before.st_mtime_ns, before.st_ino)
                    == (after.st_size, after.st_mtime_ns, after.st_ino),
                    'source changed or exceeds byte limit',
                )
            finally:
                os.close(handle)
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise ValueError('secure source read refused') from exc
        finally:
            os.close(fd)


def read_named(root, path):
    with open_named(root, path) as fd:
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(MAX_BYTES + 1)
        require(len(data) <= MAX_BYTES, 'named file exceeds byte limit')
        return data


def transcript_rows(root, path, config, started, manifest):
    limit = config.get('maxSourceBytes', MAX_SOURCE_BYTES)
    rows = config.get('maxSourceRows', MAX_ROWS)
    require(
        type(limit) is int and 0 < limit <= MAX_SOURCE_BYTES,
        'invalid source byte limit',
    )
    require(type(rows) is int and 0 < rows <= MAX_ROWS, 'invalid source row limit')
    digest = hashlib.sha256()
    total = 0
    with open_named(root, path, limit) as fd:
        with os.fdopen(os.dup(fd), 'rb') as stream:
            while True:
                line = stream.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                total += len(line)
                manifest['rows'] += 1
                require(
                    total <= limit and len(line) <= MAX_LINE_BYTES,
                    'transcript byte/line limit exceeded',
                )
                require(manifest['rows'] <= rows, 'transcript row limit exceeded')
                require(
                    time.monotonic() - started <= MAX_SECONDS,
                    'source time budget exceeded',
                )
                digest.update(line)
                if not line.endswith(b'\n'):
                    manifest['tail'] = True
                yield json.loads(line)
    manifest['identity'] = digest.hexdigest()


def sensitive_key(key):
    normalized = re.sub(r'[-_]', '', str(key)).casefold()
    return any(
        marker in normalized
        for marker in (
            'password',
            'secret',
            'token',
            'authorization',
            'apikey',
            'privatekey',
            'providerenv',
        )
    )


def sanitize(value, gaps):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if sensitive_key(key):
                result[key] = '[REDACTED]'
                gaps.append('sensitive structured evidence redacted')
            else:
                result[key] = sanitize(item, gaps)
        return result
    if isinstance(value, list):
        return [sanitize(item, gaps) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, RecursionError):
            parsed = None
        if isinstance(parsed, (dict, list)):
            return json.dumps(sanitize(parsed, gaps))

        def quoted(match):
            if sensitive_key(match.group('key')):
                gaps.append('sensitive quoted evidence redacted')
                return match.group('prefix') + '"[REDACTED]"'
            return match.group(0)

        text = re.sub(
            r"""(?P<prefix>["'](?P<key>[^"']+)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""",
            quoted,
            value,
        )
        text = SECRET.sub('[REDACTED]', text)
        if text != value:
            gaps.append('sensitive text evidence redacted')
        return text
    return value


def snapshot(config, sid):
    started = time.monotonic()
    jobs, projects = Path(config['jobsRoot']), Path(config['projectRoot'])
    job_ids = config['jobIds']
    require(
        isinstance(job_ids, list) and 0 < len(job_ids) <= 1000,
        'explicit bounded job IDs required',
    )
    matches = []
    for job in job_ids:
        require(
            isinstance(job, str)
            and (job == '.' or re.fullmatch(r'[A-Za-z0-9_-]+', job)),
            'invalid job ID',
        )
        row = json.loads(read_named(jobs, jobs / job / 'state.json'))
        if row.get('sessionId') == sid:
            matches.append(row)
        require(
            time.monotonic() - started <= MAX_SECONDS, 'source time budget exceeded'
        )
    require(len(matches) == 1, 'session needs exactly one named job source')
    path = Path(matches[0]['linkScanPath'])
    gaps, messages, receipts = [], [], []
    manifest = dict(rows=0, tail=False, identity='')
    meta_rows = 0
    approval_calls, approval_results = set(), set()
    progress_times = []
    payload_bytes = 0
    allowed = config.get('allowedToolResultIds', [])
    require(isinstance(allowed, list), 'tool evidence allowance required')
    for row in transcript_rows(projects, path, config, started, manifest):
        kind = row.get('type')
        if kind == 'system' and 'compact' in str(row.get('subtype', '')).lower():
            gaps.append('compacted transcript requires original source segments')
        if kind not in ('user', 'assistant', 'tool'):
            continue
        identities = [row[key] for key in ('sessionId', 'session_id') if key in row]
        require(
            all(value == sid for value in identities),
            'contradictory transcript session identity',
        )
        if (
            not identities
            and config.get('attestedSourceSessions', {}).get(str(path)) != sid
        ):
            gaps.append('transcript session identity absent')
        if row.get('isMeta'):
            meta_rows += 1
            continue
        if kind in ('assistant', 'tool'):
            try:
                progress_times.append(
                    datetime.fromisoformat(
                        row['timestamp'].replace('Z', '+00:00')
                    ).timestamp()
                )
            except (KeyError, ValueError, TypeError):
                pass
        message = row.get('message', {})
        content = message.get('content', '')
        blocks = (
            [dict(type='text', text=content)] if isinstance(content, str) else content
        )
        require(isinstance(blocks, list), 'unsupported transcript content')
        texts = []
        receipt_start = len(receipts)
        for block in blocks:
            if not isinstance(block, dict):
                gaps.append('unsupported content block')
                continue
            if block.get('type') == 'text':
                text = block.get('text', '')
                require(isinstance(text, str), 'invalid text block')
                sanitized = sanitize(text, gaps)
                if sanitized != text:
                    gaps.append('sensitive transcript evidence redacted')
                texts.append(sanitized)
            elif block.get('type') == 'tool_result':
                rid = block.get('tool_use_id')
                if (
                    block.get('is_error') is not True
                    and row.get('origin', {}).get('kind') == 'human'
                ):
                    approval_results.add(rid)
                if rid not in allowed:
                    gaps.append('tool result outside explicit evidence allowance')
                    continue
                value = block.get('content')
                cleaned = sanitize(value, gaps)
                sanitized = cleaned if isinstance(cleaned, str) else json.dumps(cleaned)
                receipts.append(dict(id=rid, text=sanitized or '[empty result]'))
            elif block.get('type') == 'tool_use':
                if block.get('name') == 'AskUserQuestion':
                    approval_calls.add(block.get('id'))
                if block.get('name') in (
                    'TaskCreate',
                    'TaskUpdate',
                    'TaskList',
                    'TodoWrite',
                ):
                    texts.append(
                        json.dumps(
                            dict(
                                untrustedTaskEvidence=True,
                                toolUseId=block.get('id'),
                                tool=block.get('name'),
                                input=sanitize(block.get('input', {}), gaps),
                            )
                        )
                    )
            elif block.get('type') != 'thinking':
                gaps.append('unsupported content block omitted')
        payload_bytes += len(json.dumps(texts).encode()) + sum(
            len(json.dumps(r).encode()) for r in receipts[receipt_start:]
        )
        require(
            payload_bytes <= MAX_BYTES - 100000,
            'selected evidence payload exceeds output budget',
        )
        if not texts:
            continue
        mid = row.get('uuid')
        require(isinstance(mid, str) and bool(mid), 'message identity missing')
        origin = (
            'human'
            if kind == 'user' and row.get('origin', {}).get('kind') == 'human'
            else 'unknown'
        )
        if kind == 'user' and origin != 'human':
            gaps.append('user provenance unknown')
        messages.append(dict(id=mid, role=kind, origin=origin, text='\n'.join(texts)))
    require(bool(messages), 'no usable transcript messages')
    if manifest['tail']:
        gaps.append('unterminated transcript tail')
    identity = manifest['identity']
    content_hash = guard._hash(messages)
    human = [m for m in messages if m['origin'] == 'human']
    task_id = config.get('authorizedHumanMessageIds', {}).get(sid)
    task = next((m for m in human if m['id'] == task_id), None)
    paused, hold_unknown = False, False
    for m in human:
        text = m['text'].strip()
        # Negated stop is a continuation constraint, not a request to pause.
        remainder = re.sub(
            r"(?i)\b(?:do not|don't|never)\s+(?:stop|pause)\b[^.!?;]*", '', text
        )
        if re.search(
            r'(?i)(?:^|[.!?;]\s*)(?:please\s+)?(?:stop|pause|cancel|stoppen|pauzeer|annuleer|wacht|wait)\b',
            remainder,
        ):
            paused = True
            hold_unknown = False
        elif re.fullmatch(
            r'(?i)(?:please\s+)?(?:resume|continue|hervat|ga verder)(?:\s+(?:now|nu|this task|deze taak))?[.!]?',
            text,
        ):
            paused, hold_unknown = False, False
        elif re.search(
            r'(?i)\b(?:stop|pause|cancel|stoppen|pauzeer|annuleer|wacht|wait|resume|hervat)\b',
            remainder,
        ):
            hold_unknown = True
    approval = 'pending' if approval_calls - approval_results else 'unknown'
    # Caller must explicitly attest that this scoped source carries every approval
    # channel. Without it absence of AskUserQuestion is not absence of a gate.
    if approval == 'unknown' and config.get('approvalCoverageComplete') is True:
        approval = 'clear'
    if hold_unknown:
        approval = 'unknown'
    job = matches[0]

    def timestamp(value):
        try:
            return (
                datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
                if isinstance(value, str)
                else None
            )
        except ValueError:
            return None

    progress = max((t for t in progress_times if t is not None), default=None)
    observed = timestamp(job.get('updatedAt'))
    flight = job.get('inFlight', {})
    idle = (
        job.get('state') == 'idle'
        and isinstance(flight, dict)
        and flight.get('tasks') == 0
        and flight.get('queued') == 0
        and flight.get('kinds') == []
        and flight.get('drainableMonitors') == 0
        and observed is not None
        and 0 <= time.time() - observed <= 300
    )
    stalled = idle and progress is not None and 300 <= time.time() - progress <= 86400
    refs = ['message:' + task['id']] if task else []
    owner = (
        dict(state='known', sessionId=sid, refs=refs)
        if task
        else dict(state='unknown', refs=[])
    )
    authority = (
        dict(state='authorized', contractHash=content_hash, refs=refs)
        if task
        else dict(state='unknown', refs=[])
    )
    eligibility = (
        dict(state='stalled', refs=refs)
        if stalled and task
        else dict(state='unknown', refs=[])
    )
    return dict(
        schemaVersion=1,
        sessionId=sid,
        generation=0,
        contractHash=content_hash,
        evidenceSetHash=guard._hash(receipts),
        transcriptIdentity=identity,
        observedAt=time.time(),
        paused=paused,
        stopped=paused,
        approval=approval,
        owner=owner,
        authority=authority,
        eligibility=eligibility,
        messages=messages,
        receipts=receipts,
        coverage=dict(
            complete=not gaps,
            gaps=list(dict.fromkeys(gaps)),
            sourceRowCount=manifest['rows'],
            excludedMetaRows=meta_rows,
            messageCount=len(messages),
            receiptCount=len(receipts),
            transcriptIdentity=identity,
            messageIds=[m['id'] for m in messages],
            receiptIds=[r['id'] for r in receipts],
        ),
    )


def durable(config, action, key, record=None):
    root = Path(config['stateRoot'])
    for field in ('jobsRoot', 'projectRoot'):
        source = Path(config[field])
        require(
            not root.is_relative_to(source) and not source.is_relative_to(root),
            'state/source roots overlap',
        )
    require(isinstance(key, str) and 0 < len(key) <= 1000, 'invalid durable key')
    name = hashlib.sha256(key.encode()).hexdigest()
    with directory(root) as fd:
        require(not os.fstat(fd).st_mode & 0o077, 'durable root must be private')
        lock = os.open(
            name + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=fd
        )
        try:
            require(
                os.fstat(lock).st_uid == os.getuid()
                and not os.fstat(lock).st_mode & 0o077,
                'unsafe lock',
            )
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                previous = json.loads(read_named(root, root / (name + '.json')))
            except FileNotFoundError:
                previous = None
            if action == 'get':
                return previous
            if action == 'reserve' and previous is not None:
                return dict(reserved=False)
            require(isinstance(record, dict), 'durable record required')
            if action == 'put':
                require(previous is not None, 'put requires existing reservation')
            data = json.dumps(record, allow_nan=False).encode()
            require(len(data) <= MAX_BYTES, 'durable record byte limit exceeded')
            temporary = name + '.' + os.urandom(12).hex() + '.tmp'
            handle = os.open(
                temporary,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o600,
                dir_fd=fd,
            )
            try:
                with os.fdopen(handle, 'wb') as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, name + '.json', src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
            return dict(reserved=True) if action == 'reserve' else dict(written=True)
        finally:
            os.close(lock)


def load_config(path):
    path = Path(path)
    with open_named(path.parent, path) as fd:
        require(not os.fstat(fd).st_mode & 0o077, 'config must be private')
        data = os.read(fd, MAX_BYTES + 1)
    config = json.loads(data)
    required = {
        'enabled',
        'jobsRoot',
        'projectRoot',
        'stateRoot',
        'jobIds',
        'sessions',
        'allowedToolResultIds',
        'maxJudgeCalls',
        'maxOutputTokens',
    }
    optional = {
        'authorizedHumanMessageIds',
        'approvalCoverageComplete',
        'maxSourceBytes',
        'maxSourceRows',
        'attestedSourceSessions',
    }
    require(
        isinstance(config, dict)
        and required <= config.keys()
        and config.keys() <= required | optional,
        'invalid config fields',
    )
    require(type(config['enabled']) is bool, 'invalid enabled flag')
    for key in ('jobsRoot', 'projectRoot', 'stateRoot'):
        with directory(config[key]):
            pass
    for key in ('jobIds', 'allowedToolResultIds'):
        require(
            isinstance(config[key], list)
            and all(isinstance(v, str) for v in config[key]),
            'invalid config list',
        )
    for key in ('sessions', 'authorizedHumanMessageIds', 'attestedSourceSessions'):
        value = config.get(key, {})
        require(
            isinstance(value, dict)
            and all(
                isinstance(k, str) and isinstance(v, str) for k, v in value.items()
            ),
            'invalid config mapping',
        )
    require(
        type(config['maxJudgeCalls']) is int
        and 0 <= config['maxJudgeCalls'] <= 1000
        and type(config['maxOutputTokens']) is int
        and 1 <= config['maxOutputTokens'] <= 8192,
        'explicit judge allowance required',
    )
    return config


def dispatch(request):
    action = request['action']
    if action == 'load-config':
        return load_config(request['path'])
    if action == 'snapshot':
        return snapshot(request['config'], request['sessionId'])
    if action == 'eligible':
        s = request['snapshot']
        refs = guard._snapshot(s, s['sessionId'], time.time(), 300)
        return dict(eligible=guard._eligible(s, refs))
    if action == 'binding':
        return guard.binding(request['snapshot'])
    if action == 'instructions':
        return dict(instructions=guard.JUDGE_INSTRUCTIONS)
    if action in ('validate-snapshot', 'validate-judgment'):
        s = request['snapshot']
        refs = guard._snapshot(s, s['sessionId'], time.time(), 300)
        if action == 'validate-judgment':
            guard._judgment(request['judgment'], s, refs, time.time())
        return dict(valid=True, binding=guard.binding(s))
    if action in ('get', 'reserve', 'put'):
        return durable(request['config'], action, request['key'], request.get('record'))
    raise ValueError('unsupported source action')


def main():
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        require(len(data) <= MAX_BYTES, 'request byte limit exceeded')
        print(
            json.dumps(
                dict(ok=True, result=dispatch(json.loads(data))), allow_nan=False
            )
        )
        return 0
    except Exception as exc:
        # Source contents and exception text can contain secrets; expose only type.
        print(json.dumps(dict(ok=False, error=type(exc).__name__)))
        return 1


if __name__ == '__main__':
    sys.exit(main())
