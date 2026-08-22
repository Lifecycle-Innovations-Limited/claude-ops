#!/usr/bin/env python3
"""Paperclip ↔ Linear mirror (Paperclip is SSOT).

Outbound: Paperclip issues with `mirror:linear` or `linear:HEA-N` → update Linear state/comment.
Inbound: configured client-team Linear issues labeled `agent-work` (or filter) → create Paperclip if missing.

Never reverse SSOT. Idempotent. State: ~/.hermes/state/paperclip_linear_mirror.json
"""
from __future__ import annotations

import argparse
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
    CLIENT_COMPANY_ID,
    PC_TO_LINEAR_STATE,
    add_comment,
    canonical_paperclip_title,
    collect_issue_meta,
    create_issue,
    get_comments,
    get_issue,
    load_env,
    load_state,
    now_iso,
    title_has_export_markers,
    write_state,
    ISSUE_ID_RE,
)

HOME = Path.home()
STATE_PATH = HOME / ".hermes" / "state" / "paperclip_linear_mirror.json"
LINEAR_GQL = "https://api.linear.app/graphql"
CLIENT_TEAM_ID = os.environ.get("LINEAR_CLIENT_TEAM_ID", "")


def linear_key() -> str:
    return (
        os.environ.get("LINEAR_API_KEY", "").strip()
        or os.environ.get("CLIENT_LINEAR_API_KEY", "").strip()
        or os.environ.get("HEA" + "LIFY_LINEAR_API_KEY", "").strip()
    )


def linear_gql(query: str, variables: Optional[dict] = None) -> dict:
    key = linear_key()
    if not key:
        return {"errors": [{"message": "missing LINEAR_API_KEY"}]}
    payload = {"query": query, "variables": variables or {}}
    req = urllib.request.Request(
        LINEAR_GQL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"errors": [{"message": e.read().decode(errors="replace")[:500]}]}
    except Exception as e:  # noqa: BLE001
        return {"errors": [{"message": str(e)}]}


def find_linear_issue(identifier: str) -> Optional[dict]:
    q = """
    query($id: String!) {
      issue(id: $id) {
        id identifier title url
        state { id name type }
        labels { nodes { name } }
      }
    }
    """
    data = linear_gql(q, {"id": identifier})
    if data.get("errors"):
        # fallback search
        q2 = """
        query($f: IssueFilter) {
          issues(filter: $f, first: 5) {
            nodes { id identifier title url state { id name type } labels { nodes { name } } }
          }
        }
        """
        data = linear_gql(q2, {"f": {"number": {"eq": int(identifier.split("-")[-1])}, "team": {"key": {"eq": identifier.split("-")[0]}}}})
        nodes = (((data.get("data") or {}).get("issues") or {}).get("nodes")) or []
        for n in nodes:
            if n.get("identifier") == identifier:
                return n
        return None
    return (data.get("data") or {}).get("issue")


def team_states(team_id: str) -> list[dict]:
    q = """
    query($id: String!) {
      team(id: $id) {
        states { nodes { id name type } }
      }
    }
    """
    data = linear_gql(q, {"id": team_id})
    return (((data.get("data") or {}).get("team") or {}).get("states") or {}).get("nodes") or []


def pick_state_id(states: list[dict], pc_status: str) -> Optional[str]:
    candidates = PC_TO_LINEAR_STATE.get(pc_status.lower(), [])
    by_name = {s["name"]: s["id"] for s in states if s.get("name") and s.get("id")}
    for name in candidates:
        if name in by_name:
            return by_name[name]
    # type fallback
    type_map = {
        "backlog": "backlog",
        "todo": "unstarted",
        "in_progress": "started",
        "in_review": "started",
        "blocked": "unstarted",  # client workflow uses On Hold (unstarted)
        "done": "completed",
        "cancelled": "canceled",
    }
    want = type_map.get(pc_status.lower())
    for s in states:
        if (s.get("type") or "").lower() == want:
            return s.get("id")
    return None


def update_linear_state(issue_id: str, state_id: str) -> dict:
    m = """
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id identifier state { name } }
      }
    }
    """
    return linear_gql(m, {"id": issue_id, "stateId": state_id})


def comment_linear(issue_id: str, body: str) -> dict:
    m = """
    mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) {
        success
      }
    }
    """
    return linear_gql(m, {"id": issue_id, "body": body})


