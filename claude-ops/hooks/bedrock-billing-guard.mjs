#!/usr/bin/env node
// PreToolUse guard — hard-block any agent MEASURED to be billing AWS Bedrock,
// until it EXPLICITLY acknowledges. Owner directive (2026-06-15): "notify the
// agent with an error hook only dismissable on explicit ok, to the agent that
// is measured to be sending aws bedrock calls or using bedrock tokens."
//
// Why this works: a PreToolUse hook is spawned as a child of the Claude session
// node process, so it INHERITS the session's live process.env — including a
// runtime-injected CLAUDE_CODE_USE_BEDROCK=1 (the literal per-token billing
// flag). That env var IS the measurement: if it's set, this session's model
// calls are hitting metered Bedrock right now. Zero false positives. We also
// honor a daemon-written offender flag (the rotation watchdog's network/env
// measurement) keyed by the short session id, as a second trigger.
//
// Dismiss = EXPLICIT OK: run a Bash command containing the sentinel BEDROCK-ACK.
// The hook recognizes it, records the ack, and stops blocking. This is the only
// way to proceed while still on Bedrock (the legitimate last-resort case where
// zero OAuth headroom exists and the watchdog cannot swap). When OAuth IS
// available the watchdog respawns the session off Bedrock within ~45s and clears
// the flag, so the block lifts on its own — no ack needed for a non-problem.
//
// FAIL-OPEN: any error, missing input, or unexpected state → exit 0 (allow).
// A money guard must never wedge an innocent session.

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function allow() {
  process.exit(0);
}

// ── Configurable mode (claude-ops templatable) ────────────────────────────────
// Decide how strict the guard is. Resolution order (first wins):
//   1. env CLAUDE_BEDROCK_GUARD               (block | warn | off)
//   2. ~/.claude/bedrock-guard.conf           (single word, same values)
//   3. default → "block"                      (safe: protect spend by default)
// Modes:
//   block — hard-block every tool (exit 2) until explicit `echo BEDROCK-ACK`.
//   warn  — never block; inject a non-blocking warning into the agent's context.
//   off   — no-op. For users who intentionally run Bedrock unrestricted.
function guardMode() {
  const norm = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return s === 'off' || s === 'warn' || s === 'block' ? s : '';
  };
  const env = norm(process.env.CLAUDE_BEDROCK_GUARD);
  if (env) return env;
  try {
    const f = norm(readFileSync(join(homedir(), '.claude', 'bedrock-guard.conf'), 'utf8'));
    if (f) return f;
  } catch {}
  return 'block';
}

const MODE = guardMode();
if (MODE === 'off') allow(); // unrestricted Bedrock — guard disabled by config

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // no/garbled hook input → never block
}

const sidFull = String((input && input.session_id) || '');
const sid8 = sidFull ? sidFull.slice(0, 8) : '';
const tool = (input && input.tool_name) || '';
const cmd = (input && input.tool_input && (input.tool_input.command || '')) || '';

// ── Is THIS session billing Bedrock? ──────────────────────────────────────────
// (a) own inherited runtime env (authoritative — the actual billing flag), and
// (b) daemon offender flag from the watchdog's measurement (short-id keyed).
const envBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === '1';
const offenderFile = sid8 ? `/tmp/claude-bedrock-offender-${sid8}` : '';
const flagged = !!offenderFile && existsSync(offenderFile);
const onBedrock = envBedrock || flagged;

if (!onBedrock) allow(); // not on metered Bedrock → allow everything, silently

const ackFile = sid8 ? `/tmp/claude-bedrock-ack-${sid8}` : '';

// ── Explicit OK: a Bash call carrying the BEDROCK-ACK sentinel dismisses ───────
if (tool === 'Bash' && /BEDROCK-ACK/.test(cmd)) {
  try {
    if (ackFile) writeFileSync(ackFile, String(Date.now()));
  } catch {}
  allow(); // permit the acknowledging command itself
}

// Already acknowledged this session → allow (agent chose to proceed knowingly).
if (ackFile && existsSync(ackFile)) allow();

// ── Block: loud, money-focused error fed back to the agent on EVERY tool call ──
let detail = '';
try {
  if (flagged) {
    const j = readFileSync(offenderFile, 'utf8').trim();
    if (j) detail = `\nWatchdog measurement: ${j.slice(0, 220)}`;
  }
} catch {}

// warn mode: surface it loudly but never block — just inject context, exit 0.
if (MODE === 'warn') {
  const warn =
    `⚠️💸 BEDROCK BILLING: this session${sid8 ? ` (${sid8})` : ''} is making metered AWS Bedrock ` +
    `model calls (real $$$, not the Max/CRS pool).${detail} The rotation watchdog should swap you ` +
    `to CRS/OAuth shortly. (bedrock-guard mode=warn — not blocking.)`;
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warn },
      }),
    );
  } catch {}
  process.exit(0);
}

// block mode (default): hard-block every tool until explicit acknowledgement.
const msg =
  `🛑🔥 METERED AWS BEDROCK BILLING DETECTED on THIS session${sid8 ? ` (${sid8})` : ''}.\n` +
  `Every model call you make is spending REAL $$$ on AWS Bedrock per-token billing — ` +
  `NOT the free Max/CRS account pool. This is the opposite of intended routing.${detail}\n` +
  `\nALL tool calls are BLOCKED until you acknowledge. The rotation watchdog will normally ` +
  `swap you to CRS/OAuth within ~45s and this clears automatically. If it does NOT clear, ` +
  `there is no OAuth headroom and Bedrock is the only option.\n` +
  `\nTo acknowledge and continue ANYWAY (knowingly on metered Bedrock), run exactly:\n` +
  `    echo BEDROCK-ACK\n` +
  `This error re-fires on every tool call until you acknowledge.`;

process.stderr.write(msg + '\n');
process.exit(2); // PreToolUse: exit 2 → block the tool, stderr becomes the reason to the model
