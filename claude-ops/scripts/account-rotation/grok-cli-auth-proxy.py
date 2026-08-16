#!/usr/bin/env python3
"""OpenAI-compatible local proxy backed by SuperGrok CLI OAuth (multi-account).

Ported into claude-ops. Host path ~/.local/bin is not required.
Configure seats via GROK_PREFERRED_EMAILS / GROK_SLOT_FILES / ~/.grok/auth-slots.

Reads OAuth grants from ~/.grok/auth.json plus ~/.grok/auth-slots/*.json, refreshes
tokens under a lock, and forwards coding traffic to cli-chat-proxy.grok.com so
callers stay on SuperGrok subscription seats instead of metered api.x.ai credits.

Seats are load-balanced (round-robin) across all non-exhausted SuperGrok OAuth
accounts. On 429/quota the failing seat is cooled down and the request retries
on another seat.
"""

from __future__ import annotations

import base64
import datetime as dt
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

AUTH_FILE = Path(os.environ.get("GROK_AUTH_FILE", str(Path.home() / ".grok" / "auth.json"))).expanduser()
LOCK_FILE = Path(os.environ.get("GROK_AUTH_LOCK_FILE", str(AUTH_FILE) + ".lock")).expanduser()
SLOTS_DIR = Path(os.environ.get("GROK_AUTH_SLOTS_DIR", str(Path.home() / ".grok" / "auth-slots"))).expanduser()
STATE_FILE = Path(os.environ.get("GROK_ROTATE_STATE_FILE", str(Path.home() / ".grok" / ".proxy-rotate-state.json"))).expanduser()
UPSTREAM = os.environ.get("GROK_UPSTREAM", "https://cli-chat-proxy.grok.com/v1").rstrip("/")
UPSTREAM_CODING = os.environ.get("GROK_UPSTREAM_CODING", UPSTREAM).rstrip("/")
UPSTREAM_IMAGINE = os.environ.get("GROK_UPSTREAM_IMAGINE", "https://api.x.ai/v1").rstrip("/")
# Hard-coded host allowlist for CodeQL SSRF; env may only point at these hosts.
_SAFE_UPSTREAM_HOSTS = frozenset({"cli-chat-proxy.grok.com", "api.x.ai"})
_SAFE_PATH_RE = re.compile(r"^/v1(?:/[A-Za-z0-9._-]+)*$")
ISSUER = os.environ.get("GROK_OIDC_ISSUER", "https://auth.x.ai").rstrip("/")
CLIENT_ID = os.environ.get("GROK_OIDC_CLIENT_ID", "b1a00492-073a-47ea-816f-4c329264a828")
REFRESH_SKEW_SECONDS = int(os.environ.get("GROK_REFRESH_SKEW_SECONDS", str(6 * 3600)))  # proactive: refresh when <6h left
EXHAUST_COOLDOWN_SECONDS = int(os.environ.get("GROK_EXHAUST_COOLDOWN_SECONDS", "3600"))

# Ordered SuperGrok seats used for rotation (comma-separated emails).
PREFERRED_GROK_EMAILS = [
    e.strip().lower()
    for e in os.environ.get(
        "GROK_PREFERRED_EMAILS",
        "",  # operator-supplied; never hardcode personal seats in the public plugin
    ).split(",")
    if e.strip()
]

# Optional explicit slot filename map: email=file,email2=file2
_SLOT_MAP_ENV = os.environ.get("GROK_SLOT_FILES", "").strip()
DEFAULT_SLOT_FILES = {}  # optional: GROK_SLOT_FILES=email=file.json,...
if _SLOT_MAP_ENV:
    for part in _SLOT_MAP_ENV.split(","):
        if "=" in part:
            email, fname = part.split("=", 1)
            DEFAULT_SLOT_FILES[email.strip().lower()] = fname.strip()

LISTEN_HOST = os.environ.get("GROK_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("GROK_PROXY_PORT", "31845"))
HTTP_TIMEOUT = float(os.environ.get("GROK_PROXY_TIMEOUT", "600"))

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
}

