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


def queue_bullets(text):
    # Step 3 bullets: "- **`type` / ...** -> instruction", one entry per bullet.
    step = re.search(r'## Step 3.*?(?=\n## )', body(text), re.S)
    if not step:
        return None
    return [b for b in re.split(r'\n- ', step.group(0))[1:] if b.startswith('**')]


def archive_failures(text):
    # A package from a read-only agent is not owner authorization. A real
    # archive must require explicit owner authorization; only tracker-only
    # closure of already_done / info_only may proceed without asking.
    found = []
    bullets = queue_bullets(text)
    if bullets is None:
        return ['approval queue section (Step 3) not found']
    archive_bullets = []
    for bullet in bullets:
        head, _, rest = bullet.partition('**')[2].partition('**')
        flat = re.sub(r'\s+', ' ', rest)
        types = re.findall(r'`([a-z_]+)`', head)
        unasked = re.search(r'without asking|immediately|no approval', flat, re.I)
        if 'archive' in types:
            archive_bullets.append(bullet)
            if types != ['archive']:
                found.append('archive shares a queue entry with ' + ', '.join(t for t in types if t != 'archive'))
            if unasked:
                found.append('archive allowed without owner authorization: ' + unasked.group(0))
            if 'explicit owner authorization' not in flat:
                found.append('archive entry lacks explicit owner authorization')
        elif unasked and re.search(r'\barchiv', flat, re.I):
            found.append('unasked queue entry archives: ' + ', '.join(types))
    if not archive_bullets:
        found.append('no separate queue entry for archive')
    closure = [b for b in bullets if {'already_done', 'info_only'} & set(re.findall(r'`([a-z_]+)`', b.split('**')[1]))]
    if not closure:
        found.append('no tracker-only closure entry for already_done / info_only')
    for bullet in closure:
        if 'tracker-only' not in re.sub(r'\s+', ' ', bullet):
            found.append('already_done / info_only closure not limited to the tracker')
    return found


def failures(text):
    found = []
    flat = re.sub(r'\s+', ' ', body(text))
    for pattern in FORBIDDEN:
        if re.search(pattern, flat, re.I):
            found.append('direct send route or token: ' + pattern)
    for phrase in REQUIRED:
        if phrase not in flat:
            found.append('missing gate-only clause: ' + phrase)
    found.extend(archive_failures(text))
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
    # The pre-fix wording: archive bundled with closure and done without asking.
    ('archive-unasked', lambda t: re.sub(
        r'- \*\*`already_done` / `info_only`\*\*.*?(?=\n- \*\*`send_email`)',
        '- **`already_done` / `archive` / `info_only`** → report in one line, archive/close\n'
        '  immediately (tracker status → done). These are the free wins; do them without asking.',
        t, count=1, flags=re.S)),
    ('archive-no-auth', lambda t: re.sub(r'explicit\s+owner\s+authorization', 'a ranked package', t, count=1)),
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
