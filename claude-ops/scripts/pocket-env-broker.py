#!/usr/bin/env python3
"""pocket-env-broker — peer-authenticated secrets broker for restricted pocket workers.

The pocket executor spawns autonomous `claude --bg` workers as a restricted unix
user (POCKET_WORKER_USER, e.g. `pocket-worker`) that deliberately does NOT inherit
the orchestrator's secret environment. This broker lets such a worker request a
*specific* allowlisted secret at runtime, instead of getting all-or-nothing.

Design:
  • Runs as the privileged orchestrator user (the one that has the secrets in its
    environment — launched via the same env wrapper as the executor).
  • Listens on a unix-domain socket. Secrets are returned over the socket only —
    they never touch disk.
  • Every connection is peer-authenticated with SO_PEERCRED: the caller's uid MUST
    equal the worker user's uid, otherwise the request is denied.
  • A default-deny allowlist (env-broker-policy.json → {"allow": [...]}) decides
    which variable names are grantable. Values come from this process's own
    environment (so the deployment populates them the same way the executor's
    secrets are populated — e.g. sourcing ~/.mcp-secrets.env in the env wrapper).
  • Every request (granted or denied) is appended to an audit log.

Protocol (line-delimited JSON over the socket):
  request : {"var": "GOG_ACCOUNT", "task_id": "...", "worker_id": "..."}\n
  reply   : {"ok": true,  "value": "..."}\n
            {"ok": false, "error": "denied|unknown_var|not_allowed_uid|bad_request"}\n

Env:
  POCKET_ENV_BROKER_SOCK    socket path (default $POCKET_STATE_DIR/env-broker.sock)
  POCKET_ENV_BROKER_POLICY  policy json   (default $POCKET_STATE_DIR/env-broker-policy.json)
  POCKET_ENV_BROKER_AUDIT   audit log     (default $POCKET_STATE_DIR/env-broker-audit.log)
  POCKET_STATE_DIR          base dir      (default /var/lib/pocket-pipeline)
  POCKET_WORKER_USER        unix user allowed to request (default pocket-worker)
"""

from __future__ import annotations

import json
import os
import pwd
import signal
import socket
import struct
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", "/var/lib/pocket-pipeline"))
SOCK_PATH = Path(
    os.environ.get("POCKET_ENV_BROKER_SOCK", str(STATE_DIR / "env-broker.sock"))
)
POLICY_PATH = Path(
    os.environ.get(
        "POCKET_ENV_BROKER_POLICY", str(STATE_DIR / "env-broker-policy.json")
    )
)
AUDIT_PATH = Path(
    os.environ.get("POCKET_ENV_BROKER_AUDIT", str(STATE_DIR / "env-broker-audit.log"))
)
WORKER_USER = os.environ.get("POCKET_WORKER_USER", "pocket-worker").strip()
MAX_REQUEST_BYTES = 4096


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"{now_iso()} [pocket-env-broker] {msg}", file=sys.stderr, flush=True)


def allowed_uid() -> int | None:
    """Resolve the uid the worker user runs as. None if the user does not exist."""
    try:
        return pwd.getpwnam(WORKER_USER).pw_uid
    except KeyError:
        return None


def load_policy() -> set[str]:
    """Return the set of grantable variable names. Default-deny: missing/broken
    policy yields an empty allowlist (deny everything)."""
    try:
        data = json.loads(POLICY_PATH.read_text())
        allow = data.get("allow", [])
        return {str(v) for v in allow if isinstance(v, str)}
    except (OSError, json.JSONDecodeError, AttributeError):
        return set()


def audit(record: dict) -> None:
    record = {"ts": now_iso(), **record}
    try:
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT_PATH.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as e:
        log(f"audit write failed: {e}")


def peer_uid(conn: socket.socket) -> int:
    """Read the connected peer's uid via SO_PEERCRED (Linux). Raises on failure."""
    creds = conn.getsockopt(
        socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
    )
    _pid, uid, _gid = struct.unpack("3i", creds)
    return uid


def decide(var: str, policy: set[str]) -> tuple[bool, str | None, str]:
    """Pure policy decision. Returns (ok, value_or_None, reason)."""
    if not var:
        return False, None, "bad_request"
    if var not in policy:
        return False, None, "not_allowed"
    value = os.environ.get(var)
    if value is None:
        # In the allowlist but the broker has no such value in its environment.
        return False, None, "unknown_var"
    return True, value, "granted"


def handle(conn: socket.socket, want_uid: int | None) -> None:
    try:
        conn.settimeout(5)
        # Peer authentication first — reject any caller that is not the worker user.
        uid = peer_uid(conn)
        raw = conn.recv(MAX_REQUEST_BYTES)
        try:
            req = json.loads(raw.decode("utf-8").strip() or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            req = {}
        var = str(req.get("var", "")).strip()
        task_id = str(req.get("task_id", ""))[:128]
        worker_id = str(req.get("worker_id", ""))[:128]

        if want_uid is None or uid != want_uid:
            audit(
                {
                    "uid": uid,
                    "var": var,
                    "task_id": task_id,
                    "worker_id": worker_id,
                    "decision": "not_allowed_uid",
                }
            )
            conn.sendall(
                json.dumps({"ok": False, "error": "not_allowed_uid"}).encode() + b"\n"
            )
            return

        ok, value, reason = decide(var, load_policy())
        audit(
            {
                "uid": uid,
                "var": var,
                "task_id": task_id,
                "worker_id": worker_id,
                "decision": reason,
            }
        )
        if ok:
            conn.sendall(json.dumps({"ok": True, "value": value}).encode() + b"\n")
        else:
            conn.sendall(json.dumps({"ok": False, "error": reason}).encode() + b"\n")
    except (OSError, socket.timeout) as e:
        log(f"connection error: {e}")
    finally:
        try:
            conn.close()
        except OSError:
            pass


def serve() -> int:
    want_uid = allowed_uid()
    if want_uid is None:
        log(
            f"worker user {WORKER_USER!r} does not exist — every request will be denied"
        )

    SOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SOCK_PATH.exists():
        SOCK_PATH.unlink()

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(SOCK_PATH))
    # 0660: connect is gated by filesystem perms (provisioning grants the worker
    # user via group/ACL) AND by SO_PEERCRED at the application layer.
    os.chmod(SOCK_PATH, 0o660)
    srv.listen(16)
    log(f"listening on {SOCK_PATH} (grant uid={want_uid}, policy={POLICY_PATH})")

    stop = threading.Event()

    def _shutdown(*_):
        stop.set()
        try:
            srv.close()
        except OSError:
            pass

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while not stop.is_set():
        try:
            conn, _ = srv.accept()
        except OSError:
            break
        threading.Thread(target=handle, args=(conn, want_uid), daemon=True).start()

    try:
        if SOCK_PATH.exists():
            SOCK_PATH.unlink()
    except OSError:
        pass
    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(serve())