QUOTA_RE = re.compile(
    r"quota|rate.?limit|too many requests|limit.?reached|credits?.?exhaust|"
    r"prepaid.?balance|usage.?cap|throttl|capacity|resource.?exhausted",
    re.I,
)


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _parse_iso(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    # Truncate nanoseconds to microseconds for fromisoformat.
    raw = re.sub(r"\.(\d{1,6})\d*(?=[+-]\d\d:\d\d$)", lambda m: "." + m.group(1), raw)
    try:
        out = dt.datetime.fromisoformat(raw)
        if out.tzinfo is None:
            out = out.replace(tzinfo=dt.timezone.utc)
        return out
    except Exception:
        return None


def _jwt_exp(token: str) -> float | None:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
        exp = data.get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def _email_of(entry: Dict[str, Any]) -> str:
    return str(entry.get("email") or "").strip().lower()


def _auth_entries(raw: Dict[str, Any]) -> list[tuple[str, Dict[str, Any]]]:
    out: list[tuple[str, Dict[str, Any]]] = []
    if not isinstance(raw, dict):
        return out
    for key, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("auth_mode") in (None, "oidc", "oauth") and (
            entry.get("refresh_token") or entry.get("key") or entry.get("access_token")
        ):
            out.append((key, entry))
    return out


def _load_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        return {"exhausted": {}, "active_email": None}
    try:
        data = json.loads(STATE_FILE.read_text())
        if not isinstance(data, dict):
            return {"exhausted": {}, "active_email": None}
        data.setdefault("exhausted", {})
        data.setdefault("active_email", None)
        return data
    except Exception:
        return {"exhausted": {}, "active_email": None}


def _save_state(state: Dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(STATE_FILE.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


def _is_exhausted(state: Dict[str, Any], email: str) -> bool:
    exp_map = state.get("exhausted") or {}
    until = exp_map.get(email)
    if not until:
        return False
    try:
        return float(until) > time.time()
    except Exception:
        return False


def _mark_exhausted(state: Dict[str, Any], email: str) -> None:
    state.setdefault("exhausted", {})[email] = time.time() + EXHAUST_COOLDOWN_SECONDS
    _save_state(state)
    sys.stderr.write(f"[grok-proxy] marked exhausted: {email} for {EXHAUST_COOLDOWN_SECONDS}s\n")


def _slot_path_for_email(email: str) -> Path:
    fname = DEFAULT_SLOT_FILES.get(email.lower())
    if not fname:
        safe = re.sub(r"[^a-z0-9]+", "_", email.lower()).strip("_")
        fname = f"{safe}.json"
    return SLOTS_DIR / fname


def _discover_slot_files() -> Dict[str, Path]:
    """email -> path for all known SuperGrok OAuth slot files + active auth."""
    found: Dict[str, Path] = {}
    # Preferred slot filenames first.
    for email in PREFERRED_GROK_EMAILS:
        path = _slot_path_for_email(email)
        if path.exists():
            found[email] = path
    # Active auth.json
    if AUTH_FILE.exists():
        try:
            raw = json.loads(AUTH_FILE.read_text())
            for _, entry in _auth_entries(raw):
                email = _email_of(entry)
                if email:
                    found.setdefault(email, AUTH_FILE)
        except Exception:
            pass
    # Any other json in slots dir.
    if SLOTS_DIR.exists():
        for path in SLOTS_DIR.glob("*.json"):
            if ".bak" in path.name:
                continue
            try:
                raw = json.loads(path.read_text())
            except Exception:
                continue
            for _, entry in _auth_entries(raw):
                email = _email_of(entry)
                if email:
                    found.setdefault(email, path)
    return found


def _load_auth_blob(path: Path) -> Dict[str, Any]:
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise RuntimeError(f"{path} is not a JSON object")
    return raw


def _pick_entry_from_raw(raw: Dict[str, Any], want_email: Optional[str] = None) -> tuple[str, Dict[str, Any]]:
    entries = _auth_entries(raw)
    if not entries:
        raise RuntimeError("No usable Grok CLI OAuth entry found")
    by_email = {}
    for key, entry in entries:
        email = _email_of(entry)
        if email:
            by_email[email] = (key, entry)
    if want_email and want_email in by_email:
        return by_email[want_email]
    for preferred in PREFERRED_GROK_EMAILS:
        if preferred in by_email:
            return by_email[preferred]
    return entries[0]


def _ordered_accounts(state: Dict[str, Any]) -> List[str]:
    slots = _discover_slot_files()
    ordered: List[str] = []
    for email in PREFERRED_GROK_EMAILS:
        if email in slots and not _is_exhausted(state, email):
            ordered.append(email)
    # append any other non-preferred available seats last
    for email in sorted(slots):
        if email not in ordered and not _is_exhausted(state, email):
            ordered.append(email)
    # if all exhausted, allow preferred slots anyway (retry after cooldown may have expired mid-loop)
    if not ordered:
        for email in PREFERRED_GROK_EMAILS:
            if email in slots:
                ordered.append(email)
        for email in sorted(slots):
            if email not in ordered:
                ordered.append(email)
    return ordered


def _needs_refresh(entry: Dict[str, Any], *, force: bool = False) -> bool:
    if force:
        return True
    token = str(entry.get("key") or entry.get("access_token") or "").strip()
    exp = _jwt_exp(token)
    if exp is not None:
        return exp <= time.time() + REFRESH_SKEW_SECONDS
    exp_dt = _parse_iso(entry.get("expires_at"))
    if exp_dt is not None:
        return exp_dt.timestamp() <= time.time() + REFRESH_SKEW_SECONDS
    return False


def _token_endpoint() -> str:
    req = urllib.request.Request(
        f"{ISSUER}/.well-known/openid-configuration",
        headers={"Accept": "application/json", "User-Agent": "grok-cli-auth-proxy/1.1"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    endpoint = str(data.get("token_endpoint") or "").strip()
    parsed = urllib.parse.urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or (host != "x.ai" and not host.endswith(".x.ai")):
        raise RuntimeError(f"Refusing unexpected xAI token endpoint: {endpoint!r}")
    return endpoint


def _refresh(entry: Dict[str, Any]) -> Dict[str, Any]:
    refresh_token = str(entry.get("refresh_token") or "").strip()
    if not refresh_token:
        raise RuntimeError("Grok CLI auth entry has no refresh_token")
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": str(entry.get("oidc_client_id") or CLIENT_ID),
            "refresh_token": refresh_token,
        }
    ).encode()
    req = urllib.request.Request(
        _token_endpoint(),
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "grok-cli-auth-proxy/1.1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"xAI refresh failed HTTP {exc.code}: {detail}") from exc
    access = str(data.get("access_token") or "").strip()
    if not access:
        raise RuntimeError(f"xAI refresh response missing access_token: {data!r}")
    now = _utc_now()
    expires_in = int(data.get("expires_in") or 3600)
    updated = dict(entry)
    updated["key"] = access
    updated["refresh_token"] = str(data.get("refresh_token") or refresh_token).strip()
    updated["expires_at"] = (now + dt.timedelta(seconds=expires_in)).isoformat().replace("+00:00", "Z")
    updated["token_type"] = str(data.get("token_type") or entry.get("token_type") or "Bearer")
    if data.get("id_token"):
        updated["id_token"] = str(data.get("id_token"))
    return updated


def _atomic_write_json(path: Path, raw: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(raw, indent=2, sort_keys=False) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _persist_slot(email: str, raw: Dict[str, Any], source_path: Path) -> None:
    """Write seat tokens back to its slot file (and optionally mirror last-used auth.json)."""
    slot = _slot_path_for_email(email)
    _atomic_write_json(slot, raw)
    # Keep auth.json as last-used mirror for tools that still read it; not sticky for LB.
    if os.environ.get("GROK_MIRROR_ACTIVE_AUTH", "1") not in ("0", "false", "no"):
        _atomic_write_json(AUTH_FILE, raw)


def _rr_pick(candidates: List[str], state: Dict[str, Any]) -> List[str]:
    """Rotate candidate order for round-robin load balancing."""
    if not candidates:
        return candidates
    rr = int(state.get("rr_index") or 0) % len(candidates)
    return candidates[rr:] + candidates[:rr]


def current_token(*, force_refresh: bool = False, prefer_email: Optional[str] = None) -> Tuple[str, str]:
    """Return (access_token, email) for the next SuperGrok seat (round-robin LB)."""
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = _load_state()
        state.setdefault("request_counts", {})
        slots = _discover_slot_files()
        candidates = _ordered_accounts(state)
        if prefer_email and prefer_email in candidates:
            ordered = [prefer_email] + [e for e in candidates if e != prefer_email]
        else:
            ordered = _rr_pick(candidates, state)

        last_err: Exception | None = None
        for email in ordered:
            path = slots.get(email)
            if not path or not path.exists():
                continue
            try:
                raw = _load_auth_blob(path)
                key, entry = _pick_entry_from_raw(raw, want_email=email)
                if _needs_refresh(entry, force=force_refresh):
                    try:
                        entry = _refresh(entry)
                        raw[key] = entry
                        _atomic_write_json(path, raw)
                    except Exception as refresh_exc:
                        # Keep serving while access JWT is still valid even if RT is dead.
                        tok_now = str(entry.get("key") or entry.get("access_token") or "").strip()
                        exp = _jwt_exp(tok_now)
                        if exp is None or exp <= time.time() + 60:
                            raise RuntimeError(f"{email}: refresh failed and access expired: {refresh_exc}") from refresh_exc
                        sys.stderr.write(
                            f"[grok-proxy] {email}: refresh failed ({refresh_exc}); "
                            f"using access token until {int(exp - time.time())}s left\n"
                        )
                token = str(entry.get("key") or entry.get("access_token") or "").strip()
                if not token:
                    raise RuntimeError(f"{email}: no access token")
                # Reject clearly expired access even if present
                exp_chk = _jwt_exp(token)
                if exp_chk is not None and exp_chk <= time.time():
                    raise RuntimeError(f"{email}: access token expired")
                _persist_slot(email, raw, path)
                # Advance RR only on successful pick so failed seats do not burn slots forever.
                if email in candidates:
                    idx = candidates.index(email)
                    state["rr_index"] = (idx + 1) % max(1, len(candidates))
                state["active_email"] = email  # last-used, not sticky
                counts = state.setdefault("request_counts", {})
                counts[email] = int(counts.get(email) or 0) + 1
                _save_state(state)
                return token, email
            except Exception as exc:
                last_err = exc
                sys.stderr.write(f"[grok-proxy] skip {email}: {exc}\n")
                continue
        raise RuntimeError(f"No usable SuperGrok OAuth seat: {last_err}")


def refresh_all_seats(*, force: bool = True) -> Dict[str, Any]:
    """Force-refresh every known SuperGrok slot. Clears exhaust cooldowns for successes."""
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    results: Dict[str, Any] = {}
    with LOCK_FILE.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = _load_state()
        slots = _discover_slot_files()
        for email, path in slots.items():
            try:
                raw = _load_auth_blob(path)
                key, entry = _pick_entry_from_raw(raw, want_email=email)
                entry = _refresh(entry) if force or _needs_refresh(entry) else entry
                raw[key] = entry
                _atomic_write_json(path, raw)
                # clear exhaust on successful refresh
                if isinstance(state.get("exhausted"), dict):
                    state["exhausted"].pop(email, None)
                results[email] = {
                    "ok": True,
                    "expires_at": entry.get("expires_at"),
                    "path": str(path),
                }
            except Exception as exc:
                results[email] = {"ok": False, "error": str(exc), "path": str(path)}
        _save_state(state)
    return results


def _looks_like_quota(status: int, body: bytes) -> bool:
    if status in (429, 402):
        return True
    if status == 403 and QUOTA_RE.search(body.decode("utf-8", "replace")[:2000] or ""):
        return True
    if status >= 400 and QUOTA_RE.search(body.decode("utf-8", "replace")[:2000] or ""):
        return True
    return False


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "grok-cli-auth-proxy/1.2-lb"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _select_upstream(self, body: bytes | None) -> str:
        path = self.path.lower()
        if "/images" in path or "/videos" in path or "/image" in path or "/video" in path:
            return UPSTREAM_IMAGINE
        if body:
            try:
                model = str(json.loads(body).get("model") or "").lower()
                if model.startswith("grok-imagine") or "imagine" in model:
                    return UPSTREAM_IMAGINE
            except Exception:
                pass
        return UPSTREAM_CODING

    def _target_url(self, upstream: str) -> str:
        """Map client path onto a fixed upstream base (no open proxy / SSRF).

        Host comes only from configured UPSTREAM_* (must be in _SAFE_UPSTREAM_HOSTS).
        Path is restricted to /v1/... with safe charset; query is re-encoded.
        """
        base = urllib.parse.urlparse(upstream)
        host = (base.hostname or "").lower()
        if base.scheme not in ("https", "http") or host not in _SAFE_UPSTREAM_HOSTS:
            # Fall back to hard-coded coding upstream if env is mis-set.
            base = urllib.parse.urlparse("https://cli-chat-proxy.grok.com/v1")
            host = base.hostname or "cli-chat-proxy.grok.com"

        req = urllib.parse.urlparse(self.path or "/")
        # Absolute-form request lines: ignore client-supplied scheme/host entirely.
        path = req.path or "/"
        if not path.startswith("/"):
            path = "/" + path
        if not path.startswith("/v1"):
            path = "/v1" + path
        # Collapse // and reject traversal / non-allowlisted chars.
        parts = [p for p in path.split("/") if p and p != "."]
        if any(p == ".." for p in parts):
            raise ValueError(f"rejected path: {path!r}")
        safe_path = "/" + "/".join(parts)
        if not _SAFE_PATH_RE.fullmatch(safe_path):
            raise ValueError(f"rejected path charset: {safe_path!r}")

        # Rebuild URL from allowlisted host + sanitized path segments only.
        base_path = (base.path or "/v1").rstrip("/") or "/v1"
        # client path is /v1/...; strip /v1 and append under base_path
        suffix_parts = parts[1:]  # drop leading "v1"
        full_path = base_path + (("/" + "/".join(suffix_parts)) if suffix_parts else "")
        query = urllib.parse.urlencode(urllib.parse.parse_qsl(req.query, keep_blank_values=True))
        target = urllib.parse.urlunparse((base.scheme, host, full_path, "", query, ""))
        # Final belt: host must still be allowlisted.
        final = urllib.parse.urlparse(target)
        if (final.hostname or "").lower() not in _SAFE_UPSTREAM_HOSTS:
            raise ValueError(f"upstream host not allowed: {final.hostname}")
        return target

    def _build_headers(self, token: str) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in HOP_BY_HOP or lk == "authorization" or lk == "content-length":
                continue
            headers[k] = v
        headers["Authorization"] = f"Bearer {token}"
        headers.setdefault("Accept", "application/json")
        headers.setdefault("User-Agent", "grok-cli-auth-proxy/1.1")
        headers.setdefault("x-grok-client-version", "0.2.93")
        headers.setdefault("x-grok-client-identifier", "grok-cli")
        return headers

    def _do_upstream(self, upstream: str, body: bytes | None, token: str) -> tuple[int, list[tuple[str, str]], bytes]:
        headers = self._build_headers(token)
        req = urllib.request.Request(self._target_url(upstream), data=body, method=self.command, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT)
            with resp:
                payload = resp.read()
                hdrs = [(k, v) for k, v in resp.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"]
                return int(resp.status), hdrs, payload
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            hdrs = [(k, v) for k, v in exc.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"]
            return int(exc.code), hdrs, payload

    def _forward(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        upstream = self._select_upstream(body)

        tried: list[str] = []
        last_status = 503
        last_headers: list[tuple[str, str]] = []
        last_body = b'{"error":"no_accounts"}'

        # Try up to N preferred seats on quota/exhaust errors.
        max_tries = max(1, len(PREFERRED_GROK_EMAILS) or 1)
        for _ in range(max_tries):
            try:
                token, email = current_token()
            except Exception as exc:
                self._send_json(503, {"error": f"grok_cli_auth_unavailable: {exc}"})
                return
            if email in tried:
                break
            tried.append(email)
            try:
                status, headers, payload = self._do_upstream(upstream, body, token)
            except Exception as exc:
                self._send_json(502, {"error": f"upstream_error: {exc}"})
                return
            last_status, last_headers, last_body = status, headers, payload
            if status < 400:
                # success
                self.send_response(status)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header("X-Grok-Proxy-Account", email)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if _looks_like_quota(status, payload):
                state = _load_state()
                _mark_exhausted(state, email)
                sys.stderr.write(f"[grok-proxy] quota on {email} status={status}; rotating\n")
                continue
            # non-quota error: return as-is
            self.send_response(status)
            for k, v in headers:
                self.send_header(k, v)
            self.send_header("X-Grok-Proxy-Account", email)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # all seats exhausted or failed
        self.send_response(last_status)
        for k, v in last_headers:
            self.send_header(k, v)
        self.send_header("X-Grok-Proxy-Tried", ",".join(tried))
        self.send_header("Content-Length", str(len(last_body)))
        self.end_headers()
        self.wfile.write(last_body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path in ("/accounts", "/v1/accounts", "/health", "/v1/health", "/rotate", "/v1/rotate", "/refresh-all", "/v1/refresh-all", "/refresh_all", "/v1/refresh_all"):
            try:
                state = _load_state()
                slots = _discover_slot_files()
                available = []
                missing = []
                for email in PREFERRED_GROK_EMAILS:
                    if email in slots:
                        available.append(email)
                    else:
                        missing.append(email)
                for email in slots:
                    if email not in available:
                        available.append(email)
                exhausted = {
                    e: int(float(until) - time.time())
                    for e, until in (state.get("exhausted") or {}).items()
                    if float(until) > time.time()
                }
                if path.endswith("refresh-all") or path.endswith("refresh_all"):
                    results = refresh_all_seats(force=True)
                    payload = {"refreshed": results, "load_balance": "round_robin"}
                elif path.endswith("rotate") and self.command == "GET":
                    # Advance RR without long exhaust (LB mode).
                    token, email = current_token(force_refresh=False)
                    payload = {"rotated_to": email, "token_preview": token[:8] + "...", "load_balance": "round_robin"}
                elif path.endswith("health"):
                    state = _load_state()
                    payload = {
                        "status": "ok",
                        "service": "grok-cli-auth-proxy",
                        "load_balance": "round_robin",
                        "active_accounts": available,
                        "active": state.get("active_email"),
                        "last_used": state.get("active_email"),
                        "rr_index": state.get("rr_index", 0),
                        "request_counts": state.get("request_counts") or {},
                        "preferred": PREFERRED_GROK_EMAILS,
                        "missing_preferred": missing,
                        "exhausted_seconds_remaining": exhausted,
                        "slots_dir": str(SLOTS_DIR),
                    }
                else:
                    state = _load_state()
                    payload = {
                        "object": "list",
                        "load_balance": "round_robin",
                        "active": available,
                        "current": state.get("active_email"),
                        "last_used": state.get("active_email"),
                        "rr_index": state.get("rr_index", 0),
                        "request_counts": state.get("request_counts") or {},
                        "preferred": PREFERRED_GROK_EMAILS,
                        "missing_preferred": missing,
                        "exhausted_seconds_remaining": exhausted,
                        "auth_file": str(AUTH_FILE),
                        "slots_dir": str(SLOTS_DIR),
                    }
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        self._forward()

    def do_POST(self) -> None:  # noqa: N802
        self._forward()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._forward()


def main() -> int:
    # Prefer a live seat at start, but stay up even if all seats are cooling/refresh-broken
    # so keepalive + re-login can recover without a dead listener.
    try:
        token, email = current_token(force_refresh=False)
        sys.stderr.write(f"grok-cli-auth-proxy active seat={email} token_ok={bool(token)}\n")
    except Exception as exc:
        sys.stderr.write(f"grok-cli-auth-proxy starting degraded: {exc}\n")
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    print(
        f"grok-cli-auth-proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT}/v1 "
        f"-> {UPSTREAM_CODING} (slots={SLOTS_DIR})",
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
