#!/usr/bin/env python3
"""ops-pocket-approvals — surface ASK/DRAFT items to the owner by email and act
on their APPROVE/REJECT replies.

Modes:
  --digest   email the owner the current open ASK (review.jsonl) + DRAFT
             (drafts.jsonl) items, each with a short code (A1/D1...), via the
             email-bridge SES backend. Idempotent: only emails when the open
             set changed.
  --replies  poll the owner's Gmail (gog) for "APPROVE <code|id>" /
             "REJECT <code|id>" and act: APPROVE -> append the task to
             tasks.jsonl (executor runs it; the worker keeps its own Rule-6
             staging for any 3rd-party send); REJECT -> record dropped.
             Idempotent via approval-resolved.jsonl.

Recipient is locked to email-config.self_address. Self-notification to the
owner only.

Requires the SES email backend in ops-pocket-email-bridge.py (send_email's
`backend`/`ses_cfg` kwargs) — see the related "SES email backend" PR.
"""
from __future__ import annotations
import json, os, sys, time, subprocess
from pathlib import Path

STATE = Path(os.environ.get("POCKET_STATE_DIR", str(Path.home() / ".claude/state/pocket")))
REVIEW = STATE / "review.jsonl"
DRAFTS = STATE / "drafts.jsonl"
TASKS = STATE / "tasks.jsonl"
RESOLVED = STATE / "approval-resolved.jsonl"     # ids approved/rejected
CODEMAP = STATE / "approval-codemap.json"        # code -> {id,kind,title}
NOTIFIED = STATE / "approval-notified.json"      # hash of last-digested open set
LOG = STATE / "approvals.log"
CFG = STATE / "email-config.json"
# Sibling scripts dir: env override, else this file's own directory.
SCRIPTS = Path(os.environ.get("POCKET_SCRIPTS_DIR", str(Path(__file__).resolve().parent)))
GOG = os.environ.get("POCKET_GOG_BIN", "gog")

def log(m):
    line=f"{time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())} [approvals] {m}"
    print(line, file=sys.stderr)
    try: open(LOG,"a").write(line+"\n")
    except OSError: pass

def _load_jsonl(p):
    out=[]
    if p.exists():
        for line in p.read_text().splitlines():
            line=line.strip()
            if not line: continue
            try: out.append(json.loads(line))
            except: pass
    return out

def _norm(item):
    """Return (id, kind, title, ctx, raw) from a review/draft row (raw or wrapped)."""
    t = item.get("task", item)
    return (t.get("id") or item.get("id"),
            t.get("kind") or item.get("kind","action_item"),
            (t.get("title") or item.get("title") or "")[:120],
            (t.get("context") or item.get("context") or "")[:600], t)

def _resolved_ids():
    return {r.get("id") for r in _load_jsonl(RESOLVED)}

def open_items():
    res=_resolved_ids()
    items=[]
    for src,tag in ((REVIEW,"ASK"),(DRAFTS,"DRAFT")):
        for it in _load_jsonl(src):
            iid,kind,title,ctx,raw=_norm(it)
            if not iid or iid in res: continue
            if any(x["id"]==iid for x in items): continue
            items.append({"id":iid,"bucket":tag,"kind":kind,"title":title,"ctx":ctx,"raw":raw})
    return items

def send_via_bridge(subject, body):
    """Reuse email-bridge send_email (SES backend) to mail the owner."""
    sys.path.insert(0,str(SCRIPTS))
    import importlib.util
    spec=importlib.util.spec_from_file_location("ebridge", SCRIPTS/"ops-pocket-email-bridge.py")
    eb=importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)
    cfg=json.loads(CFG.read_text())
    to=cfg.get("self_address")
    ok,info=eb.send_email(to, subject, body, backend=cfg.get("backend","gog"), ses_cfg=cfg)
    return ok,info,to

