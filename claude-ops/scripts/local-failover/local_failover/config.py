"""Strict configuration schema for the local failover gateway."""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit


ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
SAFE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,62}$")


class ConfigError(ValueError):
    """The failover configuration is unsafe or internally inconsistent."""


@dataclass(frozen=True)
class BreakerPolicy:
    failure_threshold: int = 2
    recovery_successes: int = 3
    base_backoff_seconds: float = 5.0
    max_backoff_seconds: float = 60.0
    failback_hold_seconds: float = 5.0
    max_stale_seconds: float = 60.0


@dataclass(frozen=True)
class HealthConfig:
    kind: str
    auth_env: str | None = None
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    inventory_path: str = "/v1/models"
    stream_path: str | None = None
    stream_model: str | None = None
    stream_model_env: str | None = None
    mcp_path: str | None = None
    interval_seconds: float = 15.0
    timeout_seconds: float = 8.0
    first_event_timeout_seconds: float = 5.0
    max_event_gap_seconds: float = 3.0
    max_response_bytes: int = 65536


@dataclass(frozen=True)
class TunnelConfig:
    enabled: bool
    argv: tuple[str, ...]
    listener_host: str
    listener_port: int
    startup_timeout_seconds: float = 20.0
    restart_base_seconds: float = 5.0
    restart_max_seconds: float = 120.0


@dataclass(frozen=True)
class NetworkGateConfig:
    kind: str = "none"
    destination: str | None = None
    interface_prefixes: tuple[str, ...] = ()


@dataclass(frozen=True)
class RouteConfig:
    name: str
    url: str | None
    url_env: str | None
    provisioned: bool
    trusted_overlay_http: bool
    health: HealthConfig
    breaker: BreakerPolicy
    tunnel: TunnelConfig | None = None
    network_gate: NetworkGateConfig = NetworkGateConfig()

    def resolve_url(self, env: Mapping[str, str]) -> str:
        value = self.url
        if self.url_env:
            value = env.get(self.url_env)
            if not value:
                raise ConfigError(
                    f"route {self.name!r} requires environment variable {self.url_env}"
                )
        assert value is not None
        _validate_upstream_url(value, self.trusted_overlay_http, self.name)
        return value.rstrip("/")


@dataclass(frozen=True)
class ListenerConfig:
    name: str
    host: str
    port: int
    protocol: str
    max_body_bytes: int
    max_idempotent_attempts: int
    session_ttl_seconds: float
    routes: tuple[RouteConfig, ...]


@dataclass(frozen=True)
class GatewayConfig:
    version: int
    state_file: Path | None
    listeners: tuple[ListenerConfig, ...]


