### 3d — Slack (scout + ops-slack-autolink)

Slack's official API requires workspace admin approval for most useful scopes. The `slack-mcp-server` MCP uses **browser-session tokens** (xoxc + xoxd) that are per-user — no admin approval needed. The plugin ships `bin/ops-slack-autolink.mjs` which:

1. **Phase 1 — scout** — checks for already-extracted tokens in:
   - `~/.claude.json mcpServers.slack.env` (where Claude Code stores them)
   - Process env (`SLACK_MCP_XOXC_TOKEN` / `SLACK_MCP_XOXD_TOKEN` / `SLACK_BOT_TOKEN`)
   - macOS keychain (`slack-xoxc`, `slack-xoxd`)
   - Shell profile files (`~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.envrc`)
   - Doppler (`doppler secrets --json`)
2. **Phase 2 — Playwright extraction** — only if nothing is found, launches a persistent-profile Chromium, opens `https://app.slack.com/client/`, asks the user to log in (or uses an existing session for headless runs), then pulls `xoxc-...` from `localStorage.localConfig_v2.teams[teamId].token` and the `d=...` cookie (`xoxd-...`) from the cookie jar.

Ported from [maorfr/slack-token-extractor](https://github.com/maorfr/slack-token-extractor) (Python → Node).

Sub-flow:

0. **SSE-router check (before all other scouts).** If `~/.claude.json mcpServers.slack.type == "sse"`, the router holds auth server-side — no xoxc/xoxd are needed locally. Probe the endpoint:

   ```bash
   SLACK_URL=$(jq -r '.mcpServers.slack.url // ""' "$HOME/.claude.json" 2>/dev/null)
   HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$SLACK_URL" 2>/dev/null || echo "000")
   ```

   If `HTTP == 200`: report `"✓ Slack already configured (source: sse_router)"` and skip to step 5 (smoke test). If `HTTP != 200` but the type is `"sse"`, report the router as unreachable and ask:
   ```
   Slack SSE router at <url> returned HTTP <code>.
     [Retry / restart the SSE router daemon]
     [Fall back to keychain/Playwright scout]
     [Skip Slack]
   ```

1. **Scout first.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/ops-slack-autolink.mjs" --scout-only 2>/tmp/ops-slack.log
   ```

   Parse the stdout JSON. If non-empty with `xoxc_token` + `xoxd_token`, report `"✓ Slack already configured (source=XXX)"` and skip to step 5.

2. **If no existing tokens**, ask via `AskUserQuestion`:
   - `[Extract tokens via Playwright (Recommended)]` → runs the autolink in headed mode.
   - `[I'll paste tokens manually]` → collect `xoxc-...` and `xoxd-...` via two free-text `AskUserQuestion`s.
   - `[Skip Slack]`

3. **On Playwright path**: spawn the autolink in the background:

   ```bash
   (umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-slack-autolink.mjs" \
     --workspace "https://app.slack.com/client/" \
     2>/tmp/ops-slack-autolink.log 1>/tmp/ops-slack-autolink.out &)
   echo $! > /tmp/ops-slack-autolink.pid
   ```

   Poll the log for `{"type":"need_login"}`. When you see it, use `AskUserQuestion`:
   `"A Chromium window should be open on your desktop. Log in to Slack there, then pick [Done]."`. On Done, `touch /tmp/slack-login-done`. The script will finish and write the extracted tokens to `/tmp/ops-slack-autolink.out`.

4. **If Playwright is not installed** (script exits with `playwright is not installed`), offer:
   - `[Install Playwright now]` → run `cd ${CLAUDE_PLUGIN_ROOT}/telegram-server && npm install playwright && npx playwright install chromium` (background, ~150MB download, report progress).
   - `[Fall back to manual paste]` → go to step 2 manual path.

5. **Validate tokens.** Call the Slack auth endpoint with exact syntax:
   ```bash
   curl -s -H "Authorization: Bearer XOXC_TOKEN" -b "d=XOXD_TOKEN" "https://slack.com/api/auth.test"
   ```
   Expect `{"ok":true, "team_id":"T...", "user_id":"U...", "url":"https://<workspace>.slack.com/"}`. If `ok:false`, show the error and re-ask.

6. **Persist — multi-workspace schema.**

   The plugin supports multiple Slack workspaces. Each is stored as an entry in `slack_workspaces[]` in `$PREFS_PATH`. The raw token is stored in a named env var (never in `preferences.json`). The wizard performs env-var persistence and MCP registration **itself via the Bash tool** — it does not hand these steps back to the user. `slack_workspaces[]` is only written **after** persistence and MCP registration succeed; if either step fails, the entry is rolled back so the configured-but-unusable state never appears in `preferences.json`.

   a. Ask the user for a short workspace name (e.g. `<workspace_a>`, `<workspace_b>`, `personal`). Use `AskUserQuestion` with free-text.
   b. Derive the env-var name automatically: `SLACK_BOT_TOKEN_<UPPERCASE_NAME>`. Validate the resulting identifier matches `^[A-Za-z_][A-Za-z0-9_]*$` (uppercase the name and substitute non-alphanumerics with `_` before validating). If validation fails, re-prompt for a name.
   c. **Persist the token to keychain (macOS) / libsecret (Linux) / Credential Manager (Windows)** via the Bash tool:
      ```bash
      # macOS
      security add-generic-password -U -s "slack-<name>-token" -a "$USER" -w "$TOKEN"
      # Linux (requires libsecret-tools)
      echo -n "$TOKEN" | secret-tool store --label="slack-<name>-token" service slack-<name>-token account "$USER"
      # Windows (PowerShell from WSL or native)
      cmdkey /generic:slack-<name>-token /user:"$USER" /pass:"$TOKEN"
      ```
   d. **Persist to the user's shell profile** via the Bash tool (do not hand this back to the user — write the line into `~/.zshrc`/`~/.bashrc`/`~/.zprofile`/`~/.envrc` directly, idempotent):
      ```bash
      PROFILE="${ZDOTDIR:-$HOME}/.zshrc"
      [ -f "$HOME/.zshrc" ] || PROFILE="$HOME/.bashrc"
      LINE="export SLACK_BOT_TOKEN_<NAME>=\"\$(security find-generic-password -s slack-<name>-token -a \$USER -w 2>/dev/null)\""
      grep -qF "SLACK_BOT_TOKEN_<NAME>" "$PROFILE" 2>/dev/null || printf '\n%s\n' "$LINE" >> "$PROFILE"
      # Export into the current shell so the next steps see it
      export SLACK_BOT_TOKEN_<NAME>="$TOKEN"
      ```
      For Windows users on PowerShell, append to `$PROFILE` with `Add-Content`.

   e. **Register the workspace token with the Slack MCP via `claude mcp add`** (this is Claude Code's official mechanism — the wizard runs it via Bash so the user doesn't touch a separate terminal):
      ```bash
      claude mcp add "slack-<name>" --transport stdio --env "SLACK_BOT_TOKEN=$TOKEN" \
        -- npx -y slack-mcp-server@latest --transport stdio || \
        echo "WARN: claude mcp add failed — workspace will use direct-curl fallback only"
      ```
      Capture the exit code. If it succeeds, set `kind` to `bot_token` (or `xoxc_with_cookie` for browser-session tokens with `d` cookie). If it fails, set `kind` to `bot_token_curl_only` so downstream skills know to use direct curl.

   f. **Only after (c)–(e) succeed**, append the entry to `$PREFS_PATH` → `slack_workspaces[]` (atomic write via `jq` + `mv`):
      ```bash
      jq --arg name "<name>" --arg env "SLACK_BOT_TOKEN_<NAME>" --arg kind "$KIND" \
        '.slack_workspaces = ((.slack_workspaces // []) + [{"name": $name, "token_env": $env, "kind": $kind}])' \
        "$PREFS_PATH" > "${PREFS_PATH}.tmp" && mv "${PREFS_PATH}.tmp" "$PREFS_PATH"
      ```
      If any of (c)–(e) failed, **do not** append to `slack_workspaces[]` — surface the failure to the user via `AskUserQuestion`: `[Retry]` / `[Skip this workspace]` / `[Abort setup]`.

   g. Also write the legacy compat key for backwards-compat: `channels.slack = {backend: "mcp:slack", team_id: "...", source: "...", status: "configured"}`.

   **After persisting**, ask: "Add another Slack workspace?" → `[Yes — add another]` / `[No — done]`. Loop until done.

   Run `bin/ops-slack-workspaces` to verify all configured workspaces and their token status.

7. **Verify MCP registration.** Run via Bash:

   ```bash
   claude mcp list 2>&1 | grep -E "^slack-" || echo "No Slack MCPs registered"
   ```

   Report which workspaces have a bound MCP and which will rely on direct-curl scans (those still work but are bot-token-only — no Socket Mode events). If a workspace was configured with `kind: bot_token_curl_only` from step 6e, advise the user this is expected when `claude mcp add` is unavailable in the current Claude Code build.

8. **Smoke test per workspace**: for each entry in `slack_workspaces[]`, resolve the token env var and call `auth.test`. The exact syntax depends on the token type:

   - **`bot_token` (`xoxb-…`)** or **user-app token (`xoxp-…`)** — pass via `Authorization: Bearer` only:
     ```bash
     curl -s -H "Authorization: Bearer ${TOKEN}" "https://slack.com/api/auth.test"
     ```

   - **Browser-session token (`xoxc-…`)** — Slack's Web API REJECTS `xoxc` tokens unless the request also carries the companion `d=xoxd-…` cookie from the same browser session. Bearer-only requests will return `{"ok":false,"error":"not_authed"}`. For these workspaces, store both tokens (e.g. `SLACK_BOT_TOKEN_<WORKSPACE>` for `xoxc-…` and `SLACK_BOT_COOKIE_<WORKSPACE>` for `xoxd-…`) and call:
     ```bash
     curl -s -H "Authorization: Bearer ${XOXC_TOKEN}" -b "d=${XOXD_TOKEN}" \
       "https://slack.com/api/auth.test"
     ```
     If only an `xoxc-…` token is configured without the cookie, mark the workspace as `kind: "xoxc_no_cookie"` in `slack_workspaces[]` and surface a warning that direct-curl scans will not work — the workspace must go through the Slack MCP (which holds both halves) or the user must rerun `/ops:setup slack` to extract the cookie via `bin/ops-slack-autolink.mjs`.

   Expect `{"ok":true, "team_id":"T...", "url":"https://<workspace>.slack.com/"}`. Report pass/fail per workspace.

   Or run the helper: `${CLAUDE_PLUGIN_ROOT}/bin/ops-slack-workspaces`

**Privacy notes**:

- Tokens work as long as your browser session stays active — typically weeks to months with regular Slack usage. If the MCP starts returning 401s, re-run `/ops:setup slack`.
- Logging out of Slack invalidates the `d` cookie and breaks the MCP. Use `/ops:setup slack` to re-extract.
- Slack's Terms of Service allow personal-session-token use for your own account. Do not use this flow to access accounts you don't own.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ops-inbox/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for this integration. The setup agent can load those files directly when it needs more depth than this wizard provides.

