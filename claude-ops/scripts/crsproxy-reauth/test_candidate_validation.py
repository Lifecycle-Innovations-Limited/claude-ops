#!/usr/bin/env python3
"""Behavioral tests for isolated candidate validation and rollback."""

import json
import os
import stat
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import bu_reauth

os.environ["CRSPROXY_CANDIDATE_CANARY_ALLOW_DIRECT"] = "1"


class CanaryHandler(BaseHTTPRequestHandler):
    status = 200
    body = {"choices": [{"message": {"content": "ok"}}]}
    seen_candidate = None
    delay = 0

    def do_POST(self):
        if self.delay:
            time.sleep(self.delay)
        candidate = os.environ.get("CRSPROXY_TEST_CANDIDATE_COPY", "")
        if candidate and Path(candidate).exists():
            type(self).seen_candidate = json.loads(Path(candidate).read_text())
        payload = self.body if isinstance(self.body, str) else json.dumps(self.body)
        self.send_response(self.status)
        encoded = payload.encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except BrokenPipeError:
            pass

    def log_message(self, fmt, *args):
        pass


def valid_auth(email="user@example.com"):
    return {
        "email": email,
        "type": "claude",
        "expired": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
        "access_token": "test-access-token",
        "disabled": True,
    }


def with_server(status=200, body=None, delay=0):
    CanaryHandler.status = status
    CanaryHandler.body = body if body is not None else {"choices": [{"message": {"content": "ok"}}]}
    CanaryHandler.delay = delay
    CanaryHandler.seen_candidate = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), CanaryHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}/v1/chat/completions"


def test_candidate_specific_success_and_permissions():
    with tempfile.TemporaryDirectory() as tmpdir:
        auth = Path(tmpdir) / "claude-user.json"
        auth.write_text(json.dumps(valid_auth()))
        os.chmod(auth, 0o640)
        server, url = with_server()
        original_url = bu_reauth.CANARY_URL
        try:
            bu_reauth.CANARY_URL = url
            valid, reason = bu_reauth.validate_candidate(
                auth, "user@example.com", "claude", "claude-sonnet-5")
        finally:
            bu_reauth.CANARY_URL = original_url
            server.shutdown()
        assert valid is True, reason
        assert stat.S_IMODE(auth.stat().st_mode) == 0o640
        print("PASS: isolated candidate validation requires a real HTTP 200 response")


def test_validation_classification():
    cases = [
        (401, {"error": "invalid auth"}, "authentication rejected"),
        (403, {"error": "forbidden"}, "authentication rejected"),
        (429, {"error": "rate limit"}, "rate-limited"),
        (503, {"error": "unavailable"}, "unavailable"),
        (400, {"error": "unsupported model"}, "model unsupported"),
        (200, {"choices": []}, "without model content"),
    ]
    with tempfile.TemporaryDirectory() as tmpdir:
        auth = Path(tmpdir) / "claude-user.json"
        auth.write_text(json.dumps(valid_auth()))
        original_url = bu_reauth.CANARY_URL
        try:
            for status, body, expected in cases:
                server, url = with_server(status, body)
                bu_reauth.CANARY_URL = url
                try:
                    valid, reason = bu_reauth.validate_candidate(
                        auth, "user@example.com", "claude", "claude-sonnet-5")
                finally:
                    server.shutdown()
                assert valid is False
                assert expected in reason, (status, reason)
        finally:
            bu_reauth.CANARY_URL = original_url
        print("PASS: candidate validation classifies auth, rate, availability, model, and empty-content failures")


def test_validation_timeout():
    with tempfile.TemporaryDirectory() as tmpdir:
        auth = Path(tmpdir) / "claude-user.json"
        auth.write_text(json.dumps(valid_auth()))
        server, url = with_server(delay=0.2)
        original_url = bu_reauth.CANARY_URL
        bu_reauth.CANARY_URL = url
        try:
            valid, reason = bu_reauth.send_canary("claude-sonnet-5", auth, timeout=0.05)
        finally:
            bu_reauth.CANARY_URL = original_url
            server.shutdown()
        assert valid is False
        assert "timed out" in reason
        print("PASS: candidate validation fails closed on timeout")


def test_missing_credential_rejected_before_canary():
    with tempfile.TemporaryDirectory() as tmpdir:
        auth = Path(tmpdir) / "claude-user.json"
        payload = valid_auth()
        payload.pop("access_token")
        auth.write_text(json.dumps(payload))
        with patch.object(bu_reauth, "send_canary") as canary:
            valid, reason = bu_reauth.validate_candidate(
                auth, "user@example.com", "claude", "claude-sonnet-5")
        assert valid is False
        assert "no non-empty provider credential" in reason
        canary.assert_not_called()
        print("PASS: empty provider credentials are rejected before activation")


def test_failed_candidate_rollback_and_activation_mode():
    with tempfile.TemporaryDirectory() as tmpdir:
        auth = Path(tmpdir) / "claude-user.json"
        stale = auth.with_suffix(".stale")
        stale_payload = {"email": "user@example.com", "type": "claude", "disabled": True, "access_token": "old"}
        auth.write_text(json.dumps(valid_auth("wrong@example.com")))
        stale.write_text(json.dumps(stale_payload))
        os.chmod(stale, 0o640)
        proc = object()
        with patch.object(bu_reauth, "paste_callback_url", return_value=True), \
             patch.object(bu_reauth.time, "sleep"), \
             patch.object(bu_reauth, "AUTH_FILE_WAIT", 0):
            result = bu_reauth._complete_reauth(
                proc, "http://localhost/callback", auth, stale,
                "user@example.com", "claude", bu_reauth.PROVIDERS["claude"])
        assert result == bu_reauth.EXIT_FAILURE
        assert json.loads(auth.read_text()) == stale_payload
        assert stat.S_IMODE(auth.stat().st_mode) == 0o640

        auth.write_text(json.dumps(valid_auth()))
        os.chmod(auth, 0o640)
        assert bu_reauth.activate_auth_file(auth) is True
        assert json.loads(auth.read_text())["disabled"] is False
        assert stat.S_IMODE(auth.stat().st_mode) == 0o640
        print("PASS: failed candidates roll back atomically and activation preserves permissions")


def main():
    tests = [
        test_candidate_specific_success_and_permissions,
        test_validation_classification,
        test_validation_timeout,
        test_missing_credential_rejected_before_canary,
        test_failed_candidate_rollback_and_activation_mode,
    ]
    failed = 0
    for test in tests:
        try:
            test()
        except Exception as exc:
            print(f"FAIL: {test.__name__}: {exc}")
            failed += 1
    print(f"Results: {len(tests) - failed} passed, {failed} failed, {len(tests)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
