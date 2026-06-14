### 3f — Calendar

Calendar isn't a messaging channel, but every other ops skill (briefings, `/ops-next`, `/ops-go`) benefits massively from knowing the user's schedule — meetings blocking deep work, deploy windows, travel days. The wizard wires it up the same way as email: `gog calendar` primary, Google Calendar MCP connector fallback.

#### Preferred: `gog calendar`

`gog` (the `gogcli` binary — see Step 3c) already handles email; the same binary exposes `gog calendar` with the same OAuth token. No additional auth needed if Step 3c went green. Note: `gog cal` is **not** a valid alias — always use `gog calendar`.

1. Check `gog` on PATH with `command -v gog`.
2. **If installed and already authed from Step 3c**, probe:
   ```bash
   gog calendar calendars --json 2>&1 | head -20
   ```
   If this returns JSON with calendar metadata, record `channels.calendar = "gog"` in `$PREFS_PATH` and print `✓ Calendar — gog calendar`. Stop here.
3. **If gog is installed but calendar scope is missing** (typical error: `insufficient scope` or `403 insufficient_permissions`), print:
   ```
   Your gog OAuth token doesn't include the calendar scope.
   Re-add the account with the calendar service via Bash tool with `run_in_background: true`:
     gog auth add "$USER_EMAIL" --services gmail,calendar,drive,contacts,docs,sheets
   Tell the user: "Opening browser for Calendar OAuth — complete the sign-in there, then type 'done'." Use `AskUserQuestion`: `[Done — re-authorized]`, `[Skip calendar]`.
   ```
   Do not attempt to re-auth from the skill — it's a browser flow.

#### Fallback: Claude Google Calendar MCP connector

4. **If gog is not on PATH**, scan the detector's `mcp_configured` array for any entry matching (case-insensitive) `calendar`, `google-calendar`, or `claude_ai_Calendar`.
5. If found, ask `AskUserQuestion`:
   - `[Use Google Calendar MCP (read-only fallback)]`
   - `[Install gog instead — show docs]`
   - `[Skip calendar]`
6. On "Use Google Calendar MCP", record `channels.calendar = "mcp:<name>"` in `$PREFS_PATH` and **print this warning verbatim**:
   ```
   ⚠  Using the Google Calendar MCP connector as a fallback.
      Read operations (list calendars, fetch events, check free/busy) will work.
      WRITE operations (create events, decline meetings, reschedule) will fail
      until you explicitly grant write permissions in
      Claude Desktop → Settings → Connectors → Google Calendar → Permissions.
      The ops plugin cannot grant those permissions for you.
      If you want ops-next to auto-block focus time or ops-comms to confirm
      meetings, install `gog` instead.
   ```
7. On "Install gog instead", **run the install via Bash** (Rule 2) using the same npm → bun → source-clone chain as Step 3c — either inline the snippet or call `${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-install gog` (background per Rule 4). Only fall back to printing manual instructions if all four attempts fail.

#### Neither available

8. **If `gog` is missing AND no Calendar MCP is configured**, ask:
   - `[Install gog — show docs]`
   - `[Add the Google Calendar MCP — show docs]` → print `claude mcp add google-calendar` and tell the user to re-run `/ops:setup calendar` after
   - `[Skip calendar]`

#### Why this matters (for context in the skill)

Downstream skills (`/ops-go`, `/ops-next`, `/ops-fires`) read `channels.calendar` from `$PREFS_PATH` to decide whether to cross-correlate today's schedule with their output:

- Briefings note "you have a 2pm standup, so don't start that refactor now"
- `/ops-next` deprioritizes deep work when a meeting is <30min away
- `/ops-fires` warns if a production incident falls during a scheduled call
  So this section is not optional for users who want context-aware briefings.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-go/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for this integration (calendar context feeds `/ops:go` briefings). The setup agent can load that file directly when it needs more depth than this wizard provides.
