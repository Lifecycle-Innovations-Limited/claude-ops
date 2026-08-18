---
name: ops-rotate-setup
description: "OPS on-demand: Fail-closed legacy Claude setup alias that directs operators to separately approved…"
argument-hint: ''
allowed-tools:
  - Read
effort: low
maxTurns: 5
---

# Claude enrollment handoff

Direct Claude browser, OAuth, magic-link, setup, and unattended authentication
are disabled. Do not launch a browser, poll email, invoke `rotate.mjs --setup`,
invoke `rotate-magic.mjs`, modify auth inventory, or suggest an environment
bypass.

Tell the operator to use `scripts/account-rotation/staged-enrollment.mjs` with:

1. An owner-only deployment config that pins every trust root and the canonical
   operation lock.
2. A short-lived, separately signed `stage` approval for an externally captured
   CLIProxyAPI Claude auth candidate.
3. External containment of all writers.
4. A distinct `activate` approval bound to the staged digest and attesting
   `writersQuiesced: true`.

The attestation records operator confirmation; it does not stop services or
contain writers itself. This skill does not sign approvals or perform either
operation on the operator's behalf.
