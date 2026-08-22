"""Regression tests for CodeQL findings: partial SSRF and response splitting.

Covers alerts #316 (py/partial-ssrf, request target forwarded to upstream)
and #314/#315 (py/http-response-splitting, upstream headers forwarded to the
client). The proxy must reject or sanitize attacker-shaped input on both the
inbound (client -> upstream) and outbound (upstream -> client) paths.
"""

from __future__ import annotations

import http.client
import socket
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from local_failover.config import parse_config
from local_failover.proxy import GatewayService, _safe_request_target


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SafeRequestTargetTests(unittest.TestCase):
    def test_plain_paths_and_queries_pass(self) -> None:
        for target in (
            "/",
            "/v1/messages",
            "/v1/chat/completions?stream=true",
            "/mcp",
            "/a/b/c?x=1&y=%20z",
        ):
            self.assertEqual(_safe_request_target(target), target)

    def test_absolute_and_authority_forms_are_rejected(self) -> None:
        for target in (
            "http://evil.example/steal",
            "https://evil.example/",
            "evil.example:443",
            "//evil.example/protocol-relative",
        ):
            self.assertIsNone(_safe_request_target(target))

    def test_control_characters_and_whitespace_are_rejected(self) -> None:
        for target in (
            "/a\rb",
            "/a\nb",
            "/a b HTTP/1.1\r\nHost: evil",
            "/a\x00b",
            "/a\tb",
        ):
            self.assertIsNone(_safe_request_target(target))

    def test_dot_segments_are_rejected_encoded_or_not(self) -> None:
        for target in (
            "/../secret",
            "/a/../../secret",
            "/a/./b",
            "/%2e%2e/secret",
            "/a/%2E%2E/b",
        ):
            self.assertIsNone(_safe_request_target(target))

    def test_encoded_control_characters_are_rejected(self) -> None:
        for target in ("/a%0d%0ab", "/a%00b", "/a%20b"):
            self.assertIsNone(_safe_request_target(target))

    def test_query_with_encoded_control_characters_is_rejected(self) -> None:
        for target in (
            "/v1/messages?x=%0d%0aheader",
            "/v1/messages?x=%0acrlf",
            "/v1/messages?x=%00nul",
        ):
            self.assertIsNone(_safe_request_target(target))

    def test_query_with_encoded_space_is_allowed(self) -> None:
        self.assertEqual(
            _safe_request_target("/a/b?x=%20z"), "/a/b?x=%20z"
        )

    def test_query_with_backslash_is_rejected(self) -> None:
        for target in ("/v1/messages?x=%5c", "/v1/messages?x=a\\b"):
            self.assertIsNone(_safe_request_target(target))

    def test_backslash_segments_are_rejected(self) -> None:
        self.assertIsNone(_safe_request_target("/a%5C..%5Cb"))


class SplittingOriginHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *args) -> None:
        return

    def do_GET(self) -> None:
        self.server.seen_paths.append(self.path)
        body = b'{"ok":true}'
        if self.path == "/dup-length":
            # Conflicting duplicate Content-Length: a smuggling primitive.
            self.wfile.write(b"HTTP/1.1 200 OK\r\n")
            self.wfile.write(b"Content-Type: application/json\r\n")
            self.wfile.write(b"Content-Length: %d\r\n" % len(body))
            self.wfile.write(b"Content-Length: 2\r\n")
            self.wfile.write(b"Connection: close\r\n\r\n")
            self.wfile.write(body)
            return
        # Write raw headers so we can emit values Python's send_header would
        # normally deliver verbatim, including a header with an invalid name.
        self.wfile.write(b"HTTP/1.1 200 OK\r\n")
        self.wfile.write(b"Content-Type: application/json\r\n")
        self.wfile.write(b"Content-Length: %d\r\n" % len(body))
        self.wfile.write(b"X-Ok: kept\r\n")
        self.wfile.write(b"Bad Header Name: dropped\r\n")
        self.wfile.write(b"Connection: close\r\n\r\n")
        self.wfile.write(body)

    def do_POST(self) -> None:
        self.do_GET()


