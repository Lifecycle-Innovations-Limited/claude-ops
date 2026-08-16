#!/usr/bin/env python3
"""Paperclip ↔ Linear full bidirectional parity bridge.

Identity: Linear OAuth app actor **AgentCore** (branded Paperclip in comments)
  LINEAR_AGENTCORE_TOKEN / LINEAR_AGENTCORE_USER_ID
  aliases: LINEAR_PAPERCLIP_* / LINEAR_PAPERCLIP_DELEGATE_*

Directions
----------
1. **Inbound Linear → Paperclip**
   Open Linear issues delegated to the app actor → create Paperclip SSOT issues
   with explicit `linear:` + `mirror:linear`, reverse-comment on Linear.

2. **Outbound Paperclip → Linear**
   Paperclip issues missing a Linear link → create Linear issue with
   `delegateId` = Paperclip/AgentCore app user, write `linear:` back onto
   Paperclip, comment both sides.

3. **Delegate repair**
   Already-linked Linear issues without our app as delegate → set delegateId.

4. **Status sync**
   Paperclip status → Linear workflow state (per-team states).

5. **Comment sync**
   Paperclip comments → Linear (and reverse) with idempotency markers.

Paperclip remains agent-execution SSOT. Linear is product UI + official AI delegate.

Never invent Linear IDs from bare Paperclip parent titles like `[HEA-1136]`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from alignment_lib import (  # noqa: E402
    PRIMARY_COMPANY_ID,
    PC_TO_LINEAR_STATE,
    add_comment,
    api_call,
    canonical_linear_title,
    canonical_paperclip_title,
    clean_semantic_title,
    create_issue,
    get_comments,
    get_issue,
    load_env,
    load_state,
    now_iso,
    patch_issue,
    title_has_export_markers,
    write_state,
)

HOME = Path.home()
STATE_PATH = HOME / ".hermes" / "state" / "linear_paperclip_delegate_bridge.json"
LINEAR_GQL = "https://api.linear.app/graphql"
DEFAULT_DELEGATE_USER_ID = "1972ae8f-ef08-422b-a172-1a728f86abf6"
PRIMARY_TEAM_ID = "7d9c9413-d41d-4226-a041-f935c8d492df"
# HEA inbound Linear→Paperclip: Agent Qiubo routes/owns (Sam 2026-07-19)
HEA_INBOUND_ASSIGNEE_AGENT_ID = "b33501c1-1cc6-4e44-810c-66cc1f684f2d"
HEA_INBOUND_ASSIGNEE_NAME = "Agent Qiubo"

TEAM_TO_COMPANY = {
    "HEA": PRIMARY_COMPANY_ID,
    "MES": "71380d2a-b29e-48fc-8f10-49a8df8b2e46",
    "DUTCH": "c4e2ebdd-351c-4bf0-9d96-4c22147ad85d",
    "INB": "6ef96e49-0728-4170-bd2f-13c6b8bdce25",
    "MAITR": "315900cc-2f0c-49d5-8c46-0a6b9e8612ff",
    "FIBER": "968b5198-9e73-418a-b375-edd024426f63",
}

# Optional company → inbound router agent (only HEA for now)
INBOUND_ROUTER_AGENT = {
    PRIMARY_COMPANY_ID: HEA_INBOUND_ASSIGNEE_AGENT_ID,
}

# Paperclip company → Linear team
COMPANY_TO_TEAM = {
    PRIMARY_COMPANY_ID: ("HEA", PRIMARY_TEAM_ID),
    "71380d2a-b29e-48fc-8f10-49a8df8b2e46": ("MES", "4e5dd03a-1015-4506-b6d0-b408b02ed7c2"),
    "c4e2ebdd-351c-4bf0-9d96-4c22147ad85d": ("DUTCH", "dd6deb04-63ac-43ae-b90b-6a59cc22d8fd"),
    "6ef96e49-0728-4170-bd2f-13c6b8bdce25": ("INB", "58cd5b2c-fb32-4c65-9558-db0346094883"),
    "315900cc-2f0c-49d5-8c46-0a6b9e8612ff": ("MAITR", "ce8db850-b7ac-4909-adcb-6fddb0342f72"),
    "968b5198-9e73-418a-b375-edd024426f63": ("FIBER", "44d87f3a-60cb-4760-a5ba-ccf1e43bfca7"),
}

PRIO_TO_PC = {0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low"}
PC_TO_PRIO = {"critical": 1, "high": 2, "medium": 3, "low": 4, "none": 0}

ISSUE_ID_RE = re.compile(r"\b([A-Z]{2,6}-\d+)\b")
LINEAR_MARK_RE = re.compile(r"linear:\s*([A-Z]{2,6}-\d+)", re.I)
LINEAR_URL_RE = re.compile(r"linear\.app/[^/\s]+/issue/([A-Z]{2,6}-\d+)", re.I)
PC_COMMENT_MARK = re.compile(r"paperclip-comment:([a-f0-9-]{8,})", re.I)
LIN_COMMENT_MARK = re.compile(r"linear-comment:([a-f0-9-]{8,})", re.I)


def agent_token() -> str:
    return (
        os.environ.get("LINEAR_PAPERCLIP_DELEGATE_TOKEN", "").strip()
        or os.environ.get("LINEAR_PAPERCLIP_TOKEN", "").strip()
        or os.environ.get("LINEAR_AGENTCORE_TOKEN", "").strip()
    )


def agent_user_id() -> str:
    return (
        os.environ.get("LINEAR_PAPERCLIP_DELEGATE_USER_ID", "").strip()
        or os.environ.get("LINEAR_PAPERCLIP_USER_ID", "").strip()
        or os.environ.get("LINEAR_AGENTCORE_USER_ID", "").strip()
        or DEFAULT_DELEGATE_USER_ID
    )


def personal_key() -> str:
    return (
        os.environ.get("LINEAR_API_KEY", "").strip()
        or os.environ.get("TEAM_LINEAR_API_KEY", "").strip()
    )


def linear_gql(query: str, variables: Optional[dict] = None, token: Optional[str] = None) -> dict:
    auth = (token or agent_token() or personal_key()).strip()
    if not auth:
        return {"errors": [{"message": "missing Linear token"}]}
    payload = {"query": query, "variables": variables or {}}
    req = urllib.request.Request(
        LINEAR_GQL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": auth},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        return {"errors": [{"message": f"HTTP {e.code}: {body}"}]}
    except Exception as e:  # noqa: BLE001
        return {"errors": [{"message": str(e)}]}


def psql_json(sql: str) -> Any:
    env = os.environ.copy()
    env.setdefault("PGPASSWORD", "paperclip")
    cp = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-At", "-c", sql],
        text=True,
        capture_output=True,
        env=env,
        timeout=40,
    )
    if cp.returncode != 0:
        return None
    raw = (cp.stdout or "").strip()
    if not raw or raw == "null":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def company_for_team(team_key: str) -> Optional[str]:
    return TEAM_TO_COMPANY.get((team_key or "").upper())


def team_for_company(company_id: str) -> Optional[tuple[str, str]]:
    return COMPANY_TO_TEAM.get(company_id)


def extract_linear_id(blob: str) -> Optional[str]:
    """Extract a real Linear id; never treat linear:UNLINKED as a pair."""
    text = blob or ""
    if re.search(r"linear:\s*UNLINKED\b", text, re.I) and not re.search(
        r"linear:\s*[A-Z]{2,6}-\d+",
        re.sub(r"linear:\s*UNLINKED\b", "", text, flags=re.I),
    ):
        return None
    # Prefer positive markers, skipping UNLINKED lines
    for line in text.splitlines():
        if re.search(r"linear:\s*UNLINKED\b", line, re.I):
            continue
        if re.search(r"false-linear:", line, re.I):
            continue
        for rx in (
            LINEAR_MARK_RE,
            LINEAR_URL_RE,
            re.compile(r"Original Linear Issue:\s*\[([A-Z]{2,6}-\d+)\]", re.I),
        ):
            m = rx.search(line)
            if m:
                return m.group(1).upper()
    for rx in (LINEAR_MARK_RE, LINEAR_URL_RE, re.compile(r"Original Linear Issue:\s*\[([A-Z]{2,6}-\d+)\]", re.I)):
        m = rx.search(text)
        if m:
            return m.group(1).upper()
    return None


def is_authoritative_linear_link_comment(body: str) -> bool:
    """True only for deliberate SSOT link writebacks, not cross-refs.

    Standing routines (e.g. HEA-62) accumulate mirrored Linear comments that
    end with ``linear:HEA-4949``. Treating those as pair markers makes the
    bridge push the routine's ``in_progress`` status onto the product issue
    and thrash Production ↔ In Progress every 15m.

    Accept short marker-only / export writebacks; reject Linear mirrors and
    long triage reports. Also reject cleanup/unlink markers so residual
    children cannot re-pair via historical comments.
    """
    b = (body or "").strip()
    if not b:
        return False
    if b.startswith("**Linear comment**") or "linear-comment:" in b:
        return False
    if b.startswith("**Paperclip comment**") or "paperclip-comment:" in b:
        return False
    if "Mirror from Paperclip" in b:
        return False
    # Cleanup / multi-collapse markers are never pair sources
    if re.search(r"false-linear:|linear:UNLINKED|cleanup-all:|cleanup-fix:|cleanup-wave1:|UNLINKED from linear:", b, re.I):
        return False
    if re.search(r"\b(sweep|triage|heartbeat|wake ack|not-a-bug|Sentry)\b", b, re.I) and len(b) > 200:
        return False
    if len(b) > 500:
        return False
    has_mark = bool(LINEAR_MARK_RE.search(b) or LINEAR_URL_RE.search(b) or re.search(r"Original Linear Issue:", b, re.I))
    if not has_mark:
        return False
    # Deliberate mapping writeback
    if re.search(r"mirror:\s*linear", b, re.I) or re.search(r"Original Linear Issue:", b, re.I):
        return True
    if re.search(r"Exported to Linear|paperclip-export:linked|own Linear export|Relinked existing", b, re.I):
        return True
    # Short marker-only comment (export/link ack)
    if len(b) < 220 and b.count("\n") < 8:
        return True
    return False


def find_linear_issue(identifier: str) -> Optional[dict]:
    q = """
    query($id: String!) {
      issue(id: $id) {
        id identifier title url description priority
        state { id name type }
        team { id key }
        delegate { id name }
        labels { nodes { id name } }
        comments(first: 30) { nodes { id body createdAt user { id name } } }
      }
    }
    """
    data = linear_gql(q, {"id": identifier}, token=personal_key() or agent_token())
    if data.get("errors"):
        msg = json.dumps(data.get("errors"))
        # Rate limit: return sentinel so callers skip instead of thrashing creates
        if "RATELIMITED" in msg or "Rate limit" in msg or "429" in msg:
            return {"_rate_limited": True, "identifier": identifier}
        return None
    return ((data.get("data") or {}).get("issue")) or None


def paperclip_label_names(pc_ident: str) -> list[str]:
    """Load Paperclip label names for an issue (HEA company labels)."""
    sql = f"""
