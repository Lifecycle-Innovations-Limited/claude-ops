"""Unit tests for multi-agent lease helpers (no Xvnc required)."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

# Disable background reaper / exit release before loading the server module.
os.environ["DESKTOP_ACT_REAP_INTERVAL"] = "0"
os.environ["DESKTOP_ACT_RELEASE_ON_EXIT"] = "0"

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "mcp-server" / "server.py"

spec = importlib.util.spec_from_file_location("desktop_act_server", SERVER)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
sys.modules["desktop_act_server"] = mod

try:
    import fastmcp  # noqa: F401
except ImportError:  # pragma: no cover
    import types

    fake = types.ModuleType("fastmcp")

    class _FastMCP:
        def __init__(self, *a, **k):
            pass

        def tool(self, *a, **k):
            def deco(fn):
                return fn

            return deco

        def run(self):
            pass

    fake.FastMCP = _FastMCP
    sys.modules["fastmcp"] = fake

spec.loader.exec_module(mod)


def test_lease_expired_when_no_lease():
    assert mod._lease_expired({}) is True
    assert mod._lease_expired({"lease_until": 0}) is True


def test_apply_and_hold():
    s: dict = {}
    mod._apply_lease(s, "agent-a", ttl=120)
    assert s["owner_id"] == "agent-a"
    assert s["lease_until"] > mod._now()
    assert mod._lease_held_by_other(s, "agent-b") is True
    assert mod._lease_held_by_other(s, "agent-a") is False
    s["lease_until"] = mod._now() - 10
    assert mod._lease_held_by_other(s, "agent-b") is False
    assert mod._lease_expired(s) is True


def test_clear_lease():
    s = {"owner_id": "x", "lease_until": 999999}
    mod._clear_lease(s)
    assert s["owner_id"] == ""
    assert s["lease_until"] == 0


def test_default_owner_env():
    os.environ["DESKTOP_ACT_OWNER"] = "env-owner-xyz"
    try:
        assert mod._default_owner_id() == "env-owner-xyz"
    finally:
        del os.environ["DESKTOP_ACT_OWNER"]


def test_backend_name_matches_platform():
    assert mod.BACKEND.name in ("x11", "mac", "windows")


if __name__ == "__main__":
    test_lease_expired_when_no_lease()
    test_apply_and_hold()
    test_clear_lease()
    test_default_owner_env()
    test_backend_name_matches_platform()
    print("ok")


def test_pool_lock_roundtrip():
    """Portable lock must enter/exit without error (fcntl or msvcrt)."""
    with mod._PoolLock():
        pool = mod._read_pool()
        assert isinstance(pool, dict)
        # Nested re-entry is not supported; just verify write under lock.
        mod._write_pool(pool)
