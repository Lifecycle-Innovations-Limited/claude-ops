#!/usr/bin/env bash
# Contract regressions for the inbox instructions, not a live-agent simulation.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -I - "$PLUGIN_ROOT" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
skill = root / 'skills/ops-inbox'
docs = {p.name: p.read_text() for p in [skill / 'SKILL.md', *sorted((skill / 'references').glob('*.md'))]}
all_docs = '\n'.join(docs.values())
rules = (root / 'skills/ops-rules/SKILL.md').read_text()
checks = []

def check(name, condition):
    checks.append((name, bool(condition)))

# Pressure: one fully researched candidate is ready; another source is slow.
frontmatter = docs['SKILL.md'].split('---', 2)[1]
check('parent retains the draft queue', re.search(r'^context:\s*fork\s*$', frontmatter, re.M) is None)
check('ready reply is surfaced without a whole-inbox barrier',
      'first validated draft immediately' in docs['SKILL.md'].lower())
check('context is complete per candidate, not after every scan finishes',
      'per candidate' in docs['details.md'].lower() and 'all configured' in docs['details.md'].lower())
check('one request has one research owner', 'existing owner' in docs['runtime.md'].lower())
check('read-only workers report ready packets progressively',
      'evidence packet' in docs['fan-out.md'].lower() and 'as soon as' in docs['fan-out.md'].lower())
check('worker idle without evidence is not completion',
      'idle without a report is not completion' in docs['fan-out.md'].lower())
check('no aggregate Workflow barrier', 'await parallel(' not in docs['fan-out.md'])

# Pressure: faster scan tempts unread-only, inbox-only, and single-account shortcuts.
for term in ('every mailbox', 'every agent-enabled whatsapp account', 'every slack workspace',
             'public_channel', 'private_channel', 'im,mpim', 'all mail', 'unknown'):
    check('coverage includes ' + term, term in all_docs.lower())
check('full thread and authoritative aliases remain required',
      'both directions' in docs['details.md'].lower() and 'authoritative' in docs['details.md'].lower())
check('bounded lookback is disclosed, never total coverage',
      'lookback' in all_docs.lower() and 'not checked' in all_docs.lower())

# Pressure: latest full draft has a shown-id and a genuine current-session yes.
for field in ('sessionUUID', 'recipient_tz', 'lang', 'reply-all', 'shown-id', 'native user proof'):
    check('send preflight includes ' + field, field in docs['details.md'])
for field in ('session_id', 'draft_id', 'sent=false', 'sending number', 'Do not pass a yes-word'):
    check('gate return contract includes ' + field, field in docs['details.md'])
check('no repeated consent for unchanged approved bytes',
      'do not ask twice' in docs['details.md'].lower())
check('go is not approval', 'Go is not approval' in all_docs and '`go`' not in rules.split('## Rule 6')[1].split('## Rule 7')[0])
check('failure retains ownership and concrete diagnostics',
      'diagnostic' in docs['details.md'].lower() and 'keeps ownership' in docs['details.md'].lower())
check('send verification precedes optional authorized archive',
      'explicit archive authorization' in docs['details.md'].lower())

# Executable routes from the old references must not compete with the gate.
for pattern in (r'gog gmail send', r'mcp__whatsapp[^\s`]*__send_message',
                r'curl[^\n]*-X POST[^\n]*api/send', r'! ok all',
                r'DELETE FROM whatsmeow', r'launchctl kickstart', r'wa-mac-',
                r'Paperclip', r'30.second.*heartbeat', r'conversations_unreads \{'):
    # Frontmatter tool declarations are not runtime instructions or permission edits.
    body = '\n'.join(text.split('---', 2)[-1] if name == 'SKILL.md' else text
                     for name, text in docs.items())
    check('no conflicting route: ' + pattern, re.search(pattern, body, re.I) is None)
check('no continuation or channel menu after invocation',
      'no continuation menu' in docs['SKILL.md'].lower())
check('no automatic monitor creation', 'do not create a watcher' in docs['runtime.md'].lower())

for name, passed in checks:
    print(('PASS: ' if passed else 'FAIL: ') + name)
failed = sum(not passed for _, passed in checks)
print(f'{len(checks) - failed} passed, {failed} failed')
sys.exit(bool(failed))
PY
