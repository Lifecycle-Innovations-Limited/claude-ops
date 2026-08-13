#!/usr/bin/env python3
"""Behavioral tests for exact-candidate validation and rollback."""

import json
import os
import stat
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


def make_proxy(root: Path, mode="normal") -> tuple[Path, Path]:
    proxy = root / f"candidate-proxy-{mode}.py"
    record = root / f"candidate-proxy-{mode}.json"
    proxy.write_text(f'''#!/usr/bin/env python3
import argparse, json, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument("-config", required=True)
args=parser.parse_args()
config=Path(args.config).read_text()
def field(name):
    match=re.search(r"^"+re.escape(name)+r":\\s*(.+)$",config,re.M)
    if not match: raise SystemExit(12)
    return json.loads(match.group(1)) if match.group(1).startswith('"') else match.group(1)
host=field("host")
port=int(field("port"))
auth_dir=Path(field("auth-dir"))
api_key=re.search(r"^\\s*-\\s*(.+)$",config,re.M).group(1)
api_key=json.loads(api_key) if api_key.startswith('"') else api_key
files=list(auth_dir.glob("*.json"))
if len(files) != 1: raise SystemExit(13)
payload=json.loads(files[0].read_text())
Path({str(record)!r}).write_text(json.dumps({{"host":host,"port":port,"auth_dir":str(auth_dir),"auth_file":str(files[0]),"token":payload.get("access_token"),"api_key":api_key}}))
mode={mode!r}
if mode == "exit": raise SystemExit(14)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        if mode == "timeout":
            time.sleep(2)
            return
        length=int(self.headers.get("content-length","0"))
        request=json.loads(self.rfile.read(length) or b"{{}}")
        authorized=self.headers.get("authorization") == "Bearer " + api_key
        status=200 if authorized and payload.get("access_token") == "good-token" else 401
        content="candidate-only-ok" if status == 200 else ""
        if mode == "empty": content=""
        body=json.dumps({{"model":request.get("model"),"choices":[{{"message":{{"content":content}}}}]}}).encode()
        self.send_response(status)
        self.send_header("content-type","application/json")
        self.send_header("content-length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)
ThreadingHTTPServer((host,port),Handler).serve_forever()
''')
    os.chmod(proxy, 0o700)
    return proxy, record


def proxy_env(proxy: Path):
    return patch.dict(os.environ, {"CRSPROXY_CANDIDATE_PROXY_BIN": str(proxy)}, clear=False)


def test_candidate_specific_success_and_permissions():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        auth = root / "claude-user.json"
        auth.write_text(json.dumps(valid_auth(token="good-token")))
        os.chmod(auth, 0o640)
        proxy, record = make_proxy(root)
        with proxy_env(proxy):
            valid, reason = bu_reauth.validate_candidate(
                auth, "user@example.com", "claude", "claude-sonnet-5")
        assert valid is True, reason
        used = json.loads(record.read_text())
        assert used["token"] == "good-token"
        assert Path(used["auth_file"]).name == auth.name
        assert Path(used["auth_dir"]) != auth.parent
        assert used["host"] == "127.0.0.1"
        assert stat.S_IMODE(auth.stat().st_mode) == 0o640
        print("PASS: validator launches a loopback proxy with only the exact isolated candidate")


def test_response_and_process_failures():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        auth = root / "claude-user.json"
        auth.write_text(json.dumps(valid_auth(token="good-token")))
        for mode, expected in [("empty", "without model content"), ("exit", "exited before readiness")]:
            proxy, _ = make_proxy(root, mode)
            with proxy_env(proxy):
                valid, reason = bu_reauth.send_canary("claude-sonnet-5", auth)
            assert valid is False, mode
            assert expected in reason, (mode, reason)
        print("PASS: malformed responses and failed candidate proxy startup fail closed")


def test_healthy_shared_endpoint_cannot_validate_bad_candidate():
    class HealthyShared(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = b'{"choices":[{"message":{"content":"healthy-shared"}}]}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    shared = ThreadingHTTPServer(("127.0.0.1", 0), HealthyShared)
    thread = threading.Thread(target=shared.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            auth = root / "claude-user.json"
            auth.write_text(json.dumps(valid_auth(token="bad-token")))
            proxy, record = make_proxy(root)
            shared_url = f"http://127.0.0.1:{shared.server_port}/v1/chat/completions"
            with proxy_env(proxy), patch.dict(os.environ, {"CRSPROXY_CANARY_URL": shared_url}, clear=False):
                valid, reason = bu_reauth.send_canary("claude-sonnet-5", auth)
            assert valid is False
            assert "authentication rejected" in reason
            used = json.loads(record.read_text())
            assert used["port"] != shared.server_port
            assert used["token"] == "bad-token"
            print("PASS: healthy shared service cannot substitute for a bad isolated candidate")
    finally:
        shared.shutdown()
        shared.server_close()
        thread.join(timeout=2)


def test_validation_classification_and_timeout():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        bad = root / "bad.json"
        bad.write_text(json.dumps(valid_auth(token="bad-token")))
        proxy, _ = make_proxy(root)
        with proxy_env(proxy):
            valid, reason = bu_reauth.send_canary("claude-sonnet-5", bad)
        assert valid is False and "authentication rejected" in reason

        good = root / "good.json"
        good.write_text(json.dumps(valid_auth(token="good-token")))
        timeout_proxy, _ = make_proxy(root, "timeout")
        with proxy_env(timeout_proxy):
            valid, reason = bu_reauth.send_canary("claude-sonnet-5", good, timeout=0.2)
        assert valid is False and "timed out" in reason
        print("PASS: candidate status and validator-owned timeout fail closed")


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
        test_response_and_process_failures,
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
