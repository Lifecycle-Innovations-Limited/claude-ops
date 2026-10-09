#!/usr/bin/env bash
# No skill may describe a shell file, token or counter as the owner's consent to
# send. Rule 6.8: consent is the owner's native yes on the shown draft, through
# the host's approved outbound gate. Static scan of every skills/**/SKILL.md plus
# inert mutations proving each pattern is caught. Nothing is ever sent.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -I - "$PLUGIN_ROOT/skills" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])

# Consent-specific shapes only: a generic "token" (API key, auth) is not flagged.
PATTERNS = (
    r'\.claude-send-ok',
    r'\bsend[- ]?ok\b',
    r'\b(creates?|mints?|writes?)\s+(the|a|this)\s+(send\s+|approval\s+|consent\s+)?token\b',
    r'\bunless\b[^.\n]{0,80}\btoken\s+exists\b',
    r'\bone-shot\b[^.\n]{0,40}\btoken\b|\btoken\b[^.\n]{0,40}\bone-shot\b',
    r'\b(send|approval|consent)[- ]token\b',
)


def hits(text):
    flat = re.sub(r'\s+', ' ', text)
    return [p for p in PATTERNS if re.search(p, flat, re.I)]


files = sorted(root.rglob('SKILL.md'))
failed = 0
if not files:
    print('FAIL: no SKILL.md files found; the scan would gate nothing')
    sys.exit(1)
for path in files:
    found = hits(path.read_text())
    for pattern in found:
        print(f'FAIL: {path.relative_to(root)} describes token consent: {pattern}')
    failed += bool(found)
print(f'PASS: scanned {len(files)} skill files' if not failed else f'{failed} skill file(s) failed')

# Inert mutations: each historical phrasing must be rejected by the same scanner.
mutations = {
    'send-ok-file': 'Wait for ok — this creates `/tmp/.claude-send-ok`.',
    'creates-token': 'The owner creates the token by typing ok.',
    'unless-token': 'The send command blocks unless the approval token exists.',
    'one-shot': 'Token is one-shot — consumed on send.',
    'send-token': 'Remind the owner once about the send token.',
}
for name, line in mutations.items():
    caught = bool(hits('Benign text.\n' + line + '\n'))
    print(('PASS: ' if caught else 'FAIL: ') + name + ' mutation is rejected')
    failed += not caught
clean = not hits('Outbound uses only the host approved gate. An API token is configured.')
print(('PASS: ' if clean else 'FAIL: ') + 'generic credential wording is not a false positive')
failed += not clean
sys.exit(bool(failed))
PY
