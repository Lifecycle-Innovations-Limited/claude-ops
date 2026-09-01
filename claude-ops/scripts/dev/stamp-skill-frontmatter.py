#!/usr/bin/env python3
"""Stamp official frontmatter + shared preamble onto every ops SKILL.md."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "claude-ops" / "skills"

DISABLE = {
    "uninstall",
    "ops-release",
    "ops-ship",
    "ops-rotate-setup",
    "ops-yolo",
}
FORK = {
    "ops-inbox",
    "ops-marketing",
    "setup",
    "ops-merge",
    "ops-home",
    "ops-unifi",
    "ops-comms",
    "ops-ecom",
    "ops-orchestrate",
    "ops-gtm",
    "ops-yolo",
}
HINTS = {
    "ledger": "''",
    "people": "''",
    "tonight": "''",
    "ops-deploy-fix": "'[status|tail|configure|test]'",
}
TRIGGERS = {
    "ops-inbox": (
        '"check inbox", "inbox zero", "/ops:ops-inbox", or "what needs a reply"'
    ),
    "ops-go": ('"morning briefing", "/ops:ops-go", or "what should I do today"'),
    "ops-status": ('"ops status", "/ops:ops-status", or "are integrations green"'),
    "ops-humanizer": (
        '"humanize this", "this reads like ChatGPT", or "make it sound human"'
    ),
    "setup": ('"/ops:setup", "configure ops", or "connect WhatsApp/email"'),
    "boss": ('"/ops:boss", "boss mode", or "what needs me"'),
    "ops-rules": (
        '"ops rules", "plugin rules", "Rule 6", "send gate", or "harness fallbacks"'
    ),
    "flow": '"/ops:flow", "dev lifecycle", or "where am I in the pipeline"',
    "ledger": '"ops ledger", "what did we handle", or "/ops:ledger"',
    "ops": '"ops command center", "/ops:ops", or "run the business"',
    "ops-accounts": '"rotate accounts", "switch Claude/Grok/Codex", or "/ops:accounts"',
    "ops-ar": '"A&R this track", "demo verdict", or "/ops:ops-ar"',
    "ops-aws-audit": '"audit AWS", "unused AWS resources", or "/ops:ops-aws-audit"',
    "ops-comms": '"send a message", "whatsapp/email/slack", or "/ops:ops-comms"',
    "ops-competitors": '"competitor intel", "what did they ship", or "/ops:ops-competitors"',
    "ops-credentials": '"which keys are set", "missing credentials", or "/ops:ops-credentials"',
    "ops-daemon": '"daemon health", "background services stuck", or "/ops:ops-daemon"',
    "ops-dash": '"ops dashboard", "pixel HQ", or "/ops:ops-dash"',
    "ops-deploy": '"deploy status", "what is in production", or "/ops:ops-deploy"',
    "ops-deploy-fix": '"deploy auto-fix", "failed deploy", or "/ops:ops-deploy-fix"',
    "ops-desk": '"desk sweep", "open decisions", or "/ops:ops-desk"',
    "ops-desktop": '"control the desktop", "click on screen", or "/ops:ops-desktop"',
    "ops-doctor": '"plugin broken", "ops doctor", or "/ops:ops-doctor"',
    "ops-ecom": '"shopify", "orders inventory", or "/ops:ops-ecom"',
    "ops-feature-dev": '"guided feature", "feature-dev", or "/ops:ops-feature-dev"',
    "ops-fires": '"production fires", "what is on fire", or "/ops:ops-fires"',
    "ops-fleet": '"fleet dashboard", "CLIProxy sessions", or "/ops:ops-fleet"',
    "ops-gtm": '"go to market", "GTM plan", or "/ops:ops-gtm"',
    "ops-home": '"homey", "smart home", or "/ops:ops-home"',
    "ops-integrate": '"add an API", "integrate SaaS", or "/ops:ops-integrate"',
    "ops-leadgen": '"leadgen drafts", "cold email approve", or "/ops:ops-leadgen"',
    "ops-linear": '"linear sprint", "create a ticket", or "/ops:ops-linear"',
    "ops-mac": '"mac is slow", "macos fix", or "/ops:ops-mac"',
    "ops-marketing": '"klaviyo", "ads spend", or "/ops:ops-marketing"',
    "ops-mcp": '"MCP down", "reconnect MCP", or "/ops:ops-mcp"',
    "ops-merge": '"merge PRs", "salvage branches", or "/ops:ops-merge"',
    "ops-monitor": '"datadog", "APM alerts", or "/ops:ops-monitor"',
    "ops-next": '"what should I do next", "priority stack", or "/ops:ops-next"',
    "ops-orchestrate": '"orchestrate projects", "dispatch agents", or "/ops:ops-orchestrate"',
    "ops-package": '"ship a parcel", "print a label", or "/ops:ops-package"',
    "ops-pocket": '"pocket memos", "voice memo pipeline", or "/ops:ops-pocket"',
    "ops-projects": '"portfolio dashboard", "gsd projects", or "/ops:ops-projects"',
    "ops-recap": '"recap daemon", "tmux marquee", or "/ops:ops-recap"',
    "ops-release": '"release the plugin", "publish ops version", or "/ops:ops-release"',
    "ops-resume": '"resume sessions", "reopen ghostty tabs", or "/ops:ops-resume"',
    "ops-revenue": '"burn rate", "runway", or "/ops:ops-revenue"',
    "ops-rotate": '"rotate Claude", "max seats", or "/ops:ops-rotate"',
    "ops-rotate-setup": '"rotate setup", "enroll Claude seat", or "/ops:ops-rotate-setup"',
    "ops-secret-sync": '"doppler github secrets", "secret drift", or "/ops:ops-secret-sync"',
    "ops-settings": '"update credentials", "ops settings", or "/ops:ops-settings"',
    "ops-ship": '"ship ops plugin", "merge all PRs and release", or "/ops:ops-ship"',
    "ops-social-planner": '"content calendar", "what is scheduled", or "/ops:ops-social-planner"',
    "ops-socials": '"tweet", "post to linkedin", or "/ops:ops-socials"',
    "ops-speedup": '"speed up this mac", "clean disk", or "/ops:ops-speedup"',
    "ops-statusline": '"statusline theme", "cockpit", or "/ops:ops-statusline"',
    "ops-triage": '"sentry issues", "triage github", or "/ops:ops-triage"',
    "ops-unifi": '"unifi", "cameras", or "/ops:ops-unifi"',
    "ops-update": '"update ops plugin", "upgrade claude-ops", or "/ops:ops-update"',
    "ops-voice": '"make a call", "facetime", or "/ops:ops-voice"',
    "ops-whatsapp-biz": '"whatsapp business", "template message", or "/ops:ops-whatsapp-biz"',
    "ops-yolo": '"yolo mode", "run the business today", or "/ops:ops-yolo"',
    "people": '"sync contacts", "people database", or "/ops:people"',
    "tonight": '"tomorrow brief", "evening wrap", or "/ops:tonight"',
    "uninstall": '"uninstall ops", "remove claude-ops", or "/ops:uninstall"',
}

PREAMBLE = (
    "Load `ops-rules` before acting. Public repo (no personal data). "
    "Outbound: one draft → one approval → one send. If `AskUserQuestion` / "
    "`Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered "
    "options / two-turn Telegram card; `delegate_task`)."
)


def split_fm(text: str) -> tuple[str, str]:
    if not text.startswith("---"):
        raise ValueError("missing frontmatter")
    end = text.find("\n---", 3)
    if end == -1:
        raise ValueError("unterminated frontmatter")
    fm = text[4:end]  # after first ---\n
    if text[3] == "\n":
        fm = text[4:end]
    else:
        fm = text[3:end].lstrip("\n")
    body = text[end + 4 :].lstrip("\n")
    return fm, body


def field(fm: str, name: str) -> str | None:
    m = re.search(rf"^{re.escape(name)}:\s*(.*)$", fm, re.M)
    if not m:
        return None
    val = m.group(1).strip()
    if val in ("", "|", ">"):
        return val
    return val.strip("\"'")


def yaml_str(s: str) -> str:
    if ":" in s or s.startswith("{") or '"' in s:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def rewrite_description(name: str, old: str) -> str:
    old = (old or "").strip()
    if old.lower().startswith("this skill should be used"):
        return old
    trig = TRIGGERS.get(name)
    if not trig:
        trig = f'"/ops:{name}", "run {name}", or "use {name}"'
    rest = old
    # drop leading "Use when" / "Use this skill when"
    rest = re.sub(r"^(Use this skill when|Use when)\s+", "", rest, flags=re.I)
    return f"This skill should be used when the user asks to {trig}. {rest}".strip()


def ensure_scalar(fm: str, key: str, value: str) -> str:
    if re.search(rf"^{re.escape(key)}:", fm, re.M):
        return fm
    # insert before allowed-tools if present, else at end
    m = re.search(r"^allowed-tools:", fm, re.M)
    line = f"{key}: {value}\n"
    if m:
        return fm[: m.start()] + line + fm[m.start() :]
    return fm.rstrip() + "\n" + line


def set_scalar(fm: str, key: str, value: str) -> str:
    if re.search(rf"^{re.escape(key)}:", fm, re.M):
        return re.sub(
            rf"^{re.escape(key)}:.*$",
            f"{key}: {value}",
            fm,
            count=1,
            flags=re.M,
        )
    return ensure_scalar(fm, key, value)


def add_flag(fm: str, key: str, value: str) -> str:
    if re.search(rf"^{re.escape(key)}:", fm, re.M):
        return fm
    return fm.rstrip() + f"\n{key}: {value}\n"


def stamp_body(name: str, body: str) -> str:
    if name == "ops-rules":
        return body
    if "Load `ops-rules` before acting" in body:
        return body
    lines = body.splitlines()
    # insert after first heading
    out = []
    inserted = False
    for i, line in enumerate(lines):
        out.append(line)
        if not inserted and line.startswith("# "):
            # skip blank then insert
            out.append("")
            out.append(PREAMBLE)
            inserted = True
    if not inserted:
        out = [PREAMBLE, ""] + out
    text = "\n".join(out)
    if not text.endswith("\n"):
        text += "\n"
    return text


def process(path: Path) -> bool:
    name = path.parent.name
    text = path.read_text()
    fm, body = split_fm(text)
    old_desc = field(fm, "description") or ""
    new_desc = rewrite_description(name, old_desc)
    fm = set_scalar(fm, "description", yaml_str(new_desc))
    if field(fm, "argument-hint") is None:
        hint = HINTS.get(name, "''")
        fm = ensure_scalar(fm, "argument-hint", hint)
    if name in DISABLE:
        fm = add_flag(fm, "disable-model-invocation", "true")
    if name in FORK:
        fm = add_flag(fm, "context", "fork")
    if not fm.endswith("\n"):
        fm += "\n"
    new_body = stamp_body(name, body)
    new = f"---\n{fm}---\n\n{new_body}"
    if not new.endswith("\n"):
        new += "\n"
    if new != text:
        path.write_text(new)
        return True
    return False


def main() -> None:
    changed = 0
    for skill in sorted(ROOT.iterdir()):
        md = skill / "SKILL.md"
        if not md.is_file():
            continue
        if process(md):
            changed += 1
            print("updated", skill.name)
        else:
            print("ok     ", skill.name)
    print(f"changed {changed}")


if __name__ == "__main__":
    main()
