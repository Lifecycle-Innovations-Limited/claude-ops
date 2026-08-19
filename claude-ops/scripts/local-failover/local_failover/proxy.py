"""Loopback-only streaming reverse proxy with ordered, session-safe failover."""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping
from urllib.parse import unquote, urlsplit

from .circuit import CircuitBreaker, RouteRuntime, RouteSelector
from .config import GatewayConfig, ListenerConfig, NetworkGateConfig, RouteConfig
from .health import ProbeResult, SemanticHealth
from .tunnel import TunnelSupervisor


IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
RETRYABLE_STATUSES = frozenset({502, 503, 504})
HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


@dataclass
class SessionBinding:
    route_name: str
    last_seen: float


# Origin-form request target: printable ASCII only (no SP/CTL, so no
# request-line or header injection into the upstream connection).
_REQUEST_TARGET_RE = re.compile(r"^/[\x21-\x7e]*$")
# RFC 7230 token characters for header field names.
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
# Header field values must not carry CR/LF/NUL (response splitting) and are
# limited to visible ASCII plus SP/HTAB.
_HEADER_VALUE_RE = re.compile(r"^[\t\x20-\x7e]*$")


def _sanitize_header_field(value: str) -> str | None:
    """Return a header name or value safe to write on the wire, or None.

    CodeQL models str.replace(\"\\n\", ...) as the header-injection sanitizer,
    so the replace happens first and the result of that call is what we
    return. The regex is a second, stricter gate (printable ASCII).
    """

    folded = value.replace("\n", "").replace("\r", "")
    if folded != value:
        return None
    if _HEADER_VALUE_RE.fullmatch(folded) is None:
        return None
    return folded


def _safe_request_target(raw_path: str) -> str | None:
    """Validate the client-supplied request target before forwarding.

    The proxy only forwards to the configured upstream base URL, so the
    request target must remain a plain origin-form path: no authority-form
    or absolute-form targets (which could redirect the outbound request), no
    control characters or whitespace, and no dot segments (encoded or not)
    that could escape the configured base path.
    """

    if not raw_path.startswith("/") or raw_path.startswith("//"):
        return None
    # re.fullmatch is the CodeQL-modeled sanitizer for partial SSRF. Return
    # the match text (not the original parameter) so taint tracking sees a
    # value constrained by the origin-form regex.
    matched = _REQUEST_TARGET_RE.fullmatch(raw_path)
    if matched is None:
        return None
    constrained = matched.group(0)
    path, _, query = constrained.partition("?")
    decoded_path = unquote(path)
    if any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in decoded_path):
        return None
    decoded_query = unquote(query)
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded_query):
        return None
    if "\\" in decoded_path or "\\" in decoded_query:
        return None
    for segment in decoded_path.split("/"):
        if segment in {".", ".."}:
            return None
    return constrained


def _connection_tokens(value: str | None) -> set[str]:
    if not value:
        return set()
    return {token.strip().lower() for token in value.split(",") if token.strip()}