def make_service(port: int, origin_url: str) -> GatewayService:
    config = parse_config(
        {
            "version": 1,
            "listeners": [
                {
                    "name": "llm",
                    "host": "127.0.0.1",
                    "port": port,
                    "protocol": "llm",
                    "max_body_bytes": 1024,
                    "max_concurrent_requests": 8,
                    "max_idempotent_attempts": 2,
                    "client_timeout_seconds": 2,
                    "connect_timeout_seconds": 1,
                    "idle_timeout_seconds": 2,
                    "session_ttl_seconds": 60,
                    "routes": [
                        {
                            "name": "primary",
                            "url": origin_url,
                            "provisioned": True,
                            "health": {
                                "kind": "llm",
                                "auth_env": "FAILOVER_HEALTH_TOKEN",
                                "inventory_path": "/v1/models",
                                "stream_path": "/v1/chat/completions",
                                "stream_model_env": "FAILOVER_HEALTH_MODEL",
                                "interval_seconds": 60,
                            },
                            "breaker": {
                                "failure_threshold": 1,
                                "recovery_successes": 1,
                                "base_backoff_seconds": 1,
                                "max_backoff_seconds": 5,
                                "failback_hold_seconds": 0,
                                "max_stale_seconds": 300,
                            },
                        }
                    ],
                }
            ],
        }
    )
    return GatewayService(config, env={})


class RequestHardeningIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.origin = ThreadingHTTPServer(("127.0.0.1", 0), SplittingOriginHandler)
        self.origin.seen_paths = []
        self.origin_thread = threading.Thread(
            target=self.origin.serve_forever, daemon=True
        )
        self.origin_thread.start()
        self.port = free_port()
        self.service = make_service(
            self.port, f"http://127.0.0.1:{self.origin.server_port}"
        )
        self.service.start(run_health=False)
        runtime = self.service.listeners["llm"]
        now = self.service.clock()
        for route in runtime.routes:
            route.breaker.observe_success(now, "test_ready")

    def tearDown(self) -> None:
        self.service.shutdown()
        self.origin.shutdown()
        self.origin.server_close()
        self.origin_thread.join(timeout=2)

    def raw_request(self, request: bytes) -> bytes:
        client = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        client.sendall(request)
        response = b""
        while True:
            try:
                chunk = client.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            response += chunk
        client.close()
        return response

    def test_absolute_form_target_is_rejected_before_upstream(self) -> None:
        response = self.raw_request(
            b"GET http://evil.example/steal HTTP/1.1\r\n"
            b"Host: localhost\r\nConnection: close\r\n\r\n"
        )
        self.assertIn(b" 400 ", response)
        self.assertIn(b"invalid_request_target", response)
        self.assertEqual(self.origin.seen_paths, [])

    def test_dot_segment_target_is_rejected_before_upstream(self) -> None:
        response = self.raw_request(
            b"GET /%2e%2e/internal HTTP/1.1\r\n"
            b"Host: localhost\r\nConnection: close\r\n\r\n"
        )
        self.assertIn(b" 400 ", response)
        self.assertIn(b"invalid_request_target", response)
        self.assertEqual(self.origin.seen_paths, [])

    def test_upstream_header_with_invalid_name_is_not_forwarded(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/resource")
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        response.read()
        connection.close()

        self.assertEqual(response.status, 200)
        self.assertEqual(headers.get("x-ok"), "kept")
        self.assertNotIn("bad header name", headers)
        self.assertEqual(self.origin.seen_paths, ["/resource"])

    def test_invalid_target_beats_oversized_body(self) -> None:
        # Target validation must run before body handling: an invalid
        # target with an oversized declared body is a 400, not a 413.
        response = self.raw_request(
            b"POST http://evil.example/steal HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Content-Length: 999999\r\n"
            b"Connection: close\r\n\r\n"
        )
        self.assertIn(b" 400 ", response)
        self.assertIn(b"invalid_request_target", response)
        self.assertEqual(self.origin.seen_paths, [])

    def test_conflicting_upstream_content_length_is_rejected(self) -> None:
        response = self.raw_request(
            b"GET /dup-length HTTP/1.1\r\n"
            b"Host: localhost\r\nConnection: close\r\n\r\n"
        )
        self.assertIn(b" 502 ", response)
        self.assertIn(b"upstream_invalid_response", response)
        self.assertEqual(self.origin.seen_paths, ["/dup-length"])


if __name__ == "__main__":
    unittest.main()
