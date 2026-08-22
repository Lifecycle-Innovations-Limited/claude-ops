#!/usr/bin/env python3
"""
Block outbound communications unless the user has explicitly authorized this call.

Fires on PreToolUse. Blocks Bash commands that send email/SMS/voice/chat and
blocks the equivalent MCP tools directly.

Escape hatch: user must create a single-use token from OUTSIDE the model
(e.g. `! touch /tmp/.claude-send-ok` in the Claude Code prompt, which runs
in the user's shell, not a Bash tool call). Token is consumed on use and
expires after 120 seconds.

--dangerously-skip-permissions does NOT bypass this hook.
"""
import base64
import json
import os
import re
import sys
import time

TOKEN_FILE = "/tmp/.claude-send-ok"
# Counter for `ok N` / `ok all`. Its own file and expiry, separate from the
# single-use token above and from the MCP proxy's counter.
COUNT_FILE = "/tmp/.claude-send-ok-count"
COUNT_TTL_SEC = 900
TOKEN_TTL_SEC = 120
AUDIT_LOG = "/tmp/claude-outbound-audit.log"

# Self-channel config — sends where the recipient is the user themselves are
# operational notifications, not outbound comms. Loaded from local state files
# (never committed). Missing config → empty allowlist → strict block.
_HOME = os.path.expanduser("~")
EMAIL_CONFIG_PATH = os.path.join(_HOME, ".claude/state/pocket/email-config.json")
WHATSAPP_CONFIG_PATH = os.path.join(_HOME, ".claude/state/pocket/whatsapp-config.json")
IMESSAGE_CONFIG_PATH = os.path.join(_HOME, ".claude/state/pocket/imessage-config.json")
TELEGRAM_CONFIG_PATH = os.path.join(_HOME, ".claude/state/pocket/telegram-config.json")

# Persistent prior-approval allowlist (Sam's directive 2026-06-18): EMAIL sends
# whose every to/cc/bcc recipient is on this list are sends Sam has ALREADY
# approved (e.g. an approved cancellation batch). They skip the per-send token
# gate entirely — no more slow one-token-per-message minting for work Sam has
# signed off on. Any email with even ONE recipient NOT on the list still hits
# the standard token gate. Scope is EMAIL ONLY; Slack/WhatsApp/SMS/voice keep
# the strict per-send token. Edit the JSON to grant/revoke; deleting an address
# re-arms the gate for it. Loaded once at hook-load time.
OUTBOUND_APPROVALS_PATH = os.path.join(
    _HOME, ".claude/state/outbound-approvals.json")


def _load_self_emails() -> set:
    """Return set of email addresses considered 'self' (lowercased)."""
    out = set()
    try:
        with open(EMAIL_CONFIG_PATH) as f:
            cfg = json.load(f)
        for key in ("self_address", "from_account"):
            v = (cfg.get(key) or "").strip().lower()
            if v:
                out.add(v)
    except (OSError, json.JSONDecodeError):
        pass
    return out


def _load_self_jids() -> set:
    """Return set of WhatsApp JIDs considered 'self'."""
    out = set()
    try:
        with open(WHATSAPP_CONFIG_PATH) as f:
            cfg = json.load(f)
        v = (cfg.get("chat_jid") or "").strip()
        if v:
            out.add(v)
    except (OSError, json.JSONDecodeError):
        pass
    return out


def _normalize_handle(s: str) -> str:
    """Normalize iMessage handles for comparison — lowercase, strip whitespace,
    strip leading 'E:' / 'p:' service prefixes used in chat.db.account."""
    s = (s or "").strip().lower()
    if len(s) >= 2 and s[1] == ":" and s[0] in ("e", "p"):
        s = s[2:]
    return s


def _load_self_imessage_handles() -> set:
    """Return set of iMessage handles (phone numbers / Apple-ID emails)
    considered 'self'. Loaded from imessage-config.json."""
    out = set()
    try:
        with open(IMESSAGE_CONFIG_PATH) as f:
            cfg = json.load(f)
        for h in cfg.get("self_handles") or []:
            if isinstance(h, str) and h.strip():
                out.add(_normalize_handle(h))
    except (OSError, json.JSONDecodeError):
        pass
    return out


def _load_self_telegram_owners() -> set:
    """Return set of Telegram chat_ids considered 'self' (Sam's own owner chat).
    Sends to these are operational self-notifications (status pings to Sam),
    exempt from the token gate per Sam's directive 2026-05-27. Sends to ANY
    other chat_id stay blocked."""
    out = set()
    try:
        with open(TELEGRAM_CONFIG_PATH) as f:
            cfg = json.load(f)
        for v in cfg.get("self_owner_ids") or []:
            s = str(v).strip()
            if s:
                out.add(s)
    except (OSError, json.JSONDecodeError):
        pass
    return out


