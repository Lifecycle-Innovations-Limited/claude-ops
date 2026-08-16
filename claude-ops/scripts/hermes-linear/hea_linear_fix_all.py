#!/usr/bin/env python3
"""HEA Paperclip↔Linear fix-all wave.

1) Hard-lock multi canons (description UNLINKED on non-canon)
2) Remap dead/canceled Linear targets for open PC product issues
3) Status catch-up PC→Linear on live pairs
4) Optional: export open product missing link after remap

Autonomous cron mode (default for no-agent ticks):
  HEA_LINEAR_FIX_ALL_AUTO=1 or --auto
  - caps remaps/status per run
  - silent stdout when healthy (no material action)
  - rate-limit safe (never treats 429 as missing)
  - always exit 0 unless hard config failure

Uses alignment_lib + Linear GQL. Default --apply.
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
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from alignment_lib import (  # noqa: E402
    PC_TO_LINEAR_STATE,
    add_comment,
    load_env,
    now_iso,
    patch_issue,
    write_state,
)

PC_CO = "32375bd0-2a89-4a27-ad4a-e2050459224b"
HEA = "7d9c9413-d41d-4226-a041-f935c8d492df"
AGENT = "1972ae8f-ef08-422b-a172-1a728f86abf6"
LINEAR_GQL = "https://api.linear.app/graphql"
# Positive link markers only — prose like "No linear:HEA-N" must NOT count as linked
LINEAR_RE = re.compile(r"(?m)(?:^|\n)\s*linear:\s*(HEA-\d+)\b", re.I)
ORIGINAL_LIN_RE = re.compile(r"Original Linear Issue:\s*\[(HEA-\d+)\]", re.I)
THRASH_LOCK_RE = re.compile(r"\[THRASH-CANON LOCKED\]\s*linear:\s*(HEA-\d+)\b", re.I)


def has_positive_lin_link(desc: str | None, lin: str) -> bool:
    """True only for authoritative linear: markers, not prose mentions."""
    d = desc or ""
    if re.search(rf"\[UNLINKED from linear:\s*{re.escape(lin)}\b", d, re.I):
        return False
    if re.search(rf"false-linear:\s*{re.escape(lin)}\b", d, re.I):
        return False
    if re.search(rf"Original Linear Issue:\s*\[{re.escape(lin)}\]", d, re.I):
        return True
    if re.search(rf"\[THRASH-CANON LOCKED\]\s*linear:\s*{re.escape(lin)}\b", d, re.I):
        return True
    # bare marker on its own line (footer style)
    if re.search(rf"(?m)^\s*linear:\s*{re.escape(lin)}\s*$", d, re.I):
        return True
    return False
STATE_PATH = Path.home() / ".hermes" / "state" / "hea_linear_fix_all.json"

# Shared thrash canons (single source)
try:
    from hea_thrash_canons import FORCE_UNLINK, MULTI_CANON, STANDING_OWN_LINEAR  # type: ignore
except Exception:  # noqa: BLE001
    MULTI_CANON = {
        "HEA-4949": "HEA-1172",
        "HEA-5091": "HEA-1198",
        "HEA-4840": "HEA-1157",
        "HEA-5042": "HEA-1171",
    }
    FORCE_UNLINK = {"HEA-62": "HEA-4949"}
    STANDING_OWN_LINEAR = {"HEA-62": "HEA-5460"}

MATERIAL_PREFIXES = (
    "unlink ",
    "link ",
    "export ",
    "remap ",
    "status ",
    "standing export",
    "standing restore",
    "standing keep",
    "reuse export",
    "FAIL ",
    "ERROR ",
)


def personal_key() -> str:
    return (os.environ.get("LINEAR_API_KEY") or os.environ.get("TEAM_LINEAR_API_KEY") or "").strip()


def agent_token() -> str:
    return (
        os.environ.get("LINEAR_AGENTCORE_TOKEN")
        or os.environ.get("LINEAR_PAPERCLIP_TOKEN")
        or ""
    ).strip()


def q(sql: str) -> str:
    env = os.environ.copy()
    env.setdefault("PGPASSWORD", "paperclip")
    cp = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-At", "-c", sql],
        text=True,
        capture_output=True,
        env=env,
        timeout=120,
    )
    if cp.returncode != 0:
        raise RuntimeError(cp.stderr[:400])
    return (cp.stdout or "").strip()


def gql(query: str, variables: dict | None = None, token: str | None = None) -> dict:
    auth = token or personal_key()
    req = urllib.request.Request(
        LINEAR_GQL,
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": auth, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        return {"errors": [{"message": f"HTTP {e.code}: {body}"}]}
    except Exception as e:  # noqa: BLE001
        return {"errors": [{"message": str(e)}]}


def team_states() -> dict[str, str]:
    nodes = (
        ((gql('query { team(id:"%s"){ states{ nodes{ id name type } } } }' % HEA).get("data") or {}).get("team") or {})
        .get("states")
        or {}
    ).get("nodes") or []
    return {n["name"]: n["id"] for n in nodes if n.get("name") and n.get("id")}


def find_lin(ident: str) -> dict | None:
    r = gql(
        """query($id:String!){ issue(id:$id){ id identifier title state{id name type} delegate{id name} } }""",
        {"id": ident},
    )
    if r.get("errors"):
        msg = json.dumps(r.get("errors"))
        # Rate limit / transient: do NOT treat as missing (avoids export thrash)
        if "RATELIMITED" in msg or "Rate limit" in msg or "429" in msg:
            return {"_rate_limited": True, "identifier": ident}
        if "Entity not found" in msg or "Could not find referenced Issue" in msg:
            return None
        # other errors: conservative — treat as unknown, not missing
        return {"_api_error": True, "identifier": ident, "errors": r.get("errors")}
    return ((r.get("data") or {}).get("issue")) or None


def set_state(issue_id: str, state_id: str) -> dict:
    return gql(
        """mutation($id:String!,$sid:String!){ issueUpdate(id:$id,input:{stateId:$sid}){ success issue{identifier state{name}} } }""",
        {"id": issue_id, "sid": state_id},
    )


def create_export(pc: dict, states: dict[str, str]) -> tuple[str | None, str]:
    PRIO = {"critical": 1, "high": 2, "medium": 3, "low": 4}
    PC_TO_STATE = {
        "todo": states.get("Todo"),
        "in_progress": states.get("In Progress"),
        "blocked": states.get("On Hold"),
        "backlog": states.get("Backlog"),
        "in_review": states.get("In Review"),
        "done": states.get("Production"),
    }
    pc_id = pc["identifier"]
    title = pc.get("title") or pc_id
    st = (pc.get("status") or "todo").lower()
    prio = PRIO.get(str(pc.get("priority") or "medium").lower(), 3)
    state_id = PC_TO_STATE.get(st) or states.get("Todo")
    desc = (
        f"Exported from Paperclip SSOT `{pc_id}` (fix-all remap).\n"
        f"paperclip:{pc_id}\nmirror:linear\ndelegate:paperclip\n\n"
        f"### Paperclip description\n{(pc.get('description') or '')[:3500]}\n"
    )
    lin_title = f"[Paperclip {pc_id}] {title}"[:250]
    mut = """mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }"""
    inp = {
        "teamId": HEA,
        "title": lin_title,
        "description": desc,
        "priority": prio,
        "delegateId": AGENT,
    }
    if state_id:
        inp["stateId"] = state_id
    res = gql(mut, {"input": inp}, token=agent_token() or personal_key())
    if res.get("errors") or not ((res.get("data") or {}).get("issueCreate") or {}).get("success"):
        res = gql(mut, {"input": inp}, token=personal_key())
    issue = ((res.get("data") or {}).get("issueCreate") or {}).get("issue")
    if not issue:
        return None, f"FAIL create {pc_id}: {res.get('errors')}"
    return issue["identifier"], issue.get("url") or f"https://linear.app/lifecycle-innovations/issue/{issue['identifier']}"


def force_unlink(pc: str, bad_lin: str, canon: str | None, events: list[str]) -> None:
    desc = q(f"SELECT coalesce(description,'') FROM issues WHERE identifier='{pc}'")
    new = re.sub(rf"linear:\s*{re.escape(bad_lin)}\b", "linear:UNLINKED", desc, flags=re.I)
    new = re.sub(rf"Original Linear Issue:\s*\[{re.escape(bad_lin)}\]\([^)]*\)", "", new, flags=re.I)
    # strip any remaining HEA linear markers that equal bad_lin
    new = re.sub(r"linear:\s*HEA-\d+\b", "linear:UNLINKED", new, flags=re.I)
    banner = f"[UNLINKED from linear:{bad_lin}; canonical is {canon or 'none'}↔{bad_lin}]\n"
    if not new.lstrip().startswith("[UNLINKED"):
        new = banner + new
    else:
        # refresh banner
        new = re.sub(r"^\[UNLINKED from linear:[^\]]+\]\n?", banner, new.lstrip())
    code, _ = patch_issue(pc, {"description": new[:14000]})
    add_comment(
        pc,
        f"fix-all: linear:UNLINKED false-linear:{bad_lin} canonical={canon or 'none'}\n"
        f"Do not re-pair this issue to {bad_lin}.\n",
    )
    events.append(f"unlink {pc} from {bad_lin} (canon={canon}) patch={code}")


def force_link(pc: str, lin: str, url: str, events: list[str]) -> None:
    desc = q(f"SELECT coalesce(description,'') FROM issues WHERE identifier='{pc}'")
    # remove UNLINKED banners and false markers for this re-link
    new = re.sub(r"^\[UNLINKED from linear:[^\]]+\]\n?", "", (desc or "").lstrip())
    new = re.sub(r"linear:\s*UNLINKED\b", "", new, flags=re.I)
    # neutralize other linear:HEA markers
    def _keep(m: re.Match) -> str:
        return m.group(0) if m.group(1).upper() == lin.upper() else ""

    new = re.sub(r"linear:\s*(HEA-\d+)\b", _keep, new, flags=re.I)
    if f"linear:{lin}" not in new or not has_positive_lin_link(new, lin):
        # strip any stale prose-only mentions of this lin before writing authoritative footer
        new = re.sub(rf"(?m)^\s*linear:\s*{re.escape(lin)}\s*$", "", new, flags=re.I)
        if f"Original Linear Issue: [{lin}]" not in new:
            new = (
                new.rstrip()
                + f"\n\n---\nOriginal Linear Issue: [{lin}]({url})\nlinear:{lin}\nmirror:linear\ndelegate:paperclip\n"
            )
        elif not re.search(rf"(?m)^\s*linear:\s*{re.escape(lin)}\s*$", new, re.I):
            new = new.rstrip() + f"\nlinear:{lin}\nmirror:linear\ndelegate:paperclip\n"
    # collapse blank lines
    new = re.sub(r"\n{3,}", "\n\n", new)
    code, _ = patch_issue(pc, {"description": new[:14000]})
    add_comment(
        pc,
        f"fix-all: confirmed canonical link linear:{lin}\nmirror:linear\n{url}\n"
        f"Exported to Linear `{lin}` / relinked.\npaperclip-export:linked\n",
    )
    events.append(f"link {pc}→{lin} patch={code}")


def extract_lin_from_pc(pc: str) -> str | None:
    desc = q(f"SELECT coalesce(description,'') FROM issues WHERE identifier='{pc}'")
    # Hard unlink banner wins — only accept deliberate re-link markers after it
    if re.search(r"\[UNLINKED from linear:", desc or "", re.I) or re.search(
        r"linear:\s*UNLINKED\b", desc or "", re.I
    ):
        # Positive re-link only if linear:HEA appears AFTER an explicit re-link section
        m_pos = re.search(
            r"(?:fix-all: confirmed canonical link |Exported to Linear |paperclip-export:linked|THRASH-CANON LOCKED)[\s\S]{0,200}?linear:\s*(HEA-\d+)",
            desc or "",
            re.I,
        )
        if m_pos:
            return m_pos.group(1).upper()
        bodies = q(
            f"""SELECT string_agg(body, E'\\n') FROM (
                  SELECT body FROM issue_comments c JOIN issues i ON i.id=c.issue_id
                  WHERE i.identifier='{pc}'
                    AND (
                      c.body ILIKE '%Exported to Linear%'
                      OR c.body ILIKE '%own Linear export%'
                      OR c.body ILIKE '%paperclip-export:linked%'
                      OR c.body ILIKE '%fix-all: confirmed canonical%'
                      OR c.body ILIKE '%fix-all: own Linear%'
                    )
                    AND c.body NOT ILIKE '%false-linear:%'
                    AND c.body NOT ILIKE '%UNLINKED%'
                  ORDER BY c.created_at DESC LIMIT 5
                ) t"""
        )
        m = LINEAR_RE.search(bodies or "")
        return m.group(1).upper() if m else None
    # Prefer authoritative markers over any prose substring
    m = ORIGINAL_LIN_RE.search(desc or "")
    if m:
        return m.group(1).upper()
    m = THRASH_LOCK_RE.search(desc or "")
    if m:
        return m.group(1).upper()
    m = LINEAR_RE.search(desc or "")
    if m:
        return m.group(1).upper()
    bodies = q(
        f"""SELECT string_agg(left(body,400), E'\\n') FROM (
              SELECT body FROM issue_comments c JOIN issues i ON i.id=c.issue_id
              WHERE i.identifier='{pc}' AND c.body ~* 'linear:\\s*HEA-'
                AND c.body NOT ILIKE '%false-linear:%' AND c.body NOT ILIKE '%linear:UNLINKED%'
                AND c.body NOT ILIKE '%cleanup-%' AND c.body NOT ILIKE '%fix-all:%'
                AND c.body NOT ILIKE '%**Linear comment**%'
                AND (c.body ILIKE '%Exported to Linear%' OR c.body ILIKE '%mirror:linear%'
                     OR c.body ILIKE '%paperclip-export:linked%' OR c.body ILIKE '%Original Linear Issue:%'
                     OR (length(c.body) < 220 AND c.body ~* 'linear:\\s*HEA-'))
              ORDER BY c.created_at DESC LIMIT 10
            ) t"""
    )
    m = LINEAR_RE.search(bodies or "")
    return m.group(1).upper() if m else None


def find_existing_export(pc: str, *, include_terminal: bool = True) -> str | None:
    """Find Linear issue titled [Paperclip HEA-N] … (reuse, don't re-create).

    Prefer live/open hits. If include_terminal, fall back to Duplicate/Canceled/
    Production mirrors so fix-all does not mint open clones of closed work.
    """
    r = gql(
        """query($q:String!){ searchIssues(term:$q, first:15){ nodes{ identifier title state{name type} } } }""",
        {"q": f"[Paperclip {pc}]"},
    )
    nodes = (((r.get("data") or {}).get("searchIssues") or {}).get("nodes")) or []
    hits = [n for n in nodes if (n.get("title") or "").startswith(f"[Paperclip {pc}]")]
    if not hits:
        return None

    def _num(n: dict) -> int:
        try:
            return int((n.get("identifier") or "HEA-0").split("-")[-1])
        except Exception:
            return 0

    terminal_names = {"Canceled", "Cancelled", "Duplicate", "Production", "Done"}
    live = [
        n
        for n in hits
        if ((n.get("state") or {}).get("name") or "") not in terminal_names
        and ((n.get("state") or {}).get("type") or "").lower()
        not in ("completed", "canceled", "duplicate")
    ]
    if live:
        live.sort(key=_num, reverse=True)
        return live[0]["identifier"]
    if not include_terminal:
        return None
    hits.sort(key=_num, reverse=True)
    return hits[0]["identifier"]


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--auto",
        action="store_true",
        default=(os.environ.get("HEA_LINEAR_FIX_ALL_AUTO", "0").strip() in ("1", "true", "yes")),
        help="Autonomous cron mode: silent when healthy; respect caps",
    )
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--max-remap", type=int, default=int(os.environ.get("HEA_LINEAR_FIX_ALL_MAX_REMAP", "8") or 8))
    ap.add_argument("--max-status", type=int, default=int(os.environ.get("HEA_LINEAR_FIX_ALL_MAX_STATUS", "15") or 15))
    args = ap.parse_args()
    dry = args.dry_run
    auto = bool(args.auto) and not args.verbose
    events: list[str] = []
    rate_limited = False
    remapped = 0
    fixed_status = 0
    if not auto:
        print(f"## hea_linear_fix_all dry_run={dry}")

    states = team_states()
    if not states.get("On Hold") or not states.get("Todo"):
        msg = f"ERROR missing HEA states {list(states)[:10]}"
        print(msg)
        write_state(STATE_PATH, {"updated_at": now_iso(), "error": msg, "auto": auto})
        return 0 if auto else 1

    # ---------- 1) standing routines: only if still positively paired ----------
    for pc, bad in FORCE_UNLINK.items():
        desc = q(f"SELECT coalesce(description,'') FROM issues WHERE identifier='{pc}'")
        still = bool(re.search(rf"linear:\s*{re.escape(bad)}\b", desc or "", re.I)) and not re.search(
            r"linear:\s*UNLINKED|\[UNLINKED from linear:", desc or "", re.I
        )
        own = extract_lin_from_pc(pc) or find_existing_export(pc)
        if dry:
            events.append(f"DRY standing check {pc} still={still} own={own}")
            continue
        if still:
            force_unlink(pc, bad, MULTI_CANON.get(bad), events)
            own = extract_lin_from_pc(pc) or find_existing_export(pc)
            if own and own != bad:
                force_link(pc, own, f"https://linear.app/lifecycle-innovations/issue/{own}", events)
                events.append(f"standing restore own {pc}→{own}")
            elif remapped < args.max_remap:
                found = find_existing_export(pc)
                if found:
                    force_link(pc, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                    events.append(f"standing reuse {pc}→{found}")
                else:
                    row = json.loads(
                        q(
                            f"""SELECT row_to_json(t) FROM (
                      SELECT identifier, status, priority, title, left(coalesce(description,''),2000) description
                      FROM issues WHERE identifier='{pc}') t"""
                        )
                        or "null"
                    )
                    if row:
                        new_lin, url_or_err = create_export(row, states)
                        if new_lin:
                            force_link(pc, new_lin, url_or_err, events)
                            remapped += 1
                            events.append(f"standing export {pc}→{new_lin}")
                        else:
                            events.append(url_or_err)
        elif own and own != bad and f"linear:{own}" not in (desc or ""):
            force_link(pc, own, f"https://linear.app/lifecycle-innovations/issue/{own}", events)
            events.append(f"standing keep own {pc}→{own}")
        else:
            events.append(f"standing ok {pc}")

    # multi canons
    for lin, canon in MULTI_CANON.items():
        if not dry:
            # only re-link if missing (positive markers only — ignore prose "No linear:HEA-N")
            cdesc = q(f"SELECT coalesce(description,'') FROM issues WHERE identifier='{canon}'")
            if not has_positive_lin_link(cdesc, lin):
                force_link(canon, lin, f"https://linear.app/lifecycle-innovations/issue/{lin}", events)
            else:
                events.append(f"canon ok {canon}→{lin}")
        else:
            events.append(f"DRY link canon {canon}→{lin}")
        # Residuals: only positive footer/original markers, not prose mentions
        sql = f"""
SELECT identifier FROM issues i
WHERE company_id='{PC_CO}' AND status NOT IN ('cancelled','canceled')
  AND identifier <> '{canon}'
  AND (
    coalesce(description,'') ~* 'Original Linear Issue:\\s*\\[{lin}\\]'
    OR coalesce(description,'') ~* '(?m)^[[:space:]]*linear:[[:space:]]*{lin}[[:space:]]*$'
  )
  AND coalesce(description,'') NOT ILIKE '%linear:UNLINKED%'
  AND coalesce(description,'') NOT ILIKE '%[UNLINKED from linear:{lin}%'
  AND coalesce(description,'') NOT ILIKE '%false-linear:{lin}%'
"""
        others = [x for x in q(sql).splitlines() if x.strip()]
        for p in others:
            if p in FORCE_UNLINK:
                events.append(f"standing already unlinked {p} from {lin}")
                continue
            if dry:
                events.append(f"DRY unlink multi {p} from {lin} keep {canon}")
                continue
            force_unlink(p, lin, canon, events)
            if remapped >= args.max_remap:
                events.append(f"remap cap {args.max_remap}")
                continue
            row = json.loads(
                q(
                    f"""SELECT row_to_json(t) FROM (
                      SELECT identifier, status, priority, title, left(coalesce(description,''),2000) description
                      FROM issues WHERE identifier='{p}') t"""
                )
                or "null"
            )
            if not row or (row.get("status") or "") in ("done", "cancelled", "canceled"):
                continue
            existing = extract_lin_from_pc(p) or find_existing_export(p)
            if existing and existing != lin:
                force_link(p, existing, f"https://linear.app/lifecycle-innovations/issue/{existing}", events)
                events.append(f"skip re-export {p}: keep existing {existing}")
                continue
            found = find_existing_export(p)
            if found:
                force_link(p, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                events.append(f"reuse export {p}→{found}")
                continue
            new_lin, url_or_err = create_export(row, states)
            if new_lin:
                force_link(p, new_lin, url_or_err, events)
                remapped += 1
                events.append(f"export residual {p}→{new_lin}")
            else:
                events.append(url_or_err)
                if "Rate limit" in str(url_or_err) or "RATELIMITED" in str(url_or_err):
                    rate_limited = True
                    break

    # ---------- 2) remap/export open product (capped) ----------
    rows = json.loads(
        q(
            f"""
SELECT json_agg(row_to_json(t)) FROM (
  SELECT identifier, status, priority, title, left(coalesce(description,''),2500) description
  FROM issues
  WHERE company_id='{PC_CO}'
    AND status NOT IN ('done','cancelled','canceled')
    AND title NOT LIKE 'Watchdog%'
    AND title NOT LIKE 'coord:%'
    AND title NOT LIKE '[Paperclip %'
    AND coalesce(description,'') NOT ILIKE '%source:linear-ai-delegate%'
  ORDER BY updated_at DESC
  LIMIT 120
) t"""
        )
        or "null"
    ) or []

    for r in rows:
        if remapped >= args.max_remap or rate_limited:
            break
        pc = r["identifier"]
        if pc in FORCE_UNLINK:
            continue
        lin = extract_lin_from_pc(pc)
        if not lin:
            if dry:
                events.append(f"DRY export missing {pc}")
                continue
            found = find_existing_export(pc)
            if found:
                force_link(pc, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                remapped += 1
                events.append(f"export-reuse missing {pc}→{found}")
                continue
            # comment-restore without Linear when possible is preferred; create only if needed
            new_lin, url_or_err = create_export(r, states)
            if new_lin:
                force_link(pc, new_lin, url_or_err, events)
                remapped += 1
                events.append(f"export missing {pc}→{new_lin}")
            else:
                events.append(url_or_err)
                if "Rate limit" in str(url_or_err) or "RATELIMITED" in str(url_or_err):
                    rate_limited = True
            continue
        meta = find_lin(lin)
        if not meta:
            if dry:
                events.append(f"DRY remap missing {pc} was {lin}")
                continue
            force_unlink(pc, lin, None, events)
            found = find_existing_export(pc)
            if found:
                force_link(pc, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                remapped += 1
                events.append(f"remap missing-reuse {pc}: {lin}→{found}")
            else:
                new_lin, url_or_err = create_export(r, states)
                if new_lin:
                    force_link(pc, new_lin, url_or_err, events)
                    remapped += 1
                    events.append(f"remap missing {pc}: {lin}→{new_lin}")
                else:
                    events.append(url_or_err)
            continue
        if meta.get("_rate_limited") or meta.get("_api_error"):
            rate_limited = bool(meta.get("_rate_limited"))
            events.append(f"skip remap {pc}→{lin}: linear api {'rate_limit' if meta.get('_rate_limited') else 'error'}")
            if rate_limited:
                break
            continue
        st_type = ((meta.get("state") or {}).get("type") or "").lower()
        st_name = ((meta.get("state") or {}).get("name") or "")
        if st_type == "canceled" or st_name in ("Canceled", "Cancelled", "Duplicate"):
            # Terminal Linear is intentional hygiene close-out. Do not mint a new open
            # export clone; keep the canceled/duplicate link as the mirror.
            if dry:
                events.append(f"DRY keep terminal {pc}↔{lin} ({st_name})")
                continue
            found = find_existing_export(pc, include_terminal=True)
            if found and found != lin:
                # Prefer a live open sibling if one already exists; else keep terminal.
                force_link(pc, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                remapped += 1
                events.append(f"remap canceled-reuse {pc}: {lin}→{found}")
            else:
                events.append(f"keep terminal {pc}↔{lin} ({st_name}; no create)")
            continue
        if st_name in ("Production", "Done") and (r.get("status") or "").lower() not in ("done",):
            if MULTI_CANON.get(lin) == pc:
                events.append(f"keep production pair canon {pc}↔{lin}")
                continue
            # Closed Linear + open PC: do not invent a fresh open Linear clone.
            # Status mirror already refuses to reopen terminal Linear.
            if dry:
                events.append(f"DRY keep production {pc}↔{lin} (PC open; no create)")
                continue
            found = find_existing_export(pc, include_terminal=False)
            if found and found != lin:
                force_link(pc, found, f"https://linear.app/lifecycle-innovations/issue/{found}", events)
                remapped += 1
                events.append(f"remap production-reuse {pc}: {lin}→{found}")
            else:
                events.append(f"keep production {pc}↔{lin} (PC open; no create)")
            continue

    events.append(f"remapped_or_exported={remapped}")

    # ---------- 3) status catch-up (capped) ----------
    if not rate_limited:
        name_to_id = states
        for r in rows:
            if fixed_status >= args.max_status:
                events.append(f"status cap {args.max_status}")
                break
            pc = r["identifier"]
            lin = extract_lin_from_pc(pc)
            if not lin:
                continue
            meta = find_lin(lin)
            if not meta:
                continue
            if meta.get("_rate_limited") or meta.get("_api_error"):
                rate_limited = bool(meta.get("_rate_limited"))
                events.append(f"status-skip {pc}→{lin}: linear api unavailable")
                if rate_limited:
                    break
                continue
            st_name = ((meta.get("state") or {}).get("name") or "")
            st_type = ((meta.get("state") or {}).get("type") or "").lower()
            if st_type == "canceled" or st_name in ("Canceled", "Cancelled", "Duplicate"):
                continue
            if st_name in ("Production", "Done") and (r.get("status") or "").lower() not in ("done",):
                events.append(f"status-skip {pc}→{lin}: Linear {st_name}, PC open")
                continue
            pc_status = (r.get("status") or "todo").lower()
            want_names = PC_TO_LINEAR_STATE.get(pc_status, [])
            cur = st_name
            if cur in want_names or cur.lower() in [w.lower() for w in want_names]:
                continue
            sid = None
            target = None
            for n in want_names:
                if n in name_to_id:
                    sid = name_to_id[n]
                    target = n
                    break
            if not sid:
                continue
            if dry:
                events.append(f"DRY status {pc}→{lin}: {cur} => {target}")
                fixed_status += 1
            else:
                res = set_state(meta["id"], sid)
                if res.get("errors"):
                    em = json.dumps(res.get("errors"))
                    events.append(f"FAIL status {pc}→{lin}: {res['errors']}")
                    if "RATELIMITED" in em or "Rate limit" in em:
                        rate_limited = True
                        break
                else:
                    events.append(f"status {pc}→{lin}: {cur} => {target}")
                    fixed_status += 1
    events.append(f"status_fixed={fixed_status}")

    material = [
        e
        for e in events
        if any(
            e.startswith(p)
            for p in (
                "unlink ",
                "link ",
                "export ",
                "remap ",
                "status ",
                "standing export",
                "standing restore",
                "standing keep",
                "standing reuse",
                "reuse export",
                "export-reuse",
                "export residual",
                "export missing",
                "FAIL ",
            )
        )
        and not e.startswith("status-skip")
        and not e.startswith("status cap")
        and not e.startswith("status_fixed=")
    ]

    out = {
        "updated_at": now_iso(),
        "dry_run": dry,
        "auto": auto,
        "rate_limited": rate_limited,
        "events": events[-400:],
        "material": material[:100],
        "counts": {
            "events": len(events),
            "material": len(material),
            "remapped_or_exported": remapped,
            "status_fixed": fixed_status,
        },
    }
    write_state(STATE_PATH if not dry else Path.home() / ".hermes/state/hea_linear_fix_all_dryrun.json", out)

    # Autonomous: silent when no material action (incl. rate-limit defer)
    if auto and not dry and not material:
        return 0

    print(f"## hea_linear_fix_all dry_run={dry} auto={auto} rate_limited={rate_limited}")
    print(f"## remapped={remapped} status_fixed={fixed_status} material={len(material)}")
    for e in (material if auto else events):
        print(f"- {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
