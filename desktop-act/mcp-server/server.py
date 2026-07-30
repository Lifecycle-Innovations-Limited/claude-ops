#!/usr/bin/env python3
"""desktop-act MCP — computer-use primitives + multi-desktop pool + autonomous act() loop.

Architecture:
  * OS-agnostic backend abstraction dispatched on platform.system():
      - X11Backend (Linux): persistent Xlib connection cache + Xvnc/websockify pool.
      - MacBackend (macOS): screencapture + cliclick/osascript, single real session.
      - WinBackend (Windows): Pillow ImageGrab + pyautogui/ctypes SendInput,
        EnumWindows, single interactive desktop (lease model matches macOS).
  * Multi-desktop pool (Xvnc + websockify) with file-locked allocation in /tmp (X11).
  * Optimized primitives: cached SHA-dedupe screenshots, JPEG default, batch syncs.
  * High-level act(goal) via claude-agent-sdk (CLI OAuth, no ANTHROPIC_API_KEY).

Auth path: claude-agent-sdk only (bundled CLI OAuth, Claude Max subscription).
"""

from __future__ import annotations

import asyncio
import atexit
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional, Protocol, runtime_checkable

from fastmcp import FastMCP

# ─── Module constants ────────────────────────────────────────────────────────
# Auto-detect plugin root: ${CLAUDE_PLUGIN_ROOT} (set by Claude Code) → __file__ parent → cwd.
PLUGIN_ROOT = Path(
    os.environ.get("CLAUDE_PLUGIN_ROOT")
    or os.environ.get("DESKTOP_ACT_ROOT")
    or Path(__file__).resolve().parent.parent
)
_SYS = platform.system().lower()
IS_MAC: bool = _SYS == "darwin"
IS_WIN: bool = _SYS.startswith("win")