def _load_approved_recipients() -> set:
    """Return the set of email addresses Sam has pre-approved as outbound
    recipients (lowercased). Loaded from outbound-approvals.json shaped as
    {"approved_recipients": ["addr@x.com", ...]}. Missing/empty/malformed file
    → empty set → nothing is auto-approved (strict default; gate stays armed)."""
    out = set()
    try:
        with open(OUTBOUND_APPROVALS_PATH) as f:
            cfg = json.load(f)
        for v in cfg.get("approved_recipients") or []:
            s = str(v).strip().lower()
            if s:
                out.add(s)
    except (OSError, json.JSONDecodeError):
        pass
    return out


def _load_broken_aliases() -> set:
    """Send-as aliases whose mail bounces with a 'Send mail as' misconfiguration.

    A broken alias fails silently: Gmail stamps the message SENT, then posts the
    failure into Trash under a category the inbox does not show. Approving such a send
    does not help, so the guard refuses it outright and says why. The list is written
    by refresh_broken_aliases.py, which reads the bounces themselves.
    """
    out = set()
    try:
        with open(os.path.join(_HOME, ".claude/state/broken-send-aliases.json")) as f:
            cfg = json.load(f)
        for a in (cfg.get("aliases") or {}):
            s = str(a).strip().lower()
            if s:
                out.add(s)
    except (OSError, json.JSONDecodeError):
        # No list, or an unreadable one, means no alias is known to be broken. Blocking
        # on that would refuse every send on a machine that has never run the refresh,
        # so an empty set is the correct answer rather than a swallowed error.
        return set()
    return out


BROKEN_ALIASES = _load_broken_aliases()
SELF_EMAILS = _load_self_emails()
SELF_JIDS = _load_self_jids()
SELF_IMESSAGE_HANDLES = _load_self_imessage_handles()
SELF_TELEGRAM_OWNERS = _load_self_telegram_owners()
APPROVED_RECIPIENTS = _load_approved_recipients()


def _telegram_recipient_is_self(cmd: str) -> bool:
    """True iff every Telegram chat_id target in the curl command resolves to
    one of Sam's own owner chat_ids. Accepts two safe forms:
      1. A literal numeric id present in SELF_TELEGRAM_OWNERS.
      2. The TELEGRAM_OWNER_ID / OWNER_ID env-var token ($X, ${X}). These
         resolve, in the orchestrator's environment, to Sam's own owner id by
         definition — an injection cannot change what the env var points to,
         so treating the token as 'self' is safe. (The orchestrator naturally
         writes `chat_id=$TELEGRAM_OWNER_ID` rather than the literal number.)
    Strict: if no chat_id reference is found, or any resolved target is
    non-self, returns False (stays blocked)."""
    if not cmd:
        return False
    # Capture chat_id values: numeric, or a shell var reference.
    vals = re.findall(r'chat_id["\'=\s]+(\$\{?[A-Z_]+\}?|[\-0-9]+)', cmd)
    if not vals:
        return False
    SAFE_OWNER_VARS = {"$TELEGRAM_OWNER_ID", "${TELEGRAM_OWNER_ID}",
                       "$OWNER_ID", "${OWNER_ID}", "$TG_OWNER_ID", "${TG_OWNER_ID}"}
    for v in vals:
        if v in SAFE_OWNER_VARS:
            continue
        if v in SELF_TELEGRAM_OWNERS:
            continue
        return False  # an unrecognized / non-self target → block
    return True


def _imessage_chat_id_is_self(chat_id: str) -> bool:
    """True iff the iMessage chat_id (GUID) points to a 1:1 thread whose ONLY
    remote handle is one of the owner's own handles. A 1:1 GUID has three
    semicolon-separated parts, '<service>;-;<handle>', where the handle is a phone
    number or an Apple ID. Group-chat GUIDs use '+' in the middle part instead of
    '-' and will NOT match, so third parties stay blocked.

    Strict semantics: we ONLY allow when the embedded handle is in
    SELF_IMESSAGE_HANDLES. Anything else (group, 1:1 with non-self, malformed)
    falls through to the standard block path.
    """
    if not SELF_IMESSAGE_HANDLES or not chat_id:
        return False
    parts = chat_id.split(";")
    # Expected 1:1 shape: '<service>;-;<handle>'. The '-' marks DM, '+' marks group.
    if len(parts) != 3 or parts[1] != "-":
        return False
    handle = _normalize_handle(parts[2])
    return handle in SELF_IMESSAGE_HANDLES


