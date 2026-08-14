from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from local_failover.config import parse_config
from local_failover.health import (
    ProbeHTTPResponse,
    SemanticHealth,
    classify_inventory_response,
    classify_stream_response,
)
from local_failover.tunnel import TunnelSupervisor
from test_config_circuit import valid_config


class FakeTransport:
    def __init__(self, responses: list[ProbeHTTPResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def request(self, **kwargs) -> ProbeHTTPResponse:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class HealthClassificationTests(unittest.TestCase):
    def test_authenticated_inventory_requires_list_and_discards_payload(self) -> None:
        success = classify_inventory_response(200, b'{"object":"list","data":[{"id":"a"}]}', 12)
        malformed = classify_inventory_response(200, b'{"data":{}}', 12)

        self.assertEqual(success.kind, "success")
        self.assertEqual(success.reason, "inventory_ok")
        self.assertFalse(hasattr(success, "payload"))
        self.assertEqual(malformed.kind, "failure")
        self.assertEqual(malformed.reason, "inventory_shape")

    def test_rejected_health_authorization_is_unknown_not_provider_failure(self) -> None:
        for status in (400, 401, 403):
            with self.subTest(status=status):
                result = classify_inventory_response(status, b"", 4)
                self.assertEqual(result.kind, "unknown")
                self.assertEqual(result.reason, "health_configuration_rejected")

    def test_inventory_rate_limit_and_server_error_are_failures(self) -> None:
        self.assertEqual(classify_inventory_response(429, b"", 4).kind, "failure")
        self.assertEqual(classify_inventory_response(503, b"", 4).kind, "failure")

    def test_stream_requires_fast_first_event_and_bounded_cadence(self) -> None:
        response = ProbeHTTPResponse(
            status=200,
            headers={"content-type": "text/event-stream"},
            body=b"",
            events=((0.5, b"data: one\n"), (1.5, b"data: two\n")),
            latency_ms=500,
        )

        result = classify_stream_response(
            response,
            first_event_timeout_seconds=2,
            max_event_gap_seconds=2,
            max_response_bytes=1024,
        )

        self.assertEqual(result.kind, "success")
        self.assertEqual(result.reason, "stream_cadence_ok")

    def test_stream_rejects_buffering_large_gaps_and_interruption(self) -> None:
        cases = (
            (
                ProbeHTTPResponse(
                    200,
                    {"content-type": "text/event-stream"},
                    b"",
                    ((3.0, b"data: late\n"), (3.1, b"data: two\n")),
                    1,
                ),
                "stream_first_event_timeout",
            ),
            (
                ProbeHTTPResponse(
                    200,
                    {"content-type": "text/event-stream"},
                    b"",
                    ((0.1, b"data: one\n"), (4.0, b"data: two\n")),
                    1,
                ),
                "stream_event_gap",
            ),
            (
                ProbeHTTPResponse(
                    200,
                    {"content-type": "text/event-stream"},
                    b"",
                    ((0.1, b"data: one\n"),),
                    1,
                    error="stream_interrupted",
                ),
                "stream_interrupted",
            ),
        )
        for response, reason in cases:
            with self.subTest(reason=reason):
                result = classify_stream_response(response, 2, 2, 1024)
                self.assertEqual(result.kind, "failure")
                self.assertEqual(result.reason, reason)


class SemanticHealthTests(unittest.TestCase):
    def _route(self):
        return parse_config(valid_config()).listeners[0].routes[0]

    def test_missing_health_auth_or_model_is_configuration_unknown_without_io(self) -> None:
        transport = FakeTransport([])
        health = SemanticHealth(transport=transport)

        missing_auth = health.probe(self._route(), env={})
        missing_model = health.probe(
            self._route(), env={"FAILOVER_HEALTH_TOKEN": "not-a-real-token"}
        )

        self.assertEqual(missing_auth.kind, "unknown")
        self.assertEqual(missing_auth.reason, "health_auth_missing")
        self.assertEqual(missing_model.kind, "unknown")
        self.assertEqual(missing_model.reason, "health_model_missing")
        self.assertEqual(transport.calls, [])

    def test_llm_probe_requires_inventory_then_stream_and_never_returns_payload(self) -> None:
        transport = FakeTransport(
            [
                ProbeHTTPResponse(
                    200,
                    {"content-type": "application/json"},
                    b'{"data":[{"id":"private-model-name"}]}',
                    (),
                    3,
                ),
                ProbeHTTPResponse(
                    200,
                    {"content-type": "text/event-stream"},
                    b"",
                    ((0.1, b"data: first\n"), (0.2, b"data: [DONE]\n")),
                    5,
                ),
            ]
        )
        health = SemanticHealth(transport=transport)

        result = health.probe(
            self._route(),
            env={
                "FAILOVER_HEALTH_TOKEN": "not-a-real-token",
                "FAILOVER_HEALTH_MODEL": "configured-model",
            },
        )

        self.assertEqual(result.kind, "success")
        self.assertEqual(result.reason, "semantic_ok")
        self.assertNotIn("private-model-name", repr(result))
        self.assertEqual([call["method"] for call in transport.calls], ["GET", "POST"])
        self.assertEqual(
            transport.calls[0]["headers"]["Authorization"], "Bearer not-a-real-token"
        )

    def test_mcp_probe_uses_only_read_only_health_gets(self) -> None:
        raw = valid_config()
        route_raw = raw["listeners"][0]["routes"][0]
        route_raw["health"] = {
            "kind": "mcp",
            "mcp_health_path": "/servers/example/healthz",
        }
        route = parse_config(raw).listeners[0].routes[0]
        transport = FakeTransport(
            [
                ProbeHTTPResponse(
                    200,
                    {"content-type": "application/json"},
                    b'{"status":"ready"}',
                    (),
                    2,
                ),
                ProbeHTTPResponse(
                    200,
                    {"content-type": "application/json"},
                    b'{"status":"ready"}',
                    (),
                    2,
                ),
            ]
        )

        health = SemanticHealth(transport=transport)
        first = health.probe(route, env={})
        second = health.probe(route, env={})

        self.assertEqual(first.kind, "success")
        self.assertEqual(first.reason, "mcp_health_ok")
        self.assertEqual(second.kind, "success")
        self.assertEqual([call["method"] for call in transport.calls], ["GET", "GET"])
        self.assertTrue(all(call["body"] is None for call in transport.calls))

    def test_mcp_probe_rejects_nonsemantic_success_body(self) -> None:
        raw = valid_config()
        route_raw = raw["listeners"][0]["routes"][0]
        route_raw["health"] = {"kind": "mcp", "mcp_health_path": "/healthz"}
        route = parse_config(raw).listeners[0].routes[0]
        transport = FakeTransport(
            [ProbeHTTPResponse(200, {"content-type": "text/plain"}, b"welcome", (), 2)]
        )

        result = SemanticHealth(transport=transport).probe(route, env={})

        self.assertEqual(result.kind, "failure")
        self.assertEqual(result.reason, "mcp_health_shape")


class FakeProcess:
    def __init__(self) -> None:
        self.pid = 12345
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def wait(self, timeout=None):
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class FakeProcessFactory:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], dict]] = []
        self.processes: list[FakeProcess] = []

    def __call__(self, argv, **kwargs):
        process = FakeProcess()
        self.calls.append((tuple(argv), kwargs))
        self.processes.append(process)
        return process


