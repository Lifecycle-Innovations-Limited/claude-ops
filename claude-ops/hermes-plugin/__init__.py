"""Hermes native plugin for claude-ops.

Registers every skill as ``ops:<name>``. The cross-CLI installer mirrors the
same skill tree into Hermes' normal skills directory, where Hermes creates the
working ``/<name>`` slash commands itself. Do not register duplicate plugin
commands here: plugin command return values are displayed as final text, so
they shadow the real skill command and stop before the agent can run it.
"""

from __future__ import annotations

from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
SKILLS_DIR = PLUGIN_DIR.parent / "skills"
RUNTIME_MD = PLUGIN_DIR / "RUNTIME.md"


def _iter_skills():
    if not SKILLS_DIR.is_dir():
        return
    for child in sorted(SKILLS_DIR.iterdir(), key=lambda p: p.name):
        md = child / "SKILL.md"
        if child.is_dir() and md.is_file():
            yield child.name, md


def _frontmatter_field(text: str, field: str) -> str:
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    block = text[3 : end if end != -1 else 400]
    prefix = f"{field}:"
    for line in block.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip().strip('"').strip("'")
    return ""


def _description(md: Path) -> str:
    try:
        text = md.read_text(encoding="utf-8")
    except OSError:
        return md.parent.name
    desc = _frontmatter_field(text, "description")
    return desc[:200] if desc else md.parent.name


def register(ctx) -> None:
    if RUNTIME_MD.is_file():
        ctx.register_skill(
            "hermes-runtime",
            RUNTIME_MD,
            "Claude Code → Hermes primitive map for ops skills",
        )
    for name, md in _iter_skills():
        desc = _description(md)
        ctx.register_skill(name, md, desc)