SELECT json_agg(l.name ORDER BY l.name) FROM issue_labels il
JOIN issues i ON i.id = il.issue_id
JOIN labels l ON l.id = il.label_id
WHERE i.identifier = '{pc_ident.replace(chr(39), "")}'
"""
    try:
        data = psql_json(sql)
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, list):
        return [str(x) for x in data if x]
    return []


def desired_linear_label_ids(pc_ident: str, lin: dict) -> tuple[Optional[list[str]], str]:
    """Compute Linear labelIds: keep current + add mapped PC labels.

    Additive for product taxonomy. Exception: strip banned priority/security-noise
    labels (Priority:*, P1, priority-*, Security - <company>) so they cannot return.
    Returns (label_ids_or_None_if_no_change, note).
    """
    try:
        from hea_label_map import is_banned_linear_label, resolve_linear_label_ids  # type: ignore
    except Exception as e:  # noqa: BLE001
        return None, f"label map unavailable: {e}"

    pc_names = paperclip_label_names(pc_ident)
    # never treat Priority:* as PC source labels
    pc_names = [n for n in pc_names if n and not str(n).startswith("Priority:")]
    want_managed = set(resolve_linear_label_ids(pc_names))
    cur_nodes = (((lin.get("labels") or {}).get("nodes")) or [])
    banned_ids = {str(n.get("id")) for n in cur_nodes if is_banned_linear_label(n.get("name") or "")}
    cur_ids = {str(n.get("id")) for n in cur_nodes if n.get("id")}
    keep = cur_ids - banned_ids
    final = sorted(keep | want_managed)
    if set(final) == cur_ids:
        return None, f"already aligned (pc_labels={len(pc_names)} managed={len(want_managed)})"
    return final, (
        f"pc={len(pc_names)} add_managed={len(want_managed - cur_ids)} "
        f"strip_banned={len(banned_ids)} keep={len(keep)}"
    )


def update_linear_fields(issue_id: str, fields: dict[str, Any]) -> dict:
    """Patch Linear issue fields (title/priority/state/delegate)."""
    if not fields:
        return {"data": {"issueUpdate": {"success": True}}}
    m = """
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success issue { id identifier title priority state { name } delegate { id name } }
      }
    }
    """
    # Prefer personal key for reliability; agent token also OK for HEA
    res = linear_gql(m, {"id": issue_id, "input": fields}, token=personal_key() or agent_token())
    if res.get("errors"):
        res = linear_gql(m, {"id": issue_id, "input": fields}, token=agent_token() or personal_key())
    return res


def desired_linear_title(pc_ident: str, pc_title: str, lin_title: str) -> Optional[str]:
    """Paperclip title is SSOT when AgentCore is delegate.

    - Preserve ``[Paperclip HEA-N]`` prefix on exports.
    - For native Linear titles, replace with PC title (no prefix) unless already equal.
    """
    pc_title = (pc_title or "").strip()
    lin_title = (lin_title or "").strip()
    if not pc_title:
        return None
    prefix = f"[Paperclip {pc_ident}]"
    if lin_title.startswith("[Paperclip "):
        want = f"{prefix} {pc_title}"[:250]
        return want if want != lin_title else None
    # Native Linear issue: keep PC title as SSOT under AgentCore ownership
    want = pc_title[:250]
    return want if want != lin_title else None


def desired_linear_priority(pc_priority: Any) -> Optional[int]:
    if pc_priority is None:
        return None
    if isinstance(pc_priority, int):
        # Paperclip sometimes stores numeric already; clamp to Linear 0-4
        if 0 <= pc_priority <= 4:
            return pc_priority
    key = str(pc_priority).strip().lower()
    return PC_TO_PRIO.get(key)


def team_states(team_id: str) -> list[dict]:
    q = """
    query($id: String!) {
      team(id: $id) { states { nodes { id name type } } }
    }
    """
    data = linear_gql(q, {"id": team_id}, token=personal_key() or agent_token())
    return ((((data.get("data") or {}).get("team") or {}).get("states") or {}).get("nodes")) or []


def pick_state_id(states: list[dict], pc_status: str) -> Optional[str]:
    candidates = PC_TO_LINEAR_STATE.get((pc_status or "").lower(), [])
    by_name = {s["name"]: s["id"] for s in states if s.get("name") and s.get("id")}
    for name in candidates:
        if name in by_name:
            return by_name[name]
    type_map = {
        "backlog": "backlog",
        "todo": "unstarted",
        "in_progress": "started",
        "in_review": "started",
        "blocked": "unstarted",  # HEA uses On Hold (unstarted), not a started state
        "done": "completed",
        "cancelled": "canceled",
    }
    want = type_map.get((pc_status or "").lower())
    for s in states:
        if (s.get("type") or "").lower() == want:
            return s.get("id")
    return None


def post_linear_comment(issue_id: str, body: str) -> dict:
    m = """
    mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body, createAsUser: \"Paperclip\" }) {
        success comment { id }
      }
    }
    """
    last: dict = {"errors": [{"message": "no token"}]}
    # Prefer app actor; fall back to personal key for teams the app cannot access (non-HEA).
    for tok in (agent_token(), personal_key()):
        if not tok:
            continue
        res = linear_gql(m, {"id": issue_id, "body": body}, token=tok)
        if not res.get("errors") and ((res.get("data") or {}).get("commentCreate") or {}).get("success"):
            return res
        m2 = """
        mutation($id: String!, $body: String!) {
          commentCreate(input: { issueId: $id, body: $body }) {
            success comment { id }
          }
        }
        """
        res2 = linear_gql(m2, {"id": issue_id, "body": body}, token=tok)
        if not res2.get("errors") and ((res2.get("data") or {}).get("commentCreate") or {}).get("success"):
            return res2
        last = res2 if res2.get("errors") else res
    return last


def update_linear_state(issue_id: str, state_id: str) -> dict:
    m = """
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success issue { id identifier state { name } }
      }
    }
    """
    return linear_gql(m, {"id": issue_id, "stateId": state_id}, token=personal_key() or agent_token())


def set_linear_delegate(issue_id: str, delegate_id: str) -> dict:
    m = """
    mutation($id: String!, $delegateId: String!) {
      issueUpdate(id: $id, input: { delegateId: $delegateId }) {
        success issue { id identifier delegate { id name } }
      }
    }
    """
    # App token preferred for delegate assignment
    res = linear_gql(m, {"id": issue_id, "delegateId": delegate_id}, token=agent_token() or None)
    if res.get("errors"):
        res = linear_gql(m, {"id": issue_id, "delegateId": delegate_id}, token=personal_key() or None)
    return res


def create_linear_issue(
    team_id: str,
    title: str,
    description: str,
    priority: int,
    state_id: Optional[str],
    delegate_id: str,
) -> dict:
    inp: dict[str, Any] = {
        "teamId": team_id,
        "title": title[:250],
        "description": description[:12000],
        "priority": priority,
        "delegateId": delegate_id,
    }
    if state_id:
        inp["stateId"] = state_id
    m = """
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url state { name } delegate { id name } team { key } }
      }
    }
    """
    # Agent token for HEA (has app:assignable); personal key fallback for other teams
    res = linear_gql(m, {"input": inp}, token=agent_token() or None)
    if res.get("errors") or not ((res.get("data") or {}).get("issueCreate") or {}).get("success"):
        res = linear_gql(m, {"input": inp}, token=personal_key() or None)
    return res


def paperclip_existing_for_linear(lin_ident: str) -> list[str]:
    sql = f"""