LOG_DIR = Path(os.environ.get("DESKTOP_ACT_LOG_DIR", PLUGIN_ROOT / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
# Prefer OS temp on Windows; Linux/mac keep /tmp for shared multi-agent pool paths.
if os.environ.get("DESKTOP_ACT_TMP"):
    TMP_ROOT = Path(os.environ["DESKTOP_ACT_TMP"])
elif IS_WIN:
    import tempfile as _tempfile

    TMP_ROOT = Path(_tempfile.gettempdir())
else:
    TMP_ROOT = Path("/tmp")
SHOT_DIR = TMP_ROOT / "desktop-act-shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
POOL_PATH = TMP_ROOT / "desktop-act-pool.json"
POOL_LOCK = TMP_ROOT / "desktop-act-pool.lock"
SESSIONS_DIR = TMP_ROOT / "desktop-act-sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_DISPLAY: str = os.environ.get(
    "DESKTOP_ACT_DISPLAY",
    "mac:main" if IS_MAC else ("win:main" if IS_WIN else ":1"),
)
DISPLAY_NUM_MIN: int = int(os.environ.get("DESKTOP_ACT_DISPLAY_MIN", "50"))
DISPLAY_NUM_MAX: int = int(os.environ.get("DESKTOP_ACT_DISPLAY_MAX", "99"))
VNC_PORT_BASE: int = int(os.environ.get("DESKTOP_ACT_VNC_PORT_BASE", "5900"))
NOVNC_PORT_BASE: int = int(os.environ.get("DESKTOP_ACT_NOVNC_PORT_BASE", "6082"))
# Wide default so multiple agents can place windows side-by-side on one seat;
# concurrent agents should still each hold an exclusive leased session.
DEFAULT_GEOMETRY: str = os.environ.get("DESKTOP_ACT_GEOMETRY", "2560x1440")
# Exclusive lease TTL (seconds). Heartbeat / ensure refresh the lease.
# Idle past this → reaper frees the lock and tears down Xvnc/websockify.
LEASE_TTL_SEC: int = int(os.environ.get("DESKTOP_ACT_LEASE_TTL", "600"))
# Background reaper interval (seconds). 0 disables the background loop.
REAP_INTERVAL_SEC: int = int(os.environ.get("DESKTOP_ACT_REAP_INTERVAL", "30"))
# When an owner is set and session_id is empty/busy, auto-spawn a free desktop.
AUTO_SPAWN: bool = os.environ.get("DESKTOP_ACT_AUTO_SPAWN", "1").lower() not in (
    "0",
    "false",
    "no",
    "off",
)
# Tear down pool VNC when lease expires (idle) or owner process ends.
REAP_ON_IDLE: bool = os.environ.get("DESKTOP_ACT_REAP_ON_IDLE", "1").lower() not in (
    "0",
    "false",
    "no",
    "off",
)
# On process exit, release sessions owned by this process.
# Default on for long-lived MCP hosts. Stdio CLI sets DESKTOP_ACT_RELEASE_ON_EXIT=0
# so one-shot ensure/list does not immediately kill the desktop it just created.
RELEASE_ON_EXIT: bool = os.environ.get("DESKTOP_ACT_RELEASE_ON_EXIT", "1").lower() not in (
    "0",
    "false",
    "no",
    "off",
)
# macOS single-session id (stable across the process lifetime).
MAC_SESSION_ID: str = "mac-main"
MAC_DISPLAY: str = "mac:main"
MAC_VNC_PORT: int = int(os.environ.get("DESKTOP_ACT_MAC_VNC_PORT", "5900"))
MAC_NOVNC_PORT: int = int(os.environ.get("DESKTOP_ACT_MAC_NOVNC_PORT", "6080"))
# The macOS system-framework Python always ships Quartz/pyobjc, which the venv
# (requirements.txt) does not. We shell out to it to synthesize scroll-wheel
# CGEvents — AppleScript has no working scroll verb.
MAC_SYSTEM_PYTHON: str = os.environ.get("DESKTOP_ACT_MAC_PYTHON", "/usr/bin/python3")
# Posts `amount` line-unit scroll-wheel events. argv: <dy> <dx>.
_MAC_SCROLL_PY = (
    "import sys\n"
    "from Quartz import (CGEventCreateScrollWheelEvent, CGEventPost, "
    "kCGHIDEventTap, kCGScrollEventUnitLine)\n"
    "dy, dx = int(sys.argv[1]), int(sys.argv[2])\n"
    "n = max(abs(dy), abs(dx)) or 1\n"
    "sy = (1 if dy > 0 else -1) if dy else 0\n"
    "sx = (1 if dx > 0 else -1) if dx else 0\n"
    "for _ in range(n):\n"
    "    ev = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitLine, 2, sy, sx)\n"
    "    CGEventPost(kCGHIDEventTap, ev)\n"
)
# Locate `claude` CLI: env override → PATH lookup → ~/.local/bin → ~/.claude/local.
_claude_default = shutil.which("claude") or str(Path.home() / ".local/bin/claude")
CLAUDE_CLI = Path(os.environ.get("CLAUDE_CLI_PATH", _claude_default))

# ─── Logging (stderr — visible in FastMCP startup) ───────────────────────────
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[desktop-act] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("desktop-act")


# ─── Binary discovery (cached at startup) ────────────────────────────────────
def _which(*names: str) -> Optional[str]:
    """Return the first existing path among candidates."""
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


BIN: dict[str, Optional[str]] = {
    "Xvnc": _which("Xvnc"),
    "vncserver": _which("vncserver"),
    "websockify": _which("websockify"),
    "x11vnc": _which("x11vnc"),
    # WM preference order: openbox → fluxbox → metacity → mutter
    "wm": _which("openbox", "fluxbox", "metacity", "mutter"),
    "xterm": _which("xterm"),
    "xdotool": _which("xdotool"),
    # macOS system binaries (no-op on Linux).
    "cliclick": _which("cliclick", "/opt/homebrew/bin/cliclick", "/usr/local/bin/cliclick"),
    "screencapture": _which("screencapture", "/usr/sbin/screencapture"),
    "osascript": _which("osascript", "/usr/bin/osascript"),
    "open": _which("open", "/usr/bin/open"),
}
log.info("binaries: %s", {k: v for k, v in BIN.items() if v})
if IS_MAC:
    _missing_critical = [k for k in ("cliclick", "screencapture") if BIN[k] is None]
    if _missing_critical:
        log.warning(
            "missing critical macOS binaries: %s — primitives will fail (brew install cliclick)",
            _missing_critical,
        )
elif not IS_WIN:
    _missing_critical = [k for k in ("Xvnc", "websockify") if BIN[k] is None]
    if _missing_critical:
        log.warning("missing critical binaries: %s — pool spawn will fail", _missing_critical)


# ─── Pool persistence (file-locked) ──────────────────────────────────────────
def _read_pool() -> dict[str, dict]:
    if not POOL_PATH.exists():
        return {}
    try:
        return json.loads(POOL_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _write_pool(pool: dict[str, dict]) -> None:
    POOL_PATH.write_text(json.dumps(pool, indent=2, sort_keys=True))


class _PoolLock:
    """Cross-process exclusive lock for pool mutations.

    Unix: fcntl.flock. Windows: msvcrt.locking on a 1-byte region (fcntl is
    unavailable). Pool multi-desktop is Linux-primary; Windows only guards the
    lease JSON for the limited hybrid backend.
    """

    def __enter__(self):
        # "a+" so the file exists and is readable for msvcrt byte locks.
        self.fd = POOL_LOCK.open("a+")
        if IS_WIN:
            import msvcrt

            self.fd.seek(0, os.SEEK_END)
            if self.fd.tell() == 0:
                self.fd.write("0")
                self.fd.flush()
            self.fd.seek(0)
            # LK_LOCK blocks until the region is free.
            msvcrt.locking(self.fd.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(self.fd.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            if IS_WIN:
                import msvcrt

                self.fd.seek(0)
                try:
                    msvcrt.locking(self.fd.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                import fcntl

                fcntl.flock(self.fd.fileno(), fcntl.LOCK_UN)
        finally:
            self.fd.close()


def _now() -> int:
    return int(time.time())


def _default_owner_id() -> str:
    """Stable-enough owner id for this process when caller omits owner_id."""
    env = (os.environ.get("DESKTOP_ACT_OWNER") or "").strip()
    if env:
        return env
    # Prefer explicit agent/session ids if present (Claude/Grok/etc.).
    for key in (
        "CLAUDE_SESSION_ID",
        "CLAUDE_AGENT_ID",
        "GROK_SESSION_ID",
        "AGENT_ID",
        "SESSION_ID",
    ):
        v = (os.environ.get(key) or "").strip()
        if v:
            return f"{key.lower()}:{v[:48]}"
    return f"pid-{os.getpid()}"


def _lease_expired(sess: dict, now: Optional[int] = None) -> bool:
    now = _now() if now is None else now
    until = int(sess.get("lease_until") or 0)
    if until <= 0:
        # No lease recorded → treat as free for claim.
        return True
    return until < now


def _lease_held_by_other(sess: dict, owner_id: str, now: Optional[int] = None) -> bool:
    """True if sess has a live exclusive lease for a different owner."""
    now = _now() if now is None else now
    held = (sess.get("owner_id") or "").strip()
    if not held:
        return False
    if held == owner_id:
        return False
    return not _lease_expired(sess, now)


def _apply_lease(sess: dict, owner_id: str, ttl: Optional[int] = None) -> dict:
    ttl = LEASE_TTL_SEC if ttl is None else int(ttl)
    owner = (owner_id or "").strip() or _default_owner_id()
    sess["owner_id"] = owner
    sess["lease_until"] = _now() + max(30, ttl)
    sess["lease_ttl_sec"] = max(30, ttl)
    sess["leased_at"] = _now()
    return sess


def _clear_lease(sess: dict) -> dict:
    sess["owner_id"] = ""
    sess["lease_until"] = 0
    return sess


def _kill_session_procs(sess: dict, grace: float = 0.3) -> list[dict]:
    """SIGTERM then SIGKILL Xvnc/WM/websockify for a pool session. Returns killed list."""
    killed: list[dict] = []
    for key in ("websockify_pid", "wm_pid", "xvnc_pid"):
        pid = int(sess.get(key) or 0)
        if pid and _pid_alive(pid):
            try:
                os.kill(pid, signal.SIGTERM)
                killed.append({key: pid})
            except OSError:
                pass
    if grace > 0:
        time.sleep(grace)
    for key in ("websockify_pid", "wm_pid", "xvnc_pid"):
        pid = int(sess.get(key) or 0)
        if pid and _pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    # Cleanup X lock sockets (Linux pool only).
    dnum = sess.get("display_num")
    if dnum is not None:
        for lock in (
            Path(f"/tmp/.X{dnum}-lock"),
            Path(f"/tmp/.X11-unix/X{dnum}"),
        ):
            try:
                lock.unlink(missing_ok=True)
            except OSError:
                pass
    return killed


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _port_open(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is listening on host:port (connect succeeds)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def _display_in_use(display_num: int) -> bool:
    return Path(f"/tmp/.X{display_num}-lock").exists() or not _port_free(
        VNC_PORT_BASE + display_num
    )


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# ─── SHA-dedupe screenshot cache (shared across backends) ────────────────────
_LAST_SHOT: dict[str, dict] = {}


def _encode_screenshot(
    img: Any,
    display: str,
    grab_ms: int,
    fmt: str,
    max_width: int,
    use_cache: bool,
) -> dict:
    """Shared PIL pipeline: SHA-dedupe, optional downscale, save, cache. Returns metadata.

    `img` must be a PIL RGB Image already grabbed by the backend.
    """
    from PIL import Image

    w, h = img.width, img.height
    sha = hashlib.sha256(img.tobytes()).hexdigest()[:16]

    if use_cache:
        prev = _LAST_SHOT.get(display)
        if prev and prev["sha"] == sha and Path(prev["path"]).exists():
            return {**prev, "cached": True, "grab_ms": grab_ms}

    if max_width and w > max_width:
        new_h = int(h * max_width / w)
        img = img.resize((max_width, new_h), Image.BILINEAR)

    ext = "jpg" if fmt == "jpeg" else "png"
    out = str(SHOT_DIR / f"shot-{sha[:8]}.{ext}")
    t1 = time.time()
    if fmt == "jpeg":
        img.save(out, "JPEG", quality=80, optimize=True)
    else:
        img.save(out, "PNG", optimize=False)
    save_ms = int((time.time() - t1) * 1000)

    result = {
        "path": out,
        "width": img.width,
        "height": img.height,
        "sha": sha,
        "cached": False,
        "grab_ms": grab_ms,
        "save_ms": save_ms,
    }
    _LAST_SHOT[display] = result
    return result


# ─── Backend protocol ────────────────────────────────────────────────────────
@runtime_checkable
class Backend(Protocol):
    """OS-agnostic desktop primitive surface.

    Methods mirror the @mcp.tool primitives 1:1. All return the same dict shapes
    the tools expose so callers never need to know which backend is active.
    Async to allow non-blocking subprocess / sleep within primitives.
    """

    name: str

    async def screenshot(
        self,
        session_id: str,
        region: str,
        fmt: str,
        max_width: int,
        use_cache: bool,
    ) -> dict: ...

    async def click(self, x: int, y: int, button: int, double: bool, session_id: str) -> dict: ...

    async def type_text(self, text: str, session_id: str, delay_ms: int) -> dict: ...

    async def keypress(self, key: str, modifiers: Optional[list[str]], session_id: str) -> dict: ...

    async def scroll(
        self, direction: str, amount: int, x: int, y: int, session_id: str
    ) -> dict: ...

    async def list_windows(self, session_id: str) -> dict: ...

    async def launch_app(self, command: str, session_id: str) -> dict: ...

    async def acquire_desktop(
        self, geometry: str, owner_id: str = "", force_new: bool = False
    ) -> dict: ...

    async def ensure_desktop(self, geometry: str, owner_id: str = "") -> dict: ...

    async def heartbeat_desktop(self, session_id: str, owner_id: str = "") -> dict: ...

    async def release_desktop(self, session_id: str) -> dict: ...

    async def list_desktops(self) -> dict: ...

    async def reap_idle_desktops(self) -> dict: ...


# ─── X11 backend (Linux) ─────────────────────────────────────────────────────
# ASCII printable -> X11 keysym name. python-xlib's XK.string_to_keysym() needs the
# keysym name, not the literal character, so e.g. string_to_keysym("@") returns 0
# but string_to_keysym("at") returns the right keysym. Without this map, typing
# strings containing punctuation silently drops the offending characters.
_CHAR_TO_KEYSYM_NAME: dict[str, str] = {
    " ": "space",
    "\n": "Return",
    "\t": "Tab",
    "!": "exclam",
    '"': "quotedbl",
    "#": "numbersign",
    "$": "dollar",
    "%": "percent",
    "&": "ampersand",
    "'": "apostrophe",
    "(": "parenleft",
    ")": "parenright",
    "*": "asterisk",
    "+": "plus",
    ",": "comma",
    "-": "minus",
    ".": "period",
    "/": "slash",
    ":": "colon",
    ";": "semicolon",
    "<": "less",
    "=": "equal",
    ">": "greater",
    "?": "question",
    "@": "at",
    "[": "bracketleft",
    "\\": "backslash",
    "]": "bracketright",
    "^": "asciicircum",
    "_": "underscore",
    "`": "grave",
    "{": "braceleft",
    "|": "bar",
    "}": "braceright",
    "~": "asciitilde",
}

# Keysym NAMES that live at the shifted level on a US PC layout — when the caller
# does `keypress("at")` we must hold Shift, otherwise fake_input sends the base
# keycode for "2" and the wrong character lands in the focused widget.
_SHIFT_REQUIRED_KEYSYMS: frozenset[str] = frozenset(
    {
        "exclam",
        "at",
        "numbersign",
        "dollar",
        "percent",
        "asciicircum",
        "ampersand",
        "asterisk",
        "parenleft",
        "parenright",
        "underscore",
        "plus",
        "braceleft",
        "braceright",
        "bar",
        "colon",
        "quotedbl",
        "less",
        "greater",
        "question",
        "asciitilde",
    }
)


class X11Backend:
    """X11/Xvnc backend. Behavior is byte-for-byte identical to the original server."""

    name = "x11"

    def __init__(self) -> None:
        # Persistent X11 display connection cache (lazy-init per process).
        self._displays: dict[str, Any] = {}

    # ── X11 connection helpers ────────────────────────────────────────────
    def _get_display(self, name: str) -> Any:
        """Return a long-lived Xlib display, lazy-init per process."""
        from Xlib import display as xd

        d = self._displays.get(name)
        if d is None:
            d = xd.Display(name)
            self._displays[name] = d
        return d

    def _resolve_display(self, session_id: str = "") -> str:
        """Resolve a session_id to a display name. Empty → DEFAULT_DISPLAY."""
        if not session_id:
            return DEFAULT_DISPLAY
        pool = _read_pool()
        sess = pool.get(session_id)
        if not sess:
            raise ValueError(f"unknown session_id: {session_id}")
        return sess["display"]

    def _take_screenshot(
        self,
        display: str,
        region: str = "",
        fmt: str = "jpeg",
        max_width: int = 0,
        use_cache: bool = True,
    ) -> dict:
        """Grab screen, dedupe by SHA, optional downscale, return path + metadata."""
        from PIL import Image
        from Xlib import X

        d = self._get_display(display)
        root = d.screen().root
        g = root.get_geometry()
        if region:
            x, y, w, h = (int(v) for v in region.split(","))
        else:
            x, y, w, h = 0, 0, g.width, g.height
        t0 = time.time()
        raw = root.get_image(x, y, w, h, X.ZPixmap, 0xFFFFFFFF)
        grab_ms = int((time.time() - t0) * 1000)

        img = Image.frombytes("RGB", (w, h), raw.data, "raw", "BGRX")
        return _encode_screenshot(img, display, grab_ms, fmt, max_width, use_cache)

    # ── Primitives ────────────────────────────────────────────────────────
    async def screenshot(self, session_id, region, fmt, max_width, use_cache) -> dict:
        display = self._resolve_display(session_id)
        r = self._take_screenshot(display, region, fmt, max_width, use_cache)
        return {"ok": True, "display": display, **r}

    async def click(self, x, y, button, double, session_id) -> dict:
        from Xlib import X
        from Xlib.ext.xtest import fake_input

        display = self._resolve_display(session_id)
        d = self._get_display(display)
        d.screen().root.warp_pointer(x, y)
        d.sync()
        for _ in range(2 if double else 1):
            fake_input(d, X.ButtonPress, button)
            fake_input(d, X.ButtonRelease, button)
            d.sync()
            if double:
                await asyncio.sleep(0.05)
        return {
            "ok": True,
            "x": x,
            "y": y,
            "button": button,
            "double": double,
            "display": display,
        }

    async def type_text(self, text, session_id, delay_ms) -> dict:
        from Xlib import XK, X
        from Xlib.ext.xtest import fake_input

        display = self._resolve_display(session_id)
        d = self._get_display(display)
        shift_kc = d.keysym_to_keycode(XK.XK_Shift_L)
        for ch in text:
            name = _CHAR_TO_KEYSYM_NAME.get(ch, ch)
            ks = XK.string_to_keysym(name)
            if not ks:
                continue
            kc = d.keysym_to_keycode(ks)
            shift = ch.isupper() or ch in '~!@#$%^&*()_+{}|:"<>?'
            if shift:
                fake_input(d, X.KeyPress, shift_kc)
            fake_input(d, X.KeyPress, kc)
            fake_input(d, X.KeyRelease, kc)
            if shift:
                fake_input(d, X.KeyRelease, shift_kc)
            d.sync()
            if delay_ms:
                await asyncio.sleep(delay_ms / 1000)
        return {"ok": True, "chars": len(text), "display": display}

    async def keypress(self, key, modifiers, session_id) -> dict:
        from Xlib import XK, X
        from Xlib.ext.xtest import fake_input

        display = self._resolve_display(session_id)
        d = self._get_display(display)
        mods = list(modifiers or [])
        # Auto-add Shift when the requested keysym sits at the shifted level of
        # its keycode (e.g. "at", "exclam", "question"); without this, fake_input
        # sends the base keycode and types "2", "1", "/" instead.
        if key in _SHIFT_REQUIRED_KEYSYMS and not any(m.lower() == "shift" for m in mods):
            mods.append("Shift")
        mcodes = [d.keysym_to_keycode(XK.string_to_keysym(m + "_L")) for m in mods]
        kc = d.keysym_to_keycode(XK.string_to_keysym(key))
        for m in mcodes:
            fake_input(d, X.KeyPress, m)
        fake_input(d, X.KeyPress, kc)
        fake_input(d, X.KeyRelease, kc)
        for m in reversed(mcodes):
            fake_input(d, X.KeyRelease, m)
        d.sync()
        return {"ok": True, "key": key, "modifiers": mods, "display": display}

    async def scroll(self, direction, amount, x, y, session_id) -> dict:
        from Xlib import X
        from Xlib.ext.xtest import fake_input

        display = self._resolve_display(session_id)
        d = self._get_display(display)
        if x >= 0 and y >= 0:
            d.screen().root.warp_pointer(x, y)
            d.sync()
        btn = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction.lower(), 5)
        for _ in range(amount):
            fake_input(d, X.ButtonPress, btn)
            fake_input(d, X.ButtonRelease, btn)
            d.sync()
            if amount > 1:
                await asyncio.sleep(0.03)
        return {
            "ok": True,
            "direction": direction,
            "amount": amount,
            "display": display,
        }

    async def list_windows(self, session_id) -> dict:
        display = self._resolve_display(session_id)
        d = self._get_display(display)
        wins = []
        for w in d.screen().root.query_tree().children:
            try:
                name = w.get_wm_name()
                g = w.get_geometry()
                if name:
                    wins.append({"name": name, "x": g.x, "y": g.y, "w": g.width, "h": g.height})
            except Exception:  # noqa: BLE001
                pass
        return {"ok": True, "windows": wins, "display": display}

    async def launch_app(self, command, session_id) -> dict:
        display = self._resolve_display(session_id)
        env = {**os.environ, "DISPLAY": display}
        proc = await asyncio.create_subprocess_shell(
            f"{command} &",
            env=env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.sleep(1.5)
        return {"ok": True, "command": command, "pid": proc.pid, "display": display}

    # ── Pool ──────────────────────────────────────────────────────────────
    def _spawn_desktop(self, display_num: int, geometry: str) -> dict:
        """Synchronously spawn Xvnc + WM + websockify. Returns session record. Blocking."""
        if not BIN["Xvnc"]:
            raise RuntimeError("Xvnc not installed")
        if not BIN["websockify"]:
            raise RuntimeError("websockify not installed")

        display = f":{display_num}"
        vnc_port = VNC_PORT_BASE + display_num
        novnc_port = NOVNC_PORT_BASE + (display_num - DISPLAY_NUM_MIN)
        session_id = f"desk-{uuid.uuid4().hex[:8]}"
        log_path = SESSIONS_DIR / f"{session_id}.log"
        log_fh = log_path.open("a")

        # Xvnc — no auth (loopback-bound), depth 24
        xvnc_cmd = [
            BIN["Xvnc"],
            display,
            "-geometry",
            geometry,
            "-depth",
            "24",
            "-SecurityTypes",
            "None",
            "-AlwaysShared",
            "-rfbport",
            str(vnc_port),
            "-interface",
            "127.0.0.1",
        ]
        xvnc = subprocess.Popen(
            xvnc_cmd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

        # Wait up to 5s for X server to come up
        ready = False
        for _ in range(50):
            if Path(f"/tmp/.X{display_num}-lock").exists() and not _port_free(vnc_port):
                ready = True
                break
            if xvnc.poll() is not None:
                raise RuntimeError(f"Xvnc exited early (code={xvnc.returncode}) — see {log_path}")
            time.sleep(0.1)
        if not ready:
            xvnc.terminate()
            raise RuntimeError(
                f"Xvnc :{display_num} did not become ready within 5s — see {log_path}"
            )

        # Spawn WM if available (best-effort, non-fatal)
        wm_pid: Optional[int] = None
        if BIN["wm"]:
            try:
                wm = subprocess.Popen(
                    [BIN["wm"]],
                    env={**os.environ, "DISPLAY": display},
                    stdout=log_fh,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                wm_pid = wm.pid
            except Exception as e:  # noqa: BLE001
                log.warning("WM spawn failed for %s: %s", display, e)

        # Spawn websockify (noVNC bridge)
        websockify = subprocess.Popen(
            [BIN["websockify"], str(novnc_port), f"127.0.0.1:{vnc_port}"],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

        # Best-effort xterm so the screen isn't entirely empty
        if BIN["xterm"]:
            try:
                subprocess.Popen(
                    [BIN["xterm"], "-geometry", "80x24+10+10"],
                    env={**os.environ, "DISPLAY": display},
                    stdout=log_fh,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except Exception:  # noqa: BLE001
                pass

        return {
            "session_id": session_id,
            "display": display,
            "display_num": display_num,
            "vnc_port": vnc_port,
            "novnc_port": novnc_port,
            "novnc_url": f"http://localhost:{novnc_port}",
            "geometry": geometry,
            "xvnc_pid": xvnc.pid,
            "wm_pid": wm_pid,
            "wm_bin": BIN["wm"],
            "websockify_pid": websockify.pid,
            "log_path": str(log_path),
            "created_at": int(time.time()),
        }

    def _close_display_cache(self, display: str) -> None:
        d = self._displays.pop(display, None)
        if d is not None:
            try:
                d.close()
            except Exception:  # noqa: BLE001
                pass
        _LAST_SHOT.pop(display, None)

    def _pick_free_display_num(self, pool: dict) -> Optional[int]:
        used_nums = {s.get("display_num") for s in pool.values() if "display_num" in s}
        for n in range(DISPLAY_NUM_MIN, DISPLAY_NUM_MAX + 1):
            if n in used_nums:
                continue
            if _display_in_use(n):
                continue
            return n
        return None

    def _spawn_and_lease(self, geometry: str, owner_id: str, pool: dict) -> dict:
        """Spawn under pool lock (caller holds lock). Returns result dict."""
        chosen = self._pick_free_display_num(pool)
        if chosen is None:
            return {
                "ok": False,
                "error": f"no free display in :{DISPLAY_NUM_MIN}-:{DISPLAY_NUM_MAX}",
            }
        # Spawn outside? Xvnc can take seconds — still under lock to avoid races.
        session = self._spawn_desktop(chosen, geometry)
        _apply_lease(session, owner_id)
        session["owner_pid"] = os.getpid()
        pool[session["session_id"]] = session
        _write_pool(pool)
        return {"ok": True, "reused": False, "spawned": True, **session}

    async def ensure_desktop(self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "") -> dict:
        """Return an exclusive desktop for owner_id.

        - Reuse owner's live leased session (refresh TTL).
        - Else claim an idle/expired pool session (refresh + re-lease).
        - Else spawn a new Xvnc on the next free display/port.
        Never steals a non-expired lease from another owner.
        """
        owner = (owner_id or "").strip() or _default_owner_id()
        geo = geometry or DEFAULT_GEOMETRY

        def _sync() -> dict:
            with _PoolLock():
                pool = _read_pool()
                # Drop dead processes first (free slots without waiting for reaper).
                self._reap_pool_locked(pool, reason="ensure-precheck")
                # 1) Owner already holds a live session.
                for sid, s in list(pool.items()):
                    if (s.get("owner_id") or "") == owner and self._session_alive(s):
                        _apply_lease(s, owner)
                        pool[sid] = s
                        _write_pool(pool)
                        return {"ok": True, "reused": True, "spawned": False, **s}
                # 2) Claim free / lease-expired but still-alive desktop.
                for sid, s in list(pool.items()):
                    if not self._session_alive(s):
                        continue
                    if _lease_held_by_other(s, owner):
                        continue
                    _apply_lease(s, owner)
                    s["owner_pid"] = os.getpid()
                    pool[sid] = s
                    _write_pool(pool)
                    return {
                        "ok": True,
                        "reused": True,
                        "claimed": True,
                        "spawned": False,
                        **s,
                    }
                # 3) Auto-spawn new exclusive desktop.
                if not AUTO_SPAWN:
                    return {
                        "ok": False,
                        "error": "no free desktop and DESKTOP_ACT_AUTO_SPAWN=0",
                        "owner_id": owner,
                    }
                return self._spawn_and_lease(geo, owner, pool)

        return await asyncio.get_event_loop().run_in_executor(None, _sync)

    async def acquire_desktop(
        self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "", force_new: bool = False
    ) -> dict:
        """Acquire a desktop for this agent.

        Default (force_new=False): ensure_desktop — reuse own lease or spawn if busy.
        force_new=True: always spawn a fresh exclusive session (old always-new behavior).
        """
        owner = (owner_id or "").strip() or _default_owner_id()
        geo = geometry or DEFAULT_GEOMETRY
        if not force_new:
            return await self.ensure_desktop(geo, owner)

        def _sync() -> dict:
            with _PoolLock():
                pool = _read_pool()
                self._reap_pool_locked(pool, reason="acquire-force-new")
                return self._spawn_and_lease(geo, owner, pool)

        return await asyncio.get_event_loop().run_in_executor(None, _sync)

    async def heartbeat_desktop(self, session_id: str, owner_id: str = "") -> dict:
        """Refresh lease TTL so the idle reaper does not tear the session down."""
        owner = (owner_id or "").strip() or _default_owner_id()

        def _sync() -> dict:
            with _PoolLock():
                pool = _read_pool()
                sess = pool.get(session_id)
                if not sess:
                    return {"ok": False, "error": f"unknown session_id: {session_id}"}
                if _lease_held_by_other(sess, owner):
                    return {
                        "ok": False,
                        "error": "lease held by another owner",
                        "owner_id": sess.get("owner_id"),
                        "lease_until": sess.get("lease_until"),
                    }
                _apply_lease(sess, owner)
                pool[session_id] = sess
                _write_pool(pool)
                return {
                    "ok": True,
                    "session_id": session_id,
                    "owner_id": sess.get("owner_id"),
                    "lease_until": sess.get("lease_until"),
                }

        return await asyncio.get_event_loop().run_in_executor(None, _sync)

    def _release_locked(self, pool: dict, session_id: str) -> dict:
        """Release under held pool lock. Kills VNC stack and drops lease."""
        sess = pool.get(session_id)
        if not sess:
            return {"ok": False, "error": f"unknown session_id: {session_id}"}
        display = sess.get("display") or ""
        if display:
            self._close_display_cache(display)
        killed = _kill_session_procs(sess)
        del pool[session_id]
        _write_pool(pool)
        return {
            "ok": True,
            "released": session_id,
            "killed": killed,
            "owner_id": sess.get("owner_id") or "",
        }

    async def release_desktop(self, session_id: str) -> dict:
        def _sync() -> dict:
            with _PoolLock():
                pool = _read_pool()
                return self._release_locked(pool, session_id)

        return await asyncio.get_event_loop().run_in_executor(None, _sync)

    @staticmethod
    def _session_alive(sess: dict) -> bool:
        return _pid_alive(int(sess.get("xvnc_pid") or 0))

    def _reap_pool_locked(self, pool: dict, reason: str = "reap") -> list[dict]:
        """Free locks + kill VNC for dead or idle-expired pool sessions. Mutates pool."""
        if not REAP_ON_IDLE and reason.startswith("idle"):
            return []
        now = _now()
        reaped: list[dict] = []
        for sid in list(pool.keys()):
            s = pool[sid]
            # Never reap non-pool / mac-main style records without xvnc.
            if "xvnc_pid" not in s and "display_num" not in s:
                continue
            dead = not self._session_alive(s)
            # Only idle-reap sessions that actually held a timed lease.
            had_lease = int(s.get("lease_until") or 0) > 0 or bool(s.get("owner_id"))
            idle = (
                REAP_ON_IDLE
                and had_lease
                and _lease_expired(s, now)
                and int(s.get("lease_until") or 0) > 0
            )
            # Dead Xvnc always reaped; idle lease-expired also reaped (stop VNC load).
            if not (dead or idle):
                continue
            display = s.get("display") or ""
            if display:
                self._close_display_cache(display)
            killed = _kill_session_procs(s)
            del pool[sid]
            reaped.append(
                {
                    "session_id": sid,
                    "reason": "dead" if dead else "lease_expired",
                    "via": reason,
                    "owner_id": s.get("owner_id") or "",
                    "killed": killed,
                }
            )
            log.info(
                "reaped session %s reason=%s owner=%s",
                sid,
                "dead" if dead else "lease_expired",
                s.get("owner_id"),
            )
        if reaped:
            _write_pool(pool)
        return reaped

    async def reap_idle_desktops(self) -> dict:
        """Tear down pool sessions whose lease expired or whose Xvnc died.

        Frees the exclusive lock and stops Xvnc + websockify to avoid load.
        Does not touch the host default display (e.g. :1 reauth Chrome).
        """

        def _sync() -> dict:
            with _PoolLock():
                pool = _read_pool()
                reaped = self._reap_pool_locked(pool, reason="idle-reap")
                return {
                    "ok": True,
                    "reaped": reaped,
                    "count": len(reaped),
                    "remaining": len(pool),
                }

        return await asyncio.get_event_loop().run_in_executor(None, _sync)

    async def list_desktops(self) -> dict:
        # Opportunistic reap so list stays honest under multi-agent load.
        with _PoolLock():
            pool = _read_pool()
            self._reap_pool_locked(pool, reason="list-precheck")
        pool = _read_pool()
        sessions = []
        now = _now()
        for _sid, s in pool.items():
            sessions.append(
                {
                    **s,
                    "alive": self._session_alive(s),
                    "lease_expired": _lease_expired(s, now),
                }
            )
        return {"ok": True, "count": len(sessions), "sessions": sessions}


# ─── macOS backend ───────────────────────────────────────────────────────────
class MacBackend:
    """macOS backend: screencapture + cliclick/osascript driving the one logged-in session.

    There is exactly one user desktop on macOS, so there is no Xvnc pool. acquire/list/
    release operate on a single stable session bound to the real display (mac:main), and
    release_desktop only tears down the optional websockify/VNC bridge — never the user
    session. Screen Sharing (built-in VNC, port 5900) is bridged to noVNC via websockify
    when available; if Screen Sharing is off, the session is still returned with a hint.
    """

    name = "mac"

    # button → (single-click verb, double-click verb). macOS/cliclick has no
    # native middle-click, so button=2 is reported as unsupported rather than
    # silently mis-mapped to a right-click. button 4/5 are scroll, handled in click().
    _BTN = {1: ("c", "dc"), 3: ("rc", "rc")}

    def __init__(self) -> None:
        self._bridge_pid: Optional[int] = None

    # ── helpers ───────────────────────────────────────────────────────────
    def _resolve_display(self, session_id: str = "") -> str:
        """macOS has exactly one session. Empty or MAC_SESSION_ID → the real display;
        any other id is rejected (there is no pool to look it up in)."""
        if not session_id or session_id == MAC_SESSION_ID:
            return MAC_DISPLAY
        raise ValueError(
            f"unknown session_id: {session_id} (macOS has a single session: {MAC_SESSION_ID!r})"
        )

    async def _run(self, *argv: str) -> tuple[int, str, str]:
        """Run a system binary directly (no shell), return (rc, stdout, stderr)."""
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        return (
            proc.returncode or 0,
            out.decode(errors="replace"),
            err.decode(errors="replace"),
        )

    def _cliclick(self) -> str:
        c = BIN["cliclick"]
        if not c:
            raise RuntimeError("cliclick not installed — run: brew install cliclick")
        return c

    # ── primitives ────────────────────────────────────────────────────────
    async def screenshot(self, session_id, region, fmt, max_width, use_cache) -> dict:
        from PIL import Image

        display = self._resolve_display(session_id)
        if not BIN["screencapture"]:
            raise RuntimeError("screencapture not found")
        ext = "jpg" if fmt == "jpeg" else "png"
        cap_fmt = "jpg" if fmt == "jpeg" else "png"
        raw_path = SHOT_DIR / f"raw-{uuid.uuid4().hex[:8]}.{ext}"
        # -x silent, -t format, capture main display (default).
        argv = ["-x", "-t", cap_fmt]
        if region:
            x, y, w, h = (int(v) for v in region.split(","))
            argv += ["-R", f"{x},{y},{w},{h}"]
        argv.append(str(raw_path))
        t0 = time.time()
        rc, _out, err = await self._run(BIN["screencapture"], *argv)
        grab_ms = int((time.time() - t0) * 1000)
        if rc != 0 or not raw_path.exists():
            raise RuntimeError(f"screencapture failed (rc={rc}): {err.strip()}")
        try:
            img = Image.open(raw_path).convert("RGB")
            r = _encode_screenshot(img, display, grab_ms, fmt, max_width, use_cache)
        finally:
            try:
                raw_path.unlink(missing_ok=True)
            except OSError:
                pass
        return {"ok": True, "display": display, **r}

    async def click(self, x, y, button, double, session_id) -> dict:
        display = self._resolve_display(session_id)
        cc = self._cliclick()
        # 4/5 scroll buttons → delegate to scroll for X11 parity.
        if button in (4, 5):
            return await self.scroll("up" if button == 4 else "down", 1, x, y, session_id)
        verbs = self._BTN.get(button)
        if verbs is None:
            return {
                "ok": False,
                "error": f"button {button} unsupported on macOS "
                "(no middle-click; use 1=left or 3=right)",
                "x": x,
                "y": y,
                "button": button,
                "double": double,
                "display": display,
            }
        # cliclick has no double-right verb, so synthesize it with two right-clicks.
        if double and button == 3:
            rc, _out, err = await self._run(cc, f"rc:{x},{y}", f"rc:{x},{y}")
        else:
            prefix = verbs[1] if double else verbs[0]
            rc, _out, err = await self._run(cc, f"{prefix}:{x},{y}")
        if rc != 0:
            raise RuntimeError(f"cliclick failed (rc={rc}): {err.strip()}")
        return {
            "ok": True,
            "x": x,
            "y": y,
            "button": button,
            "double": double,
            "display": display,
        }

    async def type_text(self, text, session_id, delay_ms) -> dict:
        display = self._resolve_display(session_id)
        cc = self._cliclick()
        # cliclick t: types literally; w:<ms> sets inter-keystroke wait.
        args = []
        if delay_ms:
            args.append(f"w:{delay_ms}")
        args.append(f"t:{text}")
        rc, _out, err = await self._run(cc, *args)
        if rc != 0:
            raise RuntimeError(f"cliclick failed (rc={rc}): {err.strip()}")
        return {"ok": True, "chars": len(text), "display": display}

    async def keypress(self, key, modifiers, session_id) -> dict:
        display = self._resolve_display(session_id)
        cc = self._cliclick()
        mods = modifiers or []
        # Map X11-style modifier names → cliclick kd/ku modifier names.
        mod_map = {
            "control": "ctrl",
            "ctrl": "ctrl",
            "alt": "alt",
            "option": "alt",
            "meta": "cmd",
            "super": "cmd",
            "command": "cmd",
            "cmd": "cmd",
            "shift": "shift",
        }
        cmods = [mod_map.get(m.lower(), m.lower()) for m in mods]
        # Map common X11 keysyms → cliclick key-press tokens (kp:).
        key_map = {
            "Return": "return",
            "Enter": "return",
            "Tab": "tab",
            "Escape": "esc",
            "space": "space",
            "BackSpace": "delete",
            "Delete": "fwd-delete",
            "Up": "arrow-up",
            "Down": "arrow-down",
            "Left": "arrow-left",
            "Right": "arrow-right",
            "Home": "home",
            "End": "end",
            "Page_Up": "page-up",
            "Page_Down": "page-down",
        }
        args: list[str] = []
        for m in cmods:
            args.append(f"kd:{m}")
        tok = key_map.get(key)
        if tok:
            args.append(f"kp:{tok}")
        elif len(key) == 1:
            # single character → type it (with modifiers held, e.g. cmd+a).
            args.append(f"t:{key}")
        else:
            args.append(f"kp:{key.lower()}")
        for m in reversed(cmods):
            args.append(f"ku:{m}")
        rc, _out, err = await self._run(cc, *args)
        if rc != 0:
            raise RuntimeError(f"cliclick failed (rc={rc}): {err.strip()}")
        return {"ok": True, "key": key, "modifiers": mods, "display": display}

    async def scroll(self, direction, amount, x, y, session_id) -> dict:
        display = self._resolve_display(session_id)
        # Optionally warp the pointer first (cliclick m:) so the scroll lands there.
        if x >= 0 and y >= 0 and BIN["cliclick"]:
            await self._run(BIN["cliclick"], f"m:{x},{y}")
        # Synthesize line-unit scroll-wheel CGEvents. AppleScript "System Events"
        # has no working `scroll` verb (errors -1708), so post the event via the
        # macOS system framework Python (always ships Quartz/pyobjc) — no new dep.
        # Wheel deltas: +y scrolls up, +x scrolls left.
        d = direction.lower()
        dy = dx = 0
        if d == "up":
            dy = amount
        elif d == "down":
            dy = -amount
        elif d == "left":
            dx = amount
        elif d == "right":
            dx = -amount
        else:
            dy = -amount
        rc, _out, err = await self._run(MAC_SYSTEM_PYTHON, "-c", _MAC_SCROLL_PY, str(dy), str(dx))
        if rc != 0:
            raise RuntimeError(f"scroll failed (rc={rc}): {err.strip()}")
        return {
            "ok": True,
            "direction": direction,
            "amount": amount,
            "display": display,
        }

    async def list_windows(self, session_id) -> dict:
        display = self._resolve_display(session_id)
        if not BIN["osascript"]:
            raise RuntimeError("osascript not found")
        # Enumerate visible app windows + bounds via System Events; tab-delimited rows.
        script = (
            'set out to ""\n'
            'tell application "System Events"\n'
            "  repeat with p in (every process whose visible is true)\n"
            "    repeat with w in (every window of p)\n"
            "      try\n"
            "        set pos to position of w\n"
            "        set sz to size of w\n"
            '        set out to out & (name of p) & "\\t" & (name of w) & "\\t" & '
            '(item 1 of pos) & "\\t" & (item 2 of pos) & "\\t" & '
            '(item 1 of sz) & "\\t" & (item 2 of sz) & "\\n"\n'
            "      end try\n"
            "    end repeat\n"
            "  end repeat\n"
            "end tell\n"
            "return out"
        )
        rc, out, err = await self._run(BIN["osascript"], "-e", script)
        if rc != 0:
            # Accessibility not granted, or transient — degrade gracefully like X11.
            log.warning("list_windows osascript failed (rc=%s): %s", rc, err.strip())
            return {"ok": True, "windows": [], "display": display}
        wins: list[dict] = []
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) != 6:
                continue
            app, wname, px, py, sw, sh = parts
            try:
                wins.append(
                    {
                        "name": f"{app}: {wname}" if wname else app,
                        "x": int(px),
                        "y": int(py),
                        "w": int(sw),
                        "h": int(sh),
                    }
                )
            except ValueError:
                continue
        return {"ok": True, "windows": wins, "display": display}

    async def launch_app(self, command, session_id) -> dict:
        display = self._resolve_display(session_id)
        if not BIN["open"]:
            raise RuntimeError("open not found")
        # Heuristic: a bare token → treat as app name (open -a); else open the path/URL.
        if " " not in command and "/" not in command:
            argv = [BIN["open"], "-a", command]
        else:
            argv = [BIN["open"], command]
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
        await asyncio.sleep(1.5)
        if proc.returncode != 0:
            return {
                "ok": False,
                "error": f"open failed: {err.decode(errors='replace').strip()}",
                "command": command,
                "display": display,
            }
        return {"ok": True, "command": command, "pid": proc.pid, "display": display}

    # ── single-session "pool" ────────────────────────────────────────────
    async def _start_bridge(self) -> dict:
        """Bridge built-in Screen Sharing (VNC :5900) → noVNC via websockify if possible.

        Never fails the acquire. Returns fields merged into the session record.
        """
        vnc_up = _port_open(MAC_VNC_PORT)
        extra: dict[str, Any] = {
            "vnc_port": MAC_VNC_PORT,
            "screen_sharing_enabled": vnc_up,
        }
        if not vnc_up:
            extra["vnc_hint"] = (
                "macOS Screen Sharing (VNC) is off — enable it in System Settings → "
                "General → Sharing → Screen Sharing to get a live noVNC view."
            )
            return extra
        if not BIN["websockify"]:
            extra["vnc_hint"] = (
                "Screen Sharing is on but websockify is missing — "
                "pip install websockify (or brew install websockify) for a noVNC bridge."
            )
            return extra
        if self._bridge_pid and _pid_alive(self._bridge_pid):
            extra["websockify_pid"] = self._bridge_pid
            extra["novnc_port"] = MAC_NOVNC_PORT
            extra["novnc_url"] = f"http://localhost:{MAC_NOVNC_PORT}"
            return extra
        if not _port_free(MAC_NOVNC_PORT):
            # Something already bridging on this port — reuse it.
            extra["novnc_port"] = MAC_NOVNC_PORT
            extra["novnc_url"] = f"http://localhost:{MAC_NOVNC_PORT}"
            return extra
        log_path = SESSIONS_DIR / f"{MAC_SESSION_ID}.log"
        log_fh = log_path.open("a")
        ws = subprocess.Popen(
            [BIN["websockify"], str(MAC_NOVNC_PORT), f"127.0.0.1:{MAC_VNC_PORT}"],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self._bridge_pid = ws.pid
        extra["websockify_pid"] = ws.pid
        extra["novnc_port"] = MAC_NOVNC_PORT
        extra["novnc_url"] = f"http://localhost:{MAC_NOVNC_PORT}"
        extra["log_path"] = str(log_path)
        return extra

    def _session_record(self, geometry: str, bridge: dict) -> dict:
        return {
            "session_id": MAC_SESSION_ID,
            "display": MAC_DISPLAY,
            "geometry": geometry,
            "created_at": int(time.time()),
            "novnc_url": bridge.get("novnc_url"),
            **bridge,
        }

    @staticmethod
    def _session_alive(sess: dict) -> bool:
        """A mac session is live iff its real display is up (VNC reachable) — or, when
        Screen Sharing is off, the bridge port we recorded for it. Falls back to the
        VNC port for the canonical session."""
        if sess.get("session_id") == MAC_SESSION_ID:
            return _port_open(MAC_VNC_PORT)
        ws = sess.get("websockify_pid")
        if ws:
            return _pid_alive(ws)
        return False

    async def ensure_desktop(self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "") -> dict:
        # Single real desktop — lease is advisory; second agent is warned but can share.
        return await self.acquire_desktop(geometry, owner_id=owner_id, force_new=False)

    async def acquire_desktop(
        self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "", force_new: bool = False
    ) -> dict:
        # macOS: one real session. Persist a stable record; bridge VNC best-effort.
        owner = (owner_id or "").strip() or _default_owner_id()
        bridge = await self._start_bridge()
        session = self._session_record(geometry, bridge)
        _apply_lease(session, owner)
        session["owner_pid"] = os.getpid()
        with _PoolLock():
            pool = _read_pool()
            prev = pool.get(MAC_SESSION_ID) or {}
            if not force_new and prev.get("owner_id") and _lease_held_by_other(prev, owner):
                # Cannot spawn a second real desktop on macOS.
                return {
                    "ok": True,
                    "reused": True,
                    "spawned": False,
                    "shared": True,
                    "warning": (
                        "macOS has one desktop; another owner holds the lease. "
                        "Primitives still target the real session (limited isolation)."
                    ),
                    "other_owner": prev.get("owner_id"),
                    **{
                        **session,
                        **{k: prev.get(k, session.get(k)) for k in ("owner_id", "lease_until")},
                    },
                    "session_id": MAC_SESSION_ID,
                }
            # Pool hygiene: drop stale Linux desk-* entries if any.
            pool = {MAC_SESSION_ID: session}
            _write_pool(pool)
        return {"ok": True, "reused": False, "spawned": False, **session}

    async def heartbeat_desktop(self, session_id: str, owner_id: str = "") -> dict:
        owner = (owner_id or "").strip() or _default_owner_id()
        with _PoolLock():
            pool = _read_pool()
            sess = pool.get(session_id) or pool.get(MAC_SESSION_ID)
            if not sess:
                return {"ok": False, "error": f"unknown session_id: {session_id}"}
            _apply_lease(sess, owner)
            pool[sess["session_id"]] = sess
            _write_pool(pool)
            return {
                "ok": True,
                "session_id": sess["session_id"],
                "owner_id": sess.get("owner_id"),
                "lease_until": sess.get("lease_until"),
            }

    async def reap_idle_desktops(self) -> dict:
        # macOS: only drop expired lease metadata + optional websockify bridge.
        # Never terminate the user's login session / Screen Sharing.
        reaped: list[dict] = []
        with _PoolLock():
            pool = _read_pool()
            sess = pool.get(MAC_SESSION_ID)
            if (
                sess
                and REAP_ON_IDLE
                and int(sess.get("lease_until") or 0) > 0
                and _lease_expired(sess)
            ):
                _clear_lease(sess)
                pid = sess.get("websockify_pid") or self._bridge_pid
                killed: list[dict] = []
                if pid and _pid_alive(int(pid)):
                    try:
                        os.kill(int(pid), signal.SIGTERM)
                        killed.append({"websockify_pid": int(pid)})
                    except OSError:
                        pass
                    self._bridge_pid = None
                pool[MAC_SESSION_ID] = sess
                _write_pool(pool)
                reaped.append(
                    {
                        "session_id": MAC_SESSION_ID,
                        "reason": "lease_expired",
                        "killed": killed,
                        "note": "user desktop kept; bridge only",
                    }
                )
        return {"ok": True, "reaped": reaped, "count": len(reaped), "remaining": 1}

    async def release_desktop(self, session_id) -> dict:
        # Only tear down the optional websockify bridge — never the user's session.
        with _PoolLock():
            pool = _read_pool()
            sess = pool.get(session_id)
            if not sess:
                return {"ok": False, "error": f"unknown session_id: {session_id}"}
            killed: list[dict] = []
            pid = sess.get("websockify_pid") or self._bridge_pid
            did_term = False
            if pid and _pid_alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                    killed.append({"websockify_pid": pid})
                    did_term = True
                except OSError:
                    pass
            if did_term:
                await asyncio.sleep(0.3)
                if pid and _pid_alive(pid):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
            _clear_lease(sess)
            pool[session_id] = sess
            _write_pool(pool)
            self._bridge_pid = None
            _LAST_SHOT.pop(sess["display"], None)
            pool.pop(session_id, None)
            _write_pool(pool)
            return {
                "ok": True,
                "released": session_id,
                "killed": killed,
                "note": "macOS user session is never terminated — only the noVNC bridge.",
            }

    async def list_desktops(self) -> dict:
        # Only ever surface the single mac session; drop any stale X11 entries.
        pool = _read_pool()
        sessions = []
        for _sid, s in pool.items():
            if s.get("session_id") != MAC_SESSION_ID:
                continue
            sessions.append({**s, "alive": self._session_alive(s)})
        return {"ok": True, "count": len(sessions), "sessions": sessions}


# ─── Windows backend (native desktop — single interactive session) ───────────
class WinBackend:
    """Windows native computer-use backend (single interactive desktop).

    Multi-desktop Xvnc pools are Linux-only. On Windows we drive the real
    logged-in session with the same tool signatures:

    - screenshot: Pillow ImageGrab (GDI)
    - click / type / keypress / scroll: pyautogui (optional) or ctypes SendInput
    - list_windows: user32 EnumWindows
    - launch_app: subprocess / os.startfile

    Multi-agent: exclusive leases still apply, but there is only one real
    desktop (shared warning if another owner holds the lease) — same model
    as macOS.
    """

    name = "windows"
    WIN_SESSION_ID = "win-main"

    # Virtual-key map for common keypress names (subset of X11-style names).
    _VK = {
        "return": 0x0D,
        "enter": 0x0D,
        "tab": 0x09,
        "escape": 0x1B,
        "esc": 0x1B,
        "backspace": 0x08,
        "delete": 0x2E,
        "space": 0x20,
        "up": 0x26,
        "down": 0x28,
        "left": 0x25,
        "right": 0x27,
        "home": 0x24,
        "end": 0x23,
        "page_up": 0x21,
        "page_down": 0x22,
        "f1": 0x70,
        "f2": 0x71,
        "f3": 0x72,
        "f4": 0x73,
        "f5": 0x74,
        "f6": 0x75,
        "f7": 0x76,
        "f8": 0x77,
        "f9": 0x78,
        "f10": 0x79,
        "f11": 0x7A,
        "f12": 0x7B,
    }
    _MOD_VK = {
        "control": 0x11,
        "ctrl": 0x11,
        "alt": 0x12,
        "shift": 0x10,
        "win": 0x5B,
        "meta": 0x5B,
        "super": 0x5B,
        "cmd": 0x5B,
    }

    def __init__(self) -> None:
        self._session: dict = {
            "session_id": self.WIN_SESSION_ID,
            "display": "win:main",
            "geometry": DEFAULT_GEOMETRY,
            "novnc_url": None,
            "created_at": _now(),
            "limited": False,
            "platform_note": (
                "Windows native backend: single interactive desktop "
                "(no Xvnc multi-seat pool). Requires an interactive session; "
                "RDP/headless may need 'console' session."
            ),
        }
        self._pyautogui = None
        if IS_WIN:
            try:
                import pyautogui  # type: ignore

                pyautogui.FAILSAFE = False
                pyautogui.PAUSE = 0.02
                self._pyautogui = pyautogui
            except Exception as e:  # noqa: BLE001
                log.warning("pyautogui unavailable (%s) — using ctypes SendInput", e)

    def _resolve_display(self, session_id: str = "") -> str:
        if session_id and session_id not in ("", self.WIN_SESSION_ID):
            # Unknown pool ids are rejected so agents notice they are on Windows.
            pool = _read_pool()
            if session_id not in pool and session_id != self.WIN_SESSION_ID:
                raise ValueError(
                    f"unknown session_id: {session_id} "
                    f"(Windows has a single session: {self.WIN_SESSION_ID!r})"
                )
        return "win:main"

    @staticmethod
    def _session_alive(sess: dict) -> bool:
        return True

    def _screen_size(self) -> tuple[int, int]:
        if self._pyautogui is not None:
            sz = self._pyautogui.size()
            return int(sz.width), int(sz.height)
        import ctypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))

    def _take_screenshot(
        self,
        region: str = "",
        fmt: str = "jpeg",
        max_width: int = 0,
        use_cache: bool = True,
    ) -> dict:
        from PIL import ImageGrab

        t0 = time.time()
        bbox = None
        if region:
            parts = [int(x.strip()) for x in region.split(",")]
            if len(parts) == 4:
                x, y, w, h = parts
                bbox = (x, y, x + w, y + h)
        img = ImageGrab.grab(bbox=bbox, all_screens=True)
        path, meta = _encode_screenshot(img, fmt=fmt, max_width=max_width, use_cache=use_cache)
        w, h = self._screen_size()
        return {
            "ok": True,
            "path": str(path),
            "display": "win:main",
            "width": meta.get("width") or img.width,
            "height": meta.get("height") or img.height,
            "screen": f"{w}x{h}",
            "sha": meta.get("sha"),
            "cached": meta.get("cached", False),
            "ms": int((time.time() - t0) * 1000),
        }

    def _sendinput_mouse(self, flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> None:
        import ctypes
        from ctypes import wintypes

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [
                ("dx", wintypes.LONG),
                ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
            ]

        class INPUT(ctypes.Structure):
            class _I(ctypes.Union):
                _fields_ = [("mi", MOUSEINPUT)]

            _anonymous_ = ("i",)
            _fields_ = [("type", wintypes.DWORD), ("i", _I)]

        inp = INPUT()
        inp.type = 0  # INPUT_MOUSE
        inp.mi = MOUSEINPUT(dx, dy, data, flags, 0, None)
        ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))  # type: ignore[attr-defined]

    def _sendinput_key(self, vk: int, up: bool = False) -> None:
        import ctypes
        from ctypes import wintypes

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
            ]

        class INPUT(ctypes.Structure):
            class _I(ctypes.Union):
                _fields_ = [("ki", KEYBDINPUT)]

            _anonymous_ = ("i",)
            _fields_ = [("type", wintypes.DWORD), ("i", _I)]

        KEYEVENTF_KEYUP = 0x0002
        inp = INPUT()
        inp.type = 1  # INPUT_KEYBOARD
        inp.ki = KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP if up else 0, 0, None)
        ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))  # type: ignore[attr-defined]

    def _click_impl(self, x: int, y: int, button: int = 1, double: bool = False) -> None:
        if self._pyautogui is not None:
            btn = {1: "left", 2: "middle", 3: "right"}.get(button, "left")
            clicks = 2 if double else 1
            self._pyautogui.click(x=x, y=y, button=btn, clicks=clicks)
            return
        import ctypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        user32.SetCursorPos(int(x), int(y))
        down_up = {
            1: (0x0002, 0x0004),  # LEFTDOWN/UP
            2: (0x0020, 0x0040),  # MIDDLE
            3: (0x0008, 0x0010),  # RIGHT
        }.get(button, (0x0002, 0x0004))
        n = 2 if double else 1
        for _ in range(n):
            self._sendinput_mouse(down_up[0])
            self._sendinput_mouse(down_up[1])
            time.sleep(0.03)

    def _type_impl(self, text: str, delay_ms: int = 5) -> None:
        if self._pyautogui is not None:
            # interval in seconds
            self._pyautogui.write(text, interval=max(0.0, delay_ms / 1000.0))
            return
        # Fallback: clipboard paste for reliability with unicode
        try:
            import ctypes

            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            CF_UNICODETEXT = 13
            GMEM_MOVEABLE = 0x0002
            data = text.encode("utf-16-le") + b"\x00\x00"
            user32.OpenClipboard(0)
            user32.EmptyClipboard()
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            ptr = kernel32.GlobalLock(h)
            ctypes.memmove(ptr, data, len(data))
            kernel32.GlobalUnlock(h)
            user32.SetClipboardData(CF_UNICODETEXT, h)
            user32.CloseClipboard()
            # Ctrl+V
            self._sendinput_key(0x11, up=False)  # VK_CONTROL
            self._sendinput_key(0x56, up=False)  # V
            self._sendinput_key(0x56, up=True)
            self._sendinput_key(0x11, up=True)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"type_text failed without pyautogui: {e}") from e

    def _keypress_impl(self, key: str, modifiers: Optional[list[str]] = None) -> None:
        mods = [m.lower() for m in (modifiers or [])]
        k = (key or "").lower()
        if self._pyautogui is not None:
            keys = []
            for m in mods:
                if m in ("control", "ctrl"):
                    keys.append("ctrl")
                elif m in ("alt",):
                    keys.append("alt")
                elif m in ("shift",):
                    keys.append("shift")
                elif m in ("win", "meta", "super", "cmd"):
                    keys.append("win")
            # map common names
            pg_map = {
                "return": "enter",
                "escape": "esc",
                "page_up": "pageup",
                "page_down": "pagedown",
            }
            keys.append(pg_map.get(k, k))
            self._pyautogui.hotkey(*keys) if len(keys) > 1 else self._pyautogui.press(keys[0])
            return
        held = [self._MOD_VK[m] for m in mods if m in self._MOD_VK]
        vk = self._VK.get(k)
        if vk is None and len(k) == 1:
            import ctypes

            vk = ctypes.windll.user32.VkKeyScanW(ord(k)) & 0xFF  # type: ignore[attr-defined]
        if vk is None:
            raise ValueError(f"unsupported key on Windows: {key!r}")
        for m in held:
            self._sendinput_key(m, up=False)
        self._sendinput_key(vk, up=False)
        self._sendinput_key(vk, up=True)
        for m in reversed(held):
            self._sendinput_key(m, up=True)

    def _scroll_impl(self, direction: str, amount: int, x: int, y: int) -> None:
        if x >= 0 and y >= 0:
            if self._pyautogui is not None:
                self._pyautogui.moveTo(x, y)
            else:
                import ctypes

                ctypes.windll.user32.SetCursorPos(int(x), int(y))  # type: ignore[attr-defined]
        d = (direction or "down").lower()
        if self._pyautogui is not None:
            if d == "up":
                self._pyautogui.scroll(amount)
            elif d == "down":
                self._pyautogui.scroll(-amount)
            elif d == "left":
                self._pyautogui.hscroll(-amount)
            else:
                self._pyautogui.hscroll(amount)
            return
        # MOUSEEVENTF_WHEEL = 0x0800, HWHEEL = 0x01000; data is wheel delta * 120
        WHEEL = 0x0800
        HWHEEL = 0x01000
        delta = 120 * int(amount)
        if d == "up":
            self._sendinput_mouse(WHEEL, data=delta)
        elif d == "down":
            self._sendinput_mouse(WHEEL, data=-delta)
        elif d == "left":
            self._sendinput_mouse(HWHEEL, data=-delta)
        else:
            self._sendinput_mouse(HWHEEL, data=delta)

    def _list_windows_impl(self) -> list[dict]:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        EnumWindows = user32.EnumWindows
        IsWindowVisible = user32.IsWindowVisible
        GetWindowTextLengthW = user32.GetWindowTextLengthW
        GetWindowTextW = user32.GetWindowTextW
        GetWindowRect = user32.GetWindowRect
        GetClassNameW = user32.GetClassNameW

        results: list[dict] = []

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", wintypes.LONG),
                ("top", wintypes.LONG),
                ("right", wintypes.LONG),
                ("bottom", wintypes.LONG),
            ]

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _lparam):  # type: ignore[misc]
            if not IsWindowVisible(hwnd):
                return True
            n = GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            GetWindowTextW(hwnd, buf, n + 1)
            title = buf.value.strip()
            if not title:
                return True
            rect = RECT()
            GetWindowRect(hwnd, ctypes.byref(rect))
            cls = ctypes.create_unicode_buffer(256)
            GetClassNameW(hwnd, cls, 256)
            results.append(
                {
                    "name": title,
                    "class": cls.value,
                    "x": int(rect.left),
                    "y": int(rect.top),
                    "w": int(rect.right - rect.left),
                    "h": int(rect.bottom - rect.top),
                    "hwnd": int(hwnd),
                }
            )
            return True

        EnumWindows(_cb, 0)
        return results

    async def screenshot(self, session_id, region, fmt, max_width, use_cache) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._take_screenshot(region, fmt, max_width, use_cache)
        )

    async def click(self, x, y, button, double, session_id) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._click_impl(int(x), int(y), int(button), bool(double))
        )
        return {
            "ok": True,
            "x": x,
            "y": y,
            "button": button,
            "double": double,
            "display": "win:main",
        }

    async def type_text(self, text, session_id, delay_ms) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._type_impl(text, int(delay_ms))
        )
        return {"ok": True, "chars": len(text or ""), "display": "win:main"}

    async def keypress(self, key, modifiers, session_id) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._keypress_impl(key, modifiers)
        )
        return {"ok": True, "key": key, "modifiers": modifiers or [], "display": "win:main"}

    async def scroll(self, direction, amount, x, y, session_id) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._scroll_impl(direction, int(amount), int(x), int(y))
        )
        return {
            "ok": True,
            "direction": direction,
            "amount": amount,
            "display": "win:main",
        }

    async def list_windows(self, session_id) -> dict:
        if not IS_WIN:
            return {"ok": True, "windows": [], "display": "win:main", "note": "not on Windows"}
        self._resolve_display(session_id)
        wins = await asyncio.get_event_loop().run_in_executor(None, self._list_windows_impl)
        return {"ok": True, "windows": wins, "display": "win:main", "count": len(wins)}

    async def launch_app(self, command, session_id) -> dict:
        if not IS_WIN:
            return {"ok": False, "error": "WinBackend only runs on Windows"}
        self._resolve_display(session_id)
        cmd = (command or "").strip()
        if not cmd:
            return {"ok": False, "error": "empty command"}
        try:
            # Prefer startfile for apps/paths; fall back to shell.
            if os.path.exists(cmd) or cmd.lower().endswith((".exe", ".bat", ".cmd", ".lnk")):
                os.startfile(cmd)  # type: ignore[attr-defined]
                return {"ok": True, "command": cmd, "method": "startfile", "display": "win:main"}
            proc = subprocess.Popen(
                cmd,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {
                "ok": True,
                "command": cmd,
                "pid": proc.pid,
                "method": "shell",
                "display": "win:main",
            }
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "command": cmd}

    async def ensure_desktop(self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "") -> dict:
        owner = (owner_id or "").strip() or _default_owner_id()
        geo = geometry or DEFAULT_GEOMETRY
        w, h = (0, 0)
        if IS_WIN:
            try:
                w, h = self._screen_size()
                geo = f"{w}x{h}"
            except Exception:  # noqa: BLE001
                pass
        with _PoolLock():
            pool = _read_pool()
            prev = pool.get(self.WIN_SESSION_ID) or {}
            if prev and _lease_held_by_other(prev, owner):
                return {
                    **dict(self._session),
                    **prev,
                    "geometry": prev.get("geometry") or geo,
                    "ok": True,
                    "reused": True,
                    "spawned": False,
                    "shared": True,
                    "warning": (
                        "Windows has a single interactive desktop; "
                        "another owner holds the exclusive lease."
                    ),
                    "other_owner": prev.get("owner_id"),
                }
            s = dict(self._session)
            _apply_lease(s, owner)
            s["geometry"] = geo
            s["owner_pid"] = os.getpid()
            s["limited"] = False
            if w and h:
                s["screen"] = f"{w}x{h}"
            pool[self.WIN_SESSION_ID] = s
            _write_pool(pool)
        return {
            "ok": True,
            "reused": bool(prev),
            "spawned": False,
            "limited": False,
            **s,
        }

    async def acquire_desktop(
        self, geometry: str = DEFAULT_GEOMETRY, owner_id: str = "", force_new: bool = False
    ) -> dict:
        # force_new is a no-op: Windows cannot spawn a second interactive desktop.
        return await self.ensure_desktop(geometry, owner_id=owner_id)

    async def heartbeat_desktop(self, session_id: str, owner_id: str = "") -> dict:
        owner = (owner_id or "").strip() or _default_owner_id()
        with _PoolLock():
            pool = _read_pool()
            s = pool.get(session_id) or pool.get(self.WIN_SESSION_ID) or dict(self._session)
            if _lease_held_by_other(s, owner):
                return {
                    "ok": False,
                    "error": "lease held by another owner",
                    "owner_id": s.get("owner_id"),
                    "lease_until": s.get("lease_until"),
                }
            _apply_lease(s, owner)
            pool[s.get("session_id") or self.WIN_SESSION_ID] = s
            _write_pool(pool)
            return {
                "ok": True,
                "session_id": s.get("session_id") or self.WIN_SESSION_ID,
                "owner_id": s.get("owner_id"),
                "lease_until": s.get("lease_until"),
            }

    async def release_desktop(self, session_id: str) -> dict:
        with _PoolLock():
            pool = _read_pool()
            if session_id in pool:
                del pool[session_id]
                _write_pool(pool)
        return {
            "ok": True,
            "released": session_id,
            "killed": [],
            "note": "Windows: interactive session kept; lease only released",
        }

    async def list_desktops(self) -> dict:
        pool = _read_pool()
        sessions = [{**s, "alive": True} for s in pool.values()]
        if not sessions:
            sessions = [{**self._session, "alive": True}]
        return {"ok": True, "count": len(sessions), "sessions": sessions}

    async def reap_idle_desktops(self) -> dict:
        reaped: list[dict] = []
        with _PoolLock():
            pool = _read_pool()
            for sid in list(pool.keys()):
                s = pool[sid]
                if int(s.get("lease_until") or 0) > 0 and _lease_expired(s):
                    del pool[sid]
                    reaped.append({"session_id": sid, "reason": "lease_expired"})
            if reaped:
                _write_pool(pool)
        return {
            "ok": True,
            "reaped": reaped,
            "count": len(reaped),
            "remaining": len(_read_pool()),
            "note": "Windows: lease metadata only (no VNC process teardown)",
        }


