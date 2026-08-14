"""Ownership-safe supervision for an optional local forwarding tunnel."""

from __future__ import annotations

import os
import re
import socket
import subprocess
from dataclasses import dataclass
from typing import Callable, Mapping

from .config import TunnelConfig


ENV_REFERENCE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


@dataclass(frozen=True)
class TunnelStatus:
    state: str
    ready: bool
    restart_count: int
    reason: str


def listener_bound(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False


class TunnelSupervisor:
    """Starts only an unbound listener and trusts only its live child process."""

    def __init__(
        self,
        config: TunnelConfig,
        *,
        env: Mapping[str, str] | None = None,
        process_factory: Callable = subprocess.Popen,
        listener_checker: Callable[[str, int], bool] = listener_bound,
    ) -> None:
        self.config = config
        self.env = dict(env if env is not None else os.environ)
        self.process_factory = process_factory
        self.listener_checker = listener_checker
        self.process = None
        self.started_at: float | None = None
        self.next_restart = 0.0
        self.restart_count = 0
        self._state = "disabled" if not config.enabled else "stopped"
        self._reason = "disabled" if not config.enabled else "not_started"
        self._observed_free_before_start = False

    @property
    def ready(self) -> bool:
        return self._state == "bound" and self.process is not None and self.process.poll() is None

    def _status(self) -> TunnelStatus:
        return TunnelStatus(self._state, self.ready, self.restart_count, self._reason)

    def _resolve_argv(self) -> tuple[str, ...] | None:
        resolved: list[str] = []
        for item in self.config.argv:
            missing = False

            def replace(match: re.Match[str]) -> str:
                nonlocal missing
                value = self.env.get(match.group(1))
                if value is None or value == "":
                    missing = True
                    return ""
                return value

            value = ENV_REFERENCE.sub(replace, item)
            if missing:
                return None
            resolved.append(value)
        return tuple(resolved)

    def _backoff(self, now: float, reason: str) -> None:
        self.restart_count += 1
        exponent = min(self.restart_count - 1, 30)
        delay = min(
            self.config.restart_base_seconds * (2**exponent),
            self.config.restart_max_seconds,
        )
        self.next_restart = now + delay
        self._state = "backoff"
        self._reason = reason
        self.process = None
        self.started_at = None
        self._observed_free_before_start = False

    def _stop_owned(self) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def tick(self, now: float) -> TunnelStatus:
        if not self.config.enabled:
            return self._status()
        if self.process is not None:
            if self.process.poll() is not None:
                self._backoff(now, "process_exited")
                return self._status()
            bound = self.listener_checker(
                self.config.listener_host, self.config.listener_port
            )
            if bound and self._observed_free_before_start:
                self._state = "bound"
                self._reason = "owned_process_bound"
                return self._status()
            if (
                self.started_at is not None
                and now - self.started_at > self.config.startup_timeout_seconds
            ):
                self._stop_owned()
                self._backoff(now, "startup_timeout")
                return self._status()
            self._state = "starting"
            self._reason = "waiting_for_listener"
            return self._status()
        if now < self.next_restart:
            self._state = "backoff"
            return self._status()
        if self.listener_checker(self.config.listener_host, self.config.listener_port):
            self._state = "conflict"
            self._reason = "preexisting_listener"
            return self._status()
        argv = self._resolve_argv()
        if argv is None:
            self._state = "configuration_unknown"
            self._reason = "tunnel_environment_missing"
            return self._status()
        self._observed_free_before_start = True
        try:
            self.process = self.process_factory(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                start_new_session=True,
                close_fds=True,
            )
        except OSError:
            self._backoff(now, "process_start_failed")
            return self._status()
        self.started_at = now
        self._state = "starting"
        self._reason = "process_started"
        return self._status()

    def shutdown(self) -> None:
        self._stop_owned()
        self.process = None
        self._state = "stopped"
        self._reason = "shutdown"