def _object(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{context} must be an object")
    return value


def _list(value: Any, context: str) -> list[Any]:
    if not isinstance(value, list):
        raise ConfigError(f"{context} must be an array")
    return value


def _only_keys(value: dict[str, Any], allowed: set[str], context: str) -> None:
    extra = sorted(set(value) - allowed)
    if extra:
        raise ConfigError(f"{context} contains unknown keys: {', '.join(extra)}")


def _name(value: Any, context: str) -> str:
    if not isinstance(value, str) or not SAFE_NAME.fullmatch(value):
        raise ConfigError(f"{context} must match {SAFE_NAME.pattern}")
    return value


def _env_name(value: Any, context: str, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not ENV_NAME.fullmatch(value):
        raise ConfigError(f"{context} must be an uppercase environment variable name")
    return value


def _bounded_int(value: Any, minimum: int, maximum: int, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ConfigError(f"{context} must be an integer from {minimum} to {maximum}")
    return value


def _bounded_float(value: Any, minimum: float, maximum: float, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{context} must be a number")
    result = float(value)
    if not minimum <= result <= maximum:
        raise ConfigError(f"{context} must be from {minimum} to {maximum}")
    return result


def _loopback(host: str, context: str) -> None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ConfigError(f"{context} must be a literal loopback address") from exc
    if not address.is_loopback:
        raise ConfigError(f"{context} must be loopback-only")


def _safe_path(value: Any, context: str, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise ConfigError(f"{context} must be an absolute HTTP path")
    if "?" in value or "#" in value:
        raise ConfigError(f"{context} cannot contain a query or fragment")
    return value


def _validate_upstream_url(value: str, trusted_overlay_http: bool, context: str) -> None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ConfigError(f"route {context!r} has an invalid upstream URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigError(f"route {context!r} upstream must use http or https")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigError(
            f"route {context!r} upstream cannot contain credentials, query, or fragment"
        )
    if port is not None and not 1 <= port <= 65535:
        raise ConfigError(f"route {context!r} upstream port is invalid")
    if parsed.scheme == "http":
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = parsed.hostname == "localhost"
        if not loopback and not trusted_overlay_http:
            raise ConfigError(
                f"route {context!r} cleartext upstream requires trusted_overlay_http"
            )


def _parse_breaker(raw: Any, context: str) -> BreakerPolicy:
    data = _object(raw or {}, context)
    _only_keys(
        data,
        {
            "failure_threshold",
            "recovery_successes",
            "base_backoff_seconds",
            "max_backoff_seconds",
            "failback_hold_seconds",
            "max_stale_seconds",
        },
        context,
    )
    policy = BreakerPolicy(
        failure_threshold=_bounded_int(
            data.get("failure_threshold", 2), 1, 20, f"{context}.failure_threshold"
        ),
        recovery_successes=_bounded_int(
            data.get("recovery_successes", 3), 1, 20, f"{context}.recovery_successes"
        ),
        base_backoff_seconds=_bounded_float(
            data.get("base_backoff_seconds", 5), 0.1, 3600, f"{context}.base_backoff_seconds"
        ),
        max_backoff_seconds=_bounded_float(
            data.get("max_backoff_seconds", 60), 0.1, 86400, f"{context}.max_backoff_seconds"
        ),
        failback_hold_seconds=_bounded_float(
            data.get("failback_hold_seconds", 5), 0, 3600, f"{context}.failback_hold_seconds"
        ),
        max_stale_seconds=_bounded_float(
            data.get("max_stale_seconds", 60), 1, 86400, f"{context}.max_stale_seconds"
        ),
    )
    if policy.max_backoff_seconds < policy.base_backoff_seconds:
        raise ConfigError(f"{context}.max_backoff_seconds must be at least base_backoff_seconds")
    return policy


def _parse_health(raw: Any, context: str) -> HealthConfig:
    data = _object(raw, context)
    _only_keys(
        data,
        {
            "kind",
            "auth_env",
            "auth_header",
            "auth_prefix",
            "inventory_path",
            "stream_path",
            "stream_model",
            "stream_model_env",
            "mcp_path",
            "interval_seconds",
            "timeout_seconds",
            "first_event_timeout_seconds",
            "max_event_gap_seconds",
            "max_response_bytes",
        },
        context,
    )
    kind = data.get("kind")
    if kind not in {"llm", "mcp"}:
        raise ConfigError(f"{context}.kind must be llm or mcp")
    auth_env = _env_name(data.get("auth_env"), f"{context}.auth_env", optional=True)
    auth_header = data.get("auth_header", "Authorization")
    auth_prefix = data.get("auth_prefix", "Bearer ")
    if not isinstance(auth_header, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", auth_header):
        raise ConfigError(f"{context}.auth_header is invalid")
    if not isinstance(auth_prefix, str) or len(auth_prefix) > 32 or "\r" in auth_prefix or "\n" in auth_prefix:
        raise ConfigError(f"{context}.auth_prefix is invalid")
    stream_model = data.get("stream_model")
    if stream_model is not None and (not isinstance(stream_model, str) or not stream_model):
        raise ConfigError(f"{context}.stream_model must be a non-empty string")
    stream_model_env = _env_name(
        data.get("stream_model_env"), f"{context}.stream_model_env", optional=True
    )
    if stream_model and stream_model_env:
        raise ConfigError(f"{context} must use stream_model or stream_model_env, not both")
    inventory_path = _safe_path(
        data.get("inventory_path", "/v1/models"), f"{context}.inventory_path"
    )
    stream_path = _safe_path(data.get("stream_path"), f"{context}.stream_path", optional=True)
    mcp_path = _safe_path(data.get("mcp_path"), f"{context}.mcp_path", optional=True)
    if kind == "llm" and not stream_path:
        raise ConfigError(f"{context}.stream_path is required for llm health")
    if kind == "mcp" and not mcp_path:
        raise ConfigError(f"{context}.mcp_path is required for mcp health")
    return HealthConfig(
        kind=kind,
        auth_env=auth_env,
        auth_header=auth_header,
        auth_prefix=auth_prefix,
        inventory_path=inventory_path or "/v1/models",
        stream_path=stream_path,
        stream_model=stream_model,
        stream_model_env=stream_model_env,
        mcp_path=mcp_path,
        interval_seconds=_bounded_float(
            data.get("interval_seconds", 15), 1, 3600, f"{context}.interval_seconds"
        ),
        timeout_seconds=_bounded_float(
            data.get("timeout_seconds", 8), 0.1, 120, f"{context}.timeout_seconds"
        ),
        first_event_timeout_seconds=_bounded_float(
            data.get("first_event_timeout_seconds", 5),
            0.1,
            120,
            f"{context}.first_event_timeout_seconds",
        ),
        max_event_gap_seconds=_bounded_float(
            data.get("max_event_gap_seconds", 3), 0.1, 120, f"{context}.max_event_gap_seconds"
        ),
        max_response_bytes=_bounded_int(
            data.get("max_response_bytes", 65536), 1024, 1048576, f"{context}.max_response_bytes"
        ),
    )


def _parse_tunnel(raw: Any, context: str, provisioned: bool) -> TunnelConfig | None:
    if raw is None:
        return None
    data = _object(raw, context)
    _only_keys(
        data,
        {
            "enabled",
            "argv",
            "listener_host",
            "listener_port",
            "startup_timeout_seconds",
            "restart_base_seconds",
            "restart_max_seconds",
        },
        context,
    )
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        raise ConfigError(f"{context}.enabled must be boolean")
    if enabled and not provisioned:
        raise ConfigError(f"{context} cannot be enabled until the route is provisioned")
    argv_raw = _list(data.get("argv"), f"{context}.argv")
    if not argv_raw or any(not isinstance(item, str) or not item for item in argv_raw):
        raise ConfigError(f"{context}.argv must contain non-empty strings")
    host = data.get("listener_host")
    if not isinstance(host, str):
        raise ConfigError(f"{context}.listener_host must be a string")
    _loopback(host, f"{context} tunnel listener")
    config = TunnelConfig(
        enabled=enabled,
        argv=tuple(argv_raw),
        listener_host=host,
        listener_port=_bounded_int(
            data.get("listener_port"), 1, 65535, f"{context}.listener_port"
        ),
        startup_timeout_seconds=_bounded_float(
            data.get("startup_timeout_seconds", 20),
            1,
            300,
            f"{context}.startup_timeout_seconds",
        ),
        restart_base_seconds=_bounded_float(
            data.get("restart_base_seconds", 5), 0.1, 3600, f"{context}.restart_base_seconds"
        ),
        restart_max_seconds=_bounded_float(
            data.get("restart_max_seconds", 120), 0.1, 86400, f"{context}.restart_max_seconds"
        ),
    )
    if config.restart_max_seconds < config.restart_base_seconds:
        raise ConfigError(f"{context}.restart_max_seconds must be at least restart_base_seconds")
    return config


def _parse_network_gate(raw: Any, context: str) -> NetworkGateConfig:
    if raw is None:
        return NetworkGateConfig()
    data = _object(raw, context)
    _only_keys(data, {"kind", "destination", "interface_prefixes"}, context)
    kind = data.get("kind", "none")
    if kind not in {"none", "route_interface"}:
        raise ConfigError(f"{context}.kind must be none or route_interface")
    if kind == "none":
        return NetworkGateConfig()
    destination = data.get("destination")
    if not isinstance(destination, str) or not destination:
        raise ConfigError(f"{context}.destination is required")
    prefixes = _list(data.get("interface_prefixes"), f"{context}.interface_prefixes")
    if not prefixes or any(
        not isinstance(prefix, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,32}", prefix)
        for prefix in prefixes
    ):
        raise ConfigError(f"{context}.interface_prefixes must contain safe prefixes")
    return NetworkGateConfig(kind=kind, destination=destination, interface_prefixes=tuple(prefixes))


def _parse_route(raw: Any, context: str) -> RouteConfig:
    data = _object(raw, context)
    _only_keys(
        data,
        {
            "name",
            "url",
            "url_env",
            "provisioned",
            "trusted_overlay_http",
            "health",
            "breaker",
            "tunnel",
            "network_gate",
        },
        context,
    )
    name = _name(data.get("name"), f"{context}.name")
    url = data.get("url")
    url_env = _env_name(data.get("url_env"), f"{context}.url_env", optional=True)
    if (url is None) == (url_env is None):
        raise ConfigError(f"{context} must set exactly one of url or url_env")
    if url is not None and not isinstance(url, str):
        raise ConfigError(f"{context}.url must be a string")
    trusted_overlay_http = data.get("trusted_overlay_http", False)
    provisioned = data.get("provisioned", False)
    if not isinstance(trusted_overlay_http, bool) or not isinstance(provisioned, bool):
        raise ConfigError(f"{context} provisioned/trusted_overlay_http must be boolean")
    if url is not None:
        _validate_upstream_url(url, trusted_overlay_http, name)
    health = _parse_health(data.get("health"), f"{context}.health")
    breaker = _parse_breaker(data.get("breaker"), f"{context}.breaker")
    tunnel = _parse_tunnel(data.get("tunnel"), f"{context}.tunnel", provisioned)
    gate = _parse_network_gate(data.get("network_gate"), f"{context}.network_gate")
    return RouteConfig(
        name=name,
        url=url,
        url_env=url_env,
        provisioned=provisioned,
        trusted_overlay_http=trusted_overlay_http,
        health=health,
        breaker=breaker,
        tunnel=tunnel,
        network_gate=gate,
    )


def _parse_listener(raw: Any, context: str) -> ListenerConfig:
    data = _object(raw, context)
    _only_keys(
        data,
        {
            "name",
            "host",
            "port",
            "protocol",
            "max_body_bytes",
            "max_idempotent_attempts",
            "session_ttl_seconds",
            "routes",
        },
        context,
    )
    name = _name(data.get("name"), f"{context}.name")
    host = data.get("host")
    if not isinstance(host, str):
        raise ConfigError(f"{context}.host must be a string")
    _loopback(host, f"{context} listener")
    protocol = data.get("protocol")
    if protocol not in {"llm", "mcp"}:
        raise ConfigError(f"{context}.protocol must be llm or mcp")
    routes = tuple(
        _parse_route(item, f"{context}.routes[{index}]")
        for index, item in enumerate(_list(data.get("routes"), f"{context}.routes"))
    )
    if not routes:
        raise ConfigError(f"{context}.routes cannot be empty")
    names = [route.name for route in routes]
    if len(names) != len(set(names)):
        raise ConfigError(f"{context} route names must be unique")
    return ListenerConfig(
        name=name,
        host=host,
        port=_bounded_int(data.get("port"), 1, 65535, f"{context}.port"),
        protocol=protocol,
        max_body_bytes=_bounded_int(
            data.get("max_body_bytes", 1048576), 1, 16777216, f"{context}.max_body_bytes"
        ),
        max_idempotent_attempts=_bounded_int(
            data.get("max_idempotent_attempts", 2),
            1,
            8,
            f"{context}.max_idempotent_attempts",
        ),
        session_ttl_seconds=_bounded_float(
            data.get("session_ttl_seconds", 3600), 1, 86400, f"{context}.session_ttl_seconds"
        ),
        routes=routes,
    )


def parse_config(raw: Any) -> GatewayConfig:
    data = _object(raw, "config")
    _only_keys(data, {"version", "state_file", "listeners"}, "config")
    if data.get("version") != 1:
        raise ConfigError("config.version must be 1")
    state_file_raw = data.get("state_file")
    if state_file_raw is not None and (
        not isinstance(state_file_raw, str) or not state_file_raw.strip()
    ):
        raise ConfigError("config.state_file must be a non-empty path")
    listeners = tuple(
        _parse_listener(item, f"config.listeners[{index}]")
        for index, item in enumerate(_list(data.get("listeners"), "config.listeners"))
    )
    if not listeners:
        raise ConfigError("config.listeners cannot be empty")
    names = [listener.name for listener in listeners]
    binds = [(listener.host, listener.port) for listener in listeners]
    if len(names) != len(set(names)):
        raise ConfigError("listener names must be unique")
    if len(binds) != len(set(binds)):
        raise ConfigError("listener bind addresses must be unique")
    return GatewayConfig(
        version=1,
        state_file=Path(state_file_raw).expanduser() if state_file_raw else None,
        listeners=listeners,
    )


def load_config(path: Path) -> GatewayConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"cannot read config: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid config JSON at line {exc.lineno}, column {exc.colno}") from exc
    return parse_config(raw)