def outbound_candidates_sql(limit: int = 40) -> list[dict]:
    """Only explicit linear: / mirror:linear markers.

    Never match bare Paperclip parent titles like ``[HEA-1136] child work`` —
    Paperclip and Linear share team prefixes but are different ID spaces.
    Also include issues whose comments carry ``linear:`` (microcompany pattern).
    """
    env = os.environ.copy()
    env.setdefault("PGPASSWORD", "paperclip")
    sql = f"""
SELECT json_agg(row_to_json(t)) FROM (
  SELECT i.identifier, i.status, i.title, left(coalesce(i.description,''), 2000) AS description
  FROM issues i
  WHERE i.status NOT IN ('cancelled','canceled')
    AND (
      i.description ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
      OR i.description ILIKE '%%mirror:linear%%'
      OR i.description ILIKE '%%Original Linear Issue:%%'
      OR EXISTS (
        SELECT 1 FROM issue_comments c
        WHERE c.issue_id = i.id
          AND (
            c.body ~* 'linear:\\s*[A-Z]{{2,6}}-[0-9]+'
            OR c.body ILIKE '%%mirror:linear%%'
          )
      )
    )
  ORDER BY i.updated_at DESC
  LIMIT {int(limit)}
) t;
"""
    cp = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-At", "-c", sql],
        text=True,
        capture_output=True,
        env=env,
        timeout=30,
    )
    if cp.returncode != 0:
        return []
    data = json.loads(cp.stdout.strip() or "null")
    return data if isinstance(data, list) else []


def linear_from_meta(meta: dict, blob: str, paperclip_ident: Optional[str] = None) -> Optional[str]:
    """Resolve Linear issue id only from explicit markers.

    Accepts:
      - meta key ``linear:`` (from comments/description schema)
      - ``linear:TEAM-123``
      - Linear URL ``.../issue/TEAM-123/...``
      - ``Original Linear Issue: [TEAM-123](url)``

    Rejects bare ``[TEAM-N]`` title parent refs (Paperclip parent IDs).
    Never returns the Paperclip issue's own identifier as a Linear link.
    """
    candidates: list[str] = []
    if meta.get("linear"):
        m = ISSUE_ID_RE.search(meta["linear"])
        if m:
            candidates.append(m.group(1).upper())
    for m in re.finditer(r"linear:\s*([A-Z]{2,6}-\d+)", blob, re.I):
        candidates.append(m.group(1).upper())
    for m in re.finditer(r"linear\.app/[^/\s]+/issue/([A-Z]{2,6}-\d+)", blob, re.I):
        candidates.append(m.group(1).upper())
    for m in re.finditer(r"Original Linear Issue:\s*\[([A-Z]{2,6}-\d+)\]", blob, re.I):
        candidates.append(m.group(1).upper())

    own = (paperclip_ident or "").upper()
    for c in candidates:
        if own and c == own:
            # Same identifier string on both systems is still allowed ONLY when
            # an explicit linear: marker pointed at it (candidates list). Keep it.
            # But if the only match is accidental self-title, drop later.
            pass
        return c
    return None


