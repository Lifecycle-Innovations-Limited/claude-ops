#!/usr/bin/env python3
"""Own a new CLI stream-json session; expose only MCP status/recovery locally."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import time

LIMIT = 1024 * 1024
TIMEOUT = 10
MAX_ATTEMPTS = 3
BACKOFF = 60


def private(path, kind):
    info = path.lstat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if kind == 'dir' else 0o600):
        raise ValueError('unsafe ownership or permissions')
    if not (stat.S_ISDIR(info.st_mode) if kind == 'dir' else stat.S_ISSOCK(info.st_mode)):
        raise ValueError('unexpected file type')


def root_path(value):
    path = Path(value).absolute()
    # Reject symlinks in every existing component, including the registry itself.
    for component in [*reversed(path.parents), path]:
        if component.is_symlink():
            raise ValueError('symlink in registry path')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    private(path, 'dir')
    return path


def schema(request):
    if not isinstance(request, dict) or request not in ({'op': 'status'}, {'op': 'poll'}):
        raise ValueError('unsupported request')


class Owner:
    def __init__(self, child):
        self.child = child
        self.pending = {}
        self.retry = {}
        self.lock = asyncio.Lock()
        self.clients = 0
        self.identity = secrets.token_hex(16)

    async def read_child(self):
        try:
            while line := await self.child.stdout.readline():
                message = json.loads(line)
                response = message.get('response', {}) if isinstance(message, dict) else {}
                if message.get('type') == 'control_response' and response.get('request_id') in self.pending:
                    future = self.pending[response['request_id']]
                    if not future.done():
                        future.set_result(response)
                else:
                    # The foreground JSON client owns human prompts and permission responses.
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError('child transport closed'))

    async def control(self, request):
        if self.child.returncode is not None:
            raise RuntimeError('child exited')
        key = secrets.token_hex(16)
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            self.child.stdin.write((json.dumps({'type': 'control_request', 'request_id': key, 'request': request}) + '\n').encode())
            await self.child.stdin.drain()
            response = await asyncio.wait_for(future, TIMEOUT)
            if response.get('subtype') != 'success':
                raise RuntimeError('control rejected')
            return response.get('response', {})
        finally:
            self.pending.pop(key, None)

    async def status(self):
        response = await self.control({'subtype': 'mcp_status'})
        servers = response.get('mcpServers')
        allowed = {'connected', 'failed', 'needs-auth', 'pending', 'disabled'}
        if not isinstance(servers, list) or len(servers) > 256:
            raise ValueError('invalid status')
        result = []
        names = set()
        for server in servers:
            if not isinstance(server, dict) or not isinstance(server.get('name'), str) or not 0 < len(server['name']) <= 512 or server.get('status') not in allowed or server['name'] in names:
                raise ValueError('invalid server status')
            names.add(server['name'])
            result.append({'name': server['name'], 'status': server['status']})
        return result

    async def handle(self, request):
        schema(request)
        async with self.lock:
            servers = await self.status()
            attempted = []
            if request['op'] == 'poll':
                for server in servers:
                    name = server['name']
                    if server['status'] != 'failed':
                        continue
                    count, deadline = self.retry.get(name, (0, 0))
                    if count >= MAX_ATTEMPTS or time.monotonic() < deadline:
                        continue
                    # Count before attempting, including timeout/rejection. Never reset automatically.
                    self.retry[name] = (count + 1, time.monotonic() + BACKOFF * 2 ** count)
                    attempted.append(name)
                    try:
                        await self.control({'subtype': 'mcp_reconnect', 'serverName': name})
                    except (RuntimeError, asyncio.TimeoutError, ConnectionError):
                        continue
                if attempted:
                    servers = await self.status()
            return {'identity': self.identity, 'pid': os.getpid(), 'child_pid': self.child.pid, 'servers': servers, 'attempted': attempted}

    async def socket_client(self, reader, writer):
        if self.clients >= 4:
            writer.close()
            await writer.wait_closed()
            return
        self.clients += 1
        try:
            line = await asyncio.wait_for(reader.readline(), TIMEOUT)
            if not line.endswith(b'\n') or len(line) > 4096:
                raise ValueError('invalid frame')
            result = await asyncio.wait_for(self.handle(json.loads(line)), 35)
            writer.write((json.dumps({'ok': True, **result}) + '\n').encode())
        except (ValueError, RuntimeError, asyncio.TimeoutError, ConnectionError):
            writer.write(b'{"ok":false}\n')
        finally:
            self.clients -= 1
            try:
                await writer.drain()
            except ConnectionError:
                pass
            writer.close()
            await writer.wait_closed()


async def foreground(owner):
    reader = asyncio.StreamReader(limit=LIMIT)
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    while line := await reader.readline():
        message = json.loads(line)
        # The owning client supplies initialization and human permission replies.
        if not isinstance(message, dict) or message.get('type') not in {'user', 'control_response', 'control_request'}:
            raise ValueError('expected user or control_response JSON')
        if len(line) > LIMIT:
            raise ValueError('input too large')
        owner.child.stdin.write(line)
        await owner.child.stdin.drain()


async def launch(args):
    root = root_path(args.registry)
    cli = shutil.which('claude')
    if not cli:
        raise ValueError('claude executable unavailable')
    child = await asyncio.create_subprocess_exec(cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=None, limit=LIMIT)
    owner = Owner(child)
    path = root / (owner.identity + '.sock')
    if len(os.fsencode(path)) > 100:
        child.terminate()
        await child.wait()
        raise ValueError('registry path too long for Unix socket')
    tasks = []
    try:
        server = await asyncio.start_unix_server(owner.socket_client, path=path, limit=4096)
        os.chmod(path, 0o600)
        private(path, 'socket')
        tasks = [asyncio.create_task(owner.read_child()), asyncio.create_task(foreground(owner)), asyncio.create_task(child.wait())]
        async with server:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    finally:
        for task in tasks:
            task.cancel()
        if child.returncode is None:
            child.terminate()
            try:
                await asyncio.wait_for(child.wait(), 5)
            except asyncio.TimeoutError:
                child.kill()
                await child.wait()
        await asyncio.gather(*tasks, return_exceptions=True)
        path.unlink(missing_ok=True)


async def request_socket(path, operation):
    private(path.parent, 'dir')
    private(path, 'socket')
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=LIMIT), TIMEOUT)
    try:
        writer.write((json.dumps({'op': operation}) + '\n').encode())
        await writer.drain()
        result = json.loads(await asyncio.wait_for(reader.readline(), TIMEOUT * 4))
        # Random per-launch identity binds a socket name to this owner, not a stale PID.
        if result.get('ok') is not True or result.get('identity') != path.stem or not isinstance(result.get('pid'), int) or not isinstance(result.get('child_pid'), int):
            raise ValueError('owner identity mismatch')
        os.kill(result['pid'], 0)
        os.kill(result['child_pid'], 0)
        return result
    finally:
        writer.close()
        await writer.wait_closed()


async def watchdog(args):
    root = root_path(args.registry)
    results = []
    # No state file can provide an executable, command, PID target or server request.
    paths = sorted(root.glob('*.sock'))
    if len(paths) > 64:
        raise ValueError('session limit exceeded')
    for path in paths:
        try:
            result = await request_socket(path, 'poll')
            results.append({'session': path.stem, 'ok': True, 'attempted': len(result['attempted'])})
        except (OSError, ValueError, asyncio.TimeoutError, ConnectionError):
            results.append({'session': path.stem, 'ok': False})
    print(json.dumps(results))
    return int(any(not result['ok'] for result in results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['launch', 'watchdog'])
    parser.add_argument('--registry', default=str(Path.home() / '.local' / 'state' / 'ops-mcp'))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        return asyncio.run(launch(args) if args.mode == 'launch' else watchdog(args)) or 0
    except (OSError, ValueError, RuntimeError, asyncio.TimeoutError):
        print('managed session operation failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
