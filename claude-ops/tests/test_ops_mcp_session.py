import asyncio
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'ops-mcp-session.py'
spec = importlib.util.spec_from_file_location('managed', SCRIPT)
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
FAKE = '''import sys,json
states=[{'name':'lost','status':'failed'},{'name':'ready','status':'connected'},{'name':'auth','status':'needs-auth'},{'name':'off','status':'disabled'},{'name':'wait','status':'pending'}]
for line in sys.stdin:
 r=json.loads(line); q=r['request']; out={}
 if q['subtype']=='mcp_status': out={'mcpServers':states}
 elif q['subtype']=='mcp_reconnect':
  assert q['serverName']=='lost'
  states[0]['status']='connected'
 print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':out}}),flush=True)
'''


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.child = await asyncio.create_subprocess_exec(sys.executable, '-I', '-u', '-c', FAKE, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        self.owner = m.Owner(self.child)
        self.task = asyncio.create_task(self.owner.read_child())

    async def asyncTearDown(self):
        self.child.terminate()
        await self.child.wait()
        await self.task

    async def test_protocol_recovers_only_failed(self):
        before = await self.owner.handle({'op': 'status'})
        self.assertEqual(before['servers'][0]['status'], 'failed')
        after = await self.owner.handle({'op': 'poll'})
        self.assertEqual(after['attempted'], ['lost'])
        self.assertEqual(after['servers'][0]['status'], 'connected')
        self.assertEqual((await self.owner.handle({'op': 'poll'}))['attempted'], [])

    async def test_bound_and_backoff(self):
        calls = []
        async def control(request):
            calls.append(request)
            return {'mcpServers': [{'name': 'lost', 'status': 'failed'}]}
        self.owner.control = control
        with patch.object(m.time, 'monotonic', return_value=0):
            await self.owner.handle({'op': 'poll'})
            self.assertEqual((await self.owner.handle({'op': 'poll'}))['attempted'], [])
        for now in (1000, 2000, 3000):
            with patch.object(m.time, 'monotonic', return_value=now):
                await self.owner.handle({'op': 'poll'})
        self.assertEqual(sum(c['subtype'] == 'mcp_reconnect' for c in calls), 3)

    async def test_unknown_and_request_fail_closed(self):
        async def control(request):
            return {'mcpServers': [{'name': 'lost', 'status': 'disconnected'}]}
        self.owner.control = control
        with self.assertRaises(ValueError):
            await self.owner.handle({'op': 'poll'})
        for request in ({'op': 'reconnect', 'serverName': 'lost'}, {'op': 'poll', 'command': 'anything'}, [], None):
            with self.assertRaises(ValueError):
                await self.owner.handle(request)

    async def test_private_socket_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            path = root / (self.owner.identity + '.sock')
            server = await asyncio.start_unix_server(self.owner.socket_client, path=path, limit=4096)
            path.chmod(0o600)
            async with server:
                result = await m.request_socket(path, 'status')
                self.assertEqual(result['identity'], self.owner.identity)
                path.chmod(0o666)
                with self.assertRaises(ValueError):
                    await m.request_socket(path, 'poll')
                path.chmod(0o600)
                root.chmod(0o755)
                with self.assertRaises(ValueError):
                    await m.request_socket(path, 'poll')
                root.chmod(0o700)

    async def test_symlink_registry_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            link = root / 'link'
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                m.root_path(link)

    async def test_installer_stages_only_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'stage'
            installer = SCRIPT.with_name('install-mcp-session-guard.py')
            command = [sys.executable, '-I', str(installer), '--destination', str(destination)]
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = plistlib.loads((destination / 'com.claude-ops.mcp-session.plist').read_bytes())
            self.assertEqual(value['ProgramArguments'], [sys.executable, str(destination / SCRIPT.name), 'watchdog'])
            self.assertEqual(value['StartInterval'], 60)
            self.assertEqual(sorted(p.name for p in destination.iterdir()), ['com.claude-ops.mcp-session.plist', SCRIPT.name])
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    async def test_rejected_server_does_not_starve_next(self):
        calls = []
        async def control(request):
            if request['subtype'] == 'mcp_status':
                return {'mcpServers': [{'name': name, 'status': 'failed'} for name in ('a', 'b')]}
            calls.append(request['serverName'])
            if request['serverName'] == 'a':
                raise RuntimeError('rejected')
            return {}
        self.owner.control = control
        result = await self.owner.handle({'op': 'poll'})
        self.assertEqual(calls, ['a', 'b'])
        self.assertEqual(result['attempted'], ['a', 'b'])

    async def test_foreground_initialization_and_permission_reply(self):
        read_fd, write_fd = __import__('os').pipe()
        payload = (b'{"type":"control_request","request_id":"client-init","request":{"subtype":"initialize"}}\n'
                   b'{"type":"control_response","response":{"request_id":"permission","subtype":"success"}}\n')
        __import__('os').write(write_fd, payload)
        __import__('os').close(write_fd)
        received = []
        class Input:
            def write(self, line):
                received.append(line)
            async def drain(self):
                pass
        self.owner.child.stdin = Input()
        with __import__('os').fdopen(read_fd, 'rb') as source:
            with patch.object(m.sys, 'stdin', type('Stdin', (), {'buffer': source})()):
                await m.foreground(self.owner)
        self.assertEqual(b''.join(received), payload)

    async def test_serial_polls(self):
        results = await asyncio.gather(*(self.owner.handle({'op': 'poll'}) for _ in range(4)))
        self.assertEqual(sum(len(r['attempted']) for r in results), 1)


if __name__ == '__main__':
    unittest.main()
