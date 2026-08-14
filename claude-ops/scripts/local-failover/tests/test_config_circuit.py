from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from local_failover.circuit import CircuitBreaker, RouteRuntime, RouteSelector
from local_failover.config import ConfigError, parse_config


def valid_config() -> dict:
    return {
        "version": 1,
        "state_file": "~/.local/state/local-failover/status.json",
        "listeners": [
            {
                "name": "cli",
                "host": "127.0.0.1",
                "port": 18316,
                "protocol": "llm",
                "max_body_bytes": 1048576,
                "max_idempotent_attempts": 2,
                "session_ttl_seconds": 3600,
                "routes": [
                    {
                        "name": "cloud-primary",
                        "url": "https://gateway.example.com",
                        "provisioned": True,
                        "health": {
                            "kind": "llm",
                            "auth_env": "FAILOVER_HEALTH_TOKEN",
                            "inventory_path": "/v1/models",
                            "stream_path": "/v1/chat/completions",
                            "stream_model_env": "FAILOVER_HEALTH_MODEL",
                        },
                    },
                    {
                        "name": "overlay-secondary",
                        "url": "http://100.64.0.10:8317",
                        "trusted_overlay_http": True,
                        "provisioned": True,
                        "health": {
                            "kind": "llm",
                            "auth_env": "FAILOVER_HEALTH_TOKEN",
                            "inventory_path": "/v1/models",
                            "stream_path": "/v1/chat/completions",
                            "stream_model_env": "FAILOVER_HEALTH_MODEL",
                        },
                    },
                    {
                        "name": "tunnel-tertiary",
                        "url": "http://127.0.0.1:18317",
                        "provisioned": False,
                        "health": {
                            "kind": "llm",
                            "auth_env": "FAILOVER_HEALTH_TOKEN",
                            "inventory_path": "/v1/models",
                            "stream_path": "/v1/chat/completions",
                            "stream_model_env": "FAILOVER_HEALTH_MODEL",
                        },
                        "tunnel": {
                            "enabled": False,
                            "argv": ["aws", "ssm", "start-session"],
                            "listener_host": "127.0.0.1",
                            "listener_port": 18317,
                        },
                    },
                ],
            }
        ],
    }


class ConfigTests(unittest.TestCase):
    def test_parses_and_preserves_route_order(self) -> None:
        parsed = parse_config(valid_config())

        self.assertEqual(parsed.version, 1)
        self.assertEqual(parsed.listeners[0].host, "127.0.0.1")
        self.assertEqual(
            [route.name for route in parsed.listeners[0].routes],
            ["cloud-primary", "overlay-secondary", "tunnel-tertiary"],
        )

    def test_listener_rejects_non_loopback_bind(self) -> None:
        raw = valid_config()
        raw["listeners"][0]["host"] = "0.0.0.0"

        with self.assertRaisesRegex(ConfigError, "loopback"):
            parse_config(raw)

    def test_cleartext_non_loopback_requires_explicit_overlay_trust(self) -> None:
        raw = valid_config()
        raw["listeners"][0]["routes"][1].pop("trusted_overlay_http")

        with self.assertRaisesRegex(ConfigError, "trusted_overlay_http"):
            parse_config(raw)

    def test_upstream_url_rejects_credentials_query_and_fragment(self) -> None:
        for url in (
            "https://user:pass@gateway.example.com",
            "https://gateway.example.com?token=hidden",
            "https://gateway.example.com/#fragment",
        ):
            with self.subTest(url=url):
                raw = valid_config()
                raw["listeners"][0]["routes"][0]["url"] = url
                with self.assertRaises(ConfigError):
                    parse_config(raw)

    def test_route_can_resolve_url_from_environment_without_storing_value(self) -> None:
        raw = valid_config()
        route = raw["listeners"][0]["routes"][0]
        route.pop("url")
        route["url_env"] = "FAILOVER_PRIMARY_URL"
        parsed = parse_config(raw)

        self.assertEqual(
            parsed.listeners[0].routes[0].resolve_url(
                {"FAILOVER_PRIMARY_URL": "https://gateway.example.com"}
            ),
            "https://gateway.example.com",
        )
        with self.assertRaisesRegex(ConfigError, "FAILOVER_PRIMARY_URL"):
            parsed.listeners[0].routes[0].resolve_url({})

    def test_rejects_duplicate_route_names_and_invalid_environment_names(self) -> None:
        duplicate = valid_config()
        duplicate["listeners"][0]["routes"][1]["name"] = "cloud-primary"
        with self.assertRaisesRegex(ConfigError, "unique"):
            parse_config(duplicate)

        invalid_env = valid_config()
        invalid_env["listeners"][0]["routes"][0]["health"]["auth_env"] = "BAD-NAME"
        with self.assertRaisesRegex(ConfigError, "environment"):
            parse_config(invalid_env)

    def test_enabled_tunnel_must_be_loopback_and_provisioned(self) -> None:
        raw = valid_config()
        tunnel_route = raw["listeners"][0]["routes"][2]
        tunnel_route["provisioned"] = True
        tunnel_route["tunnel"]["enabled"] = True
        tunnel_route["tunnel"]["listener_host"] = "100.64.0.10"

        with self.assertRaisesRegex(ConfigError, "tunnel listener"):
            parse_config(raw)