SELECT json_agg(identifier) FROM (
  SELECT identifier FROM issues
  WHERE description ILIKE '%linear:{lin_ident}%'
     OR description ILIKE '%Original Linear Issue: [{lin_ident}]%'
  ORDER BY updated_at DESC LIMIT 5
) t;
"""
    data = psql_json(sql)
    return data if isinstance(data, list) else []


def append_linear_markers_to_paperclip(pc_ident: str, lin_ident: str, lin_url: str) -> None:
    code, issue = get_issue(pc_ident)
    if code != 200 or not isinstance(issue, dict):
        return
    desc = issue.get("description") or ""
    if f"linear:{lin_ident}" in desc:
        return
    block = (
        f"\n\n---\n"
        f"Original Linear Issue: [{lin_ident}]({lin_url})\n"
        f"linear:{lin_ident}\n"
        f"mirror:linear\n"
        f"delegate:paperclip\n"
    )
    # Prefer comment (safer than description rewrite via API which may lack PATCH body)
    add_comment(
        pc_ident,
        f"linear:{lin_ident}\nmirror:linear\ndelegate:paperclip\n"
        f"Linked Linear: [{lin_ident}]({lin_url})\n"
        f"paperclip-export:linked",
    )
    # Also try description patch if board API allows
    from alignment_lib import patch_issue  # local import

    new_desc = (desc.rstrip() + block)[:14000]
    patch_issue(pc_ident, {"description": new_desc})


# ---------------------------------------------------------------------------
# 1) Inbound Linear → Paperclip
# ---------------------------------------------------------------------------

def list_delegated(limit: int = 25) -> list[dict]:
    uid = agent_user_id()
    q = """
    query($uid: ID!, $n: Int!) {
      issues(
        filter: {
          delegate: { id: { eq: $uid } }
          state: { type: { nin: [\"completed\", \"canceled\"] } }
        }
        first: $n
      ) {
        nodes {
          id identifier title description url priority
          state { name type }
          team { id key name }
          delegate { id name }
        }
      }
    }
    """
    data = linear_gql(q, {"uid": uid, "n": limit}, token=personal_key() or None)
    if data.get("errors"):
        data = linear_gql(q, {"uid": uid, "n": limit}, token=agent_token() or None)
    if data.get("errors"):
        return []
    return (((data.get("data") or {}).get("issues") or {}).get("nodes")) or []


def wakeup_agent(agent_id: str, reason: str = "inbound-linear-delegate") -> tuple[int, Any]:
    """Wake a Paperclip agent so assigned work is picked up."""
    return api_call("POST", f"/api/agents/{agent_id}/wakeup", {"reason": reason})


def route_inbound_to_qiubo(
    pc_id: str,
    lin: str,
    dry_run: bool = False,
    *,
    do_wakeup: bool = True,
    already_assigned: bool = False,
) -> list[str]:
    """Assign Agent Qiubo + comment (+ optional wakeup) for HEA inbound dual-writes.

    Cost guard: callers should set do_wakeup=False for all-but-last create in a
    tick so we only burn one Qiubo heartbeat per full-sync batch.
    """
    events: list[str] = []
    if dry_run:
        events.append(
            f"DRY route {pc_id}: assignee={HEA_INBOUND_ASSIGNEE_NAME}"
            + (" + wakeup" if do_wakeup else " (wakeup deferred)")
        )
        return events
    if not already_assigned:
        code, resp = patch_issue(
            pc_id,
            {
                "assigneeAgentId": HEA_INBOUND_ASSIGNEE_AGENT_ID,
                "status": "todo",
            },
        )
        if code not in (200, 201):
            events.append(f"route FAIL assign {pc_id}: HTTP {code} {resp}")
            return events
    # Idempotent comment marker — skip if already routed this issue
    try:
        comments = get_comments(pc_id)
        bodies = "\n".join((c.get("body") or "") for c in comments if isinstance(c, dict))
    except Exception:  # noqa: BLE001
        bodies = ""
    if "Inbound Linear→Paperclip route" not in bodies:
        add_comment(
            pc_id,
            (
                f"**Inbound Linear→Paperclip route (Sam 2026-07-19)**\n\n"
                f"- Source Linear: `{lin}` (AgentCore delegate)\n"
                f"- Assignee: **{HEA_INBOUND_ASSIGNEE_NAME}** (`{HEA_INBOUND_ASSIGNEE_AGENT_ID}`)\n"
                f"- Action: triage + route to product/eng/growth as needed\n"
                f"- Paperclip is agent SSOT; Linear stays product UI\n"
            ),
        )
        events.append(f"route {pc_id}: assigned {HEA_INBOUND_ASSIGNEE_NAME}")
    else:
        events.append(f"route {pc_id}: already routed (no re-comment)")
    if do_wakeup:
        wcode, wresp = wakeup_agent(
            HEA_INBOUND_ASSIGNEE_AGENT_ID, reason=f"inbound-linear:{lin}->{pc_id}"
        )
        if wcode in (200, 201, 202, 204):
            events.append(f"wakeup {HEA_INBOUND_ASSIGNEE_NAME} ok")
        else:
            events.append(f"wakeup HTTP {wcode} {wresp}")
    else:
        events.append("wakeup deferred (batch)")
    return events


def inbound_dual_write(node: dict, dry_run: bool) -> str:
    lin = node.get("identifier") or ""
    if not lin:
        return "inbound skip: missing identifier"
    title = node.get("title") or ""
    desc = node.get("description") or ""
    # Break ping-pong: do not re-import Linear issues that we exported from Paperclip.
    if (
        title_has_export_markers(title)
        or title.startswith("[Paperclip ")
        or "Exported from Paperclip" in desc
        or re.search(r"paperclip:\s*[A-Z]{2,6}-\d+", desc, re.I)
    ):
        return f"inbound skip {lin}: originated from Paperclip export (anti-loop)"
    existing = paperclip_existing_for_linear(lin)
    if existing:
        return f"inbound skip {lin}: already {existing[0]}"
    team_key = ((node.get("team") or {}).get("key")) or lin.split("-")[0]
    company_id = company_for_team(team_key)
    if not company_id:
        return f"inbound skip {lin}: no Paperclip company for team {team_key}"
    # Canonical: one [{linear_id}] + semantic (never re-wrap storm prefixes)
    pc_title = canonical_paperclip_title(title, linear_id=lin)
    prio = PRIO_TO_PC.get(int(node.get("priority") or 3), "medium")
    url = node.get("url") or ""
    router = INBOUND_ROUTER_AGENT.get(company_id)
    body = (
        f"Original Linear Issue: [{lin}]({url})\n"
        f"linear:{lin}\n"
        f"mirror:linear\n"
        f"stage:todo\n"
        f"delegate:paperclip\n"
        f"source:linear-ai-delegate\n"
        + (f"router:{HEA_INBOUND_ASSIGNEE_NAME}\n" if router else "")
        + "\n"
        f"Delegated to Paperclip (Linear app actor AgentCore / Paperclip).\n"
        f"Paperclip is the agent execution SSOT; Linear remains product UI.\n"
        + (
            f"Routed to {HEA_INBOUND_ASSIGNEE_NAME} for triage + assignment.\n\n"
            if router
            else "\n"
        )
        + f"### Linear description\n{desc[:2500]}\n"
    )
    if dry_run:
        route = f" assignee={HEA_INBOUND_ASSIGNEE_NAME}" if router else ""
        return f"DRY inbound create Paperclip for {lin} → {team_key} prio={prio}{route}"
    code, resp = create_issue(
        company_id,
        pc_title,
        body,
        priority=prio,
        status="todo",
        assignee_agent_id=router,
    )
    if code not in (200, 201) or not isinstance(resp, dict):
        return f"inbound FAIL {lin}: HTTP {code} {resp}"
    pc_id = resp.get("identifier") or resp.get("id")
    events = [f"inbound created {pc_id} for {lin}"]
    # Wake deferred to main loop (one wakeup per tick). Comment/assign here only.
    if router and pc_id:
        events.extend(
            route_inbound_to_qiubo(
                str(pc_id),
                lin,
                dry_run=False,
                do_wakeup=False,
                already_assigned=True,  # create_issue set assigneeAgentId
            )
        )
    post_linear_comment(
        node["id"],
        f"**Paperclip SSOT dual-write**\n\n"
        f"- Paperclip issue: `{pc_id}`\n- Linear: `{lin}`\n"
        f"- Mapping: `linear:{lin}` + `mirror:linear`\n"
        + (
            f"- Routed to: **{HEA_INBOUND_ASSIGNEE_NAME}** (triage + route)\n\n"
            if router
            else "\n"
        )
        + "Agents execute on Paperclip. Do not treat Linear as the agent queue.",
    )
    return "; ".join(events)


# ---------------------------------------------------------------------------
# 2) Outbound Paperclip → Linear (create + delegate)
# ---------------------------------------------------------------------------

def outbound_export_candidates(limit: int = 40, include_unlinked_open: bool = True) -> list[dict]:
    """Paperclip issues that should exist on Linear.

    Always: open issues with mirror:linear/export:linear and no linear: link.
    Optional: open HEA issues missing linear: (capped by caller).
    Prefers unlinked rows via SQL so older product work is not starved by recency.
    """
    companies = "','".join(COMPANY_TO_TEAM.keys())
    sql = f"""
SELECT json_agg(row_to_json(t)) FROM (
  SELECT i.identifier, i.status, i.priority, i.title,
         left(coalesce(i.description,''), 3000) AS description,
         i.company_id::text AS company_id,
         CASE
           WHEN i.description ~* 'mirror:\\s*linear' OR i.description ~* 'export:\\s*linear' THEN true
           WHEN EXISTS (
             SELECT 1 FROM issue_comments c
             WHERE c.issue_id=i.id AND (c.body ~* 'mirror:\\s*linear' OR c.body ~* 'export:\\s*linear')
           ) THEN true
           ELSE false
         END AS marked,
         CASE
           WHEN i.description ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+' THEN true
           WHEN i.description ILIKE '%Original Linear Issue:%' THEN true
           WHEN EXISTS (
             SELECT 1 FROM issue_comments c
             WHERE c.issue_id=i.id AND c.body ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
           ) THEN true
           ELSE false
         END AS has_linear
  FROM issues i
  WHERE i.company_id::text IN ('{companies}')
    AND i.status NOT IN ('cancelled','canceled','done')
    AND NOT (
      i.description ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
      OR i.description ILIKE '%Original Linear Issue:%'
      OR EXISTS (
        SELECT 1 FROM issue_comments c
        WHERE c.issue_id=i.id AND c.body ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
      )
    )
  ORDER BY
    CASE WHEN i.description ~* 'mirror:\\s*linear' OR i.description ~* 'export:\\s*linear' THEN 0 ELSE 1 END,
    CASE i.status
      WHEN 'in_progress' THEN 0
      WHEN 'in_review' THEN 1
      WHEN 'todo' THEN 2
      WHEN 'blocked' THEN 3
      ELSE 4
    END,
    i.updated_at DESC
  LIMIT {int(limit) * 4}
) t;
"""
    rows = psql_json(sql) or []
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for r in rows:
        if r.get("has_linear"):
            continue
        title = r.get("title") or ""
        desc = r.get("description") or ""
        # Anti-loop / non-product noise
        if (
            title.startswith("[Paperclip ")
            or "[Paperclip " in title
            or "source:linear-ai-delegate" in desc
            or re.match(r"^\[HEA-\d+\]\s", title)
            or title.startswith("Watchdog review for ")
            or title.startswith("coord:")
            or title.startswith("[HEA-") and "residual" in title.lower()
        ):
            continue
        if r.get("marked"):
            out.append(r)
        elif include_unlinked_open and r.get("company_id") == PRIMARY_COMPANY_ID:
            out.append(r)
        if len(out) >= limit:
            break
    return out



def _title_fingerprint(title: str) -> str:
    """Normalize title for open-sibling matching (strip Paperclip/HEA brackets)."""
    sem = clean_semantic_title(title or "")
    t = re.sub(r"\s+", " ", sem).strip().lower()
    t = re.sub(r"^hea-\d+\s*[:\-–—]?\s*", "", t)
    return t


def _linear_issue_search(
    team_id: str,
    term: str,
    *,
    n: int = 10,
    open_only: bool = True,
) -> list[dict]:
    """Search team issues by title/description term. open_only excludes terminal types."""
    if open_only:
        q = """
        query($teamId: ID!, $n: Int, $term: String!) {
          issues(
            first: $n
            filter: {
              team: { id: { eq: $teamId } }
              state: { type: { nin: ["completed", "canceled", "duplicate"] } }
              or: [
                { description: { containsIgnoreCase: $term } }
                { title: { containsIgnoreCase: $term } }
              ]
            }
          ) {
            nodes {
              id identifier title description url
              state { name type }
            }
          }
        }
        """
    else:
        # Any state, including Duplicate/Canceled/Production — used for exact pc-id guard.
        q = """
        query($teamId: ID!, $n: Int, $term: String!) {
          issues(
            first: $n
            filter: {
              team: { id: { eq: $teamId } }
              or: [
                { description: { containsIgnoreCase: $term } }
                { title: { containsIgnoreCase: $term } }
              ]
            }
          ) {
            nodes {
              id identifier title description url
              state { name type }
            }
          }
        }
        """
    data = linear_gql(
        q,
        {"teamId": team_id, "n": n, "term": term},
        token=personal_key() or agent_token(),
    )
    if data.get("errors"):
        return []
    return (((data.get("data") or {}).get("issues") or {}).get("nodes")) or []


def find_open_linear_sibling(
    team_id: str,
    pc_id: str,
    title: str,
    *,
    min_fp_len: int = 20,
) -> Optional[dict]:
    """Return a Linear issue that already mirrors this Paperclip work.

    Guard order:
      1) description contains paperclip:{pc_id}  (any state, including terminal)
      2) title contains [Paperclip {pc_id}]       (any state, including terminal)
      3) open issue whose cleaned title fingerprint equals ours (len >= min_fp_len)

    Exact paperclip-id matches include terminal Linear (Duplicate/Canceled/Production)
    so hygiene-closed mirrors are not re-minted as open clones. Title fingerprint
    stays open-only so distinct intentional open work can still share semantic titles
    without colliding with unrelated closed history.
    """
    pc = (pc_id or "").strip().upper()
    fp = _title_fingerprint(title)
    seen_ids: set[str] = set()
    candidates: list[dict] = []

    def _add(nodes: list[dict]) -> None:
        for n in nodes:
            iid = n.get("id")
            if not iid or iid in seen_ids:
                continue
            seen_ids.add(iid)
            candidates.append(n)

    # Exact id match: search open first, then any-state (terminal).
    if pc:
        for term in (f"paperclip:{pc}", f"[Paperclip {pc}]", pc):
            _add(_linear_issue_search(team_id, term, n=10, open_only=True))
            _add(_linear_issue_search(team_id, term, n=10, open_only=False))
        # Prefer open exact id hits, then terminal exact id hits (newest identifier wins).
        exact: list[dict] = []
        for n in candidates:
            blob = f"{n.get('description') or ''}\n{n.get('title') or ''}"
            if re.search(rf"paperclip:\s*{re.escape(pc)}\b", blob, re.I) or re.search(
                rf"\[Paperclip\s+{re.escape(pc)}\]", n.get("title") or "", re.I
            ):
                exact.append(n)
        if exact:
            def _rank(n: dict) -> tuple:
                st = ((n.get("state") or {}).get("type") or "").lower()
                openish = 0 if st not in ("completed", "canceled", "duplicate") else 1
                try:
                    num = int((n.get("identifier") or "HEA-0").split("-")[-1])
                except Exception:
                    num = 0
                return (openish, -num)

            exact.sort(key=_rank)
            return exact[0]

    # Title fingerprint: open siblings only
    if fp and len(fp) >= min_fp_len:
        needle = fp[:48]
        _add(_linear_issue_search(team_id, needle, n=25, open_only=True))
        for n in candidates:
            other_fp = _title_fingerprint(n.get("title") or "")
            if other_fp and other_fp == fp:
                return n
    return None


def outbound_create(row: dict, dry_run: bool, states_cache: dict[str, list[dict]]) -> str:
    pc = row.get("identifier") or ""
    company_id = row.get("company_id") or ""
    team_info = team_for_company(company_id)
    if not team_info:
        return f"outbound skip {pc}: company not mapped to Linear team"
    team_key, team_id = team_info
    blob = "\n".join([row.get("description") or "", row.get("title") or ""])
    # re-check comments for linear:
    comments = get_comments(pc)
    for c in comments:
        if isinstance(c, dict):
            blob += "\n" + (c.get("body") or "")
    existing_lin = extract_linear_id(blob)
    if existing_lin:
        return f"outbound skip {pc}: already linear:{existing_lin}"

    # Create-guard: reuse Linear sibling (exact paperclip id any state, or open title fingerprint)
    # instead of minting another mirror of the same work.
    sibling = find_open_linear_sibling(team_id, pc, row.get("title") or pc)
    if sibling and sibling.get("identifier"):
        lin_ident = sibling["identifier"]
        lin_uuid = sibling.get("id") or ""
        lin_url = sibling.get("url") or f"https://linear.app/lifecycle-innovations/issue/{lin_ident}"
        st_name = ((sibling.get("state") or {}).get("name") or "")
        st_type = ((sibling.get("state") or {}).get("type") or "").lower()
        terminal = st_type in ("completed", "canceled", "duplicate") or st_name.lower() in (
            "canceled",
            "cancelled",
            "duplicate",
            "done",
            "production",
        )
        kind = "terminal" if terminal else "open"
        if dry_run:
            return (
                f"DRY outbound reuse Linear {lin_ident} for {pc} "
                f"(create-guard {kind} sibling; skip create)"
            )
        append_linear_markers_to_paperclip(pc, lin_ident, lin_url)
        if lin_uuid:
            post_linear_comment(
                lin_uuid,
                f"**Paperclip create-guard reuse**\n\n"
                f"- Linked existing Linear `{lin_ident}` ({st_name or st_type or kind}) "
                f"to Paperclip `{pc}`\n"
                f"- Skipped issueCreate ({kind} sibling by id/title fingerprint; "
                f"will not reopen terminal mirrors)\n"
                f"paperclip:{pc}\nmirror:linear",
            )
        add_comment(
            pc,
            f"Create-guard: reused existing Linear `{lin_ident}` "
            f"({st_name or kind}; no new issue; terminal not reopened).\n"
            f"linear:{lin_ident}\nmirror:linear\n{lin_url}\n"
            f"create-guard:reuse:{kind}",
        )
        return (
            f"outbound reuse {lin_ident} for {pc} "
            f"(create-guard {kind} sibling; skip create)"
        )

    # Canonical Linear title: one [Paperclip {pc}] + semantic (no nested prefixes)
    lin_title = canonical_linear_title(pc, row.get("title") or pc)
    prio_str = (row.get("priority") or "medium")
    if isinstance(prio_str, int):
        priority = prio_str if 0 <= prio_str <= 4 else 3
    else:
        priority = PC_TO_PRIO.get(str(prio_str).lower(), 3)
    pc_status = (row.get("status") or "todo").lower()
    if team_id not in states_cache:
        states_cache[team_id] = team_states(team_id)
    state_id = pick_state_id(states_cache[team_id], pc_status)
    desc = (
        f"Exported from Paperclip SSOT `{pc}`.\n"
        f"paperclip:{pc}\n"
        f"mirror:linear\n"
        f"delegate:paperclip\n\n"
        f"### Paperclip description\n{(row.get('description') or '')[:4000]}\n"
    )
    if dry_run:
        return f"DRY outbound create Linear for {pc} → team={team_key} state={pc_status} prio={priority} delegate=Paperclip"

    res = create_linear_issue(team_id, lin_title, desc, priority, state_id, agent_user_id())
    if res.get("errors"):
        return f"outbound FAIL create {pc}: {res['errors']}"
    created = ((res.get("data") or {}).get("issueCreate") or {})
    issue = created.get("issue") or {}
    if not created.get("success") or not issue.get("identifier"):
        return f"outbound FAIL create {pc}: {res}"
    lin_ident = issue["identifier"]
    lin_url = issue.get("url") or f"https://linear.app/lifecycle-innovations/issue/{lin_ident}"
    lin_uuid = issue["id"]
    append_linear_markers_to_paperclip(pc, lin_ident, lin_url)
    post_linear_comment(
        lin_uuid,
        f"**Exported from Paperclip**\n\n"
        f"- Paperclip: `{pc}`\n- Linear: `{lin_ident}`\n"
        f"- Delegate: Paperclip (AgentCore app actor)\n"
        f"- Status seed: `{pc_status}`\n\n"
        f"paperclip:{pc}",
    )
    add_comment(
        pc,
        f"Exported to Linear `{lin_ident}` with Paperclip as delegate.\n"
        f"linear:{lin_ident}\nmirror:linear\n{lin_url}",
    )
    return f"outbound created {lin_ident} for {pc} (delegate=Paperclip)"


# ---------------------------------------------------------------------------
# 3) Delegate repair + status + comments on linked pairs
# ---------------------------------------------------------------------------

def linked_pairs(limit: int = 50) -> list[dict]:
    sql = f"""
