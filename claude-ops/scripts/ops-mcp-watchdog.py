#!/usr/bin/env python3
"""ops-mcp-watchdog — Detect MCP server health, notify the owner on degradation.

Every cron tick:
  1. For each HTTP MCP in ~/.claude.json, probe with a JSON-RPC `initialize`
     using the cached Bearer (or API key). Classify:
       healthy        — 200 OK, MCP server responded with init result
       token_expired  — 401, refresh_token exists → recoverable via OAuth refresh
       needs_bootstrap— 401, no refresh_token → user must do interactive consent
       cloudflare_ua  — 403 from Cloudflare's bot challenge (UA filter)
       unreachable    — DNS / connection failure
       server_error   — 5xx
  2. Diff vs last tick's state. If a previously-healthy MCP degrades, send
     WhatsApp notification with a re-auth link (if interactive consent needed)
     OR auto-attempt the refresh_token flow (if recoverable).
  3. Write current state to ~/.claude/state/mcp-watchdog/state.json (audit).

Env:
  MCP_WATCHDOG_AUTO_REFRESH=1  (default 1) — attempt silent OAuth refresh
                               when token_expired. Set 0 to disable.
  MCP_WATCHDOG_NOTIFY=1        (default 1) — fire WhatsApp on new degradations.
  POCKET_STATE_DIR              for WhatsApp config lookup
  MCP_WATCHDOG_PROBE_TIMEOUT    default 6s per MCP

Cron: */5 * * * *
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerr
from urllib import parse as urlparse
from urllib import request as urlreq

LOG_PREFIX = "[ops-mcp-watchdog]"
HOME = Path(os.path.expanduser("~"))
STATE_DIR = HOME / ".claude/state/mcp-watchdog"
POCKET_STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
STATE_FILE = STATE_DIR / "state.json"
LAST_STATE_FILE = STATE_DIR / "state.last.json"
HEALTH = STATE_DIR / ".health"
LOG_FILE = STATE_DIR / "run.log"

AUTO_REFRESH = os.environ.get("MCP_WATCHDOG_AUTO_REFRESH", "1") == "1"
AUTO_REAUTH = os.environ.get("MCP_WATCHDOG_AUTO_REAUTH", "1") == "1"
NOTIFY = os.environ.get("MCP_WATCHDOG_NOTIFY", "1") == "1"
PROBE_TIMEOUT = int(os.environ.get("MCP_WATCHDOG_PROBE_TIMEOUT", "6"))
REAUTH_SCRIPT = Path(__file__).resolve().parent / "ops-mcp-reauth.py"

UA_HEADER = "ops-mcp-watchdog/0.1 (Mozilla/5.0)"

# MCPs that use a Bearer API key (not OAuth). The key lives in keychain under
# the listed `keychain_service` name; we'll inject it as Authorization: Bearer.
API_KEY_MCPS = {
    "pocketai": {"keychain_service": "POCKET_API_KEY", "account": "ops-daemon"},
}


def get_api_key_for(name: str) -> str | None:
    spec = API_KEY_MCPS.get(name)
    if not spec:
        return None
    try:
        out = subprocess.run(
            ["security", "find-generic-password",
             "-s", spec["keychain_service"], "-a", spec["account"], "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now_iso()} {LOG_PREFIX} {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def write_health(status: str, msg: str = "", extra: dict | None = None) -> None:
    payload = {"status": status, "message": msg, "last_run": now_iso()}
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEALTH.write_text(json.dumps(payload, indent=2))
    except OSError as e:
        log(f"health write failed: {e}")


def list_http_mcps() -> dict[str, str]:
    """Returns {name: url} for all HTTP MCPs in ~/.claude.json."""
    try:
        d = json.loads((HOME / ".claude.json").read_text())
    except Exception as e:
        log(f"cannot read .claude.json: {e}")
        return {}
    out = {}
    for name, cfg in (d.get("mcpServers") or {}).items():
        if cfg.get("type") == "http" and cfg.get("url"):
            out[name] = cfg["url"]
    return out


def claude_code_health() -> dict | None:
    """Claude Code maintains its own MCP health cache. Use it as ground truth
    when fresh (it's the canonical view of what active sessions see).
    Falls back to None if missing or stale (>15 min old).
    """
    p = HOME / ".claude/mcp-health-cache.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text())
        ts = d.get("ts", 0)
        if not ts:
            return None
        age_sec = time.time() - ts
        # 24h is generous — Claude Code only updates this cache on session
        # events (startup, MCP reconnect, settings change). It does NOT
        # heartbeat. So even a "stale" cache is closer to truth than our HTTP
        # probe, which doesn't see the in-memory tokens Claude Code holds.
        if age_sec > 86400:
            return None
        return d
    except Exception:
        return None


def find_token_cache(url: str) -> tuple[Path | None, Path | None]:
    """Locate (tokens.json, client_info.json) under ~/.mcp-auth/mcp-remote-*/."""
    h = hashlib.md5(url.encode()).hexdigest()
    base = HOME / ".mcp-auth"
    if not base.is_dir():
        return (None, None)
    for d in sorted(base.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        if not d.is_dir() or not d.name.startswith("mcp-remote-"):
            continue
        tp = d / f"{h}_tokens.json"
        cp = d / f"{h}_client_info.json"
        if tp.exists():
            return (tp, cp if cp.exists() else None)
    return (None, None)


def probe(url: str, mcp_name: str = "") -> dict:
    """Probe one MCP. Returns {state, http_code, detail, ...}."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": UA_HEADER,
    }

    # API-key MCPs (pocketai etc.)
    api_key = get_api_key_for(mcp_name)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        tokens = None  # Skip OAuth token cache lookup for API-key MCPs
        tokens_path = None
    else:
        tokens_path, client_path = find_token_cache(url)
        tokens = None
        if tokens_path:
            try:
                tokens = json.loads(tokens_path.read_text())
            except Exception:
                pass
        if tokens and tokens.get("access_token"):
            headers["Authorization"] = f"Bearer {tokens['access_token']}"

    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "ops-mcp-watchdog", "version": "0.1"},
        },
    }).encode()

    req = urlreq.Request(url, data=body, headers=headers, method="POST")
    try:
        resp = urlreq.urlopen(req, timeout=PROBE_TIMEOUT)
    except urlerr.HTTPError as e:
        code = e.code
        err = ""
        try:
            err = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            pass
        if code == 401:
            has_refresh = bool(tokens and tokens.get("refresh_token"))
            return {
                "state": "token_expired" if has_refresh else "needs_bootstrap",
                "http_code": 401,
                "detail": err[:120],
                "has_refresh_token": has_refresh,
                "tokens_present": bool(tokens),
            }
        if code == 403:
            # Cloudflare 1010 bot challenge etc.
            if "cloudflare" in err.lower() or "1010" in err:
                return {"state": "cloudflare_ua", "http_code": 403, "detail": err[:120]}
            return {"state": "forbidden", "http_code": 403, "detail": err[:120]}
        if 500 <= code < 600:
            return {"state": "server_error", "http_code": code, "detail": err[:120]}
        return {"state": f"http_{code}", "http_code": code, "detail": err[:120]}
    except urlerr.URLError as e:
        return {"state": "unreachable", "detail": str(e)[:160]}
    except Exception as e:
        return {"state": "probe_error", "detail": f"{type(e).__name__}: {e}"[:200]}

    # 2xx — read just the first SSE event or JSON
    try:
        # Read up to a few KB to avoid hanging on SSE keep-alive
        chunk = resp.read(4096).decode("utf-8", errors="replace")
        # Look for an init result anywhere in the chunk
        ok = '"result"' in chunk and '"protocolVersion"' in chunk
        resp.close()
        if ok:
            return {"state": "healthy", "http_code": 200}
        return {"state": "weird_2xx", "http_code": 200, "detail": chunk[:200]}
    except Exception as e:
        return {"state": "read_error", "detail": str(e)[:160]}