def run_outbound(state: dict, dry_run: bool, limit: int) -> list[str]:
    events: list[str] = []
    rows = outbound_candidates_sql(limit)
    if not rows:
        events.append("outbound: no candidates (mirror:linear / linear:HEA-*)")
        return events
    # Cache Linear team workflow states per team key (HEA vs MES vs DUTCH …)
    states_by_team: dict[str, list[dict]] = {}
    # Always warm HEA as default
    states_by_team["HEA"] = team_states(CLIENT_TEAM_ID)
    for row in rows:
        ident = row.get("identifier")
        code, issue = get_issue(ident)
        if code != 200 or not isinstance(issue, dict):
            continue
        comments = get_comments(ident)
        # Do NOT use collect_issue_meta for linear: — it harvests mirrored
        # Linear comments (``linear:HEA-4949`` footers on standing HEA-62) and
        # falsely pairs the routine's in_progress status onto product issues.
        meta: dict = {}
        # Description/title first — comment ``linear:`` on mirrored Linear
        # comments (standing sweep HEA-62 ↔ product HEA-4949) is NOT a pair.
        desc_blob = "\n".join([issue.get("description") or "", issue.get("title") or ""])
        auth_comment_bodies = []
        for c in comments:
            if not isinstance(c, dict):
                continue
            body = (c.get("body") or "").strip()
            if not body:
                continue
            if body.startswith("**Linear comment**") or "linear-comment:" in body:
                continue
            if body.startswith("**Paperclip comment**") or "paperclip-comment:" in body:
                continue
            if "Mirror from Paperclip" in body:
                continue
            if len(body) > 500 and re.search(r"\b(sweep|triage|heartbeat)\b", body, re.I):
                continue
            if re.search(r"linear:\s*[A-Z]{2,6}-\d+|mirror:\s*linear|Original Linear Issue:", body, re.I):
                if len(body) < 500 or re.search(r"mirror:\s*linear|Original Linear Issue:", body, re.I):
                    auth_comment_bodies.append(body)
        blob = "\n".join([desc_blob] + auth_comment_bodies)
        if re.search(r"mirror:\s*linear\s*#\s*optional", desc_blob + "\n" + blob, re.I):
            continue
        has_explicit = bool(
            re.search(r"linear:\s*[A-Z]{2,6}-\d+", blob, re.I)
            or re.search(r"linear\.app/[^/\s]+/issue/[A-Z]{2,6}-\d+", blob, re.I)
            or re.search(r"Original Linear Issue:\s*\[[A-Z]{2,6}-\d+\]", blob, re.I)
        )
        if not has_explicit and "mirror:linear" not in blob.lower():
            continue
        # Prefer description markers so comment cross-refs cannot hijack status.
        lin_id = linear_from_meta(meta, desc_blob, paperclip_ident=ident) or linear_from_meta(
            meta, blob, paperclip_ident=ident
        )
        if not lin_id:
            # Internal/non-product Paperclip records may carry an explicitly
            # optional mirror marker. Do not treat those as broken mappings.
            if re.search(r"mirror:\s*linear\s*#\s*optional", blob, re.I):
                continue
            events.append(f"outbound {ident}: no explicit linear: link (refusing bare [HEA-N] parent titles)")
            continue
        pc_status = (issue.get("status") or "").lower()
        # The local state file is only an audit trail, not proof of remote state.
        # Always re-read Linear so manual changes, failed prior writes, and stale
        # state files are corrected on the next sweep.
        lin = find_linear_issue(lin_id)
        if not lin:
            events.append(f"outbound {ident}: Linear {lin_id} not found")
            continue
        team_key = (lin_id.split("-")[0] or "HEA").upper()
        if team_key not in states_by_team:
            # Resolve team id via the Linear issue payload when possible
            team_id = None
            # find_linear_issue may not include team; fetch lightweight
            q_team = """
            query($id: String!) {
              issue(id: $id) { team { id key } }
            }
            """
            td = linear_gql(q_team, {"id": lin.get("id") or lin_id})
            team_obj = (((td.get("data") or {}).get("issue") or {}).get("team")) or {}
            team_id = team_obj.get("id")
            team_key = (team_obj.get("key") or team_key).upper()
            states_by_team[team_key] = team_states(team_id) if team_id else states_by_team.get("HEA", [])
        states = states_by_team.get(team_key) or states_by_team.get("HEA") or []
        state_id = pick_state_id(states, pc_status)
        cur_state = ((lin.get("state") or {}).get("name") or "")
        cur_type = ((lin.get("state") or {}).get("type") or "").lower()
        # Never push open PC status onto terminal Linear (Duplicate/Canceled/Done).
        # Re-opening finished Linear issues from mirror thrash recreated noise.
        if cur_type in ("canceled", "duplicate", "completed") or cur_state.lower() in (
            "canceled",
            "cancelled",
            "duplicate",
            "done",
            "production",
        ):
            events.append(
                f"outbound skip {ident}->{lin_id}: Linear is terminal {cur_state}/{cur_type} "
                f"(refuse PC {pc_status})"
            )
            state.setdefault("outbound", {})[ident] = {
                "status": pc_status,
                "linear": lin_id,
                "at": now_iso(),
                "skipped": "terminal_linear",
            }
            continue
        if not state_id:
            events.append(f"outbound {ident}->{lin_id}: no Linear state map for {pc_status} on team {team_key}")
            continue
        if cur_state.lower() == (PC_TO_LINEAR_STATE.get(pc_status) or [""])[0].lower():
            events.append(f"outbound {ident}->{lin_id}: already {cur_state}")
            state.setdefault("outbound", {})[ident] = {"status": pc_status, "linear": lin_id, "at": now_iso()}
            continue
        target_name = next((s.get("name") for s in states if s.get("id") == state_id), pc_status)
        msg = f"Mirror from Paperclip {ident} status={pc_status}"
        if dry_run:
            events.append(f"DRY outbound {ident}->{lin_id}: {cur_state} => {target_name} ({state_id[:8]}…) team={team_key}")
            continue
        res = update_linear_state(lin["id"], state_id)
        if res.get("errors"):
            events.append(f"outbound FAIL {ident}->{lin_id}: {res['errors']}")
            continue
        comment_linear(lin["id"], msg)
        state.setdefault("outbound", {})[ident] = {"status": pc_status, "linear": lin_id, "at": now_iso()}
        events.append(f"outbound {ident}->{lin_id}: {cur_state} => {pc_status} (team={team_key})")
    return events


