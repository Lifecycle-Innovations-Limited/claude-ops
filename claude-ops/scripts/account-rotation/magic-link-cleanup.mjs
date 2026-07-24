// ── Magic-link email cleanup ─────────────────────────────────────────────────
// Claude magic-link login emails are single-use: once the poller has extracted
// the link/code and the rotation has consumed it, the email is dead weight. Left
// in the inbox they accumulate (dozens after a few days) AND actively confuse the
// stale-link guards every poller runs (`seenSkip`, target-email validation,
// newer_than windows). So every rotation script ARCHIVES the consumed email
// right after use.
//
// Archive = remove the Gmail system label INBOX via `gog gmail messages modify
// --remove INBOX` (the message stays in All Mail / is searchable, it just leaves
// the inbox). This is non-destructive — unlike trashing, the email is preserved.
// Safe against re-consumption: every poll anchors to "now", validates the
// decoded target email, and uses a tight `newer_than` window, so an archived
// older link is never picked up again.
//
// Best-effort by contract: this NEVER throws and NEVER blocks rotation. A failed
// cleanup is logged and swallowed — a stuck/garbage inbox must not wedge auth.
import { execFileSync } from 'child_process';

const GMAIL_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Archive consumed magic-link emails (remove them from the inbox; message kept).
 * @param {string[]} messageIds - Gmail message IDs (from thread.messages[].id).
 * @param {string|null} inbox   - account email for `gog --account`; null = gog default.
 * @param {(msg:string)=>void} log
 * @returns {number} count archived
 */
export function archiveMagicLinkMessages(messageIds, inbox, log = () => {}) {
  const ids = [...new Set((messageIds || []).filter((id) => id && GMAIL_ID_RE.test(id)))];
  if (ids.length === 0) return 0;
  const acctArgs = inbox ? ['--account', inbox] : [];
  let archived = 0;
  for (const id of ids) {
    try {
      execFileSync('gog', ['gmail', 'messages', 'modify', id, '--remove', 'INBOX', '-y', ...acctArgs], {
        timeout: 15_000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      archived++;
    } catch (err) {
      const stderr = err?.stderr ? err.stderr.toString().trim().slice(0, 100) : '';
      log(`[magic-link] cleanup: could not archive ${id}${stderr ? ' — ' + stderr : ''}`);
    }
  }
  if (archived) log(`[magic-link] cleanup: archived ${archived} consumed login email(s)`);
  return archived;
}

// Back-compat alias: existing callers import { trashMagicLinkMessages }. The
// behavior is now "archive" (remove INBOX) rather than "trash" (add TRASH), but
// the name is kept so import sites don't need to change. Prefer
// archiveMagicLinkMessages in new code.
export const trashMagicLinkMessages = archiveMagicLinkMessages;
