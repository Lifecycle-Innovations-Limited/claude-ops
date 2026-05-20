#!/usr/bin/env python3
"""pocket-ops-ui — Flask web UI for the Pocket pipeline.

Auth: Tailscale identity header (Tailscale-User-Login). Only the configured
owner identity is allowed. All data read from state files at runtime — no DB.

Listens on 127.0.0.1:7777, served to the tailnet via `tailscale serve`.
"""
from __future__ import annotations

import html
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, redirect, request, url_for

app = Flask(__name__)

HOME = Path(os.environ.get("HOME", "$HOME"))
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
ALLOWED_USER = os.environ.get("TAILSCALE_USER", "")  # e.g. sam@example.com

# ── Auth ─────────────────────────────────────────────────────────────────────

def check_auth() -> None:
    """Abort 403 if Tailscale-User-Login header doesn't match ALLOWED_USER."""
    if not ALLOWED_USER:
        return  # unconfigured = open (Tailscale network is the perimeter)
    user = request.headers.get("Tailscale-User-Login", "")
    if user != ALLOWED_USER:
        abort(403)

# ── Data helpers ─────────────────────────────────────────────────────────────

def _html(s: object) -> str:
    return html.escape("" if s is None else str(s), quote=True)


def read_jsonl(path: Path, limit: int | None = 200) -> list[dict]:
    if not path.exists():
        return []
    out = []
    try:
        lines = path.read_text().splitlines()
        chunk = lines if limit is None else lines[-limit:]
        for raw in chunk:
            raw = raw.strip()
            if not raw:
                continue
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return out


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def health_files() -> dict[str, dict]:
    names = {
        "activity-notifier": STATE_DIR / ".activity-notifier-health",
        "out-queue": STATE_DIR / ".out-queue-health",
        "email-bridge": STATE_DIR / ".email-bridge-health",
        "whatsapp-bridge": STATE_DIR / ".whatsapp-bridge-health",
        "executor": STATE_DIR / ".executor-health",
    }
    return {name: read_json(path) for name, path in names.items()}


def all_tasks() -> list[dict]:
    return read_jsonl(STATE_DIR / "tasks.jsonl", limit=500)


def pending_triage() -> list[dict]:
    return read_jsonl(STATE_DIR / "pending-triage.jsonl", limit=100)


def triage_decisions() -> list[dict]:
    return read_jsonl(STATE_DIR / "triage-decisions.jsonl", limit=200)


def spawn_ledger(limit: int = 50) -> list[dict]:
    return read_jsonl(STATE_DIR / "spawn-ledger.jsonl", limit=limit)