def _bash_recipient_is_self(cmd: str) -> bool:
    """Best-effort: parse --to <addr> from gog gmail send commands and check
    whether every --to / --cc / --bcc target is in SELF_EMAILS."""
    if not SELF_EMAILS:
        return False
    # Extract all --to / --cc / --bcc values (handles quoted and unquoted)
    targets = re.findall(
        r'--(?:to|cc|bcc)[=\s]+(?:"([^"]+)"|\'([^\']+)\'|(\S+))',
        cmd,
    )
    flat = []
    for trio in targets:
        for v in trio:
            if v:
                flat.append(v.strip().lower())
    if not flat:
        return False
    # Every target must be a self address (an email to self + one external = NOT self)
    return all(t in SELF_EMAILS for t in flat)

# Patterns are tightened to require an actual send-invocation flag (e.g., --to,
# --body, --reply-to-message-id) so that merely MENTIONING a send command inside
# a Python heredoc, shell comment, grep query, or audit script doesn't trip.
BASH_PATTERNS = [
    (r'(?:^|[\s;&|`/])gog\s+gmail\s+send\b[^#\n]{0,400}?--(?:to|body|body-file|reply-to-message-id|subject|from|cc|bcc)\b', 'gog gmail send'),
    (r'(?:^|[\s;&|`/])gog\s+send\b[^#\n]{0,400}?--(?:to|body|body-file|reply-to-message-id|subject|from|cc|bcc)\b', 'gog send (alias)'),
    # Both `drafts` and `draft` are valid gog subcommands, and sending a draft is
    # still sending. The old rule only caught the singular. A real draft id must
    # follow (e.g. r2782687644185019208), otherwise the rule also fires on a commit
    # message or documentation that merely names the command.
    (r'(?:^|[\s;&|`/])gog\s+gmail\s+drafts?\s+send\s+[\w-]{3,}', 'gog gmail drafts send'),
    # The WhatsApp bridge runs locally and had no rule at all. A curl to it sends a
    # real message to a real person, and went past the guard unseen. Multi-account
    # installs use one port per account, hence the 80xx range.
    (r'curl\s+[^\n]*127\.0\.0\.1:80\d\d/api/send\b', 'whatsapp bridge api/send'),
    (r'curl\s+[^\n]*localhost:80\d\d/api/send\b', 'whatsapp bridge api/send'),
    (r'(?:^|[\s;&|`/])wacli\s+send\b[^#\n]{0,400}?(?:--to|--message|--jid|--contact|--file)', 'wacli send'),
    (r'(?:^|[\s;&|`/])wacli\s+message\s+send\b', 'wacli message send'),
    (r'osascript[^\n]*\btell\s+application\s+"(Messages|Mail)"', 'osascript Messages/Mail'),
    (r'osascript[^\n]*-e[^\n]*\bMessages\b[^\n]*\bsend\b', 'osascript Messages send'),
    (r'curl\s+[^\n]*\bapi\.resend\.com/emails\b', 'Resend API'),
    (r'curl\s+[^\n]*\bapi\.sendgrid\.com/v\d+/mail/send\b', 'SendGrid API'),
    (r'curl\s+[^\n]*\bapi\.postmarkapp\.com/email\b', 'Postmark API'),
    (r'curl\s+[^\n]*\bapi\.mailgun\.net/v\d+/[^\n]*/messages\b', 'Mailgun API'),
    (r'curl\s+[^\n]*mandrillapp\.com/api/[^\n]*/messages\b', 'Mandrill API'),
    (r'curl\s+[^\n]*sparkpostmail\.com[^\n]*/transmissions', 'SparkPost API'),
    (r'curl\s+[^\n]*mailersend\.com[^\n]*/email', 'MailerSend API'),
    (r'curl\s+[^\n]*api\.mailchimp\.com[^\n]*/messages/send', 'Mailchimp send'),
    (r'curl\s+[^\n]*api\.klaviyo\.com/[^\n]*campaigns[^\n]*/send', 'Klaviyo campaign send'),
    (r'curl\s+[^\n]*api\.twilio\.com[^\n]*/Messages\b', 'Twilio SMS'),
    (r'curl\s+[^\n]*api\.twilio\.com[^\n]*/Calls\b', 'Twilio voice'),
    (r'curl\s+[^\n]*api\.telegram\.org/bot[^\n]*(sendMessage|sendPhoto|sendDocument|sendVoice)', 'Telegram bot'),
    (r'curl\s+[^\n]*hooks\.slack\.com/services/', 'Slack webhook'),
    (r'curl\s+[^\n]*slack\.com/api/chat\.postMessage', 'Slack chat.postMessage'),
    (r'curl\s+[^\n]*graph\.microsoft\.com[^\n]*sendMail', 'MS Graph sendMail'),
    (r'curl\s+[^\n]*gmail\.googleapis\.com[^\n]*/send', 'Gmail API send'),
    (r'curl\s+[^\n]*api\.bland\.ai/v\d+/calls(?!/[\w-])', 'Bland AI call'),
    (r'curl\s+[^\n]*api\.elevenlabs\.io[^\n]*dial', 'ElevenLabs dial'),
    (r'curl\s+[^\n]*api\.brevo\.com[^\n]*(smtp|email)', 'Brevo transactional'),
    (r'(?:^|[\s;&|`/])sendmail\s+[^#\n]*@', 'sendmail binary'),
    (r'(?:^|[\s;&|`/])mail\s+-s\s+[^\n]*@', 'mail -s'),
    (r'/usr/sbin/sendmail\s+[^\n]*@', 'sendmail path'),
    (r'(?:^|[\s;&|`/])msmtp\s+[^#\n]*@', 'msmtp'),
    (r'(?:^|[\s;&|`/])mutt\s+[^\n]*-s\s+[^\n]*@', 'mutt -s'),
    (r'cartesia[^\n]*synthesize[^\n]*/call', 'Cartesia TTS (to phone)'),

    # Token-tampering: Claude itself trying to forge the approval token
    (r'touch\s+[^\n;&|`]*?/tmp/\.claude-send-ok\b', 'forging approval token (touch)'),
    (r'>\s*/tmp/\.claude-send-ok\b', 'forging approval token (redirect)'),
    (r'(?:echo|printf|cat|tee)\s+[^\n]*>\s*/tmp/\.claude-send-ok', 'forging approval token (write)'),
    (r'install\s+[^\n]*/tmp/\.claude-send-ok', 'forging approval token (install)'),
    (r'cp\s+[^\n]*/tmp/\.claude-send-ok', 'forging approval token (cp)'),
    (r'mv\s+[^\n]*/tmp/\.claude-send-ok', 'forging approval token (mv)'),
    (r'ln\s+[^\n]*/tmp/\.claude-send-ok', 'forging approval token (ln)'),
    (r'python3?\s+[^\n]*\.claude-send-ok', 'forging approval token (python)'),
]


