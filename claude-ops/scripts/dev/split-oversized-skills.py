#!/usr/bin/env python3
"""Move trailing H2 sections of oversized SKILL.md files into references/."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "claude-ops" / "skills"

# Cut is exclusive: this heading and everything after goes to references/details.md
CUT = {
    "ops-inbox": "## Pre-gathered data",
    "ops-marketing": "## CLI/API Reference",
    "setup": "## Step 2 — Install CLIs (if selected)",
    "ops-merge": "## CLI/API Reference",
    "ops-home": "## CLI/API Reference",
    "ops-unifi": "## CLI/API Reference",
    "ops-comms": "## CLI/API Reference",
    "ops-humanizer": "## Content patterns",
    "ops-ecom": "## CLI/API Reference",
    "ops-orchestrate": "## CLI/API Reference",
    "ops-gtm": "## Agent Teams support",
    "ops-settings": "## CLI/API Reference",
    "ops-socials": "## Routing recipes",
    "ops-dash": "## CLI/API Reference",
    "ops-yolo": "## CLI/API Reference",
}

RESOURCES = """
## Additional resources

Channel, CLI, and edge-case detail lives in `references/` next to this skill. Read those files before acting on a matching channel or sub-command. Do not skip them.
"""


def split_once(name: str, cut: str) -> None:
    md = ROOT / name / "SKILL.md"
    text = md.read_text()
    idx = text.find("\n" + cut)
    if idx == -1:
        idx = text.find(cut)
        if idx <= 0:
            print("NO CUT", name, cut)
            return
    keep = text[:idx].rstrip() + "\n"
    rest = text[idx:].lstrip("\n")
    if "Load `ops-rules`" not in keep:
        print("WARN no preamble in keep", name)
    refs = ROOT / name / "references"
    refs.mkdir(exist_ok=True)
    dest = refs / "details.md"
    header = f"# {name} — detailed reference\n\nLoaded from the parent SKILL.md. Follow `ops-rules`.\n\n"
    dest.write_text(header + rest)
    if "## Additional resources" not in keep:
        keep = keep.rstrip() + "\n" + RESOURCES
    md.write_text(keep if keep.endswith("\n") else keep + "\n")
    kw, rw = len(keep.split()), len(rest.split())
    print(f"{name:20} keep={kw:5} refs={rw:5} -> references/details.md")


def main() -> None:
    for name, cut in CUT.items():
        split_once(name, cut)


if __name__ == "__main__":
    main()