def attempt_refresh(url: str) -> bool:
    """Use direct OAuth refresh-token POST (no mcp-remote). Returns True on success."""
    tokens_path, client_path = find_token_cache(url)
    if not tokens_path:
        return False
    try:
        tokens = json.loads(tokens_path.read_text())
    except Exception:
        return False
    refresh = tokens.get("refresh_token")
    if not refresh:
        return False

    # Resolve token endpoint
    token_endpoint = None
    if client_path:
        try:
            ci = json.loads(client_path.read_text())
            token_endpoint = ci.get("token_endpoint")
        except Exception:
            pass
    if not token_endpoint:
        parsed = urlparse.urlparse(url)
        wkw = f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-authorization-server"
        try:
            with urlreq.urlopen(urlreq.Request(wkw, headers={"User-Agent": UA_HEADER}), timeout=8) as r:
                meta = json.loads(r.read().decode())
                token_endpoint = meta.get("token_endpoint")
        except Exception:
            pass
    if not token_endpoint:
        parsed = urlparse.urlparse(url)
        token_endpoint = f"{parsed.scheme}://{parsed.netloc}/token"

    client_id = ""
    if client_path:
        try:
            ci = json.loads(client_path.read_text())
            client_id = ci.get("client_id", "")
        except Exception:
            pass

    form = {"grant_type": "refresh_token", "refresh_token": refresh}
    if client_id:
        form["client_id"] = client_id
    req = urlreq.Request(
        token_endpoint, data=urlparse.urlencode(form).encode(), method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json",
                 "User-Agent": UA_HEADER},
    )
    try:
        with urlreq.urlopen(req, timeout=15) as resp:
            new_tokens = json.loads(resp.read().decode())
    except Exception as e:
        log(f"refresh POST failed for {url}: {type(e).__name__}: {e}")
        return False

    merged = dict(tokens)
    merged.update(new_tokens)
    if "refresh_token" not in new_tokens:
        merged["refresh_token"] = refresh
    if "expires_at" not in new_tokens and "expires_in" in new_tokens:
        merged["expires_at"] = int((time.time() + new_tokens["expires_in"]) * 1000)

    tmp = tokens_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, indent=2))
    os.replace(tmp, tokens_path)
    return True