# One pattern for every MCP tool that actually sends something outward. A pattern
# rather than an exact list, so an extra account (whatsapp-nl, whatsapp-us, a second
# Gmail) cannot silently fall outside the gate.
OUTBOUND_TOOL_RE = re.compile(
    r'^mcp__(?:'
    r'gog[a-z0-9_-]*__(?:gmail_send|gmail_send_message|gmail_reply|gmail_drafts_send'
    r'|gmail_draft_send|gmail_forward)'
    r'|slack[a-z0-9_-]*__conversations_add_message'
    r'|whatsapp[a-z0-9_-]*__send_(?:message|audio_message|file)'
    r'|(?:plugin_imessage_)?imessage[a-z0-9_-]*__reply'
    r'|telegram[a-z0-9_-]*__send_(?:message|file)'
    r')$'
)


def is_outbound_mcp(tool_name: str, tool_input: dict):
    """MCP tools whose name alone implies outbound comms."""
    # Scope: real human-to-human messaging only (email, Slack DMs/channels,
    # WhatsApp, SMS). Project-management tool comments (Linear, GitHub issues,
    # Sentry issues) are NOT covered — they're work-tracking, not messaging.
    # Tool names are matched by pattern, not by an exact list. A two-account install
    # exposes mcp__whatsapp-nl__send_message and mcp__whatsapp-us__send_message; neither
    # was in the old exact tuple, so the hook ran and did nothing while WhatsApp sends
    # went out ungated. The settings matcher was already routing them here correctly.
    if OUTBOUND_TOOL_RE.match(tool_name):
        # iMessage self-thread exception: replies inside a 1:1 thread with
        # Sam's own handle (self-chat / notes-to-self) are operational, not
        # outbound human-to-human comms. Group chats and 1:1 to anyone else
        # remain BLOCKED.
        if tool_name == 'mcp__imessage__reply':
            chat_id = tool_input.get('chat_id') or ''
            if isinstance(chat_id, str) and _imessage_chat_id_is_self(chat_id):
                return None
        # Self-channel exception: messages where the recipient IS the user are
        # operational notifications (pocket pipeline, watchdog, supervisor
        # approvals) — not human-to-human comms. Self-identifiers loaded from
        # ~/.claude/state/pocket/{email,whatsapp}-config.json at hook load time.
        if re.match(r'^mcp__whatsapp[a-z0-9_-]*__send', tool_name):
            recipient = (tool_input.get('recipient')
                         or tool_input.get('jid')
                         or tool_input.get('chat_jid')
                         or '')
            if recipient and recipient in SELF_JIDS:
                return None
        if re.match(r'^mcp__gog[a-z0-9_-]*__gmail_', tool_name):
            # Collect every to/cc/bcc target; if all are self, allow.
            targets = []
            for k in ('to', 'cc', 'bcc'):
                v = tool_input.get(k)
                if isinstance(v, str) and v.strip():
                    targets.extend(p.strip().lower() for p in v.split(',') if p.strip())
                elif isinstance(v, list):
                    targets.extend(str(p).strip().lower() for p in v if str(p).strip())
            if targets and SELF_EMAILS and all(t in SELF_EMAILS for t in targets):
                return None
        return f'outbound MCP ({tool_name})'

    # gog_raw can execute any gog subcommand — inspect args for dangerous ones
    if tool_name == 'mcp__gog__gog_raw':
        args = tool_input.get('args') or []
        try:
            args_str = ' '.join(str(a) for a in args)
        except Exception:
            return None
        if re.search(r'\b(gmail\s+send|gmail\s+draft\s+send|chat\s+send|send\s+--to)\b', args_str, re.IGNORECASE):
            return f'outbound via gog_raw ({args_str[:100]})'

    return None


