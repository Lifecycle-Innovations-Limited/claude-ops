#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sanitize-public-content.py"
FIXTURES = ROOT / "tests" / "fixtures" / "public-sanitizer"

spec = importlib.util.spec_from_file_location("sanitize_public_content", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_good_fixture_passes():
    report = module.run([str(FIXTURES / "good.md")])
    assert report["findings"] == 0, report


def test_bad_fixture_fails_by_category():
    # Build unsafe values at runtime so repository PII/secret guards do not
    # mistake intentional test data for leaked operator data.
    content = "\n".join(
        [
            "Do not ship absolute paths like " + "/" + "home" + "/" + "alice" + "/private-plugin.",
            "Do not ship real emails like " + "owner" + "@" + "private.invalid" + " even beside {{ORG_NAME}}.",
            "Do not ship chat IDs like chat_id=" + "12345" + "67890.",
            "Do not ship private URLs like https://" + "192.168.1.10" + "/admin.",
            "Do not ship unadapted runtime primitives like " + "Task" + "Create.",
        ]
    )
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "bad.md"
        bad.write_text(content)
        report = module.run([str(bad)])
    assert report["findings"] >= 5, report
    for kind in [
        "absolute_local_path",
        "real_email",
        "chat_or_channel_id",
        "private_service_url",
        "unadapted_runtime_primitive",
    ]:
        assert report["by_kind"].get(kind, 0) >= 1, report


def test_public_contract_and_example_pass():
    report = module.run([
        str(ROOT / "docs" / "public-template-contract.md"),
        str(ROOT / "templates" / "claude-ops.example.config.yaml"),
    ])
    assert report["findings"] == 0, report


if __name__ == "__main__":
    test_good_fixture_passes()
    test_bad_fixture_fails_by_category()
    test_public_contract_and_example_pass()
    print("public sanitizer tests passed")