def _network_gate_status(gate: NetworkGateConfig) -> tuple[bool, str]:
    """Inspect the local route table without changing network state."""

    if gate.kind == "none":
        return True, "ready"
    assert gate.destination is not None
    try:
        result = subprocess.run(
            ["/sbin/route", "-n", "get", gate.destination],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "network_gate_unknown"
    if result.returncode != 0:
        return False, "network_route_missing"
    interface = ""
    for line in result.stdout.splitlines():
        key, separator, value = line.strip().partition(":")
        if separator and key == "interface":
            interface = value.strip()
            break
    if not interface:
        return False, "network_interface_unknown"
    if not any(interface.startswith(prefix) for prefix in gate.interface_prefixes):
        return False, "network_interface_unapproved"
    return True, "network_route_ready"


class ListenerRuntime:
    """Mutable state for one configured listener."""

    def __init__(self, service: GatewayService, config: ListenerConfig) -> None:
        self.service = service
        self.config = config
        now = service.clock()
        self.routes = [
            RouteRuntime(
                route,
                CircuitBreaker(route.breaker, now),
                gate_ready=route.provisioned
                and route.tunnel is None
                and route.network_gate.kind == "none",
                gate_reason="ready"
                if route.provisioned
                and route.tunnel is None
                and route.network_gate.kind == "none"
                else "gate_not_checked",
            )
            for route in config.routes
        ]
        self.selector = RouteSelector(self.routes)
        self.sessions: dict[str, SessionBinding] = {}
        self.lock = threading.RLock()
        self.requests = 0
        self.responses = 0
        self.errors = 0

    def _expire_sessions(self, now: float) -> None:
        expired = [
            session_id
            for session_id, binding in self.sessions.items()
            if now - binding.last_seen > self.config.session_ttl_seconds
        ]
        for session_id in expired:
            del self.sessions[session_id]

    def session_route(self, session_id: str, now: float) -> str | None:
        with self.lock:
            self._expire_sessions(now)
            binding = self.sessions.get(session_id)
            if binding is None:
                return None
            binding.last_seen = now
            return binding.route_name

    def bind_session(self, session_id: str, route_name: str, now: float) -> None:
        if not session_id or len(session_id) > 512 or "\r" in session_id or "\n" in session_id:
            return
        with self.lock:
            self._expire_sessions(now)
            self.sessions[session_id] = SessionBinding(route_name, now)

    def choose(
        self, session_route: str | None, now: float, excluded: set[str] | None = None
    ) -> RouteRuntime | None:
        with self.lock:
            return self.selector.choose(session_route, now, excluded)

    def begin_attempt(self, route: RouteRuntime) -> None:
        with self.lock:
            self.requests += 1
            route.requests += 1

    def observe_failure(self, route: RouteRuntime, reason: str) -> None:
        with self.lock:
            self.errors += 1
            route.failures += 1
            route.breaker.observe_failure(self.service.clock(), reason)

    def add_response_bytes(self, route: RouteRuntime, count: int) -> None:
        with self.lock:
            route.bytes_to_client += count

    def complete_response(self) -> None:
        with self.lock:
            self.responses += 1

    def snapshot(self, now: float) -> dict[str, object]:
        with self.lock:
            self._expire_sessions(now)
            return {
                "name": self.config.name,
                "protocol": self.config.protocol,
                "active_route": self.selector.active_route,
                "requests": self.requests,
                "responses": self.responses,
                "errors": self.errors,
                "sessions": len(self.sessions),
                "routes": [route.snapshot(now) for route in self.routes],
            }


class _GatewayHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        *,
        max_concurrent_requests: int,
    ) -> None:
        self._request_slots = threading.BoundedSemaphore(max_concurrent_requests)
        super().__init__(server_address, handler_class)

    @staticmethod
    def _reject_overload(request: socket.socket) -> None:
        body = b'{"error":"gateway_overloaded"}'
        response = (
            b"HTTP/1.1 503 Service Unavailable\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Retry-After: 1\r\nConnection: close\r\n\r\n"
            + body
        )
        try:
            request.settimeout(0.5)
            request.sendall(response)
        except OSError:
            pass

    def process_request(self, request: socket.socket, client_address: object) -> None:
        if not self._request_slots.acquire(blocking=False):
            self._reject_overload(request)
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: object) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


