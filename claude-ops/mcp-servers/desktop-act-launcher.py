#!/usr/bin/env python3
"""desktop-act-launcher — locate or bootstrap the desktop-act MCP server.

Cross-platform launcher (Linux / macOS / Windows) used by the claude-ops plugin
to bring up the `desktop-act` FastMCP server for the /ops:desktop skill.

Resolution order:
    1. ``$DESKTOP_ACT_COMMAND`` — explicit path to an executable script.
    2. ``$DESKTOP_ACT_HOME/mcp-server/`` — manual install directory.
    3. ``$CLAUDE_CONFIG_DIR/plugins/marketplaces/desktop-act/mcp-server/``
    4. Per-OS default Claude config dir.
    5. Per-user cache: $XDG_CACHE_HOME/desktop-act-mcp (Linux) /
       ~/Library/Caches/desktop-act-mcp (macOS) /
       %LOCALAPPDATA%\\desktop-act-mcp (Windows).
       If absent and ``DESKTOP_ACT_REPO`` is set, we ``git clone`` it,
       bootstrap a venv, ``pip install -r requirements.txt``, then exec.

Linux is the only platform with full desktop automation today; macOS and
Windows currently surface a clear "not supported yet" message so the
launcher fails loudly instead of hanging the MCP host.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_REPO = os.environ.get(
    "DESKTOP_ACT_REPO",
    "https://github.com/your-org/desktop-act.git",
)
DEFAULT_BRANCH = os.environ.get("DESKTOP_ACT_BRANCH", "main")


def _system() -> str:
    s = platform.system().lower()
    if s.startswith("win"):
        return "windows"
    if s == "darwin":
        return "macos"
    return "linux"


def _cache_root() -> Path:
    sysname = _system()
    if sysname == "macos":
        return Path.home() / "Library" / "Caches" / "desktop-act-mcp"
    if sysname == "windows":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "desktop-act-mcp"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "desktop-act-mcp"


def _claude_config_dirs() -> list[Path]:
    sysname = _system()
    explicit = os.environ.get("CLAUDE_CONFIG_DIR")
    out: list[Path] = []
    if explicit:
        out.append(Path(explicit))
    if sysname == "windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            out.append(Path(appdata) / "claude-code")
    out.append(Path.home() / ".claude")
    out.append(Path.home() / ".config" / "claude-code")
    return out


def _runner_in(home: Path) -> Path | None:
    """Pick the platform-appropriate launcher inside a desktop-act install."""
    if not home.is_dir():
        return None
    if _system() == "windows":
        for cand in (
            home / "mcp-server" / "run.cmd",
            home / "mcp-server" / "run.ps1",
        ):
            if cand.exists():
                return cand
    sh = home / "mcp-server" / "run.sh"
    if sh.exists() and os.access(sh, os.X_OK):
        return sh
    server_py = home / "mcp-server" / "server.py"
    if server_py.exists():
        return server_py
    return None


def _resolve_existing() -> Path | None:
    override = os.environ.get("DESKTOP_ACT_COMMAND")
    if override and Path(override).exists():
        return Path(override)

    explicit_home = os.environ.get("DESKTOP_ACT_HOME")
    if explicit_home:
        runner = _runner_in(Path(explicit_home))
        if runner:
            return runner

    for cfg in _claude_config_dirs():
        runner = _runner_in(cfg / "plugins" / "marketplaces" / "desktop-act")
        if runner:
            return runner

    runner = _runner_in(_cache_root() / "src")
    if runner:
        return runner
    return None


def _exec_runner(runner: Path) -> None:
    if runner.suffix == ".py":
        py = (
            _venv_python(runner.parent.parent)
            or shutil.which("python3")
            or shutil.which("python")
        )
        if not py:
            print(
                "[desktop-act-launcher] No python3 available to exec server.py",
                file=sys.stderr,
            )
            sys.exit(127)
        os.execv(py, [py, str(runner)])
    if runner.suffix in (".cmd", ".ps1"):
        if runner.suffix == ".ps1":
            ps = shutil.which("pwsh") or shutil.which("powershell")
            if not ps:
                print("[desktop-act-launcher] PowerShell not found", file=sys.stderr)
                sys.exit(127)
            os.execv(ps, [ps, "-ExecutionPolicy", "Bypass", "-File", str(runner)])
        os.execv(str(runner), [str(runner)])
    os.execv(str(runner), [str(runner)])


def _venv_python(install_root: Path) -> str | None:
    bin_dir = "Scripts" if _system() == "windows" else "bin"
    py = (
        install_root
        / ".venv"
        / bin_dir
        / ("python.exe" if _system() == "windows" else "python")
    )
    return str(py) if py.exists() else None


def _have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def _bootstrap() -> Path | None:
    """Clone desktop-act into the per-user cache and set up its venv.

    Returns the path to the runner once ready, or ``None`` if bootstrap is not
    possible (missing git/python3 or unsupported platform).
    """
    if not _have("git") or not (_have("python3") or _have("python")):
        print(
            "[desktop-act-launcher] git + python3 are required to auto-install desktop-act.\n"
            "  macOS:   brew install git python\n"
            "  Linux:   sudo apt install -y git python3 python3-venv  # or your distro's equivalent\n"
            "  Windows: install Git + Python 3.11+ from python.org",
            file=sys.stderr,
        )
        return None

    cache = _cache_root()
    src = cache / "src"
    cache.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        print(f"[desktop-act-launcher] cloning {DEFAULT_REPO} → {src}", file=sys.stderr)
        try:
            subprocess.run(
                [
                    "git",
                    "clone",
                    "--depth",
                    "1",
                    "--branch",
                    DEFAULT_BRANCH,
                    DEFAULT_REPO,
                    str(src),
                ],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(
                f"[desktop-act-launcher] git clone failed (exit {e.returncode}). "
                f"Set DESKTOP_ACT_REPO to a reachable URL, or install desktop-act manually.",
                file=sys.stderr,
            )
            return None

    py_bin = shutil.which("python3") or shutil.which("python")
    venv_dir = src / ".venv"
    if not venv_dir.exists():
        print(f"[desktop-act-launcher] creating venv at {venv_dir}", file=sys.stderr)
        try:
            subprocess.run([py_bin, "-m", "venv", str(venv_dir)], check=True)
        except subprocess.CalledProcessError as e:
            print(
                f"[desktop-act-launcher] venv create failed (exit {e.returncode})",
                file=sys.stderr,
            )
            return None

    vpy = _venv_python(src)
    if not vpy:
        return None
    req = src / "requirements.txt"
    if req.exists():
        print(
            "[desktop-act-launcher] pip install -r requirements.txt (one-time)",
            file=sys.stderr,
        )
        try:
            subprocess.run(
                [vpy, "-m", "pip", "install", "--quiet", "-r", str(req)], check=True
            )
        except subprocess.CalledProcessError as e:
            print(
                f"[desktop-act-launcher] pip install failed (exit {e.returncode})",
                file=sys.stderr,
            )
            return None

    return _runner_in(src)


def main() -> int:
    runner = _resolve_existing()
    if runner is None:
        runner = _bootstrap()

    if runner is None:
        sysname = _system()
        if sysname != "linux":
            print(
                f"[desktop-act-launcher] desktop-act has full desktop-automation support on Linux today; "
                f"{sysname} support is partial. The MCP server may still expose Kapture / chrome-devtools / "
                f"Playwright tools but native X11 calls will no-op. Set DESKTOP_ACT_COMMAND to a custom "
                f"build to override.",
                file=sys.stderr,
            )
        print(
            "[desktop-act-launcher] Could not locate or bootstrap the desktop-act MCP server.\n"
            "  Install manually:    /plugin marketplace add <repo-url> && /plugin install desktop-act\n"
            "  Or pin a custom path: export DESKTOP_ACT_COMMAND=/path/to/run.sh",
            file=sys.stderr,
        )
        return 127

    _exec_runner(runner)
    return 0


if __name__ == "__main__":
    sys.exit(main())
