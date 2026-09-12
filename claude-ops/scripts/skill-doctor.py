#!/usr/bin/env python3
"""Validate every SKILL.md Claude Code can reach on this machine.

Stand-in for the built-in /skill-doctor, which is not registered in every build.

Checks per skill:
  - frontmatter parses, and has name + description
  - name is lowercase-hyphen, <= 64 chars, and matches its directory
  - description is present and <= 1024 chars
  - no `model:` pin (standing rule: never pin a model)
  - relative references (scripts/, bin/, references/, assets/, templates/, tools/)
    resolve against the skill dir or its plugin root

Usage:
    scripts/skill-doctor.py            # all reachable skills
    scripts/skill-doctor.py --mine     # only Sam-owned trees (~/.claude/skills + claude-ops)
    scripts/skill-doctor.py --json
"""
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".archive"}
# Paths that are documentation fixtures or vendored bundles, not loadable skills.
SKIP_PATH_MARKERS = ("/tests/fixtures/", "/.archive/")

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REF_RE = re.compile(
    r"(?:^|[\s`\"'(\[])((?:\./)?(?:scripts|bin|references|assets|templates|tools)/[A-Za-z0-9_./-]+)"
)
# A reference the document itself says is absent by design.
EXPECTED_ABSENT = re.compile(r"gitignored|not checked in|generated at runtime|created on first run", re.I)


def roots():
    out = [("user", os.path.join(HOME, ".claude", "skills"))]
    mp = os.path.join(HOME, ".claude", "plugins", "marketplaces")
    if os.path.isdir(mp):
        for m in sorted(os.listdir(mp)):
            out.append(("plugin:" + m, os.path.join(mp, m)))
    return out


def find_skills(root, maxdepth=8):
    found = []
    base_depth = root.rstrip("/").count("/")
    for dirpath, dirnames, filenames in os.walk(root):
        if dirpath.count("/") - base_depth > maxdepth:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if "SKILL.md" in filenames:
            found.append(os.path.join(dirpath, "SKILL.md"))
    return found


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_frontmatter(text):
    """Minimal YAML front-matter reader: top-level scalars plus folded continuations."""
    if not text.startswith("---"):
        return None, "no frontmatter block"
    end = text.find("\n---", 3)
    if end == -1:
        return None, "unterminated frontmatter"
    fm, key = {}, None
    for line in text[3:end].splitlines():
        if not line.strip():
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            fm[key] = m.group(2).strip()
        elif key and line[:1] in (" ", "\t"):
            fm[key] = (fm[key] + " " + line.strip()).strip()
    return fm, None


def plugin_bases(skill_dir):
    """Directories a relative reference may resolve against: skill dir up to plugin root."""
    out, cur = [skill_dir], skill_dir
    for _ in range(6):
        cur = os.path.dirname(cur)
        if not cur or cur == "/":
            break
        out.append(cur)
        if os.path.exists(os.path.join(cur, ".claude-plugin")) or os.path.exists(
            os.path.join(cur, "plugin.json")
        ):
            break
    return out


def check(path):
    out = []
    skill_dir = os.path.dirname(path)
    dirname = os.path.basename(skill_dir)

    def add(kind, detail):
        out.append({"kind": kind, "path": path, "detail": detail})

    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        add("READ", str(e))
        return out

    fm, err = parse_frontmatter(text)
    if err:
        add("FRONTMATTER", err)
        return out

    name = unquote(fm.get("name", "")) or None
    desc = unquote(fm.get("description", "")) or None

    if not name:
        add("NAME_MISSING", "no name: in frontmatter")
    else:
        if not NAME_RE.match(name):
            add("NAME_FORMAT", f"name={name!r} is not lowercase-hyphen")
        if name != dirname:
            add("NAME_MISMATCH", f"name={name!r} but directory is {dirname!r}")
        if len(name) > 64:
            add("NAME_LONG", f"{len(name)} chars > 64")

    if not desc:
        add("DESC_MISSING", "no description: in frontmatter")
    elif len(desc) > 1024:
        add("DESC_LONG", f"{len(desc)} chars > 1024")

    if fm.get("model"):
        add("MODEL_PIN", f"model={unquote(fm['model'])!r} — never pin a model")

    bases = plugin_bases(skill_dir)
    for line in text.splitlines():
        if EXPECTED_ABSENT.search(line):
            continue
        for m in REF_RE.finditer(line):
            ref = m.group(1).lstrip("./").rstrip(".,);:`\"'")
            if not ref or ref.endswith("/") or "*" in ref or "<" in ref:
                continue
            if any(os.path.exists(os.path.join(b, ref)) for b in bases):
                continue
            add("DEAD_REF", ref)
    return out


def is_mine(path):
    return path.startswith(os.path.join(HOME, ".claude", "skills")) or "/claude-ops/" in path


def main():
    mine_only = "--mine" in sys.argv
    as_json = "--json" in sys.argv

    findings, scanned, seen = [], 0, set()
    for _, root in roots():
        if not os.path.isdir(root):
            continue
        for path in find_skills(root):
            if path in seen or any(mark in path for mark in SKIP_PATH_MARKERS):
                continue
            seen.add(path)
            if mine_only and not is_mine(path):
                continue
            scanned += 1
            findings.extend(check(path))

    if as_json:
        print(json.dumps({"scanned": scanned, "findings": findings}, indent=2))
        return 1 if findings else 0

    print(f"scanned {scanned} SKILL.md file(s)")
    by_kind = {}
    for f in findings:
        by_kind.setdefault(f["kind"], []).append(f)
    for kind in sorted(by_kind, key=lambda k: -len(by_kind[k])):
        print(f"\n== {kind} ({len(by_kind[kind])}) ==")
        for f in by_kind[kind]:
            print(f"  {f['path'].replace(HOME, '~')}\n      {f['detail']}")
    if not findings:
        print("\nclean")
    else:
        print(f"\nTOTAL FINDINGS: {len(findings)}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