class _GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    runtime: ListenerRuntime

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.runtime.config.client_timeout_seconds)

    def log_message(self, _format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def _json_response(self, status: int, code: str) -> None:
        body = json.dumps({"error": code}, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _status_response(self, metrics: bool) -> None:
        if self.command not in {"GET", "HEAD"}:
            self._json_response(405, "method_not_allowed")
            return
        if metrics:
            body = self.runtime.service.metrics(self.runtime).encode()
            content_type = "text/plain; version=0.0.4"
        else:
            body = json.dumps(
                self.runtime.snapshot(self.runtime.service.clock()),
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _read_body(self) -> bytes | None:
        if self.headers.get("Transfer-Encoding"):
            self._json_response(400, "request_transfer_encoding_unsupported")
            return None
        values = self.headers.get_all("Content-Length", failobj=[])
        if len(set(values)) > 1:
            self._json_response(400, "conflicting_content_length")
            return None
        try:
            length = int(values[0]) if values else 0
        except ValueError:
            self._json_response(400, "invalid_content_length")
            return None
        if length < 0:
            self._json_response(400, "invalid_content_length")
            return None
        if length > self.runtime.config.max_body_bytes:
            self._json_response(413, "request_body_too_large")
            return None
        try:
            body = self.rfile.read(length) if length else b""
        except socket.timeout:
            self._json_response(408, "request_body_timeout")
            return None
        if len(body) != length:
            self._json_response(400, "incomplete_request_body")
            return None
        return body

    def _request_headers(self) -> dict[str, str]:
        excluded = set(HOP_BY_HOP_HEADERS)
        excluded.update(_connection_tokens(self.headers.get("Connection")))
        excluded.update({"expect", "host", "x-local-failover-route"})
        headers = {}
        for key, value in self.headers.items():
            if key.lower() in excluded:
                continue
            # Never forward header names or values that could smuggle CR/LF
            # or non-token characters into the upstream request.
            safe_key = _sanitize_header_field(key)
            if safe_key is None or _HEADER_NAME_RE.fullmatch(safe_key) is None:
                continue
            safe_value = _sanitize_header_field(value or "")
            if safe_value is None:
                continue
            headers[safe_key] = safe_value
        headers["Connection"] = "close"
        return headers

    def _upstream(
        self, route: RouteConfig
    ) -> tuple[http.client.HTTPConnection, str] | None:
        base_url = route.resolve_url(self.runtime.service.env)
        parsed = urlsplit(base_url)
        assert parsed.hostname is not None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        base_path = parsed.path.rstrip("/")
        requested = _safe_request_target(self.path)
        if requested is None:
            return None
        target = f"{base_path}{requested}"
        if not target.startswith("/"):
            target = f"/{target}"
        if parsed.scheme == "https":
            connection: http.client.HTTPConnection = http.client.HTTPSConnection(
                parsed.hostname,
                port,
                timeout=self.runtime.config.connect_timeout_seconds,
                context=ssl.create_default_context(),
            )
        else:
            connection = http.client.HTTPConnection(
                parsed.hostname,
                port,
                timeout=self.runtime.config.connect_timeout_seconds,
            )
        return connection, target

    def _response_headers(
        self, response: http.client.HTTPResponse, route_name: str
    ) -> tuple[list[tuple[str, str]], int | None] | None:
        connection_value = response.headers.get("Connection")
        excluded = set(HOP_BY_HOP_HEADERS)
        excluded.update(_connection_tokens(connection_value))
        excluded.add("x-local-failover-route")
        headers: list[tuple[str, str]] = []
        content_length: int | None = None
        # Reject ambiguous framing: upstream duplicate Content-Length headers
        # with conflicting values are a smuggling primitive (RFC 7230 3.3.2).
        length_values = {
            value.strip()
            for value in response.headers.get_all("Content-Length", failobj=[])
        }
        if len(length_values) > 1:
            return None
        for key, value in response.getheaders():
            if key.lower() in excluded:
                continue
            # Upstream headers are untrusted input relative to our client
            # connection: drop anything that could split the response.
            safe_key = _sanitize_header_field(key)
            if safe_key is None or _HEADER_NAME_RE.fullmatch(safe_key) is None:
                continue
            safe_value = _sanitize_header_field(value or "")
            if safe_value is None:
                continue
            if safe_key.lower() == "content-length":
                try:
                    content_length = int(safe_value)
                except ValueError:
                    continue
            headers.append((safe_key, safe_value))
        headers.append(("X-Local-Failover-Route", route_name))
        headers.append(("Connection", "close"))
        return headers, content_length

    def _forward_response(
        self,
        response: http.client.HTTPResponse,
        route: RouteRuntime,
    ) -> None:
        header_result = self._response_headers(response, route.config.name)
        if header_result is None:
            self.runtime.observe_failure(route, "upstream_ambiguous_framing")
            self._json_response(502, "upstream_invalid_response")
            return
        headers, content_length = header_result
        session_id = response.headers.get("Mcp-Session-Id")
        if (
            self.runtime.config.protocol == "mcp"
            and 200 <= response.status < 300
            and session_id
        ):
            self.runtime.bind_session(
                session_id, route.config.name, self.runtime.service.clock()
            )
        reason = response.reason or ""
        reason = "".join(ch if "\x20" <= ch <= "\x7e" else " " for ch in reason)
        self.send_response(response.status, reason)
        for key, value in headers:
            # Re-apply the CodeQL-modeled sanitizer at the sink so taint
            # tracking sees replace("\n") on the value written to the wire.
            self.send_header(key.replace("\n", "").replace("\r", ""), value.replace("\n", "").replace("\r", ""))
        self.end_headers()
        self.close_connection = True
        if self.command == "HEAD":
            self.runtime.complete_response()
            return

        written = 0
        upstream_failed = False
        while True:
            try:
                chunk = response.read1(65536)
            except http.client.IncompleteRead as exc:
                chunk = exc.partial
                upstream_failed = True
            except (OSError, http.client.HTTPException, socket.timeout):
                chunk = b""
                upstream_failed = True
            if chunk:
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                written += len(chunk)
                self.runtime.add_response_bytes(route, len(chunk))
            if upstream_failed or not chunk:
                break
        if content_length is not None and written != content_length:
            upstream_failed = True
        if upstream_failed:
            self.runtime.observe_failure(route, "response_interrupted")
        else:
            self.runtime.complete_response()

    def _dispatch(self) -> None:
        if self.path == "/_failover/status":
            self._status_response(metrics=False)
            return
        if self.path == "/_failover/metrics":
            self._status_response(metrics=True)
            return
        if _safe_request_target(self.path) is None:
            self._json_response(400, "invalid_request_target")
            return
        body = self._read_body()
        if body is None:
            return

        now = self.runtime.service.clock()
        session_route: str | None = None
        if self.runtime.config.protocol == "mcp":
            incoming_session = self.headers.get("Mcp-Session-Id")
            if incoming_session:
                session_route = self.runtime.session_route(incoming_session, now)
                if session_route is None:
                    self._json_response(503, "session_reconnect_required")
                    return

        safe_retry = self.command in IDEMPOTENT_METHODS and session_route is None
        attempts = self.runtime.config.max_idempotent_attempts if safe_retry else 1
        excluded: set[str] = set()
        headers = self._request_headers()

        for attempt in range(attempts):
            route = self.runtime.choose(session_route, self.runtime.service.clock(), excluded)
            if route is None:
                code = (
                    "session_reconnect_required"
                    if session_route is not None
                    else "no_healthy_route"
                )
                self._json_response(503, code)
                return
            self.runtime.begin_attempt(route)
            connection: http.client.HTTPConnection | None = None
            try:
                upstream = self._upstream(route.config)
                if upstream is None:
                    self._json_response(400, "invalid_request_target")
                    return
                connection, target = upstream
                # CodeQL's partial-SSRF sanitizer is a BarrierGuard: the
                # request sink must sit inside the true branch of
                # re.fullmatch, matching the documented GOOD example
                # (`if user_id.isalnum(): requests.get(... + user_id)`).
                # An inverted `if match is None: return` does not count.
                # Critically, the sink must reuse the *same guarded
                # variable* (`target`) rather than a value derived from
                # the match object (e.g. `match.group(0)`), or CodeQL
                # treats it as an unguarded flow node and still flags it.
                if _REQUEST_TARGET_RE.fullmatch(target) is not None:
                    connection.request(
                        self.command, target, body=body, headers=headers
                    )
                    response = connection.getresponse()
                    if connection.sock:
                        connection.sock.settimeout(self.runtime.config.idle_timeout_seconds)
                else:
                    connection.close()
                    self._json_response(400, "invalid_request_target")
                    return
            except (OSError, http.client.HTTPException, ssl.SSLError, ValueError):
                if connection:
                    connection.close()
                self.runtime.observe_failure(route, "upstream_connect_error")
                excluded.add(route.config.name)
                if attempt + 1 < attempts:
                    continue
                self._json_response(502, "upstream_unavailable")
                return

            if response.status in RETRYABLE_STATUSES:
                self.runtime.observe_failure(route, f"upstream_http_{response.status}")
                if safe_retry and attempt + 1 < attempts:
                    excluded.add(route.config.name)
                    alternative = self.runtime.choose(
                        None, self.runtime.service.clock(), excluded
                    )
                    if alternative is not None:
                        response.close()
                        connection.close()
                        continue
            try:
                self._forward_response(response, route)
            finally:
                response.close()
                connection.close()
                self.runtime.service.persist_state()
            return


class GatewayService:
    """Owns loopback listeners, health workers, and supervised route tunnels."""

    def __init__(
        self,
        config: GatewayConfig,
        *,
        env: Mapping[str, str] | None = None,
        clock=time.monotonic,
        semantic_health: SemanticHealth | None = None,
    ) -> None:
        self.config = config
        self.env = dict(os.environ if env is None else env)
        self.clock = clock
        self.semantic_health = semantic_health or SemanticHealth()
        self.listeners = {
            listener.name: ListenerRuntime(self, listener)
            for listener in config.listeners
        }
        self._servers: dict[str, _GatewayHTTPServer] = {}
        self._server_threads: list[threading.Thread] = []
        self._health_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._started = False
        self._persist_lock = threading.Lock()
        self._state_persistence = "disabled" if config.state_file is None else "pending"
        self._next_probe: dict[tuple[str, str], float] = {}
        self._tunnels: dict[tuple[str, str], TunnelSupervisor] = {}
        for listener in self.listeners.values():
            for route in listener.routes:
                if route.config.tunnel is not None:
                    self._tunnels[(listener.config.name, route.config.name)] = (
                        TunnelSupervisor(route.config.tunnel, env=self.env)
                    )

    def start(self, *, run_health: bool = True) -> None:
        if self._started:
            raise RuntimeError("gateway is already started")
        self._stop.clear()
        try:
            for name, runtime in self.listeners.items():
                handler = type(
                    f"GatewayHandler_{name}",
                    (_GatewayHandler,),
                    {"runtime": runtime},
                )
                server = _GatewayHTTPServer(
                    (runtime.config.host, runtime.config.port),
                    handler,
                    max_concurrent_requests=runtime.config.max_concurrent_requests,
                )
                thread = threading.Thread(
                    target=server.serve_forever,
                    name=f"local-failover-{name}",
                    daemon=True,
                )
                self._servers[name] = server
                self._server_threads.append(thread)
                thread.start()
            self._started = True
            if run_health:
                self._health_thread = threading.Thread(
                    target=self._health_loop,
                    name="local-failover-health",
                    daemon=True,
                )
                self._health_thread.start()
            self.persist_state()
        except BaseException:
            self.shutdown()
            raise

    def _set_gate(self, route: RouteRuntime, ready: bool, reason: str) -> None:
        route.gate_ready = ready and route.config.provisioned
        route.gate_reason = reason if route.config.provisioned else "not_provisioned"

    def _route_gate(self, listener: ListenerRuntime, route: RouteRuntime, now: float) -> bool:
        tunnel = self._tunnels.get((listener.config.name, route.config.name))
        if tunnel is not None:
            status = tunnel.tick(now)
            self._set_gate(route, status.ready, status.reason)
            return route.gate_ready
        ready, reason = _network_gate_status(route.config.network_gate)
        self._set_gate(route, ready, reason)
        return route.gate_ready

    def _observe_probe(
        self, route: RouteRuntime, result: ProbeResult, now: float
    ) -> None:
        if result.kind == "success":
            route.breaker.observe_success(now, result.reason)
        elif result.kind == "failure":
            route.breaker.observe_failure(now, result.reason)
        else:
            route.breaker.observe_unknown(now, result.reason)

    def _health_once(self) -> None:
        now = self.clock()
        for listener in self.listeners.values():
            for route in listener.routes:
                if not self._route_gate(listener, route, now):
                    continue
                key = (listener.config.name, route.config.name)
                if now < self._next_probe.get(key, 0.0):
                    continue
                if route.breaker.state == "open" and now < route.breaker.open_until:
                    self._next_probe[key] = route.breaker.open_until
                    continue
                result = self.semantic_health.probe(route.config, self.env)
                with listener.lock:
                    self._observe_probe(route, result, now)
                if result.kind == "failure" and route.breaker.state == "open":
                    self._next_probe[key] = max(now + 0.1, route.breaker.open_until)
                else:
                    self._next_probe[key] = now + route.config.health.interval_seconds
        self.persist_state()

    def _health_loop(self) -> None:
        while not self._stop.is_set():
            self._health_once()
            self._stop.wait(0.5)

    def metrics(self, runtime: ListenerRuntime) -> str:
        now = self.clock()
        snapshot = runtime.snapshot(now)
        lines = [
            "# HELP local_failover_requests_total Upstream request attempts.",
            "# TYPE local_failover_requests_total counter",
        ]
        for route in snapshot["routes"]:
            name = route["name"]
            labels = f'listener="{runtime.config.name}",route="{name}"'
            lines.append(
                f"local_failover_route_requests_total{{{labels}}} {route['requests']}"
            )
            lines.append(
                f"local_failover_route_failures_total{{{labels}}} {route['failures']}"
            )
            lines.append(
                f"local_failover_route_available{{{labels}}} "
                f"{1 if route['circuit']['available'] and route['gate_ready'] else 0}"
            )
        return "\n".join(lines) + "\n"

    def _snapshot(self) -> dict[str, object]:
        now = self.clock()
        return {
            "version": 1,
            "state_persistence": self._state_persistence,
            "listeners": [runtime.snapshot(now) for runtime in self.listeners.values()],
        }

    def persist_state(self) -> None:
        path = self.config.state_file
        if path is None:
            return
        with self._persist_lock:
            path = Path(path)
            descriptor = -1
            temporary: str | None = None
            try:
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                descriptor, temporary = tempfile.mkstemp(
                    dir=path.parent, prefix=f".{path.name}.", text=True
                )
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    descriptor = -1
                    json.dump(self._snapshot(), handle, sort_keys=True, separators=(",", ":"))
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, path)
                temporary = None
                os.chmod(path, 0o600)
                self._state_persistence = "ok"
            except OSError:
                self._state_persistence = "error"
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
                if temporary is not None:
                    try:
                        os.unlink(temporary)
                    except FileNotFoundError:
                        pass

    def shutdown(self) -> None:
        self._stop.set()
        for server in self._servers.values():
            server.shutdown()
            server.server_close()
        for thread in self._server_threads:
            thread.join(timeout=3)
        if self._health_thread is not None:
            self._health_thread.join(timeout=3)
        for tunnel in self._tunnels.values():
            tunnel.shutdown()
        self._servers.clear()
        self._server_threads.clear()
        self._health_thread = None
        self._started = False
