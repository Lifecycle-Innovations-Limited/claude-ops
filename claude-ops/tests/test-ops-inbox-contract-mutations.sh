#!/usr/bin/env bash
# Verify that removing safety clauses fails the real static contract checker.
# This is inert documentation mutation, not live messaging or an agent eval.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -I - "$PLUGIN_ROOT" <<'PY'
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
source = root / 'skills/ops-inbox'
checker = root / 'tests/test-ops-inbox-progressive.sh'
mutations = [
    ('depth', 'references/details.md', 'at least 20', 'at least 1'),
    ('show-tail', 'references/details.md', 'Immediately before showing a draft, the parent re-reads its live tail', 'Before showing a draft, trust the earlier scan'),
    ('send-tail', 'references/details.md', 'Recheck\nthe live thread immediately before sending', 'Trust the earlier thread snapshot before sending'),
    ('reply-all', 'references/details.md', 'exact to/cc/bcc, subject,\n  attachments and existing reply/thread identifiers', 'any available recipients and subject'),
    ('media', 'references/details.md', 'inbound AND outbound voice/media', 'inbound text'),
    ('unknown', 'SKILL.md', 'unknown is never a clean zero', 'unknown is a clean zero'),
    ('labels', 'references/details.md', 'Protect every todo/action/follow-up label', 'Remove task labels during cleanup'),
    ('blanket', 'SKILL.md', None, '\nApprove all queued drafts.\n'),
    ('unread', 'SKILL.md', None, '\nScan unread only.\n'),
    ('queue-proof', 'references/details.md', 'Each record\nkeeps its own shown-id and native approval proof', 'Records share the first available consent'),
    ('drain', 'references/details.md', 'Drain only individually approved records', 'Drain every queued record'),
    ('thread-identity', 'references/details.md', 'Different threads/intents for one recipient remain separate', 'Merge drafts by recipient only'),
    ('biometric', 'references/details.md', 'Touch ID cancelled, timed out, or refused', 'Any typed yes is enough'),
    ('changed-bytes', 'references/details.md', 'Changed bytes invalidate the old approval', 'Reuse consent after edits'),
    ('supersession', 'references/details.md', 'superseded or replaced by the service', 'still usable by default'),
    ('owned-jids', 'references/details.md', 'every verified owned JID', 'one convenient JID'),
    ('archive-failure', 'references/details.md', 'Archive failure means NOT inbox zero', 'Archive failure still means inbox zero'),
    ('cron', 'references/details.md', 'Cron/background monitors remain\nread-only', 'Cron/background monitors archive autonomously'),
    ('attachment-read', 'references/details.md', 'Read actual invoice/PDF/document\n   attachments before amount, due-date, entity or financial-status claims', 'Use the message preview for financial claims'),
    ('attachment-unknown', 'references/details.md', 'Unreadable or missing load-bearing attachments mean unknown and KEEP', 'Missing attachments mean resolved'),
    ('attachment-proof', 'references/fan-out.md', '`source_read_proof`', '`worker_opinion`'),
    ('connected-disabled', 'references/runtime.md', 'agent-disabled account is `not_checked_gap`', 'agent-disabled account is clean'),
    ('dynamic-coverage', 'references/runtime.md', 'count from the\n  complete discovery list', 'fixed two-account count'),
    ('disabled-permission', 'references/runtime.md', 'Do not read, send, archive, pair or enable that disabled account', 'Enable any disabled account to speed up the scan'),
    ('per-alias-readback', 'references/details.md', 'read back the archived flag for each phone JID and\n every LID separately', 'trust the write result for one alias'),
    ('false-readback', 'references/details.md', 'read=false or archived=false means failure', 'a false readback still means success'),
    ('shown-wait-turn', 'references/details.md', 'End the presentation turn after this\nsent=false draft', 'Show another draft immediately in this turn'),
    ('hold-user-event', 'references/details.md', 'after that draft\nreceives its own native user decision', 'after a timer fires'),
]

with tempfile.TemporaryDirectory(prefix='inbox-contract-mutations-', dir=os.environ.get('TMPDIR')) as directory:
    work = Path(directory)
    shutil.copytree(source, work / 'skills/ops-inbox')
    (work / 'skills/ops-rules').mkdir()
    shutil.copy2(root / 'skills/ops-rules/SKILL.md', work / 'skills/ops-rules/SKILL.md')
    (work / 'tests').mkdir()
    shutil.copy2(checker, work / 'tests/test-ops-inbox-progressive.sh')
    command = ['bash', str(work / 'tests/test-ops-inbox-progressive.sh')]
    baseline = subprocess.run(command, capture_output=True, text=True)
    if baseline.returncode:
        print('FAIL: mutation baseline is not green\n' + baseline.stdout)
        sys.exit(1)
    failed = 0
    for name, relative, old, new in mutations:
        path = work / 'skills/ops-inbox' / relative
        original = path.read_text()
        if old is not None and original.count(old) != 1:
            print(f'FAIL: {name}: mutation anchor must occur exactly once')
            failed += 1
            continue
        path.write_text(original + new if old is None else original.replace(old, new))
        result = subprocess.run(command, capture_output=True, text=True)
        path.write_text(original)
        caught = result.returncode == 1 and 'FAIL:' in result.stdout
        print(('PASS: ' if caught else 'FAIL: ') + name + ' mutation is rejected')
        failed += not caught
    print(f'{len(mutations) - failed} mutations caught, {failed} survived or invalid')
    sys.exit(bool(failed))
PY
