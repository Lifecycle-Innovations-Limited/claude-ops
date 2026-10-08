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
for term in ('every mailbox', 'every connected whatsapp account', 'every slack workspace',
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

# Review regressions: check complete normative clauses in their owning section,
# not scattered keywords or scenario-table echoes elsewhere in the documents.
def section(text, heading):
    match = re.search(r'^## ' + re.escape(heading) + r'\n(.*?)(?=^## |\Z)', text, re.M | re.S)
    return re.sub(r'\s+', ' ', match[1]).replace('**', '') if match else ''

context = section(docs['details.md'], 'Full context per candidate')
preflight = section(docs['details.md'], 'Exact first-call preflight')
approval = section(docs['details.md'], 'One draft, one yes, one send')
queue = section(docs['details.md'], 'Collect individual approvals, then drain')
archive = section(docs['details.md'], 'Verify, archive, then complete')
check('read complete chain or at least 20 unique messages',
      'full email chain or at least 20 unique recent messages plus older context' in context)
check('load-bearing inbound and outbound voice/media are both read',
      'Read load-bearing inbound AND outbound voice/media content' in context)
check('fresh live-tail check exists immediately before presentation',
      'Immediately before showing a draft, the parent re-reads its live tail' in preflight)
check('fresh live-tail check exists immediately before send',
      'Recheck the live thread immediately before sending' in approval)
check('canonical reply-all preserves exact recipients and attachments',
      'Email reply-all on the actual canonical chain: exact to/cc/bcc, subject, attachments and existing reply/thread identifiers' in preflight)
check('unknown is never a clean zero', 'unknown is never a clean zero' in docs['SKILL.md'])
check('protected task labels require actually handled outcome',
      'Protect every todo/action/follow-up label until the task is actually handled' in archive)
for pattern in (r'(?<!never )(?<!no )approve all queued', r'(?<!never )(?<!no )unread only',
                r'mcp__gog__gmail_send', r'mcp__plugin_imessage_imessage__reply',
                r'wacli\s+send', r'api\.resend\.com/emails'):
    check('no unsafe body directive: ' + pattern, re.search(pattern, body, re.I) is None)
for phrase in ('Each record keeps its own shown-id and native approval proof',
               'Drain only individually approved records',
               'Different threads/intents for one recipient remain separate',
               'assistant-preview-only is not Telegram-delivered proof',
               'Touch ID cancelled, timed out, or refused',
               'user retries the approval word and sensor',
               'Changed bytes invalidate the old approval',
               'superseded or replaced by the service'):
    check('approval queue contract: ' + phrase, phrase in queue)
for phrase in ('answered/resolved → verify → archive', 'explicit archive authorization',
               'every verified owned JID', 'correct account',
               'Cron/background monitors remain read-only',
               'Archive failure means NOT inbox zero',
               'Archived threads remain in future reply-debt scans',
               'Mark-read is separate, never implicit'):
    check('archive completion contract: ' + phrase, phrase in archive)
rule6 = rules.split('## Rule 6')[1].split('## Rule 7')[0]
check('Rule 6 permits only individually approved queue drain',
      'individually approved records' in rule6 and 'Never stack' not in rule6 and 'never batch' not in rule6)
check('Rule 6 does not describe a shell token as consent', '.claude-send-ok' not in rule6)
for tool in ('mcp__gog__gmail_send', 'mcp__whatsapp__send_message',
             'mcp__plugin_imessage_imessage__reply', 'CronCreate'):
    check('frontmatter does not preauthorize ' + tool,
          re.search(r'^\s+-\s+' + re.escape(tool) + r'\s*$', frontmatter, re.M) is None)

# Public docs name the gate generically; a host-specific tool name is not a contract.
for name, text in (('SKILL.md', docs['SKILL.md']), ('cli.md', docs['cli.md']),
                   ('details.md', docs['details.md']), ('ops-rules', rules)):
    check("generic outbound gate wording in " + name,
          "host's approved outbound gate" in re.sub(r'\s+', ' ', text))
check('gate send return is not tied to a host tool name',
      'When the gate returns `sent=false`' in preflight)

# Required review fields live in normative sections, not scenario-table echoes.
packet = section(docs['fan-out.md'], 'Minimum evidence packet')
runtime_accounts = section(docs['runtime.md'], 'Enumerate once')
cli_archive = section(docs['cli.md'], 'Authorized archive verification')
check('actual attachments precede financial claims',
      'Read actual invoice/PDF/document attachments before amount, due-date, entity or financial-status claims' in context)
check('unreadable documents keep the obligation unknown and visible',
      'Unreadable or missing load-bearing attachments mean unknown and KEEP' in context)
for field in ('attachments_read', 'amount', 'currency', 'due_date', 'entity', 'financial_status', 'source_read_proof'):
    check('financial evidence packet requires ' + field, '`' + field + '`' in packet)
check('coverage includes every connected account, including disabled gaps',
      'every connected WhatsApp account' in runtime_accounts and
      'connected but agent-disabled' in runtime_accounts and 'not_checked_gap' in runtime_accounts)
check('coverage cardinality follows discovery rather than a fixed number',
      'one coverage record per discovered account' in runtime_accounts and
      'count from the complete discovery list' in runtime_accounts)
check('disabled account scope is not expanded to obtain coverage',
      'Do not read, send, archive, pair or enable that disabled account' in runtime_accounts)
check('archive readback covers each authoritative alias separately',
      'read back the archived flag for each phone JID and every LID separately' in archive)
check('false readback cannot be accepted as successful archive',
      'read=false or archived=false means failure' in archive and 'keep the failing item owned' in archive)
check('archive proof names read surface and limits of its plane',
      '`get_chat`' in cli_archive and 'bridge metadata alone is not phone/browser proof' in cli_archive)
check('sent=false ends presentation until a native user event',
      'End the presentation turn after this sent=false draft' in preflight and
      'Only after the next native user event' in preflight)
check('technical hold does not present another draft in the same turn',
      'never show a second draft in the sent=false turn' in queue and
      'after that draft receives its own native user decision' in queue)

for name, passed in checks:
    print(('PASS: ' if passed else 'FAIL: ') + name)
failed = sum(not passed for _, passed in checks)
print(f'{len(checks) - failed} passed, {failed} failed')
sys.exit(bool(failed))
PY