def _strip_full_line_comments(cmd: str) -> str:
    """Drop lines whose first non-blank character is #.

    Documentation and scripts often show a send command in a comment. Blocking on
    those trains people to work around the guard, which is worse than the gap.

    Deliberately narrow: only whole comment lines. Stripping from any # to end of line
    would be a security regression, because # occurs inside quoted message bodies and
    URLs, and a real send could be hidden behind one.
    """
    return "\n".join(l for l in cmd.splitlines() if not l.lstrip().startswith("#"))


def detect_outbound_bash(cmd: str):
    scan = _strip_full_line_comments(cmd)
    for pat, label in BASH_PATTERNS:
        if re.search(pat, scan, re.IGNORECASE):
            return label
    return None


def _consume_counted() -> bool:
    """Legacy counter for `ok N` / `ok all`: one approval covering N messages.

    Superseded by the shared store in outbound_guard.py and kept only as a fallback.
    Every draft is still approved individually on screen; a counter only removes the
    need to retype the approval per message."""
    try:
        st = os.stat(COUNT_FILE)
        raw = open(COUNT_FILE).read().strip()
    except FileNotFoundError:
        return False
    except Exception:
        return False
    if time.time() - st.st_mtime > COUNT_TTL_SEC:
        try:
            os.remove(COUNT_FILE)
        except Exception:
            pass
        return False
    try:
        left = int(raw or '0')
    except ValueError:
        return False
    if left <= 0:
        try:
            os.remove(COUNT_FILE)
        except Exception:
            pass
        return False
    left -= 1
    try:
        if left:
            # mtime bewust laten meelopen zou het venster eindeloos oprekken; we
            # schrijven de rest terug en zetten de oude mtime weer terug.
            with open(COUNT_FILE, 'w') as f:
                f.write(str(left))
            os.utime(COUNT_FILE, (st.st_atime, st.st_mtime))
        else:
            os.remove(COUNT_FILE)
    except Exception:
        pass
    globals()['_COUNT_LEFT'] = left
    return True


def _broken_sender(tool_name: str, tool_input: dict, cmd: str = '') -> str:
    """The broken alias this send would go out from, or '' if the sender is fine.

    Reads the explicit sender: --from on a gog command, or a from/sender field on an
    MCP call. A send with no explicit sender uses the account default, which is not an
    alias and cannot be broken this way.
    """
    if not BROKEN_ALIASES:
        return ''
    candidates = []
    if isinstance(tool_input, dict):
        for k in ('from', 'sender', 'from_address', 'fromEmail'):
            v = tool_input.get(k)
            if isinstance(v, str) and v.strip():
                candidates.append(v)
    if cmd:
        candidates += re.findall(
            r'--from[=\s]+(?:"([^"]+)"|\'([^\']+)\'|(\S+))', cmd)
    flat = []
    for c in candidates:
        if isinstance(c, tuple):
            flat += [x for x in c if x]
        else:
            flat.append(c)
    for c in flat:
        m = re.search(r'[\w.+-]+@[\w.-]+', c)
        if m and m.group(0).lower() in BROKEN_ALIASES:
            return m.group(0).lower()
    return ''


