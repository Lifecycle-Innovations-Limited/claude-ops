"""Circuit breaker and fixed-order route selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .config import BreakerPolicy, RouteConfig


class CircuitBreaker:
    """Health-driven breaker with recovery hysteresis and capped backoff."""

    def __init__(self, policy: BreakerPolicy, now: float) -> None:
        self.policy = policy
        self.state = "unknown"
        self.reason = "not_checked"
        self.consecutive_failures = 0
        self.consecutive_successes = 0
        self.open_count = 0
        self.open_until = 0.0
        self.healthy_since: float | None = None
        self.last_success: float | None = None
        self.last_failure: float | None = None
        self.last_transition = now

    def _transition(self, state: str, now: float) -> None:
        if self.state != state:
            self.state = state
            self.last_transition = now

    def _open(self, now: float, reason: str) -> None:
        self.open_count += 1
        exponent = min(self.open_count - 1, 30)
        backoff = min(
            self.policy.base_backoff_seconds * (2**exponent),
            self.policy.max_backoff_seconds,
        )
        self.open_until = now + backoff
        self.healthy_since = None
        self.consecutive_successes = 0
        self.reason = reason
        self._transition("open", now)

    def observe_success(self, now: float, reason: str) -> None:
        if self.state == "open" and now < self.open_until:
            return
        if self.state in {"unknown", "open"}:
            self._transition("half_open", now)
            self.consecutive_successes = 0
            self.healthy_since = None
        self.consecutive_failures = 0
        self.consecutive_successes += 1
        self.last_success = now
        self.reason = reason
        if self.consecutive_successes >= self.policy.recovery_successes:
            if self.healthy_since is None:
                self.healthy_since = now
            self._transition("closed", now)

    def observe_failure(self, now: float, reason: str) -> None:
        self.last_failure = now
        self.reason = reason
        self.consecutive_successes = 0
        self.healthy_since = None
        if self.state in {"half_open", "open", "unknown"}:
            self.consecutive_failures += 1
            if self.state == "half_open" or self.consecutive_failures >= self.policy.failure_threshold:
                self._open(now, reason)
            return
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.policy.failure_threshold:
            self._open(now, reason)

    def observe_unknown(self, now: float, reason: str) -> None:
        self.reason = reason
        if self.state == "unknown":
            self.last_transition = now

    def available(self, now: float) -> bool:
        if self.state != "closed" or self.healthy_since is None or self.last_success is None:
            return False
        if now - self.last_success > self.policy.max_stale_seconds:
            return False
        return now - self.healthy_since >= self.policy.failback_hold_seconds

    def snapshot(self, now: float) -> dict[str, object]:
        return {
            "state": self.state,
            "reason": self.reason,
            "available": self.available(now),
            "consecutive_failures": self.consecutive_failures,
            "consecutive_successes": self.consecutive_successes,
            "open_until_monotonic": self.open_until if self.state == "open" else None,
            "last_transition_monotonic": self.last_transition,
        }


@dataclass
class RouteRuntime:
    config: RouteConfig
    breaker: CircuitBreaker
    gate_ready: bool = True
    gate_reason: str = "ready"
    requests: int = 0
    failures: int = 0
    bytes_to_client: int = 0

    def available(self, now: float) -> bool:
        return self.config.provisioned and self.gate_ready and self.breaker.available(now)

    def snapshot(self, now: float) -> dict[str, object]:
        return {
            "name": self.config.name,
            "provisioned": self.config.provisioned,
            "gate_ready": self.gate_ready,
            "gate_reason": self.gate_reason,
            "circuit": self.breaker.snapshot(now),
            "requests": self.requests,
            "failures": self.failures,
            "bytes_to_client": self.bytes_to_client,
        }


class RouteSelector:
    """Selects the first available route and preserves MCP session affinity."""

    def __init__(self, routes: Iterable[RouteRuntime]) -> None:
        self.routes = tuple(routes)
        self.by_name = {route.config.name: route for route in self.routes}
        self.active_route: str | None = None

    def choose(
        self, session_route: str | None, now: float, excluded: set[str] | None = None
    ) -> RouteRuntime | None:
        excluded = excluded or set()
        if session_route:
            route = self.by_name.get(session_route)
            if route and route.config.name not in excluded and route.available(now):
                return route
            return None
        for route in self.routes:
            if route.config.name in excluded:
                continue
            if route.available(now):
                self.active_route = route.config.name
                return route
        self.active_route = None
        return None

    def snapshot(self) -> dict[str, object]:
        return {"active_route": self.active_route}