def whatsapp_notify(message: str) -> bool:
    """Send WhatsApp notification via the configured pocket chat. Best-effort."""
    cfg_path = POCKET_STATE_DIR / "whatsapp-config.json"
    if not cfg_path.exists():
        return False
    try:
        cfg = json.loads(cfg_path.read_text())
    except Exception:
        return False
    if not cfg.get("enabled") or not cfg.get("chat_jid"):
        return False

    # Use the WhatsApp MCP server's HTTP bridge directly (bypasses Claude-via-MCP)
    # The Baileys bridge listens on localhost:8080 for `whatsmeow`-style sends.
    # But the cleaner path: spawn `claude -p` with the MCP call. To stay
    # dependency-free, we'll write a notification file and let the supervisor
    # pick it up on its next wake — that's the path that already exists.
    queue = POCKET_STATE_DIR / "supervisor-out-queue.jsonl"
    try:
        queue.parent.mkdir(parents=True, exist_ok=True)
        with queue.open("a") as f:
            f.write(json.dumps({
                "ts": now_iso(),
                "kind": "whatsapp",
                "chat_jid": cfg["chat_jid"],
                "message": message,
            }) + "\n")
        return True
    except OSError:
        return False


def macos_notify(title: str, msg: str) -> None:
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{msg}" with title "{title}" sound name "Glass"'],
            timeout=5, capture_output=True,
        )
    except Exception:
        pass


