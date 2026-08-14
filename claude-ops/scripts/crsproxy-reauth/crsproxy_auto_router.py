#!/usr/bin/env python3
"""crsproxy_auto_router.py — Auto-router HTTP service on shadow port 8321.

Receives OpenAI-compatible API requests, maps model names to providers,
queries pool health for eligible accounts, selects least-pressure account,
proxies to cli-proxy-api on :8319, and retries on distinct accounts on failure.

Logs routing decisions without exposing secrets (emails masked, no tokens).

Usage:
    python3 crsproxy_auto_router.py [--port 8321] [--dry-run]
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8321
DEFAULT_UPSTREAM = "http://127.0.0.1:8319"
DEFAULT_AUTH_DIR = "/opt/crsproxy/auths"
MAX_RETRIES = 3
RETRY_STATUS_CODES = {401, 429, 503}
UPSTREAM_TIMEOUT = 90

# Model prefix -> provider type (matches auth file "type" field)
MODEL_PREFIX_MAP = [
    ("claude-", "claude"),
    ("grok-", "xai"),
    ("gpt-", "codex"),
    ("kimi-", "kimi"),
    ("minimax-", "minimax"),
    ("gemini-", "gemini"),
]

# Providers that use API keys (no OAuth account selection)
API_KEY_PROVIDERS = {"kimi", "minimax", "gemini"}

logger = logging.getLogger("crsproxy-auto-router")

# ---------------------------------------------------------------------------
# Utility functions (pure, testable)
# ---------------------------------------------------------------------------


def mask_email(email):
    """Mask an email address for safe logging.

    Returns 'ad**@healify.ai' for 'adam@healify.ai'.
    Returns '[no-email]' for empty/invalid input.
    """
    if not email or "@" not in email:
        return "[no-email]"
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked = (local[0] + "*") if local else "*"
    else:
        masked = local[:2] + "*" * (len(local) - 2)
    return f"{masked}@{domain}"


def model_to_provider(model_name):
    """Map a model name to its provider type.

    Handles 'custom/' prefixes and '[...]' suffixes (e.g. 'custom/claude-opus-5',
    'claude-sonnet-5[1m]').
    """
    if not model_name:
        return "unknown"
    name = model_name
    if name.startswith("custom/"):
        name = name[len("custom/"):]
    name = re.sub(r"\[.*\]$", "", name)
    name_lower = name.lower()
    for prefix, provider in MODEL_PREFIX_MAP:
        if name_lower.startswith(prefix):
            return provider
    return "unknown"


def parse_expiry(expired_str):
    """Parse an ISO 8601 expiry timestamp. Returns timezone-aware datetime or None."""
    if not expired_str:
        return None
    try:
        s = expired_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def is_expired(auth_data, now=None):
    """Check if an auth file's token is expired."""
    if now is None:
        now = datetime.now(timezone.utc)
    expired = parse_expiry(auth_data.get("expired"))
    if expired is None:
        return True
    return expired <= now


def get_eligible_accounts(auth_dir, provider, now=None):
    """Read auth files and return eligible accounts for a provider.

    Returns a list of dicts with keys: email, type, path, expired.
    Only returns accounts that are not disabled and not expired.
    Never includes token fields (access_token, refresh_token, etc.).
    """
    if now is None:
        now = datetime.now(timezone.utc)

    auth_path = Path(auth_dir)
    if not auth_path.is_dir():
        return []

    accounts = []
    for f in sorted(auth_path.glob("*.json")):
        # Skip backup/stale/lock files
        if any(ext in f.name for ext in (".bak", ".stale", ".lock")):
            continue
        try:
            with open(f) as h:
                data = json.load(h)
        except (json.JSONDecodeError, OSError):
            continue

        if data.get("type") != provider:
            continue
        if data.get("disabled", False):
            continue
        if is_expired(data, now):
            continue

        accounts.append(
            {
                "email": data.get("email", ""),
                "type": provider,
                "path": str(f),
                "expired": data.get("expired", ""),
            }
        )
    return accounts


# ---------------------------------------------------------------------------
# Pressure tracking (in-memory)
# ---------------------------------------------------------------------------


