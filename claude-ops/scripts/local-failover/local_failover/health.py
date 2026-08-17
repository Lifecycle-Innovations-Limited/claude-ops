"""Authenticated semantic health probes with bounded stream validation."""

from __future__ import annotations

import http.client
import json
import socket
import ssl
import time
from dataclasses import dataclass
from typing import Mapping, Protocol
from urllib.parse import urlsplit

from .config import ConfigError, RouteConfig


@dataclass(frozen=True)
class ProbeResult:
    kind: str
    reason: str
    latency_ms: int


@dataclass(frozen=True)
class ProbeHTTPResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes
    events: tuple[tuple[float, bytes], ...]
    latency_ms: int
    error: str | None = None


class ProbeTransport(Protocol):
    def request(self, **kwargs) -> ProbeHTTPResponse: ...


def _http_classification(status: int, latency_ms: int, prefix: str) -> ProbeResult | None:
    if status in {400, 401, 403, 404, 405, 409, 422}:
        return ProbeResult("unknown", "health_configuration_rejected", latency_ms)
    if status == 429:
        return ProbeResult("failure", f"{prefix}_rate_limited", latency_ms)
    if status >= 500:
        return ProbeResult("failure", f"{prefix}_server_error", latency_ms)
    if not 200 <= status < 300:
        return ProbeResult("failure", f"{prefix}_http_status", latency_ms)
    return None


def classify_inventory_response(status: int, body: bytes, latency_ms: int) -> ProbeResult:
    classified = _http_classification(status, latency_ms, "inventory")
    if classified:
        return classified
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ProbeResult("failure", "inventory_json", latency_ms)
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return ProbeResult("failure", "inventory_shape", latency_ms)
    return ProbeResult("success", "inventory_ok", latency_ms)


def classify_stream_response(
    response: ProbeHTTPResponse,
    first_event_timeout_seconds: float,
    max_event_gap_seconds: float,
    max_response_bytes: int,
) -> ProbeResult:
    if response.error:
        return ProbeResult("failure", response.error, response.latency_ms)
    classified = _http_classification(response.status, response.latency_ms, "stream")
    if classified:
        return classified
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type and "ndjson" not in content_type:
        return ProbeResult("failure", "stream_content_type", response.latency_ms)
    total = sum(len(line) for _, line in response.events)
    if total > max_response_bytes:
        return ProbeResult("failure", "stream_response_too_large", response.latency_ms)
    data_events = [
        (elapsed, line)
        for elapsed, line in response.events
        if line.lstrip().startswith((b"data:", b"{"))
    ]
    if not data_events:
        return ProbeResult("failure", "stream_no_events", response.latency_ms)
    if data_events[0][0] > first_event_timeout_seconds:
        return ProbeResult("failure", "stream_first_event_timeout", response.latency_ms)
    if len(data_events) < 2:
        return ProbeResult("failure", "stream_interrupted", response.latency_ms)
    for previous, current in zip(data_events, data_events[1:]):
        if current[0] - previous[0] > max_event_gap_seconds:
            return ProbeResult("failure", "stream_event_gap", response.latency_ms)
    return ProbeResult("success", "stream_cadence_ok", response.latency_ms)