def cmd_digest():
    items=open_items()
    if not items:
        log("digest: no open items"); return 0
    codemap={}
    a=d=0
    lines=["Pending Pocket items need your decision. Reply to this email with one line per item:",
           "  APPROVE <code>   (run it)","  REJECT <code>    (drop it)","",]
    for it in items:
        if it["bucket"]=="ASK": a+=1; code=f"A{a}"
        else: d+=1; code=f"D{d}"
        codemap[code]={"id":it["id"],"kind":it["kind"],"title":it["title"],"bucket":it["bucket"],"raw":it["raw"]}
        lines.append(f"[{code}] ({it['bucket']}) {it['title']}")
        if it["ctx"]: lines.append(f"      {it['ctx'][:240]}")
        lines.append("")
    body="\n".join(lines)
    # idempotency: skip if same open set already notified
    import hashlib
    h=hashlib.sha256(json.dumps(sorted(c['id'] for c in codemap.values())).encode()).hexdigest()
    prev=json.loads(NOTIFIED.read_text()).get("hash") if NOTIFIED.exists() else None
    if h==prev:
        log(f"digest: open set unchanged ({len(items)} items) — not re-emailing")
        CODEMAP.write_text(json.dumps(codemap,indent=2)); return 0
    ok,info,to=send_via_bridge(f"[Pocket] {len(items)} item(s) need approval", body)
    CODEMAP.write_text(json.dumps(codemap,indent=2))
    NOTIFIED.write_text(json.dumps({"hash":h,"ts":time.time(),"count":len(items)}))
    log(f"digest: emailed {len(items)} items to {to} ok={ok} info={info}")
    return 0 if ok else 1

def _gog_search_replies():
    """Find recent emails from the owner replying to approval digests."""
    try:
        r=subprocess.run([GOG,"gmail","search","subject:[Pocket] newer_than:2d","--max","15","-j","--results-only","--no-input"],
                         capture_output=True,text=True,timeout=60,env=os.environ)
        if r.returncode!=0:
            log(f"gog search rc={r.returncode}: {r.stderr[:150]}"); return []
        return json.loads(r.stdout or "[]")
    except Exception as e:
        log(f"gog search err {e}"); return []

def _gog_body(msg_id):
    try:
        r=subprocess.run([GOG,"gmail","get",msg_id,"-j","--no-input"],capture_output=True,text=True,timeout=60,env=os.environ)
        d=json.loads(r.stdout or "{}")
        return (d.get("body") or d.get("snippet") or "")
    except Exception: return ""

def cmd_replies():
    if not CODEMAP.exists(): log("replies: no codemap yet"); return 0
    codemap=json.loads(CODEMAP.read_text())
    res=_resolved_ids()
    import re
    acted=0
    self_addr=json.loads(CFG.read_text()).get("self_address","")
    for m in _gog_search_replies():
        frm=(m.get("from") or "").lower()
        if not self_addr or self_addr.lower() not in frm:  # only the owner's own replies
            continue
        body=_gog_body(m.get("id",""))
        for mt in re.finditer(r"\b(APPROVE|REJECT)\s+([A-Za-z]\d+|[a-z0-9\-]{6,})\b", body, re.I):
            verb=mt.group(1).upper(); ref=mt.group(2)
            ent=codemap.get(ref) or codemap.get(ref.upper())
            tid=ent["id"] if ent else (ref if any(c["id"]==ref for c in codemap.values()) else None)
            if not ent and tid:
                ent=next((c for c in codemap.values() if c["id"]==tid),None)
            if not ent: continue
            if ent["id"] in res: continue  # already resolved
            if verb=="APPROVE":
                task=ent["raw"].get("task",ent["raw"]) if isinstance(ent["raw"],dict) else {}
                task=dict(task); task["id"]=ent["id"]; task.setdefault("kind","action_item")
                task["approved_at"]=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
                open(TASKS,"a").write(json.dumps(task)+"\n")
                open(RESOLVED,"a").write(json.dumps({"id":ent["id"],"decision":"APPROVE","ts":time.time()})+"\n")
                log(f"APPROVE {ref} -> promoted {ent['id']} to tasks.jsonl"); acted+=1
            else:
                open(RESOLVED,"a").write(json.dumps({"id":ent["id"],"decision":"REJECT","ts":time.time()})+"\n")
                log(f"REJECT {ref} -> dropped {ent['id']}"); acted+=1
            res.add(ent["id"])
    log(f"replies: acted={acted}")
    return 0

if __name__=="__main__":
    mode=sys.argv[1] if len(sys.argv)>1 else "--digest"
    sys.exit(cmd_digest() if mode=="--digest" else cmd_replies() if mode=="--replies" else 2)
