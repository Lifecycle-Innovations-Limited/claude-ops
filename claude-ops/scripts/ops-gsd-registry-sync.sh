#!/usr/bin/env bash
# ops-gsd-registry-sync — Scan all GSD projects, update central registry
# Writes: {OPS_DATA_DIR}/registry.json + cache/projects_health.json
# Called by: daemon cron (twice daily) or /ops:setup install
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
export OPS_DATA_DIR="$DATA_DIR"  # expose resolved path to Python subprocess
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

# ── Discover ALL .planning directories under $HOME ─────────────────────────
# Replaces the previous hardcoded [~/Projects, ~/gsd-workspaces] scan, which
# missed:
#   - root-level .planning at $HOME
#   - ad-hoc project dirs at $HOME (~/myproject/.planning)
#   - nested multi-project workspaces (~/gsd-workspaces/X/Y/.planning)
#   - any user-chosen layout that isn't one of the two hardcoded roots
#
# Honors OPS_GSD_SCAN_ROOTS (colon-separated extra paths) for non-$HOME
# layouts. Honors OPS_GSD_SCAN_DEPTH (default 5) and excludes common noise
# directories so the walk stays cheap.
# Only exclude true noise — directories that cannot contain real GSD
# projects. We deliberately do NOT exclude _archived/, tmp/, .worktrees/
# etc. by default: archived and parked projects are still legitimate
# portfolio entries the user may want to query. Power users can extend
# the exclusion list via OPS_GSD_SCAN_EXCLUDE (colon-separated).
EXCLUDE_PARTS = {
    # Build/cache noise
    "node_modules", ".git", ".venv", "venv", "env-py",
    "Library", ".claude", ".Trash", ".cache", "__pycache__",
    "dist", "build", ".next", ".nuxt", ".turbo", ".vercel",
    # Tool config dirs that occasionally contain unrelated .planning
    ".gemini",
    # Git worktrees: transient clones of the same project — including them
    # would multiply every active project by 5-30x. Power users can re-enable
    # by passing OPS_GSD_INCLUDE_WORKTREES=1 (handled below).
    ".worktrees",
}
if os.environ.get("OPS_GSD_INCLUDE_WORKTREES", "") == "1":
    EXCLUDE_PARTS.discard(".worktrees")
extra_excludes = os.environ.get("OPS_GSD_SCAN_EXCLUDE", "")
if extra_excludes:
    for part in extra_excludes.split(":"):
        part = part.strip()
        if part:
            EXCLUDE_PARTS.add(part)
try:
    MAX_DEPTH = int(os.environ.get("OPS_GSD_SCAN_DEPTH", "5"))
except ValueError:
    MAX_DEPTH = 5

scan_roots = [Path(HOME)]
extra_roots = os.environ.get("OPS_GSD_SCAN_ROOTS", "")
if extra_roots:
    for root_str in extra_roots.split(":"):
        root_str = root_str.strip()
        if not root_str:
            continue
        rp = Path(os.path.expanduser(root_str))
        if rp.exists() and rp.is_dir():
            scan_roots.append(rp)

planning_dirs = []
for root in scan_roots:
    if not root.exists():
        continue
    stack = [(root, 0)]
    while stack:
        cur, depth = stack.pop()
        if depth > MAX_DEPTH:
            continue
        try:
            entries = list(cur.iterdir())
        except (PermissionError, OSError):
            continue
        for entry in entries:
            if not entry.is_dir() or entry.is_symlink():
                continue
            if entry.name in EXCLUDE_PARTS:
                continue
            if entry.name == ".planning":
                planning_dirs.append(entry)
                continue  # don't descend into .planning itself
            if depth + 1 <= MAX_DEPTH:
                stack.append((entry, depth + 1))

# De-dupe (resolve symlinks, drop duplicates) and sort for deterministic output
seen_resolved = set()
unique_planning = []
for p in sorted(planning_dirs):
    try:
        rp = str(p.resolve())
    except OSError:
        rp = str(p)
    if rp in seen_resolved:
        continue
    seen_resolved.add(rp)
    unique_planning.append(p)

home_path = Path(HOME)

for planning in unique_planning:
    d = planning.parent
    if not d.is_dir():
        continue
    proj = d.name or "home"
    # Source = first path segment under $HOME, or "external" for OPS_GSD_SCAN_ROOTS hits
    try:
        rel_parts = d.relative_to(home_path).parts
        source = rel_parts[0] if rel_parts else "home"
    except ValueError:
        source = "external"

    if True:  # preserve original block indentation
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

        # Fall back to STATE.md if HANDOFF.json is missing or yielded no phase/status
        if not phase and not status and state.exists():
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
                status_out = subprocess.check_output(
                    ["git", "-C", str(d), "status", "--porcelain"],
                    timeout=5, stderr=subprocess.DEVNULL
                ).decode()
                uncommitted = len([l for l in status_out.strip().splitlines() if l.strip()])
            except: pass

        total_phases = ""
        if roadmap.exists():
            total_phases = str(len([l for l in roadmap.read_text().splitlines() if l.startswith("## Phase ")]))

        if not milestone and milestones.exists():
            for line in milestones.read_text().splitlines():
                if line.startswith("## v"):
                    milestone = line.lstrip("#").strip()[:60]
                    break

        # Dedupe key: prefer git remote URL (canonical), else resolved path
        remote_url = ""
        if has_git:
            try:
                remote_url = subprocess.check_output(
                    ["git", "-C", str(d), "remote", "get-url", "origin"],
                    timeout=2, stderr=subprocess.DEVNULL
                ).strip().decode() or ""
            except: pass

        # Last commit timestamp — used to pick canonical when paths collide
        last_commit_ts = 0
        if has_git:
            try:
                ts_out = subprocess.check_output(
                    ["git", "-C", str(d), "log", "-1", "--format=%ct"],
                    timeout=2, stderr=subprocess.DEVNULL
                ).strip().decode()
                last_commit_ts = int(ts_out) if ts_out else 0
            except: pass

        projects.append({
            "name": proj,
            "path": str(d) + "/",
            "source": source,
            "remote_url": remote_url,
            "last_commit_ts": last_commit_ts,
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

# ── Dedupe: same git remote URL ⇒ same logical project ────────────────────
# Multiple checkout paths (e.g. ~/healify-api and ~/Projects/healify-api,
# or a clone in gsd-workspaces/) all map to one entry. Canonical path =
# the one with the most recent commit; other paths land in `aliases`.
# Projects without a git remote are deduped by resolved filesystem path
# instead, so symlinks don't multiply entries either.
canonical_by_key = {}
for p in projects:
    key = p.get("remote_url") or ""
    if not key:
        try:
            key = "path:" + str(Path(p["path"].rstrip("/")).resolve())
        except OSError:
            key = "path:" + p["path"]
    if key not in canonical_by_key:
        p["aliases"] = []
        canonical_by_key[key] = p
        continue
    incumbent = canonical_by_key[key]
    challenger = p
    # Prefer the path with the most recent commit (active checkout wins).
    # Tie-break: shorter path (closer to $HOME, more likely "primary").
    incumbent_score = (incumbent.get("last_commit_ts", 0), -len(incumbent["path"]))
    challenger_score = (challenger.get("last_commit_ts", 0), -len(challenger["path"]))
    if challenger_score > incumbent_score:
        challenger["aliases"] = incumbent.get("aliases", []) + [incumbent["path"]]
        canonical_by_key[key] = challenger
    else:
        incumbent.setdefault("aliases", []).append(challenger["path"])

projects = list(canonical_by_key.values())

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
