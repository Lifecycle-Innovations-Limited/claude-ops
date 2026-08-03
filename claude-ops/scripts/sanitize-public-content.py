#!/usr/bin/env python3
"""Scan public Claude Ops docs/templates for non-portable content.

This is a read-only guard. It is intended for changed public files, not for
rewriting historical content automatically.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

EXCLUDE_PARTS = {".git", "node_modules", "__pycache__", ".pytest_cache", "dist", "build", "coverage"}
EXCLUDE_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "CHANGELOG.md"}
EXTS = {".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sh", ".bash", ".py", ".js", ".mjs", ".ts", ".tsx"}
PLACEHOLDER_RE = re.compile(r"\{\{[A-Z0-9_\.:-]+\}\}|\$\{?[A-Z0-9_]+\}?|example\.(com|org|net)", re.I)

RUNTIME_PRIMITIVE_RE = re.compile(
    r"\b(?:"
    + "|".join(
        [
            "Task" + "Create",
            "add" + "BlockedBy",
            "CLAUDE_CODE" + "_EXPERIMENTAL_AGENT_TEAMS",
            r"mcp" + r"__[A-Za-z0-9_]+" + r"__[A-Za-z0-9_]+",
            r"gh\s+[^\n]*" + r"--admin",
        ]
    )
    + r")\b"
)

CHECKS = [
    (
        "absolute_local_path",
        re.compile(r"(?<![A-Za-z0-9_])(/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|/mnt/[A-Za-z0-9._/-]+)"),
        "Use $HOME, XDG dirs, package-relative paths, or {{PLUGIN_ROOT}}/{{OPS_DATA_DIR}}.",
    ),
    (
        "real_email",
        re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
        "Use {{CONTACT_EMAIL}} or a reserved example.com/org/net address.",
    ),
    (
        "chat_or_channel_id",
        re.compile(r"\b(?:chat_id|thread_id|message_thread_id|jid|channel_id)\s*[:=]\s*['\"]?[A-Za-z0-9_@.-]{6,}|\b-?100\d{8,}\b|\b\d{10,}@g\.us\b", re.I),
        "Use {{APPROVAL_CHANNEL}}/{{COMM_CHANNELS.*}} and keep real IDs in user config.",
    ),
    (
        "private_service_url",
        re.compile(
            r"https?://(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|"
            r"100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|"
            r"172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|"
            r"[A-Za-z0-9.-]*\.internal)\S*",
            re.I,
        ),
        "Use {{SERVICE_URL}} or SERVICE_REGISTRY_PATH, not private URLs.",
    ),
    (
        "unadapted_runtime_primitive",
        RUNTIME_PRIMITIVE_RE,
        "Put runtime-specific primitives behind an adapter/capability name.",
    ),
]

@dataclass
class Finding:
    path: str
    line: int
    kind: str
    message: str
    snippet: str


def allowed(_line: str, match_text: str) -> bool:
    if PLACEHOLDER_RE.search(match_text):
        return True
    if re.search(r"@(example\.com|example\.org|example\.net)$", match_text, re.I):
        return True
    return False


def iter_files(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_file():
            out.append(p)
            continue
        for child in p.rglob("*"):
            if not child.is_file():
                continue
            if child.suffix not in EXTS:
                continue
            if child.name in EXCLUDE_NAMES:
                continue
            if any(part in EXCLUDE_PARTS for part in child.parts):
                continue
            out.append(child)
    return sorted(set(out))


def scan_file(path: Path) -> list[Finding]:
    try:
        text = path.read_text(errors="ignore")
    except Exception as exc:
        return [Finding(str(path), 0, "read_error", str(exc), "")]
    findings: list[Finding] = []
    for no, line in enumerate(text.splitlines(), 1):
        for kind, rx, msg in CHECKS:
            match = rx.search(line)
            if not match or allowed(line, match.group(0)):
                continue
            snippet = line.strip()
            if len(snippet) > 180:
                snippet = snippet[:177] + "..."
            findings.append(Finding(str(path), no, kind, msg, snippet))
            break
    return findings


def run(paths: list[str]) -> dict:
    files = iter_files(paths)
    findings: list[Finding] = []
    for path in files:
        findings.extend(scan_file(path))
    by_kind: dict[str, int] = {}
    for finding in findings:
        by_kind[finding.kind] = by_kind.get(finding.kind, 0) + 1
    return {
        "files_scanned": len(files),
        "findings": len(findings),
        "by_kind": dict(sorted(by_kind.items())),
        "sample": [asdict(f) for f in findings[:200]],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", help="Files or directories to scan")
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    args = parser.parse_args(argv)
    report = run(args.paths)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"files_scanned={report['files_scanned']} findings={report['findings']}")
        for kind, count in report["by_kind"].items():
            print(f"{kind}: {count}")
        for finding in report["sample"]:
            print(f"{finding['path']}:{finding['line']}: {finding['kind']}: {finding['snippet']}")
    return 1 if report["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