def _native_route(addr: str) -> str:
    """The command that sends as `addr` without the send-as relay, or '' if none exists.

    A broken alias is only half the story. These mailboxes are often reachable a second
    way: when gog holds a service account that can impersonate the address, mail goes
    out as the mailbox itself and never touches the stale SMTP credential. Where that
    file exists the fix is a different command, not a trip to the Gmail settings page.
    """
    stem = base64.urlsafe_b64encode(addr.encode()).rstrip(b'=').decode()
    for root in ('~/Library/Application Support/gogcli', '~/.config/gogcli'):
        if os.path.exists(os.path.join(os.path.expanduser(root), f'sa-{stem}.json')):
            return f'gog -a {addr} gmail send --to ... --subject ... --body ...'
    return ''


def _identify(tool_name: str, tool_input: dict, cmd: str = '') -> tuple[str, str]:
    """Recipient and text of this message, whatever shape it arrives in.

    The MCP proxy sees the same fields on an MCP call, so both layers derive the same
    fingerprint. A Bash command has no proxy side, so its fingerprint is simply unique
    per command."""
    if isinstance(tool_input, dict) and tool_input:
        rcpt = ''
        for k in ('recipient', 'jid', 'chat_jid', 'chat_id', 'to', 'channel_id'):
            v = tool_input.get(k)
            if isinstance(v, str) and v.strip():
                rcpt = v.strip()
                break
            if isinstance(v, list) and v:
                rcpt = str(v[0]).strip()
                break
        body = ''
        for k in ('message', 'text', 'body', 'payload', 'content'):
            v = tool_input.get(k)
            if isinstance(v, str) and v.strip():
                body = v
                break
        if rcpt or body:
            return (rcpt, body)
    return ('', cmd or '')


