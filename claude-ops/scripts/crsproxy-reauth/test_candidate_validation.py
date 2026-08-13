#!/usr/bin/env python3
"""Behavioral tests for exact-candidate validation and rollback."""

import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import bu_reauth


def valid_auth(email="user@example.com", token="test-access-token"):
    return {
        "email": email,
        "type": "claude",
        "expired": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
        "access_token": token,
        "disabled": True,
    }


def make_helper(root: Path) -> Path:
    helper = root / "candidate-helper.py"
    helper.write_text("""#!/usr/bin/env python3
import hashlib, json, os, time
from pathlib import Path
candidate = Path(os.environ["CRSPROXY_CANDIDATE_AUTH_FILE"])
payload = json.loads(candidate.read_text())
mode = os.environ.get("CANARY_TEST_MODE", "good")
if mode == "timeout":
    time.sleep(1)
digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
result = {
    "candidate_digest": digest,
    "nonce": os.environ["CRSPROXY_CANDIDATE_NONCE"],
    "http_status": 200 if payload.get("access_token") == "good-token" else 401,
    "model": os.environ["CRSPROXY_CANDIDATE_MODEL"],
    "content": "candidate-only-ok" if payload.get("access_token") == "good-token" else "",
}
if mode == "wrong-digest": result["candidate_digest"] = "0" * 64
if mode == "wrong-nonce": result["nonce"] = "replayed-nonce"
if mode == "wrong-model": result["model"] = "shared-model"
if mode == "empty-content": result["content"] = ""
if mode == "healthy-shared":
    result.update(http_status=200, content="healthy shared endpoint")
print(json.dumps(result))
""")
    os.chmod(helper, 0o700)
    return helper


def helper_env(helper: Path, mode="good"):
    return patch.dict(os.environ, {
        "CRSPROXY_CANDIDATE_CANARY_CMD": f"{sys.executable} {helper}",
        "CANARY_TEST_MODE": mode,
    }, clear=False)


def test_candidate_specific_success_and_permissions():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        auth = root / "claude-user.json"
        auth.write_text(json.dumps(valid_auth(token="good-token")))
        os.chmod(auth, 0o640)
        helper = make_helper(root)
        with helper_env(helper):
            valid, reason = bu_reauth.validate_candidate(
                auth, "user@example.com", "claude", "claude-sonnet-5")
        assert valid is True, reason
        assert stat.S_IMODE(auth.stat().st_mode) == 0o640
        print("PASS: helper inference is bound to the exact isolated candidate")


def test_structured_result_binding_failures():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        auth = root / "claude-user.json"
        auth.write_text(json.dumps(valid_auth(token="good-token")))
        helper = make_helper(root)
        cases = [
            ("wrong-digest", "digest mismatch"),
            ("wrong-nonce", "nonce mismatch"),
            ("wrong-model", "model mismatch"),
            ("empty-content", "without model content"),
        ]
        for mode, expected in cases:
            with helper_env(helper, mode):
                valid, reason = bu_reauth.send_canary(
                    "claude-sonnet-5", auth)
            assert valid is False, mode
            assert expected in reason, (mode, reason)
        print("PASS: digest, nonce, model, status, and content are validated")


def test_healthy_shared_endpoint_cannot_validate_bad_candidate():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        auth = root / "claude-user.json"
        auth.write_text(json.dumps(valid_auth(token="bad-token")))
        helper = make_helper(root)
        with helper_env(helper), patch.dict(
                os.environ,
                {"CRSPROXY_CANARY_URL": "http://healthy-shared.example/v1"},
                clear=False):
            valid, reason = bu_reauth.send_canary(
                "claude-sonnet-5", auth)
        assert valid is False
        assert "authentication rejected" in reason
        print("PASS: a healthy shared endpoint cannot validate a bad candidate")


def test_validation_classification_and_timeout():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        helper = make_helper(root)
        good = root / "good.json"
        good.write_text(json.dumps(valid_auth(token="good-token")))
        bad = root / "bad.json"
        bad.write_text(json.dumps(valid_auth(token="bad-token")))
        with helper_env(helper):
            valid, reason = bu_reauth.send_canary("claude-sonnet-5", bad)
        assert valid is False and "authentication rejected" in reason
        with helper_env(helper, "timeout"):
            valid, reason = bu_reauth.send_canary(
                "claude-sonnet-5", good, timeout=0.05)
        assert valid is False and "timed out" in reason
        print("PASS: candidate status and helper timeout fail closed")


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
        test_structured_result_binding_failures,
        test_healthy_shared_endpoint_cannot_validate_bad_candidate,
        test_validation_classification_and_timeout,
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
