"""Hermes native plugin for claude-ops.

Registers every skill as ``ops:<name>`` and a slash command ``/<name>``.
Skills stay in the sibling ``skills/`` tree (the Claude Code plugin). This
package does not import Hermes internals.
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


def _handler(name: str):
    def handle(raw_args: str = "") -> str:
        args = (raw_args or "").strip()
        return (
            f"Run the claude-ops skill `{name}` now.\n"
            f"Load it with skill_view(\"ops:{name}\") if that tool exists; "
            f"otherwise open `{SKILLS_DIR / name / 'SKILL.md'}`.\n"
            f"Arguments: {args or '(none)'}\n\n"
            "This session is Hermes, not Claude Code. Use the degrade table in "
            "ops:hermes-runtime (AskUserQuestion → numbered options / two-turn "
            "Telegram card; Workflow → delegate_task; never gh --admin). "
            "Rule 6 still applies: one draft, one approval, one send."
        )

    handle.__name__ = f"ops_cmd_{name.replace('-', '_')}"
    return handle


def _handle_ops(raw_args: str = "") -> str:
    token = (raw_args or "").strip().split(None, 1)
    names = [name for name, _ in _iter_skills()]
    if token:
        want = token[0].lstrip("/").replace("_", "-")
        rest = token[1] if len(token) > 1 else ""
        if want in names:
            return _handler(want)(rest)
        aliased = want if want.startswith("ops-") else f"ops-{want}"
        if aliased in names:
            return _handler(aliased)(rest)
    listed = ", ".join(f"/{n}" for n in names[:12])
    more = f" (+{len(names) - 12} more)" if len(names) > 12 else ""
    return (
        "claude-ops on Hermes. Enable this plugin in plugins.enabled, then "
        f"use a slash command.\nExamples: {listed}{more}\n"
        "Or: /ops inbox   /ops go   /ops fires\n"
        'Skills also load as skill_view("ops:<name>").'
    )


def register(ctx) -> None:
    if RUNTIME_MD.is_file():
        ctx.register_skill(
            "hermes-runtime",
            RUNTIME_MD,
            "Claude Code → Hermes primitive map for ops skills",
        )
    ctx.register_command(
        "ops",
        handler=_handle_ops,
        description="claude-ops router (inbox, go, fires, …)",
        args_hint="[skill] [args]",
    )
    for name, md in _iter_skills():
        desc = _description(md)
        ctx.register_skill(name, md, desc)
        ctx.register_command(
            name,
            handler=_handler(name),
            description=desc,
            args_hint="[args]",
        )