class CircuitTests(unittest.TestCase):
    def setUp(self) -> None:
        config = parse_config(valid_config())
        self.policy = config.listeners[0].routes[0].breaker

    def test_starts_unknown_and_requires_stable_successes(self) -> None:
        breaker = CircuitBreaker(self.policy, now=0)

        self.assertFalse(breaker.available(0))
        breaker.observe_success(1, "semantic_ok")
        breaker.observe_success(2, "semantic_ok")
        self.assertFalse(breaker.available(2))
        breaker.observe_success(3, "semantic_ok")
        self.assertEqual(breaker.state, "closed")
        self.assertFalse(breaker.available(7))
        self.assertTrue(breaker.available(8))

    def test_failure_threshold_opens_with_capped_exponential_backoff(self) -> None:
        breaker = CircuitBreaker(self.policy, now=0)
        for timestamp in (1, 2, 3):
            breaker.observe_success(timestamp, "semantic_ok")
        breaker.observe_failure(8, "connect")
        self.assertEqual(breaker.state, "closed")
        breaker.observe_failure(9, "connect")
        self.assertEqual(breaker.state, "open")
        first_until = breaker.open_until

        breaker.observe_success(first_until, "semantic_ok")
        breaker.observe_failure(first_until + 1, "connect")
        self.assertEqual(breaker.state, "open")
        self.assertGreater(breaker.open_until, first_until + self.policy.base_backoff_seconds)
        self.assertLessEqual(
            breaker.open_until - (first_until + 1), self.policy.max_backoff_seconds
        )

    def test_unknown_probe_does_not_count_as_provider_failure_but_stales(self) -> None:
        breaker = CircuitBreaker(self.policy, now=0)
        for timestamp in (1, 2, 3):
            breaker.observe_success(timestamp, "semantic_ok")
        self.assertTrue(breaker.available(8))

        breaker.observe_unknown(9, "health_auth_rejected")
        self.assertEqual(breaker.state, "closed")
        self.assertEqual(breaker.consecutive_failures, 0)
        self.assertFalse(breaker.available(3 + self.policy.max_stale_seconds + 1))

    def test_recovery_failure_reopens_immediately(self) -> None:
        breaker = CircuitBreaker(self.policy, now=0)
        breaker.observe_failure(1, "connect")
        breaker.observe_failure(2, "connect")
        breaker.observe_success(breaker.open_until, "semantic_ok")
        self.assertEqual(breaker.state, "half_open")

        breaker.observe_failure(breaker.open_until + 1, "connect")

        self.assertEqual(breaker.state, "open")


class SelectorTests(unittest.TestCase):
    def _runtime(self, route, successes=(1, 2, 3), gate_ready=True) -> RouteRuntime:
        runtime = RouteRuntime(route, CircuitBreaker(route.breaker, now=0))
        runtime.gate_ready = gate_ready
        for timestamp in successes:
            runtime.breaker.observe_success(timestamp, "semantic_ok")
        return runtime

    def test_uses_fixed_order_and_skips_unprovisioned_or_unready_routes(self) -> None:
        listener = parse_config(valid_config()).listeners[0]
        primary = self._runtime(listener.routes[0], gate_ready=False)
        secondary = self._runtime(listener.routes[1])
        tertiary = self._runtime(listener.routes[2])
        selector = RouteSelector([primary, secondary, tertiary])

        selected = selector.choose(None, now=8)

        self.assertEqual(selected.config.name, "overlay-secondary")

    def test_failback_waits_for_primary_stability_and_resists_flapping(self) -> None:
        listener = parse_config(valid_config()).listeners[0]
        primary = RouteRuntime(listener.routes[0], CircuitBreaker(listener.routes[0].breaker, 0))
        secondary = self._runtime(listener.routes[1])
        selector = RouteSelector([primary, secondary])
        self.assertEqual(selector.choose(None, 8).config.name, "overlay-secondary")

        for timestamp in (9, 10, 11):
            primary.breaker.observe_success(timestamp, "semantic_ok")
        self.assertEqual(selector.choose(None, 15).config.name, "overlay-secondary")
        primary.breaker.observe_failure(15, "stream")
        primary.breaker.observe_failure(16, "stream")
        self.assertEqual(selector.choose(None, 16).config.name, "overlay-secondary")

    def test_session_route_never_migrates(self) -> None:
        listener = parse_config(valid_config()).listeners[0]
        primary = self._runtime(listener.routes[0], gate_ready=False)
        secondary = self._runtime(listener.routes[1])
        selector = RouteSelector([primary, secondary])

        self.assertIsNone(selector.choose("cloud-primary", now=8))
        self.assertEqual(selector.choose(None, now=8).config.name, "overlay-secondary")


if __name__ == "__main__":
    unittest.main()