SELECT json_agg(row_to_json(t)) FROM (
  SELECT i.identifier, i.status, i.priority, i.title,
         left(coalesce(i.description,''), 2500) AS description,
         i.company_id::text AS company_id
  FROM issues i
  WHERE i.status NOT IN ('cancelled','canceled')
    AND (
      (
        i.description ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
        AND i.description !~* 'linear:\\s*UNLINKED'
      )
      OR i.description ILIKE '%Original Linear Issue:%'
      OR EXISTS (
        SELECT 1 FROM issue_comments c
        WHERE c.issue_id=i.id
          AND c.body ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
          AND c.body NOT ILIKE '%false-linear:%'
          AND c.body NOT ILIKE '%linear:UNLINKED%'
          AND c.body NOT ILIKE '%cleanup-all:%'
          AND c.body NOT ILIKE '%cleanup-fix:%'
          AND c.body NOT ILIKE '%cleanup-wave1:%'
          AND c.body NOT ILIKE '%**Linear comment**%'
          AND c.body NOT ILIKE '%linear-comment:%'
      )
    )
  ORDER BY i.updated_at DESC
  LIMIT {int(limit)}
) t;
"""
    rows = psql_json(sql) or []
    return rows if isinstance(rows, list) else []


def resolve_pair_linear_id(row: dict) -> Optional[str]:
    """Description is authoritative for Paperclip↔Linear pairing.

    Comment ``linear:`` markers are only accepted when the comment is a short
    deliberate link writeback — never when it is a mirrored Linear comment or
    a standing-sweep triage report that merely *mentions* a Linear issue.

    Explicit ``linear:UNLINKED`` / ``[UNLINKED from linear:…]`` in description
    means this PC issue must not pair-sync (prevents multi-PC thrash).

    Thrash canons: non-canonical PCs must not pair onto MULTI_CANON Linear IDs;
    standing routines must not pair onto their forbidden product Linear IDs.
    """
    pc = (row.get("identifier") or "").upper()
    desc = row.get("description") or ""
    title = row.get("title") or ""

    # Standing routine hard block (even if comment thrash re-added markers)
    try:
        from hea_thrash_canons import FORCE_UNLINK, MULTI_CANON, STANDING_OWN_LINEAR  # type: ignore
    except Exception:  # noqa: BLE001
        FORCE_UNLINK = {"HEA-62": "HEA-4949"}
        MULTI_CANON = {
            "HEA-4949": "HEA-1172",
            "HEA-5091": "HEA-1198",
            "HEA-4840": "HEA-1157",
            "HEA-5042": "HEA-1171",
        }
        STANDING_OWN_LINEAR = {"HEA-62": "HEA-5460"}

    if re.search(r"linear:\s*UNLINKED\b", desc, re.I) or re.search(
        r"\[UNLINKED from linear:", desc, re.I
    ):
        # Only re-pair if a *new* positive HEA linear marker exists after unlink banner
        # and it is not the forbidden product Linear for standing routines.
        positive = extract_linear_id(desc)
        if not positive:
            # standing own export via constant if present
            if pc in STANDING_OWN_LINEAR:
                return STANDING_OWN_LINEAR[pc]
            return None
        if pc in FORCE_UNLINK and positive == FORCE_UNLINK[pc]:
            return STANDING_OWN_LINEAR.get(pc)
        # non-canon must not re-pair onto multi thrash Linear
        if positive in MULTI_CANON and MULTI_CANON[positive] != pc:
            return None
        return positive

    blob = desc + "\n" + title
    lin = extract_linear_id(blob)
    if lin:
        if pc in FORCE_UNLINK and lin == FORCE_UNLINK[pc]:
            return STANDING_OWN_LINEAR.get(pc)  # redirect away from product
        if lin in MULTI_CANON and MULTI_CANON[lin] != pc:
            # Non-canonical residual must not status/comment-sync onto thrash parent
            return None
        return lin

    # Newest authoritative comment wins (export writeback after unlink)
    comments = get_comments(row["identifier"])
    if isinstance(comments, list):
        for c in reversed(comments):
            if not isinstance(c, dict):
                continue
            body = c.get("body") or ""
            if not is_authoritative_linear_link_comment(body):
                continue
            lin = extract_linear_id(body)
            if not lin:
                continue
            if pc in FORCE_UNLINK and lin == FORCE_UNLINK[pc]:
                return STANDING_OWN_LINEAR.get(pc)
            if lin in MULTI_CANON and MULTI_CANON[lin] != pc:
                continue
            return lin
    if pc in STANDING_OWN_LINEAR:
        return STANDING_OWN_LINEAR[pc]
    return None


def sync_pair(
    row: dict,
    dry_run: bool,
    states_cache: dict[str, list[dict]],
    state: dict,
    max_comments: int = 3,
) -> list[str]:
    events: list[str] = []
    pc = row["identifier"]
    lin_ident = resolve_pair_linear_id(row)
    if not lin_ident:
        events.append(f"sync skip {pc}: no linear: id")
        return events
    lin = find_linear_issue(lin_ident)
    if not lin:
        events.append(f"sync skip {pc}: Linear {lin_ident} not found")
        return events
    if lin.get("_rate_limited"):
        events.append(f"sync skip {pc}: Linear rate-limited (defer {lin_ident})")
        return events
    lin_uuid = lin["id"]
    team = (lin.get("team") or {})
    team_id = team.get("id") or PRIMARY_TEAM_ID
    team_key = (team.get("key") or lin_ident.split("-")[0]).upper()
    cur_type = ((lin.get("state") or {}).get("type") or "").lower()
    cur = ((lin.get("state") or {}).get("name") or "")
    pc_status = (row.get("status") or "").lower()

    # HEA workflow quirk: "In Review" and "Testing" are type=completed.
    # Only treat Production/Done/Canceled names as terminal product states.
    lin_terminal = cur.lower() in ("production", "done", "canceled", "cancelled", "duplicate")

    # Never thrash status onto canceled Linear from open PC (dead link).
    if cur_type in ("canceled",) or cur.lower() in ("canceled", "cancelled", "duplicate"):
        if pc_status not in ("cancelled", "canceled", "done"):
            events.append(f"sync skip {pc}->{lin_ident}: Linear is {cur}; PC open (dead link — needs remap)")
            return events
    # Refuse open PC status onto Production Linear (wrong pair / standing routine thrash)
    refuse_status = lin_terminal and cur.lower() in ("production", "done") and pc_status in (
        "in_progress", "todo", "backlog", "blocked", "in_review"
    )
    if refuse_status:
        events.append(
            f"sync skip status {pc}->{lin_ident}: refuse open PC status onto terminal Linear {cur}"
        )

    # Standing routine / thrash-canon hard skip already handled in resolve_pair.
    # Extra: if PC is done, allow status → Production even when Linear was held.
    # (no change — pick_state_id handles done→Production)

    # Delegate repair — only when app has team access (HEA); skip hard 403 noise for other teams
    del_id = ((lin.get("delegate") or {}).get("id")) or ""
    agentcore_owner = del_id == agent_user_id()
    # If human deliberately removed AgentCore on a *non-linked* issue we never see it.
    # On linked HEA pairs we re-attach so Paperclip remains the AI delegate surface.
    if not agentcore_owner:
        if team_key != "HEA":
            events.append(f"sync delegate skip {lin_ident}: app not on team {team_key}")
        elif dry_run:
            events.append(f"DRY sync delegate {lin_ident}: set Paperclip/AgentCore")
            agentcore_owner = True  # would set on live
        else:
            res = set_linear_delegate(lin_uuid, agent_user_id())
            if res.get("errors"):
                events.append(f"sync FAIL delegate {lin_ident}: {res['errors']}")
            else:
                events.append(f"sync delegate {lin_ident}: → Paperclip")
                agentcore_owner = True
    else:
        events.append(f"sync delegate {lin_ident}: already Paperclip")

    # Title + priority + labels: PC → Linear only while AgentCore is AI owner (HEA).
    # Labels use hea_label_map.py: add mapped PC labels; never strip Linear-only labels.
    if agentcore_owner and team_key == "HEA" and not refuse_status:
        meta_input: dict[str, Any] = {}
        pc_title = (row.get("title") or "").strip()
        lin_title = (lin.get("title") or "").strip()
        want_title = desired_linear_title(pc, pc_title, lin_title)
        if want_title:
            meta_input["title"] = want_title
        want_prio = desired_linear_priority(row.get("priority"))
        cur_prio = lin.get("priority")
        if want_prio is not None and cur_prio != want_prio:
            meta_input["priority"] = want_prio
        label_ids, label_note = desired_linear_label_ids(pc, lin)
        if label_ids is not None:
            meta_input["labelIds"] = label_ids
        if meta_input:
            if dry_run:
                # don't dump huge label id lists
                dry_show = {k: (v if k != "labelIds" else f"[{len(v)} labels]") for k, v in meta_input.items()}
                events.append(f"DRY sync meta {pc}->{lin_ident}: {dry_show} ({label_note})")
            else:
                res = update_linear_fields(lin_uuid, meta_input)
                if res.get("errors"):
                    events.append(f"sync FAIL meta {pc}->{lin_ident}: {res['errors']}")
                else:
                    bits = []
                    if "title" in meta_input:
                        bits.append("title")
                    if "priority" in meta_input:
                        bits.append(f"priority={meta_input['priority']}")
                    if "labelIds" in meta_input:
                        bits.append(f"labels({label_note})")
                    events.append(f"sync meta {pc}->{lin_ident}: {','.join(bits)}")
        else:
            events.append(f"sync meta {pc}->{lin_ident}: already aligned ({label_note})")
    elif team_key == "HEA" and not agentcore_owner:
        events.append(f"sync meta {pc}->{lin_ident}: skip (AgentCore not delegate)")
    elif team_key == "HEA" and refuse_status:
        events.append(f"sync meta {pc}->{lin_ident}: skip (terminal Linear)")

    # Status sync Paperclip → Linear
    if not refuse_status:
        if team_id not in states_cache:
            states_cache[team_id] = team_states(team_id)
        states = states_cache[team_id]
        state_id = pick_state_id(states, pc_status)
        target = next((s.get("name") for s in states if s.get("id") == state_id), None)
        if state_id and target and cur.lower() != target.lower() and cur.lower() != (PC_TO_LINEAR_STATE.get(pc_status) or [""])[0].lower():
            want_names = [n.lower() for n in PC_TO_LINEAR_STATE.get(pc_status, [])]
            if cur.lower() not in want_names:
                if dry_run:
                    events.append(f"DRY sync status {pc}->{lin_ident}: {cur} => {target}")
                else:
                    res = update_linear_state(lin_uuid, state_id)
                    if res.get("errors"):
                        events.append(f"sync FAIL status {pc}->{lin_ident}: {res['errors']}")
                    else:
                        post_linear_comment(lin_uuid, f"Mirror from Paperclip {pc} status={pc_status}")
                        events.append(f"sync status {pc}->{lin_ident}: {cur} => {target}")
            else:
                events.append(f"sync status {pc}->{lin_ident}: already {cur}")
        else:
            events.append(f"sync status {pc}->{lin_ident}: already {cur or 'n/a'}")
    else:
        events.append(f"sync status {pc}->{lin_ident}: skipped (terminal Linear vs open PC)")

    # Comment sync both directions (capped per pair for automatic runs)
    events.extend(sync_comments_pc_to_lin(pc, lin, dry_run, state, max_comments=max_comments))
    events.extend(sync_comments_lin_to_pc(pc, lin, dry_run, state, max_comments=max_comments))
    return events


def sync_comments_pc_to_lin(
    pc: str,
    lin: dict,
    dry_run: bool,
    state: dict,
    max_comments: int = 3,
) -> list[str]:
    events: list[str] = []
    lin_uuid = lin["id"]
    lin_ident = lin.get("identifier")
    already = set()
    for c in (((lin.get("comments") or {}).get("nodes")) or []):
        body = c.get("body") or ""
        m = PC_COMMENT_MARK.search(body)
        if m:
            already.add(m.group(1).lower())
        already.add(hashlib.sha1(body.strip().encode()).hexdigest()[:12])

    seen = state.setdefault("comments_pc_to_lin", {})
    posted = 0
    for c in get_comments(pc):
        if max_comments and posted >= max_comments:
            events.append(f"comment PC→LIN {pc}→{lin_ident}: cap {max_comments}/run")
            break
        if not isinstance(c, dict):
            continue
        body = (c.get("body") or "").strip()
        if not body:
            continue
        cid = str(c.get("id") or "")
        if not cid:
            continue
        # skip automation noise
        if body.startswith("linear:") and "mirror:linear" in body and len(body) < 400:
            continue
        if "paperclip-export:linked" in body or "Exported to Linear" in body:
            continue
        if "linear-comment:" in body or "**Linear comment**" in body:
            continue
        if cid.lower() in already or seen.get(cid):
            continue
        fp = hashlib.sha1(body.encode()).hexdigest()[:12]
        if fp in already:
            seen[cid] = {"at": now_iso(), "fp": fp}
            continue
        payload = (
            f"**Paperclip comment** (`{pc}`)\n\n{body[:3500]}\n\n"
            f"paperclip-comment:{cid}"
        )
        if dry_run:
            events.append(f"DRY comment PC→LIN {pc}→{lin_ident}: {cid[:8]}…")
            posted += 1
        else:
            res = post_linear_comment(lin_uuid, payload)
            if res.get("errors"):
                events.append(f"FAIL comment PC→LIN {pc}: {res['errors']}")
                # hard fail (missing issue / forbidden) — stop this pair for the run
                break
            else:
                seen[cid] = {"at": now_iso(), "linear": lin_ident}
                events.append(f"comment PC→LIN {pc}→{lin_ident}")
                posted += 1
    return events


def sync_comments_lin_to_pc(
    pc: str,
    lin: dict,
    dry_run: bool,
    state: dict,
    max_comments: int = 3,
) -> list[str]:
    events: list[str] = []
    lin_ident = lin.get("identifier")
    pc_comments = get_comments(pc)
    already = set()
    for c in pc_comments:
        if not isinstance(c, dict):
            continue
        body = c.get("body") or ""
        m = LIN_COMMENT_MARK.search(body)
        if m:
            already.add(m.group(1).lower())
    seen = state.setdefault("comments_lin_to_pc", {})
    posted = 0
    for c in (((lin.get("comments") or {}).get("nodes")) or []):
        if max_comments and posted >= max_comments:
            events.append(f"comment LIN→PC {lin_ident}→{pc}: cap {max_comments}/run")
            break
        body = (c.get("body") or "").strip()
        cid = str(c.get("id") or "")
        if not body or not cid:
            continue
        # skip our own bridge comments
        if "Paperclip SSOT dual-write" in body or "Exported from Paperclip" in body:
            continue
        if "Mirror from Paperclip" in body or "paperclip-comment:" in body:
            continue
        if body.startswith("**Paperclip comment**"):
            continue
        if cid.lower() in already or seen.get(cid):
            continue
        # Idempotency marker only — do NOT append ``linear:{lin_ident}``.
        # That marker on mirrored comments was re-parsed as a pair link on
        # standing routines (HEA-62) and reopened completed Linear issues.
        payload = (
            f"**Linear comment** (`{lin_ident}`)\n\n{body[:3500]}\n\n"
            f"linear-comment:{cid}"
        )
        if dry_run:
            events.append(f"DRY comment LIN→PC {lin_ident}→{pc}: {cid[:8]}…")
            posted += 1
        else:
            code, _ = add_comment(pc, payload)
            if code not in (200, 201):
                events.append(f"FAIL comment LIN→PC {pc}: HTTP {code}")
            else:
                seen[cid] = {"at": now_iso(), "paperclip": pc}
                events.append(f"comment LIN→PC {lin_ident}→{pc}")
                posted += 1
    return events


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    load_env()
    # Automatic defaults (cron runs with no args). Env overrides for ops tuning.
    def _env_int(name: str, default: int) -> int:
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    ap = argparse.ArgumentParser(description="Paperclip ↔ Linear full bidirectional parity (automatic by default)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=_env_int("LINEAR_PAPERCLIP_SYNC_LIMIT", 20))
    ap.add_argument(
        "--max-create",
        type=int,
        default=_env_int("LINEAR_PAPERCLIP_SYNC_MAX_CREATE", 5),
        help="Cap creates per direction (0=unlimited)",
    )
    ap.add_argument(
        "--max-comments",
        type=int,
        default=_env_int("LINEAR_PAPERCLIP_SYNC_MAX_COMMENTS", 3),
        help="Max comments synced per linked pair per direction per run",
    )
    ap.add_argument("--inbound-only", action="store_true")
    ap.add_argument("--outbound-only", action="store_true")
    ap.add_argument("--sync-only", action="store_true", help="Only status/delegate/comments on linked pairs")
    ap.add_argument(
        "--no-export-unlinked",
        action="store_true",
        default=(os.environ.get("LINEAR_PAPERCLIP_SYNC_EXPORT_UNLINKED", "1").strip() not in ("1", "true", "yes")),
        help="Only export mirror:linear/export:linear marked issues",
    )
    ap.add_argument("--export-unlinked", action="store_true", help="Force export of open unlinked HEA issues")
    ap.add_argument("--once-ident", help="Force inbound from a Linear id OR outbound from a Paperclip id")
    ap.add_argument("--direction", choices=["auto", "inbound", "outbound"], default="auto")
    args = ap.parse_args()
    if args.export_unlinked:
        args.no_export_unlinked = False

    if not (agent_token() or personal_key()):
        print("## linear_paperclip_delegate_bridge: missing Linear credentials")
        return 1

    me = linear_gql("{ viewer { id name email } }", token=agent_token() or None)
    viewer = ((me.get("data") or {}).get("viewer")) or {}
    print(
        f"## full-sync AUTOMATIC actor={viewer.get('name')} id={viewer.get('id')} "
        f"expected={agent_user_id()} dry_run={args.dry_run} "
        f"limit={args.limit} max_create={args.max_create} max_comments={args.max_comments}"
    )

    state = load_state(
        STATE_PATH,
        {"seen": {}, "outbound_created": {}, "comments_pc_to_lin": {}, "comments_lin_to_pc": {}, "last_events": []},
    )
    events: list[str] = []
    states_cache: dict[str, list[dict]] = {}
    max_comments = args.max_comments

    # ---- forced single ----
    if args.once_ident:
        ident = args.once_ident.upper()
        direction = args.direction
        if direction == "auto":
            # Prefer Linear if exists there
            lin = find_linear_issue(ident)
            direction = "inbound" if lin else "outbound"
        if direction == "inbound":
            lin = find_linear_issue(ident)
            if not lin:
                print(f"## Linear issue not found: {ident}")
                return 1
            events.append(inbound_dual_write(lin, args.dry_run))
        else:
            code, issue = get_issue(ident)
            if code != 200 or not isinstance(issue, dict):
                print(f"## Paperclip issue not found: {ident}")
                return 1
            row = {
                "identifier": issue.get("identifier") or ident,
                "status": issue.get("status"),
                "priority": issue.get("priority"),
                "title": issue.get("title"),
                "description": issue.get("description"),
                "company_id": issue.get("companyId") or issue.get("company_id"),
            }
            # if already linked, sync only
            if extract_linear_id((row.get("description") or "") + "\n".join(
                (c.get("body") or "") for c in get_comments(ident) if isinstance(c, dict)
            )):
                events.extend(sync_pair(row, args.dry_run, states_cache, state, max_comments=max_comments))
            else:
                events.append(outbound_create(row, args.dry_run, states_cache))
    else:
        do_inbound = not args.outbound_only and not args.sync_only
        do_outbound = not args.inbound_only and not args.sync_only
        do_sync = not args.inbound_only  # always sync linked unless inbound-only

        # 1 inbound
        if do_inbound:
            nodes = list_delegated(args.limit)
            if not nodes:
                events.append("inbound: no open Linear issues delegated to Paperclip/AgentCore")
            created = 0
            created_ids: list[str] = []
            for n in nodes:
                if args.max_create and created >= args.max_create and not args.dry_run:
                    events.append(f"inbound cap: max-create={args.max_create}")
                    break
                ev = inbound_dual_write(n, args.dry_run)
                events.append(ev)
                if not args.dry_run and "inbound created " in ev:
                    created += 1
                    # parse pc id from "inbound created HEA-N for HEA-M"
                    m = re.search(r"inbound created ([A-Z]+-\d+)", ev)
                    if m:
                        created_ids.append(m.group(1))
                    state.setdefault("seen", {})[n.get("identifier")] = {"at": now_iso(), "event": ev}
            # Cost guard: at most ONE Qiubo wakeup per full-sync tick after batch creates
            if created_ids and not args.dry_run and PRIMARY_COMPANY_ID in INBOUND_ROUTER_AGENT:
                wcode, wresp = wakeup_agent(
                    HEA_INBOUND_ASSIGNEE_AGENT_ID,
                    reason=f"inbound-linear-batch:{len(created_ids)}:{','.join(created_ids[:5])}",
                )
                if wcode in (200, 201, 202, 204):
                    events.append(
                        f"inbound batch wakeup {HEA_INBOUND_ASSIGNEE_NAME} for {created} new issue(s)"
                    )
                else:
                    events.append(f"inbound batch wakeup FAIL HTTP {wcode} {wresp}")
                state["last_inbound_batch_wake"] = {
                    "at": now_iso(),
                    "count": created,
                    "ids": created_ids[:20],
                }

        # 2 outbound create
        if do_outbound:
            rows = outbound_export_candidates(
                limit=args.limit,
                include_unlinked_open=not args.no_export_unlinked,
            )
            if not rows:
                events.append("outbound: no Paperclip candidates needing Linear create")
            created = 0
            for r in rows:
                if args.max_create and created >= args.max_create and not args.dry_run:
                    events.append(f"outbound cap: max-create={args.max_create}")
                    break
                ev = outbound_create(r, args.dry_run, states_cache)
                events.append(ev)
                if not args.dry_run and ev.startswith("outbound created "):
                    created += 1
                    state.setdefault("outbound_created", {})[r.get("identifier")] = {
                        "at": now_iso(),
                        "event": ev,
                    }

        # 3 linked pair sync (delegate + status + comments)
        if do_sync:
            pairs = linked_pairs(limit=args.limit)
            if not pairs:
                events.append("sync: no linked pairs")
            for r in pairs:
                try:
                    events.extend(
                        sync_pair(r, args.dry_run, states_cache, state, max_comments=max_comments)
                    )
                except Exception as e:  # noqa: BLE001
                    events.append(f"sync FAIL {r.get('identifier')}: {e}")

    state["updated_at"] = now_iso()
    state["last_events"] = events[-120:]
    state["mode"] = "automatic"
    state["actor"] = {
        "name": viewer.get("name"),
        "id": viewer.get("id"),
        "expected_id": agent_user_id(),
        "branding": "Paperclip (Linear app actor reuses AgentCore OAuth app)",
        "parity": "bidirectional create+delegate+status+comments AUTOMATIC",
    }
    if not args.dry_run:
        write_state(STATE_PATH, state)
    else:
        write_state(
            HOME / ".hermes" / "state" / "linear_paperclip_delegate_bridge_dryrun.json",
            {"updated_at": now_iso(), "events": events, "actor": state["actor"]},
        )

    print(f"## events={len(events)}")
    for e in events:
        print(f"- {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