def classify_mcp_response(response: ProbeHTTPResponse) -> ProbeResult:
    if response.error:
        return ProbeResult("failure", response.error, response.latency_ms)
    classified = _http_classification(response.status, response.latency_ms, "mcp")
    if classified:
        return classified
    try:
        payload = json.loads(response.body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ProbeResult("failure", "mcp_health_shape", response.latency_ms)
    if not isinstance(payload, dict):
        return ProbeResult("failure", "mcp_health_shape", response.latency_ms)
    status = payload.get("status", payload.get("state"))
    semantic_ready = (
        isinstance(status, str)
        and status.lower() in {"healthy", "ok", "online", "ready"}
    ) or payload.get("ready") is True or (
        payload.get("protocol") == "mcp"
        and isinstance(payload.get("active_route"), str)
        and bool(payload["active_route"])
    )
    if not semantic_ready:
        return ProbeResult("failure", "mcp_health_shape", response.latency_ms)
    return ProbeResult("success", "mcp_health_ok", response.latency_ms)


class HTTPProbeTransport:
    """Small HTTP/1.1 client that never retains or logs probe payloads."""

    def __init__(self, clock=time.monotonic) -> None:
        self.clock = clock

    @staticmethod
    def _target(base_url: str, path: str) -> tuple[str, str, int, str]:
        parsed = urlsplit(base_url)
        assert parsed.hostname is not None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        base_path = parsed.path.rstrip("/")
        target = f"{base_path}/{path.lstrip('/')}" or "/"
        return parsed.scheme, parsed.hostname, port, target

    def request(
        self,
        *,
        method: str,
        url: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout_seconds: float,
        max_response_bytes: int,
        stream: bool,
        event_timeout_seconds: float,
    ) -> ProbeHTTPResponse:
        started = self.clock()
        connection: http.client.HTTPConnection | None = None
        try:
            scheme, host, port, target = self._target(url, path)
            if scheme == "https":
                connection = http.client.HTTPSConnection(
                    host,
                    port,
                    timeout=timeout_seconds,
                    context=ssl.create_default_context(),
                )
            else:
                connection = http.client.HTTPConnection(host, port, timeout=timeout_seconds)
            request_headers = dict(headers)
            request_headers["Connection"] = "close"
            connection.request(method, target, body=body, headers=request_headers)
            response = connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            latency_ms = int((self.clock() - started) * 1000)
            if stream and 200 <= response.status < 300:
                if connection.sock:
                    connection.sock.settimeout(event_timeout_seconds)
                events: list[tuple[float, bytes]] = []
                total = 0
                error: str | None = None
                try:
                    while len(events) < 32:
                        line = response.readline(max_response_bytes - total + 1)
                        if not line:
                            break
                        total += len(line)
                        elapsed = self.clock() - started
                        events.append((elapsed, line))
                        if total > max_response_bytes:
                            error = "stream_response_too_large"
                            break
                        stripped = line.strip()
                        if stripped in {b"data: [DONE]", b"event: message_stop"}:
                            break
                        data_count = sum(
                            1
                            for _, event in events
                            if event.lstrip().startswith((b"data:", b"{"))
                        )
                        if data_count >= 2:
                            break
                except (OSError, http.client.HTTPException, socket.timeout):
                    error = "stream_interrupted"
                return ProbeHTTPResponse(
                    response.status,
                    response_headers,
                    b"",
                    tuple(events),
                    latency_ms,
                    error,
                )
            body_bytes = response.read(max_response_bytes + 1)
            error = "probe_response_too_large" if len(body_bytes) > max_response_bytes else None
            if error:
                body_bytes = b""
            return ProbeHTTPResponse(
                response.status,
                response_headers,
                body_bytes,
                (),
                latency_ms,
                error,
            )
        except ConfigError:
            return ProbeHTTPResponse(0, {}, b"", (), 0, "route_configuration")
        except (OSError, http.client.HTTPException, ssl.SSLError, ValueError):
            return ProbeHTTPResponse(
                0,
                {},
                b"",
                (),
                int((self.clock() - started) * 1000),
                "connect_error",
            )
        finally:
            if connection:
                connection.close()


class SemanticHealth:
    def __init__(self, transport: ProbeTransport | None = None) -> None:
        self.transport = transport or HTTPProbeTransport()

    @staticmethod
    def _headers(route: RouteConfig, env: Mapping[str, str]) -> dict[str, str] | ProbeResult:
        health = route.health
        headers = {"Accept": "application/json, text/event-stream"}
        if health.auth_env:
            credential = env.get(health.auth_env)
            if not credential:
                return ProbeResult("unknown", "health_auth_missing", 0)
            headers[health.auth_header] = f"{health.auth_prefix}{credential}"
        return headers

    def probe(self, route: RouteConfig, env: Mapping[str, str]) -> ProbeResult:
        headers = self._headers(route, env)
        if isinstance(headers, ProbeResult):
            return headers
        try:
            url = route.resolve_url(env)
        except ConfigError:
            return ProbeResult("unknown", "route_url_missing", 0)
        health = route.health
        if health.kind == "mcp":
            response = self.transport.request(
                method="GET",
                url=url,
                path=health.mcp_health_path or "/_failover/status",
                headers=headers,
                body=None,
                timeout_seconds=health.timeout_seconds,
                max_response_bytes=health.max_response_bytes,
                stream=False,
                event_timeout_seconds=health.max_event_gap_seconds,
            )
            return classify_mcp_response(response)

        model = health.stream_model
        if health.stream_model_env:
            model = env.get(health.stream_model_env)
        if not model:
            return ProbeResult("unknown", "health_model_missing", 0)
        inventory = self.transport.request(
            method="GET",
            url=url,
            path=health.inventory_path,
            headers=headers,
            body=None,
            timeout_seconds=health.timeout_seconds,
            max_response_bytes=health.max_response_bytes,
            stream=False,
            event_timeout_seconds=health.max_event_gap_seconds,
        )
        if inventory.error:
            return ProbeResult("failure", inventory.error, inventory.latency_ms)
        inventory_result = classify_inventory_response(
            inventory.status, inventory.body, inventory.latency_ms
        )
        if inventory_result.kind != "success":
            return inventory_result
        stream_body = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": "Reply OK"}],
                "max_tokens": 2,
                "stream": True,
            },
            separators=(",", ":"),
        ).encode()
        stream = self.transport.request(
            method="POST",
            url=url,
            path=health.stream_path or "/v1/chat/completions",
            headers={**headers, "Content-Type": "application/json"},
            body=stream_body,
            timeout_seconds=health.timeout_seconds,
            max_response_bytes=health.max_response_bytes,
            stream=True,
            event_timeout_seconds=max(
                health.first_event_timeout_seconds, health.max_event_gap_seconds
            ),
        )
        stream_result = classify_stream_response(
            stream,
            health.first_event_timeout_seconds,
            health.max_event_gap_seconds,
            health.max_response_bytes,
        )
        if stream_result.kind != "success":
            return stream_result
        return ProbeResult(
            "success",
            "semantic_ok",
            inventory_result.latency_ms + stream_result.latency_ms,
        )
