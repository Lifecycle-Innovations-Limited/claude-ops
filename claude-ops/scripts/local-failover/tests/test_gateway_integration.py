from __future__ import annotations

import http.client
import json
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from local_failover.config import parse_config
from local_failover.health import HTTPProbeTransport, SemanticHealth
from local_failover.proxy import GatewayService


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class OriginState:
    def __init__(self, name: str) -> None:
        self.name = name
        self.requests: list[dict] = []
        self.resource_status = 200
        self.expected_auth = "Bearer test-health-credential"
        self.block_started = threading.Event()
        self.block_release = threading.Event()


class MockOriginHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> OriginState:
        return self.server.state

    def log_message(self, _format, *args) -> None:
        return

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def _record(self, body: bytes) -> None:
        self.state.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": body,
            }
        )

    def _send(self, status: int, body: bytes, **headers: str) -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", headers.pop("content_type", "application/json"))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        self._record(b"")
        if self.path == "/v1/models":
            if self.headers.get("Authorization") != self.state.expected_auth:
                self._send(401, b'{"error":"unauthorized"}')
                return
            self._send(200, b'{"object":"list","data":[{"id":"configured"}]}')
            return
        if self.path == "/resource":
            self._send(
                self.state.resource_status,
                json.dumps({"origin": self.state.name}).encode(),
            )
            return
        if self.path == "/block":
            self.state.block_started.set()
            self.state.block_release.wait(timeout=2)
            self._send(200, json.dumps({"origin": self.state.name}).encode())
            return
        self._send(404, b'{"error":"missing"}')

    def do_POST(self) -> None:
        body = self._body()
        self._record(body)
        if self.path == "/v1/chat/completions":
            if self.headers.get("Authorization") != self.state.expected_auth:
                self._send(401, b'{"error":"unauthorized"}')
                return
            payload = b"data: first\n\ndata: [DONE]\n\n"
            self._send(200, payload, content_type="text/event-stream")
            return
        if self.path == "/interrupt-before-headers":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.path == "/stream-interrupt":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"data: partial\n\n")
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.path == "/mcp":
            response = b'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}'
            self._send(200, response, **{"Mcp-Session-Id": "session-primary"})
            return
        self._send(200, json.dumps({"origin": self.state.name}).encode())


class MockOrigin:
    def __init__(self, name: str) -> None:
        self.state = OriginState(name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockOriginHandler)
        self.server.state = self.state
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def gateway_config(
    port: int,
    primary: str,
    secondary: str,
    protocol: str = "llm",
    *,
    client_timeout_seconds: float = 1,
    max_concurrent_requests: int = 64,
):
    if protocol == "llm":
        health = {
            "kind": "llm",
            "auth_env": "FAILOVER_HEALTH_TOKEN",
            "inventory_path": "/v1/models",
            "stream_path": "/v1/chat/completions",
            "stream_model_env": "FAILOVER_HEALTH_MODEL",
            "interval_seconds": 60,
        }
    else:
        health = {
            "kind": "mcp",
            "mcp_health_path": "/_failover/status",
            "interval_seconds": 60,
        }
    breaker = {
        "failure_threshold": 1,
        "recovery_successes": 1,
        "base_backoff_seconds": 1,
        "max_backoff_seconds": 5,
        "failback_hold_seconds": 0,
        "max_stale_seconds": 300,
    }
    return parse_config(
        {
            "version": 1,
            "listeners": [
                {
                    "name": protocol,
                    "host": "127.0.0.1",
                    "port": port,
                    "protocol": protocol,
                    "max_body_bytes": 1024,
                    "max_concurrent_requests": max_concurrent_requests,
                    "max_idempotent_attempts": 2,
                    "client_timeout_seconds": client_timeout_seconds,
                    "connect_timeout_seconds": 1,
                    "idle_timeout_seconds": 2,
                    "session_ttl_seconds": 60,
                    "routes": [
                        {
                            "name": "primary",
                            "url": primary,
                            "provisioned": True,
                            "health": health,
                            "breaker": breaker,
                        },
                        {
                            "name": "secondary",
                            "url": secondary,
                            "provisioned": True,
                            "health": health,
                            "breaker": breaker,
                        },
                    ],
                }
            ],
        }
    )


class GatewayIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.primary = MockOrigin("primary")
        self.secondary = MockOrigin("secondary")
        self.port = free_port()
        self.env = {
            "FAILOVER_HEALTH_TOKEN": "test-health-credential",
            "FAILOVER_HEALTH_MODEL": "configured-model",
        }
        self.service = GatewayService(
            gateway_config(self.port, self.primary.url, self.secondary.url),
            env=self.env,
        )
        self.service.start(run_health=False)
        self.runtime = self.service.listeners["llm"]
        now = self.service.clock()
        for route in self.runtime.routes:
            route.breaker.observe_success(now, "test_ready")

    def tearDown(self) -> None:
        self.service.shutdown()
        self.primary.close()
        self.secondary.close()

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        data = response.read()
        connection.close()
        return response.status, response_headers, data

    def test_new_post_uses_healthy_secondary_when_primary_is_open(self) -> None:
        now = self.service.clock()
        self.runtime.routes[0].breaker.observe_failure(now, "simulated_down")

        status, headers, body = self.request("POST", "/v1/messages", b"{}")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["origin"], "secondary")
        self.assertEqual(headers["x-local-failover-route"], "secondary")
        self.assertEqual(len(self.primary.state.requests), 0)
        self.assertEqual(len(self.secondary.state.requests), 1)

    def test_idempotent_get_retries_503_on_next_healthy_route(self) -> None:
        self.primary.state.resource_status = 503

        status, _, body = self.request("GET", "/resource")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["origin"], "secondary")
        self.assertEqual(len(self.primary.state.requests), 1)
        self.assertEqual(len(self.secondary.state.requests), 1)

    def test_post_is_never_replayed_after_unknown_delivery(self) -> None:
        status, _, _ = self.request("POST", "/interrupt-before-headers", b"{}")

        self.assertEqual(status, 502)
        self.assertEqual(len(self.primary.state.requests), 1)
        self.assertEqual(len(self.secondary.state.requests), 0)

    def test_interrupted_stream_is_not_spliced_to_secondary(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("POST", "/stream-interrupt", body=b"{}")
        response = connection.getresponse()
        with self.assertRaises(http.client.IncompleteRead):
            response.read()
        connection.close()

        self.assertEqual(len(self.primary.state.requests), 1)
        self.assertEqual(len(self.secondary.state.requests), 0)

    def test_hop_headers_are_stripped_and_end_to_end_auth_is_preserved(self) -> None:
        status, _, _ = self.request(
            "POST",
            "/v1/messages",
            b"{}",
            {
                "Authorization": "Bearer client-credential",
                "Connection": "keep-alive, X-Remove-Me",
                "X-Remove-Me": "not-forwarded",
            },
        )

        received = self.primary.state.requests[0]["headers"]
        self.assertEqual(status, 200)
        self.assertEqual(received["authorization"], "Bearer client-credential")
        self.assertNotIn("x-remove-me", received)
        self.assertEqual(received["connection"], "close")

    def test_body_limit_is_enforced_before_any_upstream_request(self) -> None:
        status, _, _ = self.request("POST", "/v1/messages", b"x" * 1025)

        self.assertEqual(status, 413)
        self.assertEqual(self.primary.state.requests, [])
        self.assertEqual(self.secondary.state.requests, [])

    def test_stalled_request_body_times_out_without_reaching_upstream(self) -> None:
        self.service.shutdown()
        self.port = free_port()
        self.service = GatewayService(
            gateway_config(
                self.port,
                self.primary.url,
                self.secondary.url,
                client_timeout_seconds=0.2,
            ),
            env=self.env,
        )
        self.service.start(run_health=False)
        self.runtime = self.service.listeners["llm"]
        now = self.service.clock()
        for route in self.runtime.routes:
            route.breaker.observe_success(now, "test_ready")
        client = socket.create_connection(("127.0.0.1", self.port), timeout=2)
        client.sendall(
            b"POST /v1/messages HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Content-Length: 10\r\n"
            b"Connection: close\r\n\r\n"
            b"x"
        )

        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
        client.close()

        self.assertIn(b" 408 ", response)
        self.assertIn(b"request_body_timeout", response)
        self.assertEqual(self.primary.state.requests, [])
        self.assertEqual(self.secondary.state.requests, [])

    def test_concurrency_limit_rejects_excess_client_without_new_thread(self) -> None:
        self.service.shutdown()
        self.port = free_port()
        self.service = GatewayService(
            gateway_config(
                self.port,
                self.primary.url,
                self.secondary.url,
                max_concurrent_requests=1,
            ),
            env=self.env,
        )
        self.service.start(run_health=False)
        self.runtime = self.service.listeners["llm"]
        now = self.service.clock()
        for route in self.runtime.routes:
            route.breaker.observe_success(now, "test_ready")
        first_result: list[tuple[int, dict[str, str], bytes]] = []
        first = threading.Thread(
            target=lambda: first_result.append(self.request("GET", "/block")), daemon=True
        )
        first.start()
        self.assertTrue(self.primary.state.block_started.wait(timeout=1))

        status, _, body = self.request("GET", "/resource")
        self.primary.state.block_release.set()
        first.join(timeout=2)

        self.assertEqual(status, 503)
        self.assertIn(b"gateway_overloaded", body)
        self.assertEqual(first_result[0][0], 200)
        self.assertEqual(
            [request["path"] for request in self.primary.state.requests], ["/block"]
        )

    def test_status_and_metrics_do_not_expose_urls_credentials_or_models(self) -> None:
        status, _, body = self.request("GET", "/_failover/status")
        metrics_status, _, metrics = self.request("GET", "/_failover/metrics")
        combined = body + metrics

        self.assertEqual(status, 200)
        self.assertEqual(metrics_status, 200)
        self.assertIn(b'"primary"', body)
        self.assertNotIn(self.primary.url.encode(), combined)
        self.assertNotIn(b"test-health-credential", combined)
        self.assertNotIn(b"configured-model", combined)

    def test_real_semantic_probe_checks_inventory_and_stream_cadence(self) -> None:
        route = self.runtime.routes[0].config

        result = SemanticHealth(HTTPProbeTransport()).probe(route, self.env)

        self.assertEqual(result.kind, "success")
        self.assertEqual(result.reason, "semantic_ok")

    def test_state_snapshot_is_private_and_redacted(self) -> None:
        self.service.shutdown()
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "status.json"
            config = replace(
                gateway_config(free_port(), self.primary.url, self.secondary.url),
                state_file=state_file,
            )
            self.service = GatewayService(config, env=self.env)
            self.service.start(run_health=False)
            now = self.service.clock()
            for route in self.service.listeners["llm"].routes:
                route.breaker.observe_success(now, "test_ready")
            self.service.persist_state()

            body = state_file.read_bytes()
            mode = stat.S_IMODE(state_file.stat().st_mode)

            self.assertEqual(mode, 0o600)
            self.assertIn(b'"state_persistence":"ok"', body)
            self.assertNotIn(self.primary.url.encode(), body)
            self.assertNotIn(b"test-health-credential", body)
            self.assertNotIn(b"configured-model", body)


class MCPSessionIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.primary = MockOrigin("primary")
        self.secondary = MockOrigin("secondary")
        self.port = free_port()
        self.service = GatewayService(
            gateway_config(self.port, self.primary.url, self.secondary.url, "mcp"), env={}
        )
        self.service.start(run_health=False)
        self.runtime = self.service.listeners["mcp"]
        now = self.service.clock()
        for route in self.runtime.routes:
            route.breaker.observe_success(now, "test_ready")

    def tearDown(self) -> None:
        self.service.shutdown()
        self.primary.close()
        self.secondary.close()

    def request(self, session_id: str | None = None):
        headers = {"Content-Type": "application/json"}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(
            "POST",
            "/mcp",
            body=b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
            headers=headers,
        )
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        body = response.read()
        connection.close()
        return response.status, response_headers, body

    def test_session_is_pinned_and_requires_reconnect_when_route_fails(self) -> None:
        status, headers, _ = self.request()
        session_id = headers["mcp-session-id"]
        self.assertEqual(status, 200)
        self.runtime.routes[0].gate_ready = False

        failed_status, _, failed_body = self.request(session_id)

        self.assertEqual(failed_status, 503)
        self.assertIn(b"session_reconnect_required", failed_body)
        self.assertEqual(len(self.primary.state.requests), 1)
        self.assertEqual(len(self.secondary.state.requests), 0)

    def test_session_remains_pinned_across_repeated_requests(self) -> None:
        status, headers, _ = self.request()
        session_id = headers["mcp-session-id"]

        second_status, _, _ = self.request(session_id)

        self.assertEqual(status, 200)
        self.assertEqual(second_status, 200)
        self.assertEqual(len(self.primary.state.requests), 2)
        self.assertEqual(len(self.secondary.state.requests), 0)

    def test_unknown_session_is_not_sent_to_arbitrary_route(self) -> None:
        status, _, body = self.request("unknown-session")

        self.assertEqual(status, 503)
        self.assertIn(b"session_reconnect_required", body)
        self.assertEqual(self.primary.state.requests, [])
        self.assertEqual(self.secondary.state.requests, [])


if __name__ == "__main__":
    unittest.main()