class PressureTracker:
    """Tracks request/failure pressure per account in memory.

    Selection priority: fewest failures, then fewest requests, then
    least recently used.
    """

    def __init__(self):
        self._stats = defaultdict(lambda: {"requests": 0, "failures": 0, "last_used": 0.0})

    def record_request(self, email):
        self._stats[email]["requests"] += 1
        self._stats[email]["last_used"] = time.time()

    def record_failure(self, email):
        self._stats[email]["failures"] += 1

    def get_pressure(self, email):
        return self._stats.get(
            email, {"requests": 0, "failures": 0, "last_used": 0.0}
        )

    def select_least_pressure(self, accounts, exclude=None):
        """Select the least-pressure account, excluding emails in *exclude*.

        Returns the selected account dict or None if all are excluded.
        """
        exclude = exclude or set()
        candidates = [a for a in accounts if a["email"] not in exclude]
        if not candidates:
            return None

        def key(account):
            s = self._stats.get(
                account["email"], {"requests": 0, "failures": 0, "last_used": 0.0}
            )
            return (s["failures"], s["requests"], s["last_used"])

        return min(candidates, key=key)


# ---------------------------------------------------------------------------
# Upstream proxy
# ---------------------------------------------------------------------------


def proxy_to_upstream(upstream, method, path, headers, body, timeout=UPSTREAM_TIMEOUT):
    """Proxy a single request to the upstream cli-proxy-api.

    Returns (status_code, response_headers_dict, response_body_bytes).
    """
    url = upstream + path

    skip = {"host", "connection", "transfer-encoding", "content-length"}
    forward_headers = {k: v for k, v in headers.items() if k.lower() not in skip}

    data = body if body else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in forward_headers.items():
        req.add_header(k, v)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp_body = resp.read()
            resp_headers = dict(resp.headers.items())
            return resp.status, resp_headers, resp_body
    except urllib.error.HTTPError as e:
        resp_body = e.read()
        resp_headers = dict(e.headers.items()) if e.headers else {}
        return e.code, resp_headers, resp_body


# ---------------------------------------------------------------------------
# Core routing logic (testable without HTTP server)
# ---------------------------------------------------------------------------


