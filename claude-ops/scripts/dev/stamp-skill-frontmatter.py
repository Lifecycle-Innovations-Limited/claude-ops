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
    "humanizer": (
        '"humanize this", "this reads like ChatGPT", or "make it sound human"'
    ),
    "setup": ('"/ops:setup", "configure ops", or "connect WhatsApp/email"'),
    "boss": ('"/ops:boss", "boss mode", or "what needs me"'),
    "ops-rules": (
        '"ops rules", "plugin rules", "Rule 6", "send gate", or "harness fallbacks"'
    ),
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
