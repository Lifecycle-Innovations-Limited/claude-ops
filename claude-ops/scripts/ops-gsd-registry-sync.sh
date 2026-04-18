#!/usr/bin/env bash
# ops-gsd-registry-sync — Scan all GSD projects, update central registry
# Writes: {OPS_DATA_DIR}/registry.json + cache/projects_health.json
# Called by: daemon cron (twice daily) or /ops:setup install
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
export DATA_DIR  # pass to Python subprocess
CACHE_DIR="$DATA_DIR/cache"
REGISTRY="$DATA_DIR/registry.json"
PROJECTS_HEALTH="$CACHE_DIR/projects_health.json"
LOG_DIR="$DATA_DIR/logs"

mkdir -p "$CACHE_DIR" "$LOG_DIR"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG="$LOG_DIR/gsd-registry-sync.log"

log() { printf '%s [gsd-registry] %s\n' "$NOW" "$1" | tee -a "$LOG"; }
log "Starting GSD registry sync..."

# Collect project data using Python inline (avoids complex interpreter preflight)
python3 - << PYEOF
import json, os, subprocess
from pathlib import Path

HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("OPS_DATA_DIR", os.path.join(HOME, ".claude/plugins/data/ops-ops-marketplace"))
CACHE_DIR = Path(DATA_DIR) / "cache"
REGISTRY = Path(DATA_DIR) / "registry.json"
PROJECTS_HEALTH = CACHE_DIR / "projects_health.json"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

NOW = subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True).strip()

projects = []
for base in [Path(HOME) / "Projects", Path(HOME) / "gsd-workspaces"]:
    if not base.exists(): continue
    source = base.name
    for d in base.iterdir():
        if not d.is_dir(): continue
        planning = d / ".planning"
        if not planning.is_dir(): continue
        proj = d.name
        handoff = planning / "HANDOFF.json"
        state = planning / "STATE.md"
        roadmap = planning / "ROADMAP.md"
        milestones = planning / "MILESTONES.md"

        phase = status = milestone = next_action = plan_ref = ""
        remaining = blockers = "0"
        has_git = d.joinpath(".git").is_dir()
        branch = ""

        if handoff.exists():
            try:
                h = json.loads(handoff.read_text())
                phase = h.get("phase","")
                status = h.get("status","")[:60]
                next_action = h.get("next_action","")[:100]
                plan_ref = h.get("plan_ref","")[:60]
                remaining = str(len(h.get("remaining_tasks",[])))
                blockers = str(len(h.get("blockers",[])))
            except: pass

        elif state.exists():
            for line in state.read_text().splitlines():
                if line.startswith("Current Phase"):
                    phase = line.split(":",1)[1].strip()[:20]
                elif line.startswith("Status:"):
                    status = line.split(":",1)[1].strip()[:60]
                elif line.startswith("Current Milestone"):
                    milestone = line.split(":",1)[1].strip()[:60]

        # Git info (fast, no network)
        uncommitted = 0
        if has_git:
            try:
                branch = subprocess.check_output(
                    ["git", "-C", str(d), "branch", "--show-current"],
                    timeout=2, stderr=subprocess.DEVNULL
                ).strip().decode() or ""
            except: pass
            try:
                dirty_out = subprocess.check_output(
                    ["git", "-C", str(d), "status", "--porcelain"],
                    timeout=3, stderr=subprocess.DEVNULL
                ).decode()
                uncommitted = len([l for l in dirty_out.splitlines() if l.strip()])
            except: pass

        total_phases = ""
        if roadmap.exists():
            total_phases = str(len([l for l in roadmap.read_text().splitlines() if l.startswith("## Phase ")]))

        if not milestone and milestones.exists():
            for line in milestones.read_text().splitlines():
                if line.startswith("## v"):
                    milestone = line.lstrip("#").strip()[:60]
                    break

        projects.append({
            "name": proj,
            "path": str(d) + "/",
            "source": source,
            "phase": phase,
            "status": status,
            "milestone": milestone,
            "next_action": next_action,
            "plan_ref": plan_ref,
            "remaining_tasks": remaining,
            "blockers": blockers,
            "has_git": has_git,
            "branch": branch,
            "uncommitted": uncommitted,
            "has_roadmap": roadmap.exists(),
            "has_milestones": milestones.exists(),
            "has_handoff": handoff.exists(),
            "total_phases": total_phases
        })

# Sort by status priority: executing > paused > blocked > idle
def sort_key(p):
    s = p.get("status","").lower()
    if "executing" in s: return 0
    if any(x in s for x in ["paused","verifying","phase_complete"]): return 1
    if any(x in s for x in ["human","uat","blocked","pending"]): return 2
    if p.get("phase"): return 3
    return 4

projects.sort(key=sort_key)

# Write registry.json
REGISTRY.write_text(json.dumps({"updated": NOW, "projects": projects, "total": len(projects)}, indent=2))

# Categorize for health summary (mutually exclusive, matching dashboard logic)
executing = []
paused = []
blocked = []
idle = []
for p in projects:
    s = p.get("status", "").lower()
    if "executing" in s:
        executing.append(p)
    elif any(x in s for x in ["paused", "verifying", "phase_complete"]):
        paused.append(p)
    elif any(x in s for x in ["human", "uat", "blocked", "pending"]):
        blocked.append(p)
    else:
        idle.append(p)
attention = [p for p in projects if int(p.get("blockers", "0")) > 0]

health = {
    "updated": NOW,
    "summary": {
        "total": len(projects),
        "executing": len(executing),
        "paused": len(paused),
        "blocked": len(blocked),
        "idle": len(idle),
        "needs_attention": len(attention)
    },
    "projects": [{
        "name": p["name"],
        "phase": p.get("phase",""),
        "status": p.get("status",""),
        "blockers": p.get("blockers","0"),
        "next_action": p.get("next_action","")[:100],
        "milestone": p.get("milestone",""),
        "source": p.get("source","")
    } for p in projects]
}
PROJECTS_HEALTH.write_text(json.dumps(health, indent=2))

print(f"Registry: {len(projects)} projects | exec={len(executing)} paused={len(paused)} blocked={len(blocked)} idle={len(idle)}")
PYEOF

log "GSD registry sync complete"
