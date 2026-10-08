#!/usr/bin/env bash
# ops-desk must send only through the host's approved outbound gate, like
# ops-inbox and ops-rules Rule 6. Static instruction contract plus inert
# mutations of a temporary copy; no message is ever sent.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -I - "$PLUGIN_ROOT/skills/ops-desk/SKILL.md" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text()

# Direct send routes and out-of-band consent tokens that compete with the gate.
FORBIDDEN = (
    r'gog\s+gmail\s+send',
    r'mcp__[a-z0-9_-]*__send_message',
    r'mcp__plugin_imessage_imessage__reply',
    r'via\s+the\s+bridge',
    r'api/send',
    r'send[ -]token',
    r'\.claude-send-ok',
    r'!\s*ok\b',
)
REQUIRED = (
    "only through the host's approved outbound gate",
    'one draft, one approval, one send',
    'never a token, counter or',
    'never use a direct CLI, bridge or API sender',
)


def body(text):
    # Frontmatter tool declarations are not runtime instructions.
    return text.split('---', 2)[-1] if text.startswith('---') else text


def failures(text):
    found = []
    flat = re.sub(r'\s+', ' ', body(text))
    for pattern in FORBIDDEN:
        if re.search(pattern, flat, re.I):
            found.append('direct send route or token: ' + pattern)
    for phrase in REQUIRED:
        if phrase not in flat:
            found.append('missing gate-only clause: ' + phrase)
    # Frontmatter must not preauthorize a direct sender either.
    front = text.split('---', 2)[1] if text.startswith('---') else ''
    for tool in re.findall(r'^\s*-\s*(\S+)\s*$', front, re.M):
        if re.search(r'__send_|gmail_send|imessage__reply', tool):
            found.append('frontmatter preauthorizes direct sender: ' + tool)
    return found


checks = 0
failed = 0
baseline = failures(source)
for item in baseline:
    print('FAIL: ' + item)
failed += bool(baseline)
checks += 1
if not baseline:
    print('PASS: ops-desk sends only through the approved outbound gate')

# Each mutation reintroduces one historical defect; the checker must reject it.
mutations = [
    ('gmail-cli', lambda t: t + '\nAfter [Send]: send email via gog gmail send.\n'),
    ('bridge', lambda t: t + '\nWhatsApp sends go via the bridge.\n'),
    ('send-token', lambda t: t + '\nRemind the owner once about the send token.\n'),
    ('mcp-send', lambda t: t + '\nUse mcp__whatsapp__send_message directly.\n'),
    ('frontmatter-send', lambda t: t.replace('  - mcp__whatsapp__archive_chat\n', '  - mcp__whatsapp__send_message\n  - mcp__whatsapp__archive_chat\n', 1)),
    ('drop-gate',lambda t: re.sub(r"only through the host's\s+approved outbound gate", 'through any sender', t)),
]
for name, mutate in mutations:
    checks += 1
    mutated = mutate(source)
    if mutated == source:
        print(f'FAIL: {name}: mutation anchor not found')
        failed += 1
    elif failures(mutated):
        print(f'PASS: {name} mutation is rejected')
    else:
        print(f'FAIL: {name} mutation survived')
        failed += 1

print(f'{checks - failed} passed, {failed} failed')
sys.exit(bool(failed))
PY