# ─── Backend dispatch ─────────────────────────────────────────────────────────
if IS_MAC:
    BACKEND: Backend = MacBackend()
elif IS_WIN:
    BACKEND = WinBackend()
else:
    BACKEND = X11Backend()
log.info("active backend: %s (platform=%s)", BACKEND.name, platform.system())


def _resolve_display(session_id: str = "") -> str:
    """Module-level convenience used by compound tools — delegates to the backend."""
    return BACKEND._resolve_display(session_id)  # type: ignore[attr-defined]


# ─── FastMCP instance ────────────────────────────────────────────────────────
mcp = FastMCP(
    name="desktop-act",
    instructions=(
        "Computer-use primitives + multi-desktop pool + autonomous act() loop. "
        "OS-agnostic: X11/Xvnc pool on Linux; screencapture+cliclick on macOS; "
        "ImageGrab+pyautogui/SendInput on Windows (single interactive desktop). "
        "Multi-agent: call ensure_desktop(owner_id=…) — exclusive lease per agent; "
        "on Linux, busy seats auto-spawn a new Xvnc; on macOS/Windows only one "
        "real desktop exists (shared lease warning if another owner holds it). "
        "Idle/lease-expired sessions are reaped (Linux also stops VNC). "
        "Pass session_id to primitives. Optimized: SHA-dedupe screenshot cache, JPEG default."
    ),
)


