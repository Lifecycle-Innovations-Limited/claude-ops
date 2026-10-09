"""All transport and seed-writing tests use mocks and isolated files."""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(os.getenv("OPS_MAC_RECALL_SOURCE", str(pathlib.Path(__file__).resolve().parents[1] / "scripts/ops-mac/brain-recall-seed")))
loader = importlib.machinery.SourceFileLoader("seed", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
seed = importlib.util.module_from_spec(spec)
loader.exec_module(seed)


def response(text, error=False):
    return json.dumps({"jsonrpc": "2.0", "id": 2, "result": {"isError": error, "content": [{"type": "text", "text": text}]}})


class RecallTests(unittest.TestCase):
    def setUp(self):
        scope = mock.patch.object(seed, "USER_ID", "owner")
        scope.start()
        self.addCleanup(scope.stop)

    def test_json_and_sse_matching_id_not_notification(self):
        raw = response('{"results": []}')
        for value in (raw, 'data: {"method":"notice"}\n\ndata: ' + raw + '\n\n'):
            self.assertEqual(seed.parse_sse(value, 2)["id"], 2)

    def test_rpc_error_and_tool_error(self):
        for raw in ('{"jsonrpc":"2.0","id":2,"error":{"code":-1}}', response("bad", True)):
            with mock.patch.object(seed, "mcp_post", side_effect=[(None, '{"id":1,"result":{}}'), (None, ''), (None, raw)]):
                with self.assertRaises(seed.RecallError):
                    seed.mcp_tool("unused", "search", {})

    def test_invalid_and_missing_response(self):
        for raw in ('', 'invalid', '{"id":9,"result":{}}', '[]', '{"id":2}'):
            with self.assertRaises(seed.RecallError):
                seed.parse_sse(raw, 2)

    def test_empty_is_valid_not_rpc_failure(self):
        with mock.patch.object(seed, "mcp_post", side_effect=[(None, '{"id":1,"result":{}}'), (None, ''), (None, response('{"results": []}'))]):
            self.assertEqual(seed.extract_memories(seed.mcp_tool("unused", "search", {})), [])

    def test_initialization_error_stops_tool_call(self):
        with mock.patch.object(seed, "mcp_post", return_value=(None, '{"id":1,"error":{"code":-1}}')) as post:
            with self.assertRaises(seed.RecallError):
                seed.mcp_tool("unused", "search", {})
            self.assertEqual(post.call_count, 1)

    def test_preserve_previous_on_empty_error_and_partial_failure(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "seed.md"
            original = 'last good "café"\nsecond line\n'.encode()
            for outcomes, expected in ((["[]", "[]"], 1), ([TimeoutError(), TimeoutError()], 2), ([json.dumps([{"memory": "new"}]), seed.RecallError("tool error")], 2)):
                path.write_bytes(original)
                with mock.patch.object(seed, "OUT", path), mock.patch.object(seed, "MEM0_URL", "unused"), mock.patch.object(seed, "query_with_retry", side_effect=outcomes):
                    self.assertEqual(seed.main(), expected)
                self.assertEqual(path.read_bytes(), original)

    def test_finite_retry_delays(self):
        with mock.patch.object(seed, "mcp_tool", side_effect=TimeoutError()) as tool, mock.patch.object(seed.time, "sleep") as sleep:
            with self.assertRaises(TimeoutError):
                seed.query_with_retry("query")
            self.assertEqual(tool.call_count, 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])

    def test_protocol_failure_not_retried(self):
        with mock.patch.object(seed, "mcp_tool", side_effect=seed.RecallError("isError")) as tool, mock.patch.object(seed.time, "sleep") as sleep:
            with self.assertRaises(seed.RecallError):
                seed.query_with_retry("query")
            self.assertEqual(tool.call_count, 1)
            sleep.assert_not_called()

    def test_success_keeps_quotes_unicode_and_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "seed.md"
            value = '"café"\nsecond line'
            with mock.patch.object(seed, "OUT", path), mock.patch.object(seed, "MEM0_URL", "unused"), mock.patch.object(seed, "query_with_retry", return_value=json.dumps([{"memory": value}])):
                self.assertEqual(seed.main(), 0)
            self.assertIn(value, path.read_text())
            self.assertIn("auto-generated", path.read_text())


if __name__ == "__main__":
    unittest.main()
