from __future__ import annotations

import contextlib
import io
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from local_failover.main import main


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def config_document(port: int) -> dict:
    return {
        "version": 1,
        "listeners": [
            {
                "name": "llm",
                "host": "127.0.0.1",
                "port": port,
                "protocol": "llm",
                "routes": [
                    {
                        "name": "primary",
                        "url": "https://primary.invalid",
                        "provisioned": True,
                        "health": {
                            "kind": "llm",
                            "auth_env": "FAILOVER_HEALTH_TOKEN",
                            "stream_path": "/v1/chat/completions",
                            "stream_model_env": "FAILOVER_HEALTH_MODEL",
                        },
                    },
                    {
                        "name": "secondary",
                        "url": "http://127.0.0.1:18001",
                        "provisioned": True,
                        "health": {
                            "kind": "llm",
                            "auth_env": "FAILOVER_HEALTH_TOKEN",
                            "stream_path": "/v1/chat/completions",
                            "stream_model_env": "FAILOVER_HEALTH_MODEL",
                        },
                    },
                ],
            }
        ],
    }


class MainTests(unittest.TestCase):
    def write_config(self, payload: dict) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "config.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_check_prints_order_and_bind_without_upstream_urls(self) -> None:
        path = self.write_config(config_document(18000))
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = main(["check", "--config", str(path)])

        rendered = output.getvalue()
        self.assertEqual(result, 0)
        self.assertIn('"route_order":["primary","secondary"]', rendered)
        self.assertIn('"bind":"127.0.0.1:18000"', rendered)
        self.assertNotIn("primary.invalid", rendered)

    def test_status_reports_unavailable_without_starting_or_mutating(self) -> None:
        path = self.write_config(config_document(free_port()))
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = main(["status", "--config", str(path)])

        self.assertEqual(result, 0)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"listeners": [{"name": "llm", "state": "unavailable"}]},
        )

    def test_invalid_config_returns_bounded_error(self) -> None:
        path = self.write_config({"version": 1, "listeners": []})
        error = io.StringIO()

        with contextlib.redirect_stderr(error):
            result = main(["check", "--config", str(path)])

        self.assertEqual(result, 2)
        self.assertIn("configuration error", error.getvalue())


if __name__ == "__main__":
    unittest.main()