def executor_results(limit: int = 50) -> list[dict]:
    results = []
    results_dir = STATE_DIR / "executor-results"
    if not results_dir.exists():
        return results
    paths = sorted(results_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in paths[:limit]:
        try:
            d = json.loads(p.read_text())
            d["_filename"] = p.name
            results.append(d)
        except (OSError, json.JSONDecodeError):
            continue
    return results


def out_queue_sent(limit: int = 50) -> list[dict]:
    items = read_jsonl(STATE_DIR / "out-queue-sent.jsonl", limit=limit)
    items.reverse()
    return items


def email_sent(limit: int = 50) -> list[dict]:
    items = read_jsonl(STATE_DIR / "email-sent.jsonl", limit=limit)
    items.reverse()
    return items


def systemd_status(unit: str) -> str:
    try:
        r = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except Exception:
        return "unknown"


MANAGED_UNITS = [
    "whatsapp-baileys.service",
    "pocket-ops-ui.service",
    "pocket-watcher.timer",
    "pocket-executor.timer",
    "pocket-activity-notifier.timer",
    "pocket-out-queue.timer",
    "pocket-email-bridge.timer",
    "pocket-whatsapp-bridge.timer",
]


def services_status() -> list[dict]:
    out = []
    for unit in MANAGED_UNITS:
        status = systemd_status(unit)
        out.append({"unit": unit, "status": status})
    return out


def tmux_windows() -> list[str]:
    try:
        r = subprocess.run(
            ["tmux", "list-windows", "-t", "pocket-exec", "-F", "#{window_index}: #{window_name}"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip().splitlines() if r.returncode == 0 else []
    except Exception:
        return []


# ── SSE file watcher ─────────────────────────────────────────────────────────

def _sse_watcher() -> Generator[str, None, None]:
    watched = [
        STATE_DIR / "tasks.jsonl",
        STATE_DIR / "pending-triage.jsonl",
        STATE_DIR / "spawn-ledger.jsonl",
        STATE_DIR / "supervisor-out-queue.jsonl",
    ]
    mtimes: dict[str, float] = {}

    def current_mtimes() -> dict[str, float]:
        m = {}
        for p in watched:
            try:
                m[str(p)] = p.stat().st_mtime
            except OSError:
                m[str(p)] = 0.0
        return m

    mtimes = current_mtimes()
    yield "data: connected\n\n"

    while True:
        time.sleep(3)
        new = current_mtimes()
        changed = [k for k in new if new[k] != mtimes.get(k, 0)]
        if changed:
            mtimes = new
            payload = json.dumps({"changed": [Path(c).name for c in changed]})
            yield f"data: {payload}\n\n"
        else:
            yield ": ping\n\n"


TABS = [
    ("triage", "Pending Triage"),
    ("in-progress", "In Progress"),
    ("completed", "Completed"),
    ("notifications", "Notifications"),
    ("services", "Services"),
]


def render_page(tab: str, content: str) -> str:
    tab_html = ""
    for t, label in TABS:
        cls = "px-3 py-2 whitespace-nowrap border-b-2 border-indigo-500 text-indigo-600 font-semibold" if t == tab else "px-3 py-2 whitespace-nowrap text-gray-500 hover:text-gray-700"
        tab_html += f'<a href="/?tab={t}" class="{cls}">{label}</a>'

    health = health_files()
    health_bar_html = _render_health_bar(health)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket Ops</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
<header class="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
  <div class="flex items-center gap-3">
    <span class="text-lg font-bold tracking-tight">Pocket Ops</span>
    <span class="text-xs text-gray-400 hidden sm:inline">dev-sandbox</span>
  </div>
  <div id="health-bar" class="flex gap-2 text-xs flex-wrap justify-end"
       hx-get="/api/health-bar" hx-trigger="every 30s" hx-swap="innerHTML">
    {health_bar_html}
  </div>
</header>
<nav class="bg-white border-b border-gray-200 px-4 flex gap-0 overflow-x-auto text-sm">
  {tab_html}
</nav>
<main class="max-w-6xl mx-auto px-4 py-6">
  {content}
</main>
<script>
const evtSrc = new EventSource('/api/stream');
evtSrc.onmessage = e => {{
  if (e.data === 'connected') return;
  const el = document.getElementById('live-content');
  if (el) htmx.trigger(el, 'refresh');
  htmx.trigger(document.getElementById('health-bar'), 'load');
}};
</script>
</body>
</html>"""


def _badge(text: str, color: str) -> str:
    classes = {
        "green": "bg-green-100 text-green-800",
        "red": "bg-red-100 text-red-800",
        "yellow": "bg-yellow-100 text-yellow-800",
        "gray": "bg-gray-100 text-gray-600",
        "blue": "bg-blue-100 text-blue-800",
    }.get(color, "bg-gray-100 text-gray-600")
    return f'<span class="inline-block {classes} text-xs font-medium px-2 py-0.5 rounded-full">{text}</span>'


def _status_badge(status: str) -> str:
    if status == "ok":
        return _badge("ok", "green")
    if status == "running":
        return _badge("running", "blue")
    if status in ("error", "disabled"):
        return _badge(status, "red")
    if status == "warn":
        return _badge("warn", "yellow")
    return _badge(status or "unknown", "gray")


def _render_health_bar(health: dict) -> str:
    parts = []
    for name, h in health.items():
        status = h.get("status", "?")
        dot = {"ok": "text-green-500", "running": "text-blue-500", "error": "text-red-500",
               "disabled": "text-red-400", "warn": "text-yellow-500"}.get(status, "text-gray-400")
        parts.append(f'<span class="flex items-center gap-1"><span class="{dot}">&#9679;</span>{name}</span>')
    return " ".join(parts) if parts else '<span class="text-gray-400">no health data</span>'


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    check_auth()
    tab = request.args.get("tab", "triage")
    if tab == "triage":
        content = _render_triage_tab()
    elif tab == "in-progress":
        content = _render_inprogress_tab()
    elif tab == "completed":
        content = _render_completed_tab()
    elif tab == "notifications":
        content = _render_notifications_tab()
    elif tab == "services":
        content = _render_services_tab()
    else:
        content = "<p class='text-gray-500'>Unknown tab.</p>"
    return render_page(tab, content)


@app.route("/health")
def health_route():
    check_auth()
    h = health_files()
    overall = "ok" if all(v.get("status") == "ok" for v in h.values()) else "degraded"
    return jsonify({"overall": overall, "services": h})


@app.route("/api/health-bar")
def health_bar_fragment():
    check_auth()
    return _render_health_bar(health_files())


@app.route("/api/stream")
def sse_stream():
    check_auth()
    return Response(_sse_watcher(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/tasks")
def tasks_list():
    check_auth()
    return redirect(url_for("index", tab="completed"))


@app.route("/tasks/<task_id>")
def task_detail(task_id: str):
    check_auth()
    task_id_html = html.escape(task_id)
    # Find report file in executor-results
    results_dir = STATE_DIR / "executor-results"
    report_html = "<p class='text-gray-500'>No report found.</p>"
    if results_dir.exists():
        for p in results_dir.glob(f"{task_id}*"):
            try:
                data = json.loads(p.read_text())
                output_file = data.get("output_file", "")
                if output_file:
                    op = Path(os.path.expanduser(output_file))
                    if op.exists():
                        raw = op.read_text()
                        if op.suffix == ".md":
                            # Simple markdown → html (no deps, just pre-wrap)
                            escaped = raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                            report_html = f'<pre class="whitespace-pre-wrap text-sm font-mono bg-gray-50 p-4 rounded border">{escaped}</pre>'
                        else:
                            escaped = raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                            report_html = f'<pre class="whitespace-pre-wrap text-sm font-mono bg-gray-50 p-4 rounded border">{escaped}</pre>'
                summary = data.get("summary", "")
                worker_h = _html(data.get("worker", "?"))
                fname_h = _html(p.name)
                summary_h = _html(summary) if summary else ""
                content = f"""
<div class="mb-4">
  <h2 class="text-xl font-semibold mb-1">{task_id_html}</h2>
  <p class="text-gray-500 text-sm">Worker: {worker_h} &nbsp;|&nbsp; File: {fname_h}</p>
  {f'<p class="mt-2 text-gray-700">{summary_h}</p>' if summary else ''}
</div>
<h3 class="font-semibold mb-2 text-gray-700">Report</h3>
{report_html}
<div class="mt-4"><a href="/?tab=completed" class="text-indigo-600 text-sm hover:underline">&larr; Back to completed</a></div>
"""
                return render_page("completed", content)
            except (OSError, json.JSONDecodeError):
                continue
    content = f'<p class="text-gray-500">Task {task_id_html} not found.</p><a href="/?tab=completed" class="text-indigo-600 text-sm hover:underline">&larr; Back</a>'
    return render_page("completed", content)


@app.route("/tasks/<task_id>/triage", methods=["POST"])
def triage_action(task_id: str):
    check_auth()
    decision = request.form.get("decision", "")  # "ACT" or "SKIP"
    if decision not in ("ACT", "SKIP"):
        abort(400)
    # Read full pending-triage so rewrite does not drop older rows (see read_jsonl limit).
    items = read_jsonl(STATE_DIR / "pending-triage.jsonl", limit=None)
    item = next((i for i in items if i.get("id") == task_id), None)
    if not item:
        abort(404)
    # Write triage decision
    entry = {
        "id": task_id,
        "decision": decision,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "via": "web-ui",
    }
    try:
        with (STATE_DIR / "triage-decisions.jsonl").open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        return "<p class='text-red-600'>Could not record triage decision.</p>", 500
    # Remove from pending-triage
    remaining = [i for i in items if i.get("id") != task_id]
    try:
        with (STATE_DIR / "pending-triage.jsonl").open("w") as f:
            for i in remaining:
                f.write(json.dumps(i) + "\n")
    except OSError:
        pass
    return redirect(url_for("index", tab="triage"))


@app.route("/services/<name>/restart", methods=["POST"])
def restart_service(name: str):
    check_auth()
    # Validate name is in our managed set
    safe_units = {u.replace(".service", "").replace(".timer", "") for u in MANAGED_UNITS}
    unit_base = name.replace(".service", "").replace(".timer", "")
    if unit_base not in safe_units:
        abort(400)
    unit = name if ("." in name) else f"{name}.service"
    try:
        subprocess.run(["sudo", "systemctl", "restart", unit], timeout=15, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        return f"<p class='text-red-600'>Restart failed: {e}</p>", 500
    return redirect(url_for("index", tab="services"))


@app.route("/channels/<name>/toggle", methods=["POST"])
def toggle_channel(name: str):
    check_auth()
    if name == "whatsapp":
        cfg_path = STATE_DIR / "whatsapp-config.json"
    elif name == "email":
        cfg_path = STATE_DIR / "email-config.json"
    else:
        abort(400)
    cfg = read_json(cfg_path)
    cfg["enabled"] = not cfg.get("enabled", False)
    try:
        cfg_path.write_text(json.dumps(cfg, indent=2))
    except OSError:
        pass
    return redirect(url_for("index", tab="services"))


# ── Tab renderers ─────────────────────────────────────────────────────────────

def _render_triage_tab() -> str:
    items = pending_triage()
    if not items:
        return '<div id="live-content" hx-get="/api/triage-fragment" hx-trigger="refresh"><p class="text-gray-500 text-sm">No items pending triage.</p></div>'

    cards = []
    for item in items:
        tid = item.get("id", "?")
        tid_seg = quote(str(tid), safe="")
        title_h = _html(item.get("title", "(no title)"))
        context = item.get("context", "")
        rec_id = item.get("recording_id", "")
        ts = item.get("ts", "")
        ts_str = str(ts)[:16] if ts else ""
        meta_tid = _html(tid)
        meta_rec = f"&nbsp;|&nbsp; rec: {_html(rec_id)}" if rec_id else ""
        meta_ts = f"&nbsp;|&nbsp; {_html(ts_str)}" if ts_str else ""
        context_html = f'<p class="text-sm text-gray-600 mt-2">{_html(str(context)[:300])}</p>' if context else ""
        cards.append(f"""
<div class="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
  <div class="flex items-start justify-between gap-2">
    <div class="flex-1 min-w-0">
      <p class="font-semibold text-gray-900 truncate">{title_h}</p>
      <p class="text-xs text-gray-400 mt-0.5">{meta_tid}{meta_rec}{meta_ts}</p>
      {context_html}
    </div>
  </div>
  <div class="mt-3 flex gap-2">
    <form method="POST" action="/tasks/{tid_seg}/triage" class="inline">
      <input type="hidden" name="decision" value="ACT">
      <button type="submit" class="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 font-medium">ACT</button>
    </form>
    <form method="POST" action="/tasks/{tid_seg}/triage" class="inline">
      <input type="hidden" name="decision" value="SKIP">
      <button type="submit" class="px-4 py-1.5 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300 font-medium">SKIP</button>
    </form>
  </div>
</div>""")

    count = len(items)
    return f"""
<div class="mb-4 flex items-center justify-between">
  <h2 class="font-semibold text-gray-700">{count} item{'s' if count != 1 else ''} pending triage</h2>
</div>
<div id="live-content" class="grid gap-3 sm:grid-cols-2" hx-get="/api/triage-fragment" hx-trigger="refresh" hx-swap="outerHTML">
  {''.join(cards)}
</div>"""


def _render_inprogress_tab() -> str:
    windows = tmux_windows()
    ledger = spawn_ledger(limit=10)

    win_html = ""
    if windows:
        items = "".join(f'<li class="font-mono text-sm text-gray-700">{w}</li>' for w in windows)
        win_html = f'<ul class="space-y-1 list-disc list-inside">{items}</ul>'
    else:
        win_html = '<p class="text-gray-400 text-sm">No pocket-exec tmux session found.</p>'

    ledger_rows = ""
    for e in reversed(ledger):
        tid = e.get("pocket_task_id") or e.get("task_id", "?")
        title = e.get("title", "")[:60]
        worker = e.get("worker", "?")
        ts = (e.get("ts") or "")[:16]
        ledger_rows += f'<tr class="border-t border-gray-100"><td class="py-1.5 pr-4 font-mono text-xs text-gray-500">{ts}</td><td class="py-1.5 pr-4 text-sm">{tid}</td><td class="py-1.5 pr-4 text-sm text-gray-600">{title}</td><td class="py-1.5 text-sm text-gray-500">{worker}</td></tr>'

    ledger_html = f"""<table class="w-full text-left">
<thead><tr class="text-xs text-gray-400 uppercase"><th class="pr-4 pb-1">Time</th><th class="pr-4 pb-1">Task ID</th><th class="pr-4 pb-1">Title</th><th class="pb-1">Worker</th></tr></thead>
<tbody>{ledger_rows if ledger_rows else '<tr><td colspan="4" class="text-gray-400 text-sm py-2">No entries.</td></tr>'}</tbody>
</table>"""

    return f"""
<div id="live-content" hx-get="/api/inprogress-fragment" hx-trigger="refresh" hx-swap="outerHTML">
  <div class="mb-6">
    <h2 class="font-semibold text-gray-700 mb-3">tmux windows (pocket-exec)</h2>
    {win_html}
  </div>
  <div>
    <h2 class="font-semibold text-gray-700 mb-3">Recent spawns (spawn-ledger)</h2>
    {ledger_html}
  </div>
</div>"""


def _render_completed_tab() -> str:
    results = executor_results(limit=100)

    rows = ""
    for r in results:
        tid = r.get("pocket_task_id") or r.get("task_id", "")
        fname = r.get("_filename", "")
        if not tid:
            # Try to infer from filename
            for suf in (".done.json", ".completed.json"):
                if fname.endswith(suf):
                    tid = fname[:-len(suf)]
                    break
        title_raw = (r.get("title", "") or "")[:60]
        title_h = _html(title_raw)
        worker_h = _html(r.get("worker", ""))
        # Use mtime from file for completed_at
        p = STATE_DIR / "executor-results" / fname
        completed_at = ""
        try:
            mtime = p.stat().st_mtime
            completed_at = datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        except OSError:
            completed_at = ""
        tid_str = str(tid) if tid else ""
        tid_disp = _html(tid_str[:40])
        detail_url = f"/tasks/{quote(tid_str, safe='')}" if tid_str else "#"
        rows += f'<tr class="border-t border-gray-100 hover:bg-gray-50"><td class="py-2 pr-4 text-xs text-gray-500 whitespace-nowrap">{completed_at}</td><td class="py-2 pr-4 font-mono text-xs">{tid_disp}</td><td class="py-2 pr-4 text-sm">{title_h}</td><td class="py-2 pr-4 text-sm text-gray-500">{worker_h}</td><td class="py-2"><a href="{detail_url}" class="text-indigo-600 text-xs hover:underline">view</a></td></tr>'

    table = f"""<div class="overflow-x-auto">
<table class="w-full text-left">
<thead><tr class="text-xs text-gray-400 uppercase"><th class="pr-4 pb-2">Completed</th><th class="pr-4 pb-2">Task ID</th><th class="pr-4 pb-2">Title</th><th class="pr-4 pb-2">Worker</th><th class="pb-2"></th></tr></thead>
<tbody>{rows if rows else '<tr><td colspan="5" class="text-gray-400 text-sm py-4">No completed results yet.</td></tr>'}</tbody>
</table>
</div>"""

    count = len(results)
    return f"""
<div class="mb-4"><h2 class="font-semibold text-gray-700">{count} completed result{'s' if count != 1 else ''}</h2></div>
{table}"""


def _render_notifications_tab() -> str:
    wa = out_queue_sent(limit=30)
    em = email_sent(limit=30)

    # Merge and sort by ts descending
    combined = []
    for item in wa:
        combined.append({**item, "_channel": "whatsapp"})
    for item in em:
        combined.append({**item, "_channel": "email"})
    combined.sort(key=lambda x: x.get("ts", ""), reverse=True)

    rows = ""
    for item in combined[:50]:
        ch = item["_channel"]
        ch_badge = _badge("WhatsApp", "green") if ch == "whatsapp" else _badge("Email", "blue")
        ts = (item.get("ts") or "")[:16]
        msg = item.get("message") or item.get("body") or ""
        subject = item.get("subject", "")
        preview_raw = (subject or msg)[:100]
        preview_h = _html(preview_raw)
        ts_h = _html(ts)
        rows += f'<tr class="border-t border-gray-100"><td class="py-2 pr-3 text-xs text-gray-400 whitespace-nowrap">{ts_h}</td><td class="py-2 pr-3">{ch_badge}</td><td class="py-2 text-sm text-gray-700">{preview_h}</td></tr>'

    table = f"""<div class="overflow-x-auto">
<table class="w-full text-left">
<thead><tr class="text-xs text-gray-400 uppercase"><th class="pr-3 pb-2">Time</th><th class="pr-3 pb-2">Channel</th><th class="pb-2">Preview</th></tr></thead>
<tbody>{rows if rows else '<tr><td colspan="3" class="text-gray-400 text-sm py-4">No notifications sent yet.</td></tr>'}</tbody>
</table>
</div>"""

    return f"""
<div class="mb-4"><h2 class="font-semibold text-gray-700">Last 50 notifications</h2></div>
{table}"""


def _render_services_tab() -> str:
    svcs = services_status()
    health = health_files()

    # Channel toggles
    wa_cfg = read_json(STATE_DIR / "whatsapp-config.json")
    em_cfg = read_json(STATE_DIR / "email-config.json")
    wa_enabled = wa_cfg.get("enabled", False)
    em_enabled = em_cfg.get("enabled", False)

    svc_rows = ""
    for s in svcs:
        unit = s["unit"]
        status = s["status"]
        status_class = {"active": "text-green-600", "inactive": "text-gray-400",
                        "failed": "text-red-600", "unknown": "text-gray-300"}.get(status, "text-gray-400")
        svc_rows += f"""<tr class="border-t border-gray-100">
<td class="py-2 pr-4 font-mono text-sm">{unit}</td>
<td class="py-2 pr-4 text-sm {status_class}">{status}</td>
<td class="py-2">
  <form method="POST" action="/services/{unit}/restart" class="inline">
    <button type="submit" class="text-xs text-indigo-600 hover:underline">restart</button>
  </form>
</td>
</tr>"""

    # Health file details
    health_rows = ""
    for name, h in health.items():
        status = h.get("status", "?")
        msg = h.get("message", "")
        last_run = (h.get("last_run") or "")[:16]
        health_rows += f"""<tr class="border-t border-gray-100">
<td class="py-2 pr-4 text-sm font-medium">{name}</td>
<td class="py-2 pr-4">{_status_badge(status)}</td>
<td class="py-2 pr-4 text-sm text-gray-500 truncate max-w-xs">{msg}</td>
<td class="py-2 text-xs text-gray-400">{last_run}</td>
</tr>"""

    wa_toggle = "Disable" if wa_enabled else "Enable"
    em_toggle = "Disable" if em_enabled else "Enable"
    wa_badge = _badge("enabled", "green") if wa_enabled else _badge("disabled", "gray")
    em_badge = _badge("enabled", "green") if em_enabled else _badge("disabled", "gray")

    return f"""
<div class="grid gap-6 lg:grid-cols-2">
  <div>
    <h2 class="font-semibold text-gray-700 mb-3">Systemd Units</h2>
    <div class="overflow-x-auto bg-white rounded-lg border border-gray-200">
      <table class="w-full text-left">
        <thead><tr class="text-xs text-gray-400 uppercase px-4">
          <th class="px-4 py-2">Unit</th><th class="px-4 py-2">Status</th><th class="px-4 py-2"></th>
        </tr></thead>
        <tbody class="divide-y divide-gray-50">{svc_rows}</tbody>
      </table>
    </div>
  </div>
  <div class="space-y-6">
    <div>
      <h2 class="font-semibold text-gray-700 mb-3">Health Monitors</h2>
      <div class="overflow-x-auto bg-white rounded-lg border border-gray-200">
        <table class="w-full text-left">
          <thead><tr class="text-xs text-gray-400 uppercase">
            <th class="px-4 py-2">Monitor</th><th class="px-4 py-2">Status</th><th class="px-4 py-2">Message</th><th class="px-4 py-2">Last run</th>
          </tr></thead>
          <tbody>{health_rows if health_rows else '<tr><td colspan="4" class="px-4 py-3 text-gray-400 text-sm">No health data.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div>
      <h2 class="font-semibold text-gray-700 mb-3">Channels</h2>
      <div class="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
        <div class="px-4 py-3 flex items-center justify-between">
          <div>
            <span class="font-medium text-sm">WhatsApp</span>
            <span class="ml-2">{wa_badge}</span>
            <p class="text-xs text-gray-400 mt-0.5">JID: {(wa_cfg.get('chat_jid') or 'not set')[:30]}</p>
          </div>
          <form method="POST" action="/channels/whatsapp/toggle">
            <button class="text-xs text-indigo-600 hover:underline">{wa_toggle}</button>
          </form>
        </div>
        <div class="px-4 py-3 flex items-center justify-between">
          <div>
            <span class="font-medium text-sm">Email</span>
            <span class="ml-2">{em_badge}</span>
            <p class="text-xs text-gray-400 mt-0.5">{em_cfg.get('self_address','not set')}</p>
          </div>
          <form method="POST" action="/channels/email/toggle">
            <button class="text-xs text-indigo-600 hover:underline">{em_toggle}</button>
          </form>
        </div>
      </div>
    </div>
  </div>
</div>"""


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7777, debug=False)