def inbound_agent_work(state: dict, dry_run: bool, limit: int) -> list[str]:
    """Pull Linear HEA issues with label agent-work; create Paperclip if missing."""
    events: list[str] = []
    q = """
    query($tid: ID!, $n: Int) {
      issues(
        filter: {
          team: { id: { eq: $tid } }
          labels: { name: { eq: "agent-work" } }
          state: { type: { nin: ["completed", "canceled"] } }
        }
        first: $n
      ) {
        nodes {
          id identifier title url description
          state { name type }
          labels { nodes { name } }
        }
      }
    }
    """
    data = linear_gql(q, {"tid": CLIENT_TEAM_ID, "n": limit})
    if data.get("errors"):
        # label may not exist yet — soft fail
        events.append(f"inbound: Linear query note: {data['errors']}")
        return events
    nodes = (((data.get("data") or {}).get("issues") or {}).get("nodes")) or []
    if not nodes:
        events.append("inbound: no open HEA agent-work issues")
        return events
    for n in nodes:
        lin = n.get("identifier")
        # already mirrored?
        env = os.environ.copy()
        env.setdefault("PGPASSWORD", "paperclip")
        sql = f"""
SELECT identifier FROM issues
WHERE title ILIKE '%[{lin}]%' OR description ILIKE '%{lin}%'
LIMIT 3;
"""
        cp = subprocess.run(
            ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-At", "-c", sql],
            text=True,
            capture_output=True,
            env=env,
            timeout=15,
        )
        existing = [x for x in (cp.stdout or "").splitlines() if x.strip()]
        if existing:
            events.append(f"inbound skip {lin}: already {existing}")
            continue
        raw_title = n.get("title") or ""
        if title_has_export_markers(raw_title):
            events.append(f"inbound skip {lin}: Paperclip export markers in title (anti-loop)")
            continue
        title = canonical_paperclip_title(raw_title, linear_id=lin)
        desc = (
            f"Original Linear Issue: [{lin}]({n.get('url')})\n"
            f"linear:{lin}\n"
            f"mirror:linear\n"
            f"stage:backlog\n\n"
            f"{(n.get('description') or '')[:1500]}\n"
        )
        if dry_run:
            events.append(f"DRY inbound create Paperclip for {lin}: {title[:80]}")
            continue
        code, resp = create_issue(CLIENT_COMPANY_ID, title, desc, priority="medium", status="todo")
        if code in (200, 201) and isinstance(resp, dict):
            pc_id = resp.get("identifier") or resp.get("id")
            events.append(f"inbound created {pc_id} for {lin}")
            state.setdefault("inbound", {})[lin] = {"paperclip": pc_id, "at": now_iso()}
            # reverse link comment on Linear
            comment_linear(n["id"], f"Paperclip SSOT: {pc_id} (mirror; do not use Linear as agent queue)")
        else:
            events.append(f"inbound FAIL {lin}: HTTP {code} {resp}")
    return events


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--inbound", action="store_true", help="Also pull Linear agent-work → Paperclip")
    ap.add_argument("--outbound-only", action="store_true")
    ap.add_argument("--limit", type=int, default=40)
    args = ap.parse_args()

    if not linear_key():
        print("## paperclip_linear_mirror: missing LINEAR_API_KEY — outbound/inbound skipped")
        return 1
    state = load_state(STATE_PATH, {"outbound": {}, "inbound": {}})
    events: list[str] = []
    events.extend(run_outbound(state, args.dry_run, args.limit))
    if args.inbound or not args.outbound_only:
        # default: outbound always; inbound only if --inbound (safer)
        if args.inbound:
            events.extend(inbound_agent_work(state, args.dry_run, min(args.limit, 25)))
    state["updated_at"] = now_iso()
    state["last_events"] = events[-80:]
    if not args.dry_run:
        write_state(STATE_PATH, state)
    else:
        write_state(HOME / ".hermes" / "state" / "paperclip_linear_mirror_dryrun.json", {
            "updated_at": now_iso(),
            "events": events,
        })
    print(f"## paperclip_linear_mirror events={len(events)} dry_run={args.dry_run}")
    for e in events:
        print(f"- {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
