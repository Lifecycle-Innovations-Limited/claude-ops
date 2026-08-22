#!/usr/bin/env python3
"""Shared helpers for Paperclip surface-alignment bridges.

Used by agent_claim_guard, alignment_sweep, paperclip_linear_mirror, argo_triage_bridge.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

HOME = Path.home()
ENV_PATHS = (
    HOME / ".hermes" / ".env",
    HOME / ".mcp-secrets.env",
)
DEFAULT_API = "http://127.0.0.1:18790"
AURORA_COMPANY_ID = os.environ.get("PAPERCLIP_AURORA_COMPANY_ID", "")
CLIENT_COMPANY_ID = os.environ.get("PAPERCLIP_CLIENT_COMPANY_ID", "")
CLAIM_TTL_SECONDS = 2 * 60 * 60

META_RE = re.compile(
    r"^(stage|machine|worktree|branch|pr|run_id|linear|mirror|paperclip):\s*(.+)$",
    re.I | re.M,
)
ISSUE_ID_RE = re.compile(r"\b([A-Z]{2,6}-\d+)\b")
PR_URL_RE = re.compile(r"https?://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)")

# Title convention (Linear ↔ Paperclip dual-write)
# Paperclip (linked):  [{linear_id}] {semantic}
# Paperclip (native):  {semantic}
# Linear (from PC):    [Paperclip {pc_id}] {semantic}
# Never nest [Paperclip …] or re-wrap issue-id brackets.
_PC_PREFIX_RE = re.compile(r"^\s*\[Paperclip\s+([A-Z]{2,6}-\d+)\]\s*", re.I)
# Incomplete storm residue: "[Paperclip HEA-1141" (no closing bracket, title truncated)
_PC_PREFIX_OPEN_RE = re.compile(r"^\s*\[Paperclip\s+([A-Z]{2,6}-\d+)\s*$", re.I)
_PC_ANY_RE = re.compile(r"\s*\[Paperclip\s+[A-Z]{2,6}-\d+\]\s*", re.I)
_PC_TRUNC_RE = re.compile(r"\s*\[Paperclip\s+[A-Z]{2,6}-\d*\s*$", re.I)
_LEAD_ISSUE_RE = re.compile(r"^\s*\[([A-Z]{2,6}-\d+)\]\s*")
_LEAD_ISSUE_OPEN_RE = re.compile(r"^\s*\[([A-Z]{2,6}-\d+)\s*$")
_LINEAR_MARK_RE = re.compile(r"linear:\s*([A-Z]{2,6}-\d+)", re.I)
_LINEAR_URL_RE = re.compile(r"linear\.app/[^/\s]+/issue/([A-Z]{2,6}-\d+)", re.I)
_ORIG_LINEAR_RE = re.compile(r"Original Linear Issue:\s*\[([A-Z]{2,6}-\d+)\]", re.I)


def clean_semantic_title(title: str) -> str:
    """Strip nested dual-write brackets; keep semantic tags like [Phase 2], [T2]."""
    t = (title or "").strip()
    if not t:
        return "Untitled"
    while True:
        n = _PC_PREFIX_RE.sub("", t)
        n = _LEAD_ISSUE_RE.sub("", n)
        if n == t:
            break
        t = n.strip()
    t = _PC_ANY_RE.sub(" ", t)
    # Drop truncated storm residue (no closing ']')
    t = _PC_TRUNC_RE.sub("", t).strip()
    t = _PC_PREFIX_OPEN_RE.sub("", t).strip()
    t = _LEAD_ISSUE_OPEN_RE.sub("", t).strip()
    while True:
        n = _LEAD_ISSUE_RE.sub("", t)
        if n == t:
            break
        t = n.strip()
    t = re.sub(r"\s+", " ", t).strip().rstrip(" |:")
    return t or "Untitled"


def extract_linear_id_from_blob(blob: str) -> Optional[str]:
    for rx in (_LINEAR_MARK_RE, _ORIG_LINEAR_RE, _LINEAR_URL_RE):
        m = rx.search(blob or "")
        if m:
            return m.group(1).upper()
    return None


def canonical_paperclip_title(title: str, linear_id: Optional[str] = None) -> str:
    """One Paperclip title: optional single [{linear_id}] + semantic body."""
    semantic = clean_semantic_title(title)
    if linear_id:
        return f"[{linear_id.upper()}] {semantic}"[:250]
    return semantic[:250]


def canonical_linear_title(pc_id: str, title: str) -> str:
    """One Linear title for PC export: single [Paperclip {pc}] + semantic body."""
    semantic = clean_semantic_title(title)
    # Avoid wrapping if semantic accidentally still starts with Paperclip (shouldn't)
    return f"[Paperclip {pc_id}] {semantic}"[:250]


def title_has_export_markers(title: str) -> bool:
    """True if title looks like a Paperclip→Linear export (anti-loop)."""
    t = title or ""
    return bool(_PC_PREFIX_RE.match(t) or _PC_ANY_RE.search(t) or "Exported from Paperclip" in t)

STAGE_TO_STATUS = {
    "backlog": "backlog",
    "research": "todo",
    "build": "in_progress",
    "review": "in_review",
    "test": "in_review",
    "integrate": "in_review",
    "done": "done",
    "blocked": "blocked",
}

# Paperclip status -> Linear state name candidates (first match wins)
PC_TO_LINEAR_STATE = {
    "backlog": ["Backlog", "Triage"],
    "todo": ["Todo", "Ready", "Unstarted"],
    "in_progress": ["In Progress", "In progress", "Started"],
    "in_review": ["In Review", "In review", "Review", "Testing"],
    "blocked": ["On Hold", "Blocked", "Hold"],
    "done": ["Production", "Done", "Completed", "Closed"],
    "cancelled": ["Canceled", "Cancelled", "Duplicate", "Done"],
}


def load_env() -> None:
    for path in ENV_PATHS:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'").strip('"')
            os.environ.setdefault(k, v)


def api_base() -> str:
    return os.environ.get("PAPERCLIP_API_URL", DEFAULT_API).rstrip("/")


def api_key() -> str:
    return (
        os.environ.get("PAPERCLIP_BOARD_API_KEY", "").strip()
        or os.environ.get("PAPERCLIP_BRIDGE_API_KEY", "").strip()
    )


def api_call(method: str, path: str, payload: Optional[dict] = None, timeout: int = 30) -> tuple[int, Any]:
    load_env()
    key = api_key()
    if not key:
        return 0, {"error": "missing PAPERCLIP_BOARD_API_KEY"}
    url = f"{api_base()}{path if path.startswith('/') else '/' + path}"
    if not path.startswith("/api/") and not url.startswith(api_base() + "/api"):
        # normalize: callers may pass /api/... or /issues/...
        if not path.startswith("/api"):
            url = f"{api_base()}/api{path if path.startswith('/') else '/' + path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")[:800]
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def get_issue(ident: str) -> tuple[int, Any]:
    return api_call("GET", f"/api/issues/{ident}")


def list_company_issues(company_id: str, status: Optional[str] = None) -> tuple[int, Any]:
    path = f"/api/companies/{company_id}/issues"
    if status:
        path += f"?status={urllib.parse.quote(status)}"  # type: ignore[name-defined]
    return api_call("GET", path)


def create_issue(
    company_id: str,
    title: str,
    description: str,
    priority: str = "medium",
    status: Optional[str] = None,
    assignee_agent_id: Optional[str] = None,
) -> tuple[int, Any]:
    payload: dict[str, Any] = {
        "title": title,
        "description": description,
        "priority": priority,
    }
    if status:
        payload["status"] = status
    if assignee_agent_id:
        payload["assigneeAgentId"] = assignee_agent_id
    return api_call("POST", f"/api/companies/{company_id}/issues", payload)


def patch_issue(ident: str, payload: dict) -> tuple[int, Any]:
    return api_call("PATCH", f"/api/issues/{ident}", payload)


def add_comment(ident: str, body: str) -> tuple[int, Any]:
    return api_call("POST", f"/api/issues/{ident}/comments", {"body": body})


def parse_meta(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not text:
        return out
    for m in META_RE.finditer(text):
        out[m.group(1).lower()] = m.group(2).strip()
    return out


def _comment_sort_key(c: dict) -> str:
    """Prefer createdAt; fall back to updatedAt/id so order is stable."""
    return str(c.get("createdAt") or c.get("created_at") or c.get("updatedAt") or c.get("id") or "")


def collect_issue_meta(issue: dict, comments: Optional[list] = None) -> dict[str, str]:
    parts = [issue.get("description") or "", issue.get("title") or ""]
    if comments:
        # Paperclip comments API returns newest-first (DESC). Sort ASC so
        # last-match == chronologically latest stage/pr/machine tag.
        ordered = sorted(
            [c for c in comments if isinstance(c, dict)],
            key=_comment_sort_key,
        )
        for c in ordered:
            parts.append(c.get("body") or "")
    blob = "\n".join(parts)
    meta = parse_meta(blob)
    # latest wins for stage/machine etc: re-parse in order already last-match
    for key in list(meta.keys()):
        # re-scan for last occurrence
        matches = re.findall(rf"^{key}:\s*(.+)$", blob, flags=re.I | re.M)
        if matches:
            meta[key] = matches[-1].strip()
    return meta


def get_comments(ident: str) -> list[dict]:
    code, data = api_call("GET", f"/api/issues/{ident}/comments")
    if code == 200 and isinstance(data, list):
        comments = data
    elif code == 200 and isinstance(data, dict):
        comments = data.get("comments") or data.get("items") or data.get("data") or []
    else:
        return []
    # Always chronological ASC for meta/DoD consumers (API is DESC).
    return sorted([c for c in comments if isinstance(c, dict)], key=_comment_sort_key)


def lock_age_seconds(issue: dict) -> Optional[float]:
    locked = issue.get("executionLockedAt") or issue.get("execution_locked_at")
    if not locked:
        return None
    try:
        ts = datetime.fromisoformat(str(locked).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except Exception:
        return None


def is_live_lock(issue: dict, ttl: int = CLAIM_TTL_SECONDS) -> bool:
    run = issue.get("executionRunId") or issue.get("execution_run_id")
    if not run:
        return False
    age = lock_age_seconds(issue)
    if age is None:
        return True
    return age < ttl


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_state(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, default=str) + "\n")


def load_state(path: Path, default: Optional[dict] = None) -> dict:
    if not path.exists():
        return dict(default or {})
    try:
        return json.loads(path.read_text())
    except Exception:
        return dict(default or {})


# late import fix for list_company_issues
import urllib.parse  # noqa: E402