def route_request(
    model,
    body,
    headers,
    auth_dir,
    upstream,
    pressure_tracker,
    max_retries=MAX_RETRIES,
    dry_run=False,
):
    """Route a chat completions request with retry logic.

    Returns (status_code, response_headers, response_body).
    """
    provider = model_to_provider(model)
    logger.info("model=%s provider=%s", model, provider)

    # Unknown model or API-key provider: proxy directly, no account selection
    if provider == "unknown" or provider in API_KEY_PROVIDERS:
        if provider in API_KEY_PROVIDERS:
            logger.info("provider=%s uses API key, proxying directly", provider)
        if dry_run:
            return 200, {"Content-Type": "application/json"}, json.dumps(
                {"dry_run": True, "provider": provider, "model": model}
            ).encode()
        return proxy_to_upstream(
            upstream, "POST", "/v1/chat/completions", headers, body
        )

    # OAuth provider: find eligible accounts
    accounts = get_eligible_accounts(auth_dir, provider)
    if not accounts:
        logger.warning("no eligible accounts for provider=%s model=%s", provider, model)
        return 503, {"Content-Type": "application/json"}, json.dumps(
            {"error": "no eligible accounts"}
        ).encode()

    logger.info(
        "found %d eligible account(s) for provider=%s", len(accounts), provider
    )

    tried = set()
    last_result = None

    for attempt in range(max_retries + 1):
        account = pressure_tracker.select_least_pressure(accounts, exclude=tried)
        if account is None:
            logger.warning(
                "no more accounts to try (tried %d) for provider=%s",
                len(tried),
                provider,
            )
            break

        masked = mask_email(account["email"])
        logger.info(
            "attempt %d/%d selected %s", attempt + 1, max_retries + 1, masked
        )

        if dry_run:
            return 200, {"Content-Type": "application/json"}, json.dumps(
                {
                    "dry_run": True,
                    "provider": provider,
                    "account": masked,
                    "model": model,
                }
            ).encode()

        pressure_tracker.record_request(account["email"])

        try:
            result = proxy_to_upstream(
                upstream, "POST", "/v1/chat/completions", headers, body
            )
        except urllib.error.URLError as exc:
            logger.error("connection error for %s: %s", masked, exc)
            pressure_tracker.record_failure(account["email"])
            tried.add(account["email"])
            last_result = (
                502,
                {"Content-Type": "application/json"},
                json.dumps({"error": "bad gateway"}).encode(),
            )
            continue

        status, resp_headers, resp_body = result
        last_result = result
        tried.add(account["email"])

        if status not in RETRY_STATUS_CODES:
            logger.info("account %s returned %d — success", masked, status)
            break

        logger.warning(
            "account %s returned %d — retrying with different account",
            masked,
            status,
        )
        pressure_tracker.record_failure(account["email"])

    return last_result if last_result else (
        503,
        {"Content-Type": "application/json"},
        json.dumps({"error": "all retries exhausted"}).encode(),
    )


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class AutoRouterHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the auto-router."""

    # Class-level config (set by main)
    upstream = DEFAULT_UPSTREAM
    auth_dir = DEFAULT_AUTH_DIR
    max_retries = MAX_RETRIES
    dry_run = False
    pressure_tracker = PressureTracker()

    def log_message(self, fmt, *args):
        logger.debug("%s - %s", self.client_address[0], fmt % args)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            return self.rfile.read(length)
        return None

    def do_GET(self):
        self._handle("GET", None)

    def do_POST(self):
        self._handle("POST", self._read_body())

    def do_PUT(self):
        self._handle("PUT", self._read_body())

    def do_DELETE(self):
        self._handle("DELETE", self._read_body())

    def _handle(self, method, body):
        path = self.path
        if method == "POST" and path == "/v1/chat/completions" and body:
            self._handle_chat_completions(body)
        else:
            self._proxy_simple(method, path, body)

    def _proxy_simple(self, method, path, body):
        try:
            status, headers, resp_body = proxy_to_upstream(
                self.upstream, method, path, dict(self.headers), body
            )
            self._send(status, headers, resp_body)
        except urllib.error.URLError as exc:
            logger.error("proxy error for %s: %s", path, exc)
            self._send_error(502, "bad gateway")

    def _handle_chat_completions(self, body):
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send_error(400, "invalid json")
            return

        model = data.get("model", "")
        status, headers, resp_body = route_request(
            model,
            body,
            dict(self.headers),
            self.auth_dir,
            self.upstream,
            self.pressure_tracker,
            self.max_retries,
            self.dry_run,
        )
        self._send(status, headers, resp_body)

    def _send(self, status, headers, resp_body):
        self.send_response(status)
        if resp_body is not None:
            self.send_header("Content-Length", str(len(resp_body)))
        for k, v in headers.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.end_headers()
        if resp_body is not None:
            self.wfile.write(resp_body)

    def _send_error(self, status, message):
        body = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="CRSProxy Auto-Router")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Listen host")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Listen port")
    parser.add_argument(
        "--upstream", default=DEFAULT_UPSTREAM, help="Upstream cli-proxy-api URL"
    )
    parser.add_argument("--auth-dir", default=DEFAULT_AUTH_DIR, help="Auth files dir")
    parser.add_argument(
        "--max-retries", type=int, default=MAX_RETRIES, help="Max retries"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Dry run (no actual proxying)"
    )
    parser.add_argument("--log-level", default="INFO", help="Log level")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    AutoRouterHandler.upstream = args.upstream
    AutoRouterHandler.auth_dir = args.auth_dir
    AutoRouterHandler.max_retries = args.max_retries
    AutoRouterHandler.dry_run = args.dry_run
    AutoRouterHandler.pressure_tracker = PressureTracker()

    server = HTTPServer((args.host, args.port), AutoRouterHandler)
    logger.info(
        "auto-router listening on %s:%d (upstream=%s, dry_run=%s)",
        args.host,
        args.port,
        args.upstream,
        args.dry_run,
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
