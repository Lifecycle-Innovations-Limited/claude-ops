"""Command-line entry point for the local failover gateway."""

from __future__ import annotations

import argparse
import http.client
import json
import signal
import sys
import threading
from collections.abc import Sequence
from pathlib import Path

from .config import ConfigError, GatewayConfig, load_config
from .proxy import GatewayService


def check_summary(config: GatewayConfig) -> dict[str, object]:
    return {
        "valid": True,
        "listeners": [
            {
                "name": listener.name,
                "protocol": listener.protocol,
                "bind": f"{listener.host}:{listener.port}",
                "route_order": [route.name for route in listener.routes],
            }
            for listener in config.listeners
        ],
    }


def local_status(config: GatewayConfig) -> dict[str, object]:
    listeners: list[dict[str, object]] = []
    for listener in config.listeners:
        connection = http.client.HTTPConnection(
            listener.host,
            listener.port,
            timeout=min(listener.connect_timeout_seconds, 2),
        )
        try:
            connection.request("GET", "/_failover/status", headers={"Connection": "close"})
            response = connection.getresponse()
            body = response.read(1048577)
            if response.status != 200 or len(body) > 1048576:
                raise ValueError("invalid status response")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("invalid status payload")
            listeners.append({"name": listener.name, "state": "online", "status": payload})
        except (OSError, http.client.HTTPException, UnicodeError, json.JSONDecodeError, ValueError):
            listeners.append({"name": listener.name, "state": "unavailable"})
        finally:
            connection.close()
    return {"listeners": listeners}


def run(config: GatewayConfig) -> int:
    service = GatewayService(config)
    stopped = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stopped.set()

    previous = {
        signum: signal.signal(signum, request_stop)
        for signum in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        service.start(run_health=True)
        stopped.wait()
    finally:
        service.shutdown()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "check", "status"):
        command = subcommands.add_parser(name)
        command.add_argument("--config", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    if args.command == "check":
        print(json.dumps(check_summary(config), sort_keys=True, separators=(",", ":")))
        return 0
    if args.command == "status":
        print(json.dumps(local_status(config), sort_keys=True, separators=(",", ":")))
        return 0
    return run(config)


if __name__ == "__main__":
    raise SystemExit(main())