def main() -> int:
    write_health("running", "tick")
    log("watchdog tick")
    mcps = list_http_mcps()
    if not mcps:
        log("no HTTP MCPs configured")
        write_health("ok", "no mcps")
        return 0

    # Prefer Claude Code's own health cache (canonical truth from active sessions)
    cc_health = claude_code_health()
    cc_auth_needed = set(cc_health.get("auth_list", []) or []) if cc_health else None
    cc_failed = set(cc_health.get("failed_list", []) or []) if cc_health else None
    if cc_health is not None:
        log(f"using Claude Code health cache: connected={cc_health.get('connected')} "
            f"auth_needed={len(cc_auth_needed or [])} failed={len(cc_failed or [])}")

    # Load previous state for diffing
    last_state = {}
    if LAST_STATE_FILE.exists():
        try:
            last_state = json.loads(LAST_STATE_FILE.read_text())
        except Exception:
            pass

    cur_state = {}
    summary = {"healthy": 0, "token_expired": 0, "needs_bootstrap": 0,
               "cloudflare_ua": 0, "server_error": 0, "unreachable": 0, "other": 0}
    recovered = []
    degraded = []

    for name, url in mcps.items():
        # If Claude Code's cache is fresh, trust it over our direct HTTP probe.
        # Names in the cache may be prefixed like 'plugin:cloudflare:cloudflare-api'.
        if cc_health is not None:
            in_auth = any(n.endswith(name) for n in (cc_auth_needed or set()))
            in_failed = any(n.endswith(name) for n in (cc_failed or set()))
            if in_failed:
                result = {"state": "needs_bootstrap", "via": "claude_code_cache",
                          "detail": "Claude Code reports failed"}
            elif in_auth:
                result = {"state": "needs_bootstrap", "via": "claude_code_cache",
                          "detail": "Claude Code reports auth needed"}
            else:
                result = {"state": "healthy", "via": "claude_code_cache"}
            result["url"] = url
            result["probed_at"] = now_iso()
            cur_state[name] = result
            state = result["state"]
            summary[state] = summary.get(state, 0) + 1
            prev = (last_state.get(name) or {}).get("state")
            if prev == "healthy" and state != "healthy":
                degraded.append((name, state, result.get("detail", "")))
            if prev and prev != "healthy" and state == "healthy":
                recovered.append(name)
            continue

        # Fallback: direct HTTP probe (used when CC cache is missing/stale)
        result = probe(url, name)
        result["url"] = url
        result["probed_at"] = now_iso()
        cur_state[name] = result
        state = result["state"]
        if state in summary:
            summary[state] += 1
        else:
            summary["other"] += 1

        prev = (last_state.get(name) or {}).get("state")

        # Auto-refresh attempt for token_expired
        if state == "token_expired" and AUTO_REFRESH:
            log(f"{name}: token_expired, attempting silent refresh")
            if attempt_refresh(url):
                log(f"{name}: refresh ok, re-probing")
                result2 = probe(url, name)
                result2["url"] = url
                result2["probed_at"] = now_iso()
                result2["recovered_via"] = "refresh_token_post"
                cur_state[name] = result2
                state = result2["state"]
                if state == "healthy":
                    summary["token_expired"] -= 1
                    summary["healthy"] += 1

        # Diff: degraded means previously healthy now not
        if prev == "healthy" and cur_state[name]["state"] != "healthy":
            degraded.append((name, cur_state[name]["state"], cur_state[name].get("detail", "")))
        if prev and prev != "healthy" and cur_state[name]["state"] == "healthy":
            recovered.append(name)

    # Auto-reauth via Playwright for needs_bootstrap MCPs
    if AUTO_REAUTH and REAUTH_SCRIPT.exists():
        for name, info in cur_state.items():
            if info.get("state") != "needs_bootstrap":
                continue
            log(f"{name}: attempting Playwright auto-reauth")
            try:
                proc = subprocess.run(
                    [sys.executable, str(REAUTH_SCRIPT), info["url"]],
                    capture_output=True, text=True, timeout=120,
                )
                if proc.returncode == 0:
                    log(f"{name}: reauth script exit 0 — re-probing")
                    new_result = probe(info["url"], name)
                    new_result["url"] = info["url"]
                    new_result["probed_at"] = now_iso()
                    new_result["recovered_via"] = "playwright_reauth"
                    cur_state[name] = new_result
                    if new_result["state"] == "healthy":
                        recovered.append(name)
                        # Remove from degraded if present
                        degraded = [d for d in degraded if d[0] != name]
                else:
                    log(f"{name}: reauth script exit {proc.returncode}: {proc.stderr.strip()[:160]}")
            except subprocess.TimeoutExpired:
                log(f"{name}: reauth timed out")
            except Exception as e:
                log(f"{name}: reauth error: {type(e).__name__}: {e}")

    # Notify on new degradations
    if degraded and NOTIFY:
        bullets = "\n".join(f"• {n} → {s} ({d[:60]})" for n, s, d in degraded)
        macos_notify("MCP degradation", f"{len(degraded)} MCP(s) need attention")
        whatsapp_notify(
            f"⚠️ MCP watchdog — {len(degraded)} server(s) degraded:\n\n{bullets}\n\n"
            f"Run `pocket mcps` for details. Open Claude Code to re-auth via browser, "
            f"or build out the Playwright auto-approver if you want zero-touch."
        )
        log(f"notified about {len(degraded)} degradations")
    if recovered:
        log(f"recovered: {', '.join(recovered)}")

    # Persist
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if STATE_FILE.exists():
        try:
            STATE_FILE.rename(LAST_STATE_FILE)
        except OSError:
            pass
    STATE_FILE.write_text(json.dumps(cur_state, indent=2))

    write_health("ok", json.dumps(summary, separators=(",", ":")), extra={
        "summary": summary, "degraded_count": len(degraded), "recovered_count": len(recovered),
    })
    log(f"done summary={summary} degraded={len(degraded)} recovered={len(recovered)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
