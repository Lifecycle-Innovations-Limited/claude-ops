#!/usr/bin/env python3
"""ops-mcp-reauth — Headless OAuth re-auth for remote MCP servers.

Drives an MCP through its full OAuth consent flow without popping a foreground
browser. Uses Playwright + a persistent Chromium profile so once you've signed
into each provider once (Google, etc.), subsequent re-auths are zero-touch.

Usage:
  ops-mcp-reauth.py <mcp-url>
  ops-mcp-reauth.py --bootstrap   # opens a HEAD-FUL window so the owner can log in
                                  to each provider into the persistent profile
                                  ONE TIME. After that all reauths headless.

Strategy:
  1. Spawn `npx -y mcp-remote <url>` in background, capture stdout.
  2. Parse the `https://.../authorize?...` URL from its output.
  3. Launch Playwright Chromium with persistent context at
     ~/.claude/state/mcp-reauth-browser/.
  4. Navigate to the authorize URL.
  5. If the page contains a Google/MS/etc. login form, abort (need bootstrap).
  6. Otherwise wait for and click any button matching
     /approve|authorize|allow|grant|continue|accept/i.
  7. Watch for redirect to localhost:<port>/oauth/callback — that's
     mcp-remote intercepting the code.
  8. mcp-remote completes the token exchange + writes tokens.json.
  9. Verify tokens.json exists post-flow, return exit 0.

Env:
  POCKET_CLAUDE_BIN     Path to claude binary (unused but kept for parity)
  MCP_REAUTH_HEADLESS   default 1; set 0 to see the browser (debug)
  MCP_REAUTH_TIMEOUT    seconds per MCP, default 90
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

LOG_PREFIX = "[ops-mcp-reauth]"
HOME = Path(os.path.expanduser("~"))
STATE_DIR = HOME / ".claude/state/mcp-reauth"
BROWSER_PROFILE = HOME / ".claude/state/mcp-reauth-browser"
LOG_FILE = STATE_DIR / "run.log"

HEADLESS = os.environ.get("MCP_REAUTH_HEADLESS", "1") == "1"
TIMEOUT = int(os.environ.get("MCP_REAUTH_TIMEOUT", "90"))

# Regex for the OAuth authorize URL mcp-remote logs
AUTH_URL_RE = re.compile(r"(https?://[^\s\"'<>]+/authorize\?[^\s\"'<>]+)")


def now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now_iso()} {LOG_PREFIX} {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def find_tokens_path(url: str) -> Path | None:
    h = hashlib.md5(url.encode()).hexdigest()
    base = HOME / ".mcp-auth"
    if not base.is_dir():
        return None
    for d in sorted(base.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        if not d.is_dir() or not d.name.startswith("mcp-remote-"):
            continue
        tp = d / f"{h}_tokens.json"
        if tp.exists():
            return tp
    return None


def spawn_mcp_remote(url: str) -> tuple[subprocess.Popen, str | None]:
    """Spawn npx mcp-remote, parse the authorize URL from its first output.
    Returns (process, auth_url). Caller must kill the process after capture.
    """
    log(f"spawning npx mcp-remote {url}")
    proc = subprocess.Popen(
        ["npx", "-y", "mcp-remote", url],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        bufsize=1, text=True,
        # New process group so we can kill cleanly
        preexec_fn=os.setsid,
    )
    auth_url = None
    deadline = time.time() + 25
    buf_lines: list[str] = []
    while time.time() < deadline:
        line = proc.stdout.readline() if proc.stdout else ""
        if not line:
            if proc.poll() is not None:
                break
            time.sleep(0.1)
            continue
        buf_lines.append(line)
        m = AUTH_URL_RE.search(line)
        if m:
            auth_url = m.group(1)
            log(f"captured authorize URL: {auth_url[:100]}...")
            break
        # Also check if it says "Connected" — then no auth needed
        if "Connected to remote server" in line or "Proxy established" in line:
            log("mcp-remote connected without needing OAuth — token was still valid")
            return (proc, None)
    if not auth_url:
        log(f"no authorize URL in mcp-remote output. Last lines: {''.join(buf_lines[-5:])[:400]}")
    return (proc, auth_url)


def drive_consent(auth_url: str) -> bool:
    """Open the authorize URL in persistent-profile Chromium and click approve.
    Returns True if a localhost callback was observed.
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        log("playwright not installed — run: pip install playwright && playwright install chromium")
        return False

    BROWSER_PROFILE.mkdir(parents=True, exist_ok=True)
    callback_seen = {"hit": False}

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(BROWSER_PROFILE),
            headless=HEADLESS,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.new_page()

        # Watch for the localhost callback redirect — that's the success signal
        def on_request(req):
            if "localhost" in req.url and "/oauth/callback" in req.url:
                callback_seen["hit"] = True
                log(f"callback intercepted: {req.url[:120]}")

        page.on("request", on_request)

        try:
            page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)
        except PWTimeout:
            log("authorize URL load timeout")
            ctx.close()
            return False
        except Exception as e:
            log(f"goto failed: {type(e).__name__}: {e}")
            ctx.close()
            return False

        log(f"loaded page: {page.url[:100]}")

        # If the page is asking us to LOG IN (not just approve), bail out and tell user to bootstrap
        page_text = (page.content() or "").lower()
        login_indicators = ["sign in to google", "enter your email", "password", "log in with"]
        if any(ind in page_text for ind in login_indicators) and not callback_seen["hit"]:
            log("page appears to require interactive login — run with --bootstrap once to sign in")
            ctx.close()
            return False

        # Try to find and click an "approve" / "authorize" / "allow" button
        button_patterns = [
            re.compile(r"^\s*approve\s*$", re.I),
            re.compile(r"^\s*authorize\s*$", re.I),
            re.compile(r"^\s*allow\s*$", re.I),
            re.compile(r"^\s*grant\s*$", re.I),
            re.compile(r"^\s*continue\s*$", re.I),
            re.compile(r"^\s*accept\s*$", re.I),
            re.compile(r"^\s*confirm\s*$", re.I),
        ]
        clicked = False
        for pat in button_patterns:
            try:
                btn = page.get_by_role("button", name=pat).first
                if btn.is_visible(timeout=1500):
                    log(f"clicking button matching {pat.pattern}")
                    btn.click()
                    clicked = True
                    break
            except Exception:
                continue
        if not clicked:
            # Fallback: try anchor links with these labels
            for pat in button_patterns:
                try:
                    a = page.get_by_role("link", name=pat).first
                    if a.is_visible(timeout=500):
                        log(f"clicking link matching {pat.pattern}")
                        a.click()
                        clicked = True
                        break
                except Exception:
                    continue
        if not clicked:
            log("no Approve/Authorize button found on page")
            try:
                # Dump button labels for debugging
                btns = page.evaluate("[...document.querySelectorAll('button,a')].slice(0,15).map(b=>b.innerText?.slice(0,60))")
                log(f"visible buttons/links: {btns}")
            except Exception:
                pass
            ctx.close()
            return False

        # Wait up to 8s for callback
        deadline = time.time() + 8
        while time.time() < deadline and not callback_seen["hit"]:
            page.wait_for_timeout(250)

        ctx.close()
        return callback_seen["hit"]


