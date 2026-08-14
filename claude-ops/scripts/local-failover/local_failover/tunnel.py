"""Ownership-safe supervision for an optional local forwarding tunnel."""

from __future__ import annotations

import os
import re
import shutil
import signal
import socket
import subprocess
import time
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


def listener_owned_by_process_group(host: str, port: int, process_group: int) -> bool:
    """Fail closed unless every listener on the port belongs to the owned process group."""

    del host  # lsof filters the port; listener_bound already checks the configured address.
    lsof = shutil.which("lsof")
    if lsof is None or process_group <= 0:
        return False
    try:
        result = subprocess.run(
            [lsof, "-nP", "-a", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, ProcessLookupError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    listener_pids = {
        int(line[1:])
        for line in result.stdout.splitlines()
        if line.startswith("p") and line[1:].isdigit()
    }
    if not listener_pids:
        return False
    try:
        return all(
            os.getpgid(listener_pid) == process_group for listener_pid in listener_pids
        )
    except (OSError, ProcessLookupError):
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
        ownership_checker: Callable[[str, int, int], bool] = (
            listener_owned_by_process_group
        ),
        process_group_getter: Callable[[int], int] = os.getpgid,
        process_group_signaler: Callable[[int, int], None] = os.killpg,
    ) -> None:
        self.config = config
        self.env = dict(env if env is not None else os.environ)
        self.process_factory = process_factory
        self.listener_checker = listener_checker
        self.ownership_checker = ownership_checker
        self.process_group_getter = process_group_getter
        self.process_group_signaler = process_group_signaler
        self.process = None
        self.process_group: int | None = None
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
        self.process_group = None
        self.started_at = None
        self._observed_free_before_start = False

    def _stop_owned(self) -> None:
        process = self.process
        process_group = self.process_group
        if process is None:
            return
        if process_group is None:
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        process.kill()
                        process.wait(timeout=1)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
            return
        if process.poll() is None:
            try:
                if self.process_group_getter(process.pid) != process_group:
                    return
            except (OSError, ProcessLookupError):
                return
        elif not (
            self.listener_checker(self.config.listener_host, self.config.listener_port)
            and self.ownership_checker(
                self.config.listener_host,
                self.config.listener_port,
                process_group,
            )
        ):
            return
        try:
            self.process_group_signaler(process_group, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            return
        try:
            process.wait(timeout=0.2)
        except (OSError, subprocess.TimeoutExpired):
            pass
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                self.process_group_signaler(process_group, 0)
            except (OSError, ProcessLookupError):
                return
            time.sleep(0.05)
        try:
            self.process_group_signaler(process_group, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            return
        try:
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def tick(self, now: float) -> TunnelStatus:
        if not self.config.enabled:
            return self._status()
        if self.process is not None:
            if self.process.poll() is not None:
                self._stop_owned()
                self._backoff(now, "process_exited")
                return self._status()
            bound = self.listener_checker(
                self.config.listener_host, self.config.listener_port
            )
            if bound and self._observed_free_before_start:
                if not self.ownership_checker(
                    self.config.listener_host,
                    self.config.listener_port,
                    self.process_group or 0,
                ):
                    self._stop_owned()
                    self._backoff(now, "listener_ownership_mismatch")
                    return self._status()
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
        self.process_group = self.process.pid
        self._state = "starting"
        self._reason = "process_started"
        return self._status()

    def shutdown(self) -> None:
        self._stop_owned()
        self.process = None
        self.process_group = None
        self._state = "stopped"
        self._reason = "shutdown"
