#!/usr/bin/env python3
"""desktop-act stdio CLI — call the MCP server without an MCP host.

Use this from shell scripts, CI, or other agents when you need
status / acquire / screenshot / act / release over JSON-RPC stdio.

Path resolution (first match wins):

  1. ``DESKTOP_ACT_COMMAND`` — executable that starts the server (e.g. run.sh)
  2. ``DESKTOP_ACT_HOME`` — install root; uses ``$DESKTOP_ACT_HOME/mcp-server/run.sh``
     or ``server.py`` with ``$DESKTOP_ACT_VENV/bin/python``
  3. This repo checkout — ``<repo>/mcp-server/run.sh`` next to this file
  4. ``$XDG_CACHE_HOME/desktop-act-mcp/src`` (Linux) or
     ``~/Library/Caches/desktop-act-mcp/src`` (macOS)

No host-specific paths are hard-coded. Override with env vars as needed.

Examples::

  desktop-act status
  desktop-act acquire
  desktop-act screenshot --session-id SID
  desktop-act act --goal "Open a browser and go to example.com"
  desktop-act run --goal "Take a screenshot of the desktop"
  desktop-act call list_windows --arg session_id=SID
  desktop-act release --session-id SID
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ─── discovery ───────────────────────────────────────────────────────────────


def _cache_src() -> Path:
    system = platform.system().lower()
    if system == "darwin":
        return Path.home() / "Library" / "Caches" / "desktop-act-mcp" / "src"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "desktop-act-mcp" / "src"


def _repo_root() -> Path:
    """cli/ lives one level under the repo root."""
    return Path(__file__).resolve().parent.parent


def resolve_server_cmd() -> list[str]:
    """Return argv that launches the desktop-act MCP server on stdio."""
    # 1. Explicit command (may be a multi-word string)
    explicit = (os.environ.get("DESKTOP_ACT_COMMAND") or "").strip()
    if explicit:
        # Allow "python /path/server.py" or a single run.sh path
        parts = explicit.split()
        if len(parts) == 1 and Path(parts[0]).is_file():
            return parts
        if len(parts) >= 2:
            return parts
        if Path(parts[0]).exists():
            return parts

    candidates: list[Path] = []
    home = (os.environ.get("DESKTOP_ACT_HOME") or "").strip()
    if home:
        candidates.append(Path(home))
    candidates.append(_repo_root())
    candidates.append(_cache_src())

    venv = (os.environ.get("DESKTOP_ACT_VENV") or "").strip()
    py_override = (os.environ.get("DESKTOP_ACT_PYTHON") or "").strip()

    for root in candidates:
        if not root.is_dir():
            continue
        run_sh = root / "mcp-server" / "run.sh"
        server_py = root / "mcp-server" / "server.py"
        if run_sh.is_file() and os.access(run_sh, os.X_OK):
            return [str(run_sh)]
        if server_py.is_file():
            venv_root = Path(venv) if venv else root / ".venv"
            py = Path(py_override) if py_override else venv_root / "bin" / "python"
            if not py.is_file():
                py = Path(py_override or sys.executable)
            return [str(py), str(server_py)]

    raise FileNotFoundError(
        "desktop-act server not found. Set DESKTOP_ACT_HOME or DESKTOP_ACT_COMMAND, "
        "or run this CLI from a full checkout (mcp-server/run.sh present)."
    )


# ─── MCP client ──────────────────────────────────────────────────────────────


class McpClient:
    """Minimal JSON-RPC-over-stdio MCP client (initialize + tools/call)."""

    def __init__(self, cmd: list[str], env: dict[str, str] | None = None, timeout: float = 120.0):
        self.timeout = timeout
        merged = os.environ.copy()
        if env:
            merged.update(env)
        # Inherit stderr so server INFO logs do not fill a PIPE and deadlock act/run.
        # stdout stays piped for JSON-RPC; stderr is diagnostic only.
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            env=merged,
            bufsize=1,
        )
        self._id = 0

    def _send(self, method: str, params: dict | None = None, *, notify: bool = False) -> Any:
        self._id += 1
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if not notify:
            msg["id"] = self._id
        if params is not None:
            msg["params"] = params
        if not self.proc.stdin or not self.proc.stdout:
            raise RuntimeError("MCP process has no stdio")
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        if notify:
            return None
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                rc = self.proc.poll()
                raise RuntimeError(
                    f"MCP EOF while waiting for {method}"
                    + (f" (exit {rc})" if rc is not None else "")
                )
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") != self._id:
                continue
            if "error" in obj:
                raise RuntimeError(json.dumps(obj["error"])[:500])
            return obj.get("result")
        raise TimeoutError(f"timeout waiting for {method}")

    def initialize(self) -> None:
        self._send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "desktop-act-cli", "version": "1.0.0"},
            },
        )
        self._send("notifications/initialized", notify=True)

    def call_tool(self, name: str, arguments: dict | None = None) -> Any:
        return self._send("tools/call", {"name": name, "arguments": arguments or {}})

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception:
            pass


def unwrap_tool_result(result: Any) -> Any:
    """Normalize FastMCP / MCP tool result envelopes to a plain value."""
    if not isinstance(result, dict):
        return result
    if "structuredContent" in result and result["structuredContent"] is not None:
        return result["structuredContent"]
    content = result.get("content")
    if isinstance(content, list) and content:
        texts = [
            c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        ]
        joined = "\n".join(t for t in texts if t)
        if joined.strip().startswith("{") or joined.strip().startswith("["):
            try:
                return json.loads(joined)
            except json.JSONDecodeError:
                pass
        if joined:
            return {"text": joined}
    # already a plain dict from some servers
    if "ok" in result or "session_id" in result or "error" in result:
        return result
    return result


def emit(data: Any) -> None:
    if isinstance(data, (dict, list)):
        print(json.dumps(data, indent=2, default=str))
    else:
        print(data)


# ─── commands ────────────────────────────────────────────────────────────────


def _client_from_args(args: argparse.Namespace) -> McpClient:
    cmd = resolve_server_cmd()
    env: dict[str, str] = {}
    if getattr(args, "display", None):
        env["DISPLAY"] = args.display
        env.setdefault("DESKTOP_ACT_DISPLAY", args.display)
    # CLI is short-lived; do not free pool desktops when the stdio server exits.
    # Long-lived MCP hosts keep default RELEASE_ON_EXIT=1.
    env.setdefault("DESKTOP_ACT_RELEASE_ON_EXIT", "0")
    if getattr(args, "owner_id", None):
        env.setdefault("DESKTOP_ACT_OWNER", args.owner_id)
    if getattr(args, "geometry", None):
        env.setdefault("DESKTOP_ACT_GEOMETRY", args.geometry)
    timeout = float(getattr(args, "rpc_timeout", 120) or 120)
    client = McpClient(cmd, env=env or None, timeout=timeout)
    try:
        client.initialize()
    except Exception:
        client.close()
        raise
    return client


def cmd_status(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        emit(unwrap_tool_result(client.call_tool("status", {})))
        return 0
    finally:
        client.close()


def cmd_list(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        emit(unwrap_tool_result(client.call_tool("list_desktops", {})))
        return 0
    finally:
        client.close()


def cmd_acquire(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        params: dict[str, Any] = {}
        if getattr(args, "geometry", None):
            params["geometry"] = args.geometry
        if getattr(args, "owner_id", None):
            params["owner_id"] = args.owner_id
        if getattr(args, "force_new", False):
            params["force_new"] = True
        out = unwrap_tool_result(client.call_tool("acquire_desktop", params))
        emit(out)
        return 0
    finally:
        client.close()


def cmd_ensure(args: argparse.Namespace) -> int:
    """Multi-agent entry: reuse own lease or auto-spawn if busy."""
    client = _client_from_args(args)
    try:
        params: dict[str, Any] = {}
        if getattr(args, "geometry", None):
            params["geometry"] = args.geometry
        if getattr(args, "owner_id", None):
            params["owner_id"] = args.owner_id
        out = unwrap_tool_result(client.call_tool("ensure_desktop", params))
        emit(out)
        return 0 if not (isinstance(out, dict) and out.get("ok") is False) else 1
    finally:
        client.close()


def cmd_heartbeat(args: argparse.Namespace) -> int:
    if not args.session_id:
        print("error: --session-id required", file=sys.stderr)
        return 2
    client = _client_from_args(args)
    try:
        params: dict[str, Any] = {"session_id": args.session_id}
        if getattr(args, "owner_id", None):
            params["owner_id"] = args.owner_id
        out = unwrap_tool_result(client.call_tool("heartbeat_desktop", params))
        emit(out)
        return 0 if not (isinstance(out, dict) and out.get("ok") is False) else 1
    finally:
        client.close()


def cmd_reap(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        out = unwrap_tool_result(client.call_tool("reap_idle_desktops", {}))
        emit(out)
        return 0
    finally:
        client.close()


def cmd_release(args: argparse.Namespace) -> int:
    if not args.session_id:
        print("error: --session-id required", file=sys.stderr)
        return 2
    client = _client_from_args(args)
    try:
        emit(
            unwrap_tool_result(client.call_tool("release_desktop", {"session_id": args.session_id}))
        )
        return 0
    finally:
        client.close()


def cmd_screenshot(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        params: dict[str, Any] = {}
        if args.session_id:
            params["session_id"] = args.session_id
        if args.fmt:
            params["fmt"] = args.fmt
        emit(unwrap_tool_result(client.call_tool("screenshot", params)))
        return 0
    finally:
        client.close()


def cmd_observe(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    try:
        params: dict[str, Any] = {}
        if args.session_id:
            params["session_id"] = args.session_id
        emit(unwrap_tool_result(client.call_tool("observe", params)))
        return 0
    finally:
        client.close()


def cmd_act(args: argparse.Namespace) -> int:
    if not args.goal:
        print("error: --goal required", file=sys.stderr)
        return 2
    client = _client_from_args(args)
    # act() can run for a long time — raise RPC wait
    client.timeout = float(args.timeout) + 30
    try:
        params: dict[str, Any] = {
            "goal": args.goal,
            "max_iterations": args.max_iterations,
            "timeout_seconds": args.timeout,
        }
        if args.session_id:
            params["session_id"] = args.session_id
        if args.model:
            params["model"] = args.model
        result = unwrap_tool_result(client.call_tool("act", params))
        emit(result)
        if isinstance(result, dict) and result.get("ok") is False:
            return 1
        return 0
    finally:
        client.close()


def cmd_run(args: argparse.Namespace) -> int:
    """Acquire -> act(goal) -> release. Exit 0 only if act reports ok."""
    if not args.goal:
        print("error: --goal required", file=sys.stderr)
        return 2
    client = _client_from_args(args)
    client.timeout = float(args.timeout) + 30
    session_id = args.session_id or ""
    acquired = False
    try:
        if not session_id:
            acq_params: dict[str, Any] = {}
            if getattr(args, "owner_id", None):
                acq_params["owner_id"] = args.owner_id
            if getattr(args, "geometry", None):
                acq_params["geometry"] = args.geometry
            acq = unwrap_tool_result(client.call_tool("ensure_desktop", acq_params))
            emit({"phase": "ensure", "result": acq})
            if isinstance(acq, dict):
                session_id = acq.get("session_id") or acq.get("id") or ""
            acquired = bool(session_id)

        try:
            shot = unwrap_tool_result(
                client.call_tool("screenshot", {"session_id": session_id} if session_id else {})
            )
            emit({"phase": "screenshot", "result": shot})
        except Exception as exc:  # noqa: BLE001
            emit({"phase": "screenshot", "warn": str(exc)})

        params: dict[str, Any] = {
            "goal": args.goal,
            "max_iterations": args.max_iterations,
            "timeout_seconds": args.timeout,
        }
        if session_id:
            params["session_id"] = session_id
        if args.model:
            params["model"] = args.model
        result = unwrap_tool_result(client.call_tool("act", params))
        emit({"phase": "act", "result": result})
        ok = True
        if isinstance(result, dict):
            if result.get("ok") is False:
                ok = False
            elif result.get("error") and not result.get("ok"):
                ok = False
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 2
    finally:
        if acquired and session_id:
            try:
                client.call_tool("release_desktop", {"session_id": session_id})
            except Exception:
                pass
        client.close()


def cmd_call(args: argparse.Namespace) -> int:
    """Raw tools/call for any server tool."""
    tool_args: dict[str, Any] = {}
    for item in args.arg or []:
        if "=" not in item:
            print(f"error: --arg expects key=value, got {item!r}", file=sys.stderr)
            return 2
        key, raw = item.split("=", 1)
        # try JSON coerce
        try:
            tool_args[key] = json.loads(raw)
        except json.JSONDecodeError:
            tool_args[key] = raw
    client = _client_from_args(args)
    client.timeout = float(getattr(args, "timeout", 120) or 120)
    try:
        emit(unwrap_tool_result(client.call_tool(args.tool, tool_args)))
        return 0
    finally:
        client.close()


def cmd_which(args: argparse.Namespace) -> int:
    """Print resolved server command (debug / smoke)."""
    try:
        cmd = resolve_server_cmd()
        emit({"ok": True, "command": cmd})
        return 0
    except FileNotFoundError as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


# ─── argparse ────────────────────────────────────────────────────────────────


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--display",
        default=os.environ.get("DISPLAY") or os.environ.get("DESKTOP_ACT_DISPLAY") or None,
        help="X11 DISPLAY to pass through (Linux). Default: $DISPLAY or $DESKTOP_ACT_DISPLAY",
    )
    p.add_argument(
        "--rpc-timeout",
        type=float,
        default=float(os.environ.get("DESKTOP_ACT_RPC_TIMEOUT", "120")),
        help="Seconds to wait for a single MCP response (default 120)",
    )


def _add_session(p: argparse.ArgumentParser, required: bool = False) -> None:
    p.add_argument("--session-id", default="", required=required, help="Pool session id")


def _add_owner(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--owner-id",
        default=os.environ.get("DESKTOP_ACT_OWNER") or "",
        help="Exclusive lease owner (default: $DESKTOP_ACT_OWNER or process id)",
    )
    p.add_argument(
        "--geometry",
        default=os.environ.get("DESKTOP_ACT_GEOMETRY") or "",
        help="Desktop geometry e.g. 2560x1440 (default server/env)",
    )


def _add_act_opts(p: argparse.ArgumentParser) -> None:
    p.add_argument("--goal", default="", help="Natural-language goal for act()")
    p.add_argument(
        "--max-iterations",
        type=int,
        default=int(os.environ.get("DESKTOP_ACT_MAX_ITERATIONS", "20")),
        help="act() max_iterations (server param name; not max_steps)",
    )
    p.add_argument(
        "--timeout",
        type=int,
        default=int(os.environ.get("DESKTOP_ACT_ACT_TIMEOUT", "600")),
        help="act() timeout_seconds wall clock",
    )
    p.add_argument(
        "--model",
        default=os.environ.get("DESKTOP_ACT_MODEL") or "",
        help="Optional model id for act()",
    )


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="desktop-act",
        description="Call desktop-act MCP tools over stdio without an MCP host.",
    )
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("which", help="Print resolved server launch command")
    _add_common(p)
    p.set_defaults(func=cmd_which)

    p = sub.add_parser("status", help="Pool + binary inventory")
    _add_common(p)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("list", help="List pool desktops")
    _add_common(p)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser(
        "ensure",
        help="Multi-agent: reuse own lease or auto-spawn if another agent holds a desktop",
    )
    _add_common(p)
    _add_owner(p)
    p.set_defaults(func=cmd_ensure)

    p = sub.add_parser(
        "acquire", help="Acquire a desktop (ensure by default; --force-new always spawns)"
    )
    _add_common(p)
    _add_owner(p)
    p.add_argument(
        "--force-new",
        action="store_true",
        help="Always spawn a fresh exclusive desktop",
    )
    p.set_defaults(func=cmd_acquire)

    p = sub.add_parser(
        "heartbeat", help="Refresh lease TTL so idle reaper will not free the session"
    )
    _add_common(p)
    _add_session(p, required=True)
    _add_owner(p)
    p.set_defaults(func=cmd_heartbeat)

    p = sub.add_parser("reap", help="Free locks + stop VNC for idle/dead pool sessions")
    _add_common(p)
    p.set_defaults(func=cmd_reap)

    p = sub.add_parser("release", help="Release a session (free lock + stop pool VNC)")
    _add_common(p)
    _add_session(p, required=True)
    p.set_defaults(func=cmd_release)

    p = sub.add_parser("screenshot", help="Capture a screenshot")
    _add_common(p)
    _add_session(p)
    p.add_argument("--fmt", default="jpeg", choices=("jpeg", "png"))
    p.set_defaults(func=cmd_screenshot)

    p = sub.add_parser("observe", help="Screenshot + window list")
    _add_common(p)
    _add_session(p)
    p.set_defaults(func=cmd_observe)

    p = sub.add_parser("act", help="Run autonomous act() on an existing or default session")
    _add_common(p)
    _add_session(p)
    _add_act_opts(p)
    p.set_defaults(func=cmd_act)

    p = sub.add_parser(
        "run",
        help="Ensure desktop -> screenshot -> act(goal) -> release (one-shot goal loop)",
    )
    _add_common(p)
    _add_session(p)
    _add_owner(p)
    _add_act_opts(p)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("call", help="Raw tools/call by name")
    _add_common(p)
    p.add_argument("tool", help="MCP tool name, e.g. list_windows")
    p.add_argument(
        "--arg",
        action="append",
        default=[],
        help="Tool arg key=value (value JSON-parsed when possible). Repeatable.",
    )
    p.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="RPC wait seconds for this call",
    )
    p.set_defaults(func=cmd_call)

    return ap


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
