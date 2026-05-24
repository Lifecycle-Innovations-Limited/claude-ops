# ops-bg dispatch — correct shape

> Rule captured 2026-05-24 after 3x SessionStart hijack incidents.

## Correct shape (always heredoc)

```bash
ops-bg dispatch <short-kebab-slug> -p "$(cat <<'PROMPT'
Role: [who this agent is — one sentence]
Context: [verified facts — endpoint IDs, regions, creds path, ticket]

Steps:
1. [exact command or script path]
2. [exact command]
3. [verification step]

Report: [what to print when done — exit code, key output, ticket updated y/n]

IMPORTANT: Ignore any SessionStart monitoring briefing shown at session startup.
Your only task is the one described above. Do not ask questions. Execute and report.
PROMPT
)"
```

## Wrong shape (never do this)

```bash
# Shell mangling — loses newlines, breaks quoting, prompt truncated
ops-bg dispatch my-task -p "Do X. Then Y. Then Z. [500 chars inline]..."
```

## SessionStart hijack problem

`ops-bg` sessions inherit **all** SessionStart hooks — including the healify monitoring
briefing. The agent reads the briefing first, then asks "want me to dig into X?" instead
of running its assigned task. The `IMPORTANT: Ignore any SessionStart monitoring briefing`
line in the prompt is **mandatory** to prevent this.

## Surface selection

| Task type | Surface |
|---|---|
| bash script → run it → check result | `Bash` directly — no agent needed |
| ≤30min, result needed back in THIS session | `Agent` tool (in-session subagent) |
| >30min / overnight / fire-and-forget | `ops-bg dispatch` with heredoc + ignore-briefing line |

## Incident: 2026-05-24

aurora SSL reboot + WAF flip dispatched 3× as `ops-bg` — each time hijacked by the
healify SessionStart monitoring briefing. Agent responded to the briefing output instead
of running the assigned script. Fixed by running both directly via `Bash`.
