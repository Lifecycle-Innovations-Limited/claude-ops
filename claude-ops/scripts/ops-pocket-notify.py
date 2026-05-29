#!/usr/bin/env python3
"""ops-pocket-notify — config-driven notification dispatcher for the pocket module.

Pocket components (env-broker, executor, watcher, daemon) emit an EVENT id; this
dispatcher decides — from `preferences.json → pocket.notifications` — which
channels to notify, applies the per-event schedule (active/quiet windows) +
cooldown + severity escalation, and sends via the existing channel helpers. The
emitters never know about channels or timing; all routing lives in preferences,
which the interactive /ops:setup flow writes.

Usage:
    ops-pocket-notify <event-id> <message> [--severity low|medium|high]
                                           [--dry-run] [--json]

Resolution order for an event's config:
    pocket.notifications.events[<event-id>]  →  pocket.notifications.defaults
Channels default to [] (off) when unconfigured, so a brand-new event is silent
until the operator opts it in.

Schedule (per event, under "schedule"):
    cooldown            seconds between sends for the same event (rate-limit)
    quiet_hours         {"start":"HH:MM","end":"HH:MM"} — suppressed window
    active_days         list of weekday ints (0=Mon..6=Sun); empty/absent = all
    escalate_severities severities that BYPASS quiet_hours/active_days (default ["high"])

Exit: 0 if dispatched or intentionally suppressed; 2 on bad usage.

Env:
    PREFS_PATH             preferences.json (default plugin data dir)
    POCKET_STATE_DIR       cooldown-state + log dir (default /var/lib/pocket-pipeline)
    POCKET_NOTIFY_TZ       IANA tz for schedule (default from prefs, else system)
    OPS_NOTIFY_DRY_RUN=1   force dry-run
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, time as dtime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

PLUGIN_DATA = os.environ.get(
    "CLAUDE_PLUGIN_DATA_DIR",
    os.path.expanduser("~/.claude/plugins/data/ops-ops-marketplace"),
)
PREFS_PATH = Path(os.environ.get("PREFS_PATH", os.path.join(PLUGIN_DATA, "preferences.json")))
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", "/var/lib/pocket-pipeline"))
COOLDOWN_STATE = STATE_DIR / ".notify-cooldown.json"
NOTIFY_LOG = STATE_DIR / "notify-dispatch.log"
OUT_QUEUE = STATE_DIR / "supervisor-out-queue.jsonl"

DEFAULT_ESCALATE = ["high"]


def _log(msg: str) -> None:
    line = f"{datetime.now().astimezone().isoformat(timespec='seconds')} [ops-pocket-notify] {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with NOTIFY_LOG.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _load_prefs_notifications() -> dict:
    try:
        d = json.loads(PREFS_PATH.read_text())
        return d.get("pocket", {}).get("notifications", {}) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _event_config(notif: dict, event: str) -> dict:
    defaults = notif.get("defaults", {}) or {}
    ev = (notif.get("events", {}) or {}).get(event, {}) or {}
    # merged: event overrides defaults; schedule merged shallowly
    merged = {**defaults, **ev}
    sched = {**(defaults.get("schedule", {}) or {}), **(ev.get("schedule", {}) or {})}
    if sched:
        merged["schedule"] = sched
    return merged


def _tz(notif: dict):
    name = os.environ.get("POCKET_NOTIFY_TZ") or notif.get("tz")
    if name and ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            return None
    return None


def _parse_hhmm(s: str) -> dtime | None:
    try:
        h, m = s.split(":")
        return dtime(int(h), int(m))
    except (ValueError, AttributeError):
        return None


def _in_quiet_hours(now: datetime, qh: dict) -> bool:
    start = _parse_hhmm(qh.get("start", ""))
    end = _parse_hhmm(qh.get("end", ""))
    if not start or not end:
        return False
    t = now.timetz().replace(tzinfo=None)
    if start <= end:
        return start <= t < end
    # window wraps midnight (e.g. 22:00→08:00)
    return t >= start or t < end


def _schedule_suppresses(cfg: dict, severity: str, now: datetime) -> str | None:
    sched = cfg.get("schedule", {}) or {}
    escalate = sched.get("escalate_severities", DEFAULT_ESCALATE)
    if severity in escalate:
        return None  # high-severity always pages, ignores windows
    active_days = sched.get("active_days")
    if active_days and now.weekday() not in active_days:
        return "inactive_day"
    qh = sched.get("quiet_hours", {}) or {}
    if qh and _in_quiet_hours(now, qh):
        return "quiet_hours"
    return None


def _cooldown_suppresses(event: str, cooldown: int, now_ts: float) -> bool:
    if cooldown <= 0:
        return False
    try:
        state = json.loads(COOLDOWN_STATE.read_text())
    except (OSError, json.JSONDecodeError):
        state = {}
    last = state.get(event, 0)
    if now_ts - last < cooldown:
        return True
    state[event] = now_ts
    try:
        COOLDOWN_STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = COOLDOWN_STATE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state))
        tmp.replace(COOLDOWN_STATE)
    except OSError:
        pass
    return False


def _enqueue(kind: str, payload: dict) -> None:
    rec = {"kind": kind, **payload}
    OUT_QUEUE.parent.mkdir(parents=True, exist_ok=True)
    with OUT_QUEUE.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _send(channel: str, message: str, event: str, severity: str) -> bool:
    """Best-effort send to one channel via the existing helpers. Returns True on
    dispatch (queued counts as dispatched)."""
    subject = f"[pocket:{severity}] {event}"
    if channel == "telegram":
        r = subprocess.run(["ops-telegram-bot-send", message], capture_output=True, timeout=20)
        return r.returncode == 0
    if channel == "email":
        _enqueue("email", {"subject": subject, "body": message})
        return True
    if channel == "whatsapp":
        _enqueue("whatsapp", {"message": message})
        return True
    if channel == "slack":
        _enqueue("slack", {"text": f"{subject}: {message}"})
        return True
    _log(f"unknown channel {channel!r} — skipped")
    return False


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    severity = "medium"
    if "--severity" in argv:
        i = argv.index("--severity")
        if i + 1 < len(argv):
            severity = argv[i + 1]
            args = [a for a in args if a != severity]
    if len(args) < 2:
        print("usage: ops-pocket-notify <event-id> <message> [--severity low|medium|high] [--dry-run] [--json]", file=sys.stderr)
        return 2
    event, message = args[0], args[1]
    dry = "--dry-run" in flags or os.environ.get("OPS_NOTIFY_DRY_RUN") == "1"

    notif = _load_prefs_notifications()
    cfg = _event_config(notif, event)
    channels = cfg.get("channels", []) or []
    severity = severity if "--severity" in argv else cfg.get("severity", severity)
    cooldown = int(cfg.get("schedule", {}).get("cooldown", cfg.get("cooldown", notif.get("default_cooldown", 0))) or 0)

    result = {"event": event, "severity": severity, "configured_channels": channels,
              "fired": [], "suppressed": None}

    if not channels:
        result["suppressed"] = "no_channels_configured"
    else:
        now = datetime.now(_tz(notif))
        sup = _schedule_suppresses(cfg, severity, now)
        if sup:
            result["suppressed"] = sup
        elif not dry and _cooldown_suppresses(event, cooldown, now.timestamp()):
            result["suppressed"] = "cooldown"
        elif dry:
            result["fired"] = channels  # would-fire
        else:
            for ch in channels:
                try:
                    if _send(ch, message, event, severity):
                        result["fired"].append(ch)
                except (OSError, subprocess.SubprocessError) as e:
                    _log(f"send {ch} failed: {e}")

    if not dry:
        _log(f"event={event} severity={severity} fired={result['fired']} suppressed={result['suppressed']}")
    if "--json" in flags:
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
