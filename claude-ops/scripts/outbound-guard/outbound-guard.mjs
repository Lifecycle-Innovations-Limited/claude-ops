// Node side of the shared approval store. Reads and writes exactly the file managed by
// outbound_guard.py, with the same rules.
//
// Identical rather than "roughly the same" on purpose: if the two layers identify a
// message differently, one message either pays twice or not at all. The fingerprint is
// therefore literally the same computation: sha256(recipient|body), body normalised on
// whitespace and truncated to 400 chars, first 32 hex chars.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const STATE = '/tmp/.claude-outbound-guard.json';
export const SPENT_WINDOW_SEC = 120;
const LEGACY_SINGLE = '/tmp/.claude-send-ok';
const LEGACY_SINGLE_TTL_SEC = 120;

export function fingerprint(recipient, body) {
  const r = String(recipient ?? '')
    .trim()
    .toLowerCase();
  const b = String(body ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
  return crypto.createHash('sha256').update(`${r}|${b}`).digest('hex').slice(0, 32);
}

function read() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const now = Date.now() / 1000;
  if (now - (d.minted ?? 0) > (d.ttl ?? 0)) {
    clear();
    return null;
  }
  return d;
}

function write(d) {
  const tmp = `${STATE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    fs.renameSync(tmp, STATE);
  } catch {
    /* best effort, same as the Python side */
  }
}

function clear() {
  for (const p of [STATE, `${STATE}.tmp`]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

export function peek() {
  const d = read();
  if (!d) return { remaining: 0, validForSec: 0 };
  const left = (d.ttl ?? 0) - (Date.now() / 1000 - (d.minted ?? 0));
  return { remaining: Number(d.remaining ?? 0), validForSec: Math.max(0, Math.floor(left)) };
}

// True when this message may go. Deducts at most one unit. The same fingerprint inside
// the window is the same message, already charged at another guard.
export function consume(recipient = '', body = '') {
  const fp = fingerprint(recipient, body);
  const d = read();
  if (d) {
    const now = Date.now() / 1000;
    const spent = Object.fromEntries(Object.entries(d.spent ?? {}).filter(([, t]) => now - t < SPENT_WINDOW_SEC));
    if (fp in spent) {
      d.spent = spent;
      write(d);
      return true;
    }
    let remaining = Number(d.remaining ?? 0);
    if (remaining > 0) {
      remaining -= 1;
      spent[fp] = now;
      if (remaining <= 0 && Object.keys(spent).length === 0) {
        clear();
      } else {
        d.remaining = remaining;
        d.spent = spent;
        write(d);
      }
      return true;
    }
    return false;
  }

  // No canonical state: fall back to the old single-use token.
  try {
    const st = fs.statSync(LEGACY_SINGLE);
    if (Date.now() / 1000 - st.mtimeMs / 1000 > LEGACY_SINGLE_TTL_SEC) return false;
    try {
      fs.unlinkSync(LEGACY_SINGLE);
    } catch {
      /* best effort */
    }
    return true;
  } catch {
    return false;
  }
}