def check_token(recipient: str = '', body: str = '') -> bool:
    """Ask the shared store in outbound_guard for approval.

    That store is the only place counting, for every CLI. It identifies a message by
    recipient plus content, so the same message crossing several guards costs one unit.
    If the import fails this hook falls back to the old single-use token: better the
    older, stricter rule than accidentally allowing everything."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import outbound_guard
        return outbound_guard.consume(recipient, body)
    except Exception:
        pass
    try:
        st = os.stat(TOKEN_FILE)
    except Exception:
        return False
    if time.time() - st.st_mtime > TOKEN_TTL_SEC:
        return False
    try:
        os.remove(TOKEN_FILE)
    except Exception:
        pass
    return True


def audit(verdict: str, tool_name: str, reason: str, cmd_snippet: str = ''):
    try:
        with open(AUDIT_LOG, 'a') as f:
            ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            f.write(f'{ts} {verdict} tool={tool_name} reason={reason} cmd={cmd_snippet[:200]}\n')
    except Exception:
        pass


def _email_all_recipients_approved(tool_name: str, tool_input: dict, cmd: str) -> bool:
    """True iff this is an EMAIL send whose EVERY to/cc/bcc recipient is on the
    persistent approved-recipients allowlist (Sam's prior-approval). Scope is
    email only — Slack/WhatsApp/SMS/voice are never auto-approved here. An empty
    recipient set returns False so we never blanket-allow a malformed/parse-miss
    send. Covers both the MCP gmail_send tool and a `gog gmail send` Bash call."""
    if not APPROVED_RECIPIENTS:
        return False
    targets = []
    if re.match(r'^mcp__gog[a-z0-9_-]*__gmail_', tool_name) and isinstance(tool_input, dict):
        for k in ('to', 'cc', 'bcc'):
            v = tool_input.get(k)
            if isinstance(v, str) and v.strip():
                targets.extend(p.strip().lower() for p in v.split(',') if p.strip())
            elif isinstance(v, list):
                targets.extend(str(p).strip().lower() for p in v if str(p).strip())
    elif tool_name == 'Bash' and cmd:
        found = re.findall(
            r'--(?:to|cc|bcc)[=\s]+(?:"([^"]+)"|\'([^\']+)\'|(\S+))', cmd)
        for trio in found:
            for val in trio:
                if val:
                    targets.append(val.strip().lower())
    if not targets:
        return False
    return all(t in APPROVED_RECIPIENTS for t in targets)


# Tool this invocation is inspecting. Recorded as soon as it is known so the
# crash handler at the bottom can tell a plain shell call from a real send.
_CURRENT_TOOL = ''


def main():
    global _CURRENT_TOOL
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    # Valid JSON that is not an object carries no tool and no recipient, so
    # there is nothing to police. Bail instead of raising AttributeError.
    if not isinstance(data, dict):
        sys.exit(0)

    tool_name = data.get('tool_name') or ''
    _CURRENT_TOOL = str(tool_name)
    tool_input = data.get('tool_input') or {}
    agent_id = data.get('agent_id') or data.get('subagent_id') or ''
    is_subagent = bool(agent_id) or os.environ.get('CLAUDE_CODE_IS_SUBAGENT') == '1'

    reason = None
    cmd_snippet = ''
    cmd = ''

    if tool_name == 'Bash':
        # Coerce: a non-string command would blow up the regex scanners below.
        cmd = str(tool_input.get('command') or '') if isinstance(tool_input, dict) else ''
        reason = detect_outbound_bash(cmd)
        # Self-email exception: if the bash command is a self-targeted gog gmail
        # send (all --to/--cc/--bcc are user's own address), it's a notification.
        if reason and _bash_recipient_is_self(cmd):
            reason = None
        # Self-Telegram exception: if the curl sends only to Sam's own owner
        # chat_id(s), it's a status ping to Sam — operational, not outbound
        # human-to-human comms. Sends to any other chat_id stay blocked.
        if reason == 'Telegram bot' and _telegram_recipient_is_self(cmd):
            reason = None
        # Self-iMessage exception: if every osascript Messages target points to
        # one of the owner's own handles, it's an operational self-notification,
        # not outbound human-to-human comms. Two send forms are recognized:
        #   1. `chat id "<guid>"`     — GUID form (mirrors the MCP reply path).
        #   2. `buddy "<handle>"`     — direct-handle form, where the handle is a
        #      phone number or Apple ID.
        # Strict: allow only when at least one self-target form is present AND no
        # recognized target resolves to a non-self handle. Group chats and any
        # 1:1 to a third party stay BLOCKED.
        if reason and reason.startswith('osascript') and SELF_IMESSAGE_HANDLES:
            # Form 1 — chat id "<guid>" (plain, backslash-escaped, or single quotes)
            guids = re.findall(r'chat\s+id\s+\\?"([^"\\]+)\\?"', cmd)
            guids += re.findall(r"chat\s+id\s+'([^']+)'", cmd)
            # Form 2 — buddy "<handle>" (plain, backslash-escaped, or single quotes)
            buddies = re.findall(r'buddy\s+\\?"([^"\\]+)\\?"', cmd)
            buddies += re.findall(r"buddy\s+'([^']+)'", cmd)
            guids_ok = (not guids) or all(_imessage_chat_id_is_self(g) for g in guids)
            buddies_ok = (not buddies) or all(
                _normalize_handle(b) in SELF_IMESSAGE_HANDLES for b in buddies)
            if (guids or buddies) and guids_ok and buddies_ok:
                reason = None
        cmd_snippet = cmd[:200]
    else:
        reason = is_outbound_mcp(tool_name, tool_input if isinstance(tool_input, dict) else {})

    if not reason:
        sys.exit(0)

    # Subagents are BANNED from outbound comms outright (no token can unlock).
    # Only the parent Claude Code session may dispatch a send.
    if is_subagent:
        audit('BLOCKED_SUBAGENT', tool_name, reason, cmd_snippet)
        msg = (
            f'BLOCKED: subagents may NEVER send outbound comms ({reason}).\n'
            f'Only the parent Claude Code session can dispatch a send after Sam\n'
            f'explicitly approves the specific draft. Subagent id: {agent_id or "(env)"}\n'
            f'Return the DRAFT to the parent session, do not attempt to send.'
        )
        print(msg, file=sys.stderr)
        sys.exit(2)

    # A send from a known-broken alias is refused before every other allow path,
    # including the approved-recipient bypass below. Approving it would not help:
    # Gmail marks it SENT and the mail bounces into Trash, so the sender believes it
    # went and the recipient never gets it. Whether the recipient is trusted has no
    # bearing on that — the failure is in the sender's relay, so a pre-approved
    # address is exactly the case where the silent bounce would go unnoticed longest.
    _bad = _broken_sender(tool_name, tool_input if isinstance(tool_input, dict) else {}, cmd)
    if _bad:
        audit('BLOCKED_BROKEN_ALIAS', tool_name, _bad, cmd_snippet)
        msg = (
            f'BLOCKED: the sender alias {_bad} is misconfigured and its mail bounces.\n\n'
            "Gmail stamps the message SENT and then drops a delivery failure into Trash,\n"
            "so this send would look successful and never arrive. Approving it changes\n"
            "nothing.\n\n")
        native = _native_route(_bad)
        if native:
            msg += (
                "Send as the mailbox itself instead. That path does not use the send-as\n"
                "relay, so the stale password is irrelevant and no app password is needed:\n"
                f"  {native}\n\n"
                "If gog reports unauthorized_client, this Workspace granted the service\n"
                "account only some scopes. Ask for just the one you need:\n"
                f'  GOG_ACCESS_TOKEN=$(gog-sa-token {_bad} send) gog -a {_bad} gmail send ...\n\n')
        msg += (
            'To repair the alias itself: Gmail Settings > Accounts and Import >\n'
            '"Send mail as" > edit that address > re-enter a valid app password. Then run:\n'
            "  refresh_broken_aliases.py\n")
        sys.stderr.write(msg)
        sys.exit(2)

    # Persistent prior-approval bypass (Sam's directive 2026-06-18): an EMAIL
    # whose every recipient is on the approved-recipients allowlist is a send
    # Sam has already signed off on — let it through without burning a token, so
    # an approved batch doesn't require slow one-token-per-message minting. Any
    # email with a recipient NOT on the list still falls through to the gate.
    # Email only; Slack/WhatsApp/SMS/voice are unaffected.
    if _email_all_recipients_approved(tool_name, tool_input if isinstance(tool_input, dict) else {}, cmd):
        audit('ALLOWED_APPROVED', tool_name, reason, cmd_snippet)
        sys.exit(0)

    # Pass recipient and text so the shared store can recognise this message when
    # another guard sees it too. Without them the same message would cost a unit at
    # every layer.
    _rcpt, _body = _identify(tool_name, tool_input if isinstance(tool_input, dict) else {}, cmd)
    if check_token(_rcpt, _body):
        audit('ALLOWED', tool_name, reason, cmd_snippet)
        sys.exit(0)

    audit('BLOCKED', tool_name, reason, cmd_snippet)

    msg = (
        f'BLOCKED: outbound-comms guardrail tripped ({reason}).\n\n'
        f"Sam's policy: ONE send per explicit approval. Claude (and claude-ops daemon,\n"
        f'subagents, any session) may NEVER send email / Slack / WhatsApp / SMS /\n'
        f'voice calls / team pings without Sam reviewing the FINAL proposed message\n'
        f'FOR THIS SPECIFIC SEND and authorizing THIS specific send.\n\n'
        f'Required workflow — repeat for EACH message, no batching:\n'
        f'  1. Show the FINAL draft for ONE message (to, cc, bcc, subject, full body)\n'
        f'  2. Wait for Sam to explicitly say send / approve for this exact draft\n'
        f'  3. Ask Sam to authorize OUTSIDE Claude — via the `!` prompt prefix:\n'
        f'       ! ok     (shorthand for: touch /tmp/.claude-send-ok)\n'
        f'  4. Retry this tool call within 120 seconds — the token is single-use.\n'
        f'  5. For the NEXT message, repeat steps 1-4 with its own approval + token.\n\n'
        f'Batch sending is forbidden: one token = one send. `--dangerously-skip-permissions`\n'
        f'does NOT bypass this guardrail. Audit log: /tmp/claude-outbound-audit.log\n\n'
        f'Persistent prior-approval (email only): to let an already-approved\n'
        f'recipient send without a token every time, Sam adds the address to\n'
        f'"approved_recipients" in ~/.claude/state/outbound-approvals.json. Any\n'
        f'email to a NON-approved address still requires the per-send token above.'
    )
    print(msg, file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - deliberate catch-all
        # Never let a bug here surface as a raw traceback on every tool call.
        # A plain shell command fails open, so a crash cannot brick the session.
        # An actual send tool fails closed: if this guard could not do its job,
        # the message does not go out.
        if _CURRENT_TOOL and _CURRENT_TOOL != 'Bash':
            print(
                f'block-outbound-comms crashed while checking {_CURRENT_TOOL}; '
                f'refusing the send.\n{type(exc).__name__}: {exc}',
                file=sys.stderr,
            )
            sys.exit(2)
        sys.exit(0)