def main() -> int:
    if len(sys.argv) < 2:
        log("usage: ops-mcp-reauth.py <mcp-url>")
        return 2
    if sys.argv[1] == "--bootstrap":
        # Open a head-ful browser session so user can sign into providers ONCE.
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            log("playwright not installed")
            return 3
        # Default bootstrap targets — the providers that watchdog reports as
        # needs_bootstrap. Override via CLI: --bootstrap <url1> <url2> ...
        extra_urls = sys.argv[2:]
        bootstrap_urls = extra_urls or [
            "https://vercel.com/login",
            "https://app.eu.amplitude.com/login",
        ]
        log("BOOTSTRAP MODE — sign into each tab, then close the window when done")
        log(f"opening {len(bootstrap_urls)} provider login page(s): {bootstrap_urls}")
        BROWSER_PROFILE.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(str(BROWSER_PROFILE), headless=False)
            pages = []
            for u in bootstrap_urls:
                pg = ctx.new_page()
                try:
                    pg.goto(u, wait_until="domcontentloaded", timeout=20000)
                except Exception as e:
                    log(f"failed to load {u}: {e}")
                pages.append(pg)
            # Block until every bootstrap tab is closed (or 10 min total hard cap).
            # Waiting only on the last-opened tab exits early if the user closes
            # tabs in a different order, tearing down the context while other
            # sign-ins are still in progress.
            deadline = time.monotonic() + 600
            while True:
                open_pages = [p for p in pages if not p.is_closed()]
                if not open_pages:
                    break
                remaining_ms = int(max(0, (deadline - time.monotonic()) * 1000))
                if remaining_ms <= 0:
                    break
                try:
                    open_pages[0].wait_for_event("close", timeout=remaining_ms)
                except Exception:
                    break
        return 0

    url = sys.argv[1]
    proc, auth_url = spawn_mcp_remote(url)
    try:
        if auth_url is None:
            log("nothing to do — mcp-remote already connected (or no auth URL found)")
            return 0
        ok = drive_consent(auth_url)
        if not ok:
            log("consent flow did NOT complete")
            return 1
        # Wait briefly for mcp-remote to write tokens.json
        time.sleep(2)
        tp = find_tokens_path(url)
        if tp and tp.exists():
            log(f"✓ tokens written to {tp}")
            return 0
        log("consent OK but tokens.json not found — mcp-remote may need more time")
        return 0  # not a hard failure
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted")
        sys.exit(130)
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