def enabled_tunnel_config():
    raw = valid_config()
    route = raw["listeners"][0]["routes"][2]
    route["provisioned"] = True
    route["tunnel"].update(
        {
            "enabled": True,
            "argv": ["tunnel-command", "--target", "${TUNNEL_TARGET}"],
            "startup_timeout_seconds": 10,
            "restart_base_seconds": 5,
            "restart_max_seconds": 20,
        }
    )
    return parse_config(raw).listeners[0].routes[2].tunnel


class TunnelSupervisorTests(unittest.TestCase):
    def test_will_not_adopt_preexisting_listener(self) -> None:
        factory = FakeProcessFactory()
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: True,
        )

        status = supervisor.tick(0)

        self.assertEqual(status.state, "conflict")
        self.assertEqual(factory.calls, [])

    def test_requires_owned_live_process_and_newly_bound_port(self) -> None:
        factory = FakeProcessFactory()
        bound = {"value": False}
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: bound["value"],
            ownership_checker=lambda *_: bound["value"],
        )

        self.assertEqual(supervisor.tick(0).state, "starting")
        self.assertFalse(supervisor.ready)
        bound["value"] = True
        self.assertEqual(supervisor.tick(1).state, "bound")
        self.assertTrue(supervisor.ready)
        self.assertFalse(factory.calls[0][1]["shell"])
        self.assertTrue(factory.calls[0][1]["start_new_session"])

    def test_process_exit_removes_readiness_and_restarts_with_backoff(self) -> None:
        factory = FakeProcessFactory()
        bound = {"value": False}
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: bound["value"],
            ownership_checker=lambda *_: bound["value"],
        )
        supervisor.tick(0)
        bound["value"] = True
        self.assertTrue(supervisor.tick(1).ready)
        bound["value"] = False
        factory.processes[0].returncode = 1

        self.assertEqual(supervisor.tick(2).state, "backoff")
        self.assertFalse(supervisor.tick(6).ready)
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(supervisor.tick(7).state, "starting")
        self.assertEqual(len(factory.calls), 2)

    def test_bind_race_never_adopts_listener_owned_by_another_process(self) -> None:
        factory = FakeProcessFactory()
        bound = {"value": False}
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: bound["value"],
            ownership_checker=lambda *_: False,
        )
        self.assertEqual(supervisor.tick(0).state, "starting")
        bound["value"] = True

        status = supervisor.tick(1)

        self.assertEqual(status.state, "backoff")
        self.assertEqual(status.reason, "listener_ownership_mismatch")
        self.assertFalse(status.ready)
        self.assertTrue(factory.processes[0].terminated)

    def test_listener_replacement_revokes_tunnel_readiness(self) -> None:
        factory = FakeProcessFactory()
        bound = {"value": False}
        owned = {"value": True}
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: bound["value"],
            ownership_checker=lambda *_: owned["value"],
        )
        supervisor.tick(0)
        bound["value"] = True
        self.assertTrue(supervisor.tick(1).ready)
        owned["value"] = False

        status = supervisor.tick(2)

        self.assertEqual(status.state, "backoff")
        self.assertEqual(status.reason, "listener_ownership_mismatch")
        self.assertFalse(status.ready)
        self.assertTrue(factory.processes[0].terminated)

    def test_missing_argv_environment_is_unknown_without_starting(self) -> None:
        factory = FakeProcessFactory()
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={},
            process_factory=factory,
            listener_checker=lambda *_: False,
        )

        self.assertEqual(supervisor.tick(0).state, "configuration_unknown")
        self.assertEqual(factory.calls, [])

    def test_startup_timeout_terminates_only_owned_process(self) -> None:
        factory = FakeProcessFactory()
        supervisor = TunnelSupervisor(
            enabled_tunnel_config(),
            env={"TUNNEL_TARGET": "target-placeholder"},
            process_factory=factory,
            listener_checker=lambda *_: False,
        )
        supervisor.tick(0)

        status = supervisor.tick(11)

        self.assertEqual(status.state, "backoff")
        self.assertTrue(factory.processes[0].terminated)
        self.assertFalse(status.ready)


if __name__ == "__main__":
    unittest.main()