# ─── Primitive tools (delegate to BACKEND) ───────────────────────────────────
@mcp.tool
async def screenshot(
    session_id: str = "",
    region: str = "",
    fmt: str = "jpeg",
    max_width: int = 1280,
    use_cache: bool = True,
) -> dict:
    """Capture the desktop with SHA dedupe cache + optional downscale.

    Args:
      session_id: pool session (empty → default desktop).
      region: "x,y,w,h" sub-rect (empty → full screen).
      fmt: 'jpeg' (default, smaller/faster) or 'png' (lossless).
      max_width: downscale width preserving aspect; 0 = full res.
      use_cache: skip resave when SHA matches previous frame.
    """
    try:
        return await BACKEND.screenshot(session_id, region, fmt, max_width, use_cache)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def click(
    x: int, y: int, button: int = 1, double: bool = False, session_id: str = ""
) -> dict:
    """Click at absolute coords. button: 1=L 2=M 3=R 4=scrollUp 5=scrollDown."""
    try:
        return await BACKEND.click(x, y, button, double, session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def type_text(text: str, session_id: str = "", delay_ms: int = 5) -> dict:
    """Type a string into the focused window. Default delay_ms=5."""
    try:
        return await BACKEND.type_text(text, session_id, delay_ms)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def keypress(key: str, modifiers: Optional[list[str]] = None, session_id: str = "") -> dict:
    """Press a key chord. e.g. key='Return', modifiers=['Control']."""
    try:
        return await BACKEND.keypress(key, modifiers, session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def scroll(
    direction: str, amount: int = 3, x: int = -1, y: int = -1, session_id: str = ""
) -> dict:
    """Scroll up|down|left|right. amount=clicks. Optional warp to x,y first."""
    try:
        return await BACKEND.scroll(direction, amount, x, y, session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def list_windows(session_id: str = "") -> dict:
    """Enumerate top-level windows + geometry."""
    try:
        return await BACKEND.list_windows(session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def launch_app(command: str, session_id: str = "") -> dict:
    """Spawn a GUI app (Linux: 'chromium'/'xterm'; macOS: app name or path via open)."""
    try:
        return await BACKEND.launch_app(command, session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def batch(actions: list[dict], session_id: str = "") -> dict:
    """Execute multiple primitives in one MCP round-trip.

    Each action: {"op": "click"|"type_text"|"keypress"|"scroll"|"sleep_ms", ...args}
    """
    results: list[dict] = []
    try:
        for a in actions:
            op = a.get("op")
            if op == "click":
                r = await click(
                    a["x"],
                    a["y"],
                    a.get("button", 1),
                    a.get("double", False),
                    session_id,
                )
            elif op == "type_text":
                r = await type_text(a["text"], session_id, a.get("delay_ms", 5))
            elif op == "keypress":
                r = await keypress(a["key"], a.get("modifiers"), session_id)
            elif op == "scroll":
                r = await scroll(
                    a["direction"],
                    a.get("amount", 3),
                    a.get("x", -1),
                    a.get("y", -1),
                    session_id,
                )
            elif op == "sleep_ms":
                await asyncio.sleep(int(a.get("ms", 100)) / 1000)
                r = {"ok": True, "slept_ms": a.get("ms")}
            else:
                r = {"ok": False, "error": f"unknown op: {op}"}
            results.append(r)
            if not r.get("ok"):
                break
        return {
            "ok": all(x.get("ok") for x in results),
            "results": results,
            "count": len(results),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "results": results}


# ─── Compound single-round-trip tools ────────────────────────────────────────
@mcp.tool
async def observe(
    session_id: str = "",
    screenshot_format: str = "jpeg",
    screenshot_max_width: int = 1280,
) -> dict:
    """Screenshot + window list in one round-trip (no action taken)."""
    from fastmcp.utilities.types import Image

    try:
        t0 = time.time()
        display = _resolve_display(session_id)
        windows = await list_windows(session_id)
        shot = await BACKEND.screenshot(
            session_id, "", screenshot_format, screenshot_max_width, True
        )
        return {
            "ok": True,
            "display": display,
            "screenshot": shot,
            "image": Image(path=shot["path"]).to_image_content(),
            "windows": windows.get("windows", []),
            "total_ms": int((time.time() - t0) * 1000),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def act_step(
    action: dict,
    settle_ms: int = 200,
    screenshot_format: str = "jpeg",
    screenshot_max_width: int = 1280,
    session_id: str = "",
) -> dict:
    """ONE round-trip: execute action → settle → screenshot → return inline image + hint.

    action: {"op":"click","x":...,"y":...} or {"op":"type_text","text":"..."} etc.
            Use {"op":"batch","actions":[...]} for multi-step sequences.
    """
    from fastmcp.utilities.types import Image

    try:
        t0 = time.time()
        display = _resolve_display(session_id)
        op = action.get("op", "noop")
        if op == "batch":
            action_result = await batch(action.get("actions", []), session_id)
        elif op == "click":
            action_result = await click(
                action["x"],
                action["y"],
                action.get("button", 1),
                action.get("double", False),
                session_id,
            )
        elif op == "type_text":
            action_result = await type_text(action["text"], session_id, action.get("delay_ms", 5))
        elif op == "keypress":
            action_result = await keypress(action["key"], action.get("modifiers"), session_id)
        elif op == "scroll":
            action_result = await scroll(
                action["direction"],
                action.get("amount", 3),
                action.get("x", -1),
                action.get("y", -1),
                session_id,
            )
        elif op == "launch_app":
            action_result = await launch_app(action["command"], session_id)
        elif op == "noop":
            action_result = {"ok": True, "noop": True}
        else:
            return {"ok": False, "error": f"unknown action.op: {op}"}

        pre_windows = await list_windows(session_id)
        if settle_ms:
            await asyncio.sleep(settle_ms / 1000)
        post_windows = await list_windows(session_id)
        shot = await BACKEND.screenshot(
            session_id, "", screenshot_format, screenshot_max_width, True
        )

        pre_n = len(pre_windows.get("windows", []))
        post_n = len(post_windows.get("windows", []))
        delta = post_n - pre_n
        if delta > 0:
            hint = f"new window(s) appeared ({delta}) — likely menu/dialog/launched app"
        elif delta < 0:
            hint = f"window(s) closed ({-delta}) — action may have triggered close"
        elif shot.get("cached"):
            hint = "screen unchanged — action may not have taken effect; verify focus/selector"
        else:
            hint = "screen changed (no window delta) — focus/content change; reason from screenshot"

        return {
            "ok": action_result.get("ok", False),
            "action_result": action_result,
            "screenshot": shot,
            "image": Image(path=shot["path"]).to_image_content(),
            "window_count_delta": delta,
            "hint": hint,
            "display": display,
            "total_ms": int((time.time() - t0) * 1000),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ─── Multi-desktop pool tools (delegate to BACKEND) ──────────────────────────
@mcp.tool
async def ensure_desktop(
    geometry: str = DEFAULT_GEOMETRY,
    owner_id: str = "",
) -> dict:
    """Get an exclusive desktop for this agent (multi-agent safe).

    - Reuses this owner_id's live leased session (refreshes TTL).
    - Else claims an idle/expired pool seat.
    - Else auto-spawns a new Xvnc + noVNC on the next free display/port.
    Never steals a non-expired lease from another owner.

    Pass owner_id (or set DESKTOP_ACT_OWNER). Returns session_id + novnc_url.
    """
    try:
        return await BACKEND.ensure_desktop(geometry, owner_id=owner_id)
    except Exception as e:  # noqa: BLE001
        log.exception("ensure_desktop failed")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def acquire_desktop(
    geometry: str = DEFAULT_GEOMETRY,
    owner_id: str = "",
    force_new: bool = False,
) -> dict:
    """Acquire a desktop session (multi-agent aware).

    Linux: by default same as ensure_desktop (reuse own lease or spawn if busy).
    force_new=True always spawns a fresh exclusive Xvnc seat.
    macOS: returns the single real logged-in session (no second Xvnc).

    Returns {session_id, display, novnc_url, geometry, owner_id, lease_until, ...}.
    """
    try:
        return await BACKEND.acquire_desktop(geometry, owner_id=owner_id, force_new=force_new)
    except Exception as e:  # noqa: BLE001
        log.exception("acquire_desktop failed")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def heartbeat_desktop(session_id: str, owner_id: str = "") -> dict:
    """Refresh the exclusive lease TTL so the idle reaper will not free this session.

    Call periodically during long runs, or after idle gaps, while still using the desktop.
    """
    try:
        return await BACKEND.heartbeat_desktop(session_id, owner_id=owner_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def release_desktop(session_id: str) -> dict:
    """Release a session: free the exclusive lock and stop pool VNC processes.

    Linux: kill the Xvnc + WM + websockify and free its ports.
    macOS: tear down only the noVNC bridge — the user session is never terminated.
    Call on agent stop / task end.
    """
    try:
        return await BACKEND.release_desktop(session_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def list_desktops() -> dict:
    """Return all active sessions in the pool (reaps dead/idle seats first)."""
    try:
        return await BACKEND.list_desktops()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@mcp.tool
async def reap_idle_desktops() -> dict:
    """Free locks and stop VNC for lease-expired or dead pool sessions.

    Reduces host load when agents crash, stop, or go idle past DESKTOP_ACT_LEASE_TTL.
    Does not touch the host default display (e.g. reauth Chrome on :1).
    """
    try:
        return await BACKEND.reap_idle_desktops()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ─── High-level act() — claude-agent-sdk OAuth loop ──────────────────────────
ACT_SYSTEM = """You are the desktop-act executor. You drive a desktop via the
desktop-act MCP primitives (screenshot, click, type_text, keypress, scroll, list_windows,
launch_app, observe, act_step, batch). The human watches via noVNC.

Loop tightly: observe → reason → act_step → check result → repeat. Stay concise.
Stop when the goal is complete or 3 consecutive actions fail."""


@mcp.tool
async def act(
    goal: str,
    max_iterations: int = 20,
    timeout_seconds: int = 600,
    model: str = "claude-sonnet-5",
    session_id: str = "",
) -> dict:
    """Autonomous goal execution via claude-agent-sdk (CLI OAuth, no API key).

    Args:
      goal: natural-language objective.
      max_iterations: turn cap for the inner loop.
      timeout_seconds: hard wall-clock cap.
      model: model id for the inner agent (default: Claude Sonnet 5).
      session_id: target a specific pool session (empty → default desktop).
    """
    run_id = uuid.uuid4().hex[:10]
    log_path = LOG_DIR / f"act-{run_id}.log"
    start = time.time()

    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as e:
        return {
            "ok": False,
            "error": f"claude-agent-sdk not installed: {e}",
            "hint": "venv missing — re-run plugin install",
        }

    sys_prompt = ACT_SYSTEM
    if session_id:
        sys_prompt += f"\n\nTarget desktop session_id={session_id} for all primitives."

    opts = ClaudeAgentOptions(
        system_prompt=sys_prompt,
        permission_mode="bypassPermissions",
        max_turns=max_iterations,
        model=model,
    )

    chunks: list[str] = []
    try:

        async def _run():
            async for msg in query(prompt=goal, options=opts):
                chunks.append(str(msg))

        await asyncio.wait_for(_run(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        log_path.write_text(
            "\n---\n".join(chunks) + f"\n\n*** TIMEOUT after {timeout_seconds}s ***"
        )
        return {
            "ok": False,
            "error": f"timeout after {timeout_seconds}s",
            "turns_seen": len(chunks),
            "log_path": str(log_path),
        }
    except Exception as e:  # noqa: BLE001
        log_path.write_text("\n---\n".join(chunks) + f"\n\n*** ERROR {type(e).__name__}: {e} ***")
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "turns_seen": len(chunks),
            "log_path": str(log_path),
        }

    log_path.write_text("\n---\n".join(chunks))
    final = chunks[-1] if chunks else ""
    shots = list(
        dict.fromkeys(
            re.findall(
                r"/tmp/desktop-act-shots/[A-Za-z0-9_.-]+\.(?:png|jpg)",
                "\n".join(chunks),
            )
        )
    )

    return {
        "ok": True,
        "result": final[-3000:],
        "turns": len(chunks),
        "screenshots": [p for p in shots if Path(p).exists()],
        "log_path": str(log_path),
        "duration_seconds": int(time.time() - start),
        "backend": "claude-agent-sdk (OAuth/Max sub)",
        "session_id": session_id or None,
    }


# ─── Status ──────────────────────────────────────────────────────────────────
@mcp.tool
async def status() -> dict:
    """Report MCP health, active backend, binary discovery, and pool state."""
    try:
        import claude_agent_sdk

        sdk_ver = getattr(claude_agent_sdk, "__version__", "?")
        sdk_ok = True
    except ImportError:
        sdk_ok = False
        sdk_ver = "missing"

    pool = _read_pool()
    return {
        "ok": sdk_ok and CLAUDE_CLI.exists(),
        "platform": platform.system(),
        "backend": BACKEND.name,
        "claude_agent_sdk": sdk_ver,
        "claude_cli": str(CLAUDE_CLI) if CLAUDE_CLI.exists() else "missing",
        "auth_path": "OAuth via Claude Max subscription (no API key)",
        "default_display": DEFAULT_DISPLAY,
        "shot_dir": str(SHOT_DIR),
        "log_dir": str(LOG_DIR),
        "binaries": {k: v or "MISSING" for k, v in BIN.items()},
        "pool_size": len(pool),
        "default_geometry": DEFAULT_GEOMETRY,
        "lease_ttl_sec": LEASE_TTL_SEC,
        "reap_interval_sec": REAP_INTERVAL_SEC,
        "auto_spawn": AUTO_SPAWN,
        "pool_sessions": [
            {
                "session_id": s["session_id"],
                "display": s["display"],
                "novnc_url": s.get("novnc_url"),
                "geometry": s["geometry"],
                "owner_id": s.get("owner_id") or "",
                "lease_until": s.get("lease_until") or 0,
                "lease_expired": _lease_expired(s),
                # Per-session liveness via the active backend (not a blanket probe).
                "alive": BACKEND._session_alive(s),  # type: ignore[attr-defined]
            }
            for s in pool.values()
            # On mac, only surface the canonical session — never stale X11 rows.
            if not IS_MAC or s.get("session_id") == MAC_SESSION_ID
        ],
        "display_range": "mac:main (single session)"
        if IS_MAC
        else f":{DISPLAY_NUM_MIN}-:{DISPLAY_NUM_MAX}",
    }


def _start_idle_reaper() -> None:
    """Background thread: free locks + kill idle/dead pool VNC stacks."""
    if REAP_INTERVAL_SEC <= 0 or not REAP_ON_IDLE:
        log.info(
            "idle reaper disabled (REAP_INTERVAL=%s REAP_ON_IDLE=%s)",
            REAP_INTERVAL_SEC,
            REAP_ON_IDLE,
        )
        return

    def _loop() -> None:
        while True:
            try:
                time.sleep(max(5, REAP_INTERVAL_SEC))
                if hasattr(BACKEND, "reap_idle_desktops"):
                    # Sync path via asyncio.run is heavy; call locked reap when available.
                    if hasattr(BACKEND, "_reap_pool_locked"):
                        with _PoolLock():
                            pool = _read_pool()
                            reaped = BACKEND._reap_pool_locked(pool, reason="bg-idle")  # type: ignore[attr-defined]
                        if reaped:
                            log.info("bg reaper removed %d session(s)", len(reaped))
                    else:
                        # macOS: use async tool path via new event loop
                        try:
                            asyncio.run(BACKEND.reap_idle_desktops())  # type: ignore[misc]
                        except Exception:  # noqa: BLE001
                            pass
            except Exception as e:  # noqa: BLE001
                log.warning("idle reaper tick failed: %s", e)

    t = threading.Thread(target=_loop, name="desktop-act-reaper", daemon=True)
    t.start()
    log.info(
        "idle reaper started interval=%ss lease_ttl=%ss",
        REAP_INTERVAL_SEC,
        LEASE_TTL_SEC,
    )


def _shutdown_owned_sessions() -> None:
    """On process exit / signal: release sessions owned by this process or owner id."""
    owner = _default_owner_id()
    pid = os.getpid()
    try:
        with _PoolLock():
            pool = _read_pool()
            to_release = [
                sid
                for sid, s in pool.items()
                if (s.get("owner_id") or "") == owner or int(s.get("owner_pid") or 0) == pid
            ]
            for sid in to_release:
                if hasattr(BACKEND, "_release_locked"):
                    BACKEND._release_locked(pool, sid)  # type: ignore[attr-defined]
                    log.info("shutdown released session %s", sid)
                else:
                    # mac: clear lease + bridge only
                    s = pool.get(sid)
                    if s:
                        _clear_lease(s)
                        pool[sid] = s
            if to_release and not hasattr(BACKEND, "_release_locked"):
                _write_pool(pool)
    except Exception as e:  # noqa: BLE001
        log.warning("shutdown release failed: %s", e)


def _install_signal_handlers() -> None:
    if RELEASE_ON_EXIT:
        atexit.register(_shutdown_owned_sessions)
    else:
        log.info("RELEASE_ON_EXIT=0 — atexit will not free pool desktops (CLI mode)")

    def _handle(signum, _frame):  # type: ignore[no-untyped-def]
        log.info("signal %s — releasing owned desktops", signum)
        if RELEASE_ON_EXIT:
            _shutdown_owned_sessions()
        # Re-raise default for SIGTERM/SIGINT so the process exits.
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handle)
        except Exception:  # noqa: BLE001
            pass


_start_idle_reaper()
_install_signal_handlers()

if __name__ == "__main__":
    log.info(
        "desktop-act MCP starting — backend=%s pool=%s default_display=%s geometry=%s lease_ttl=%ss",
        BACKEND.name,
        POOL_PATH,
        DEFAULT_DISPLAY,
        DEFAULT_GEOMETRY,
        LEASE_TTL_SEC,
    )
    mcp.run()
