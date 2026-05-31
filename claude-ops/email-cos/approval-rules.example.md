# Approval validation rules (example)

`pocket-responder` runs these rules through an LLM **after** you approve an outbound
action (email reply, message) but **before** it is committed to run. If the action
looks stale or rule-breaking, the responder HOLDS it and pings you with the reason +
a `force <code>` override instead of sending.

Copy this file to `~/.config/email-cos/approval-rules.md` (or point
`POCKET_APPROVAL_RULES` at it) and edit to match your own preferences. If no file is
present, a generic built-in rubric is used. Disable the whole guard with
`POCKET_VALIDATE_ACTIONS=0`.

One rule per line. Phrase each as a condition to HOLD on.

- HOLD if the request appears already handled, resolved, or superseded (e.g. a meeting
  was already scheduled/accepted, the thread already has a later reply, the task is now
  obsolete).
- HOLD if the action commits to a specific time/date on your behalf unless you clearly
  set that time — scheduling is usually delegated.
- HOLD if the action contradicts a more recent message or event in the context.
- HOLD if the recipient already received an equivalent message recently.
- Otherwise PROCEED.
