### 3c — Email

Email has two possible backends, tried in this order:

#### Preferred: `gog` CLI

`gog` is the email + calendar CLI that `ops-inbox` and `ops-comms` call by default. It's a self-contained binary with its own OAuth token at `~/.gog/token.json` — full read + send permissions, no Claude Desktop config required.

1. Check `gog` on PATH with `command -v gog`.
2. **If installed**, run `gog auth status 2>&1 || true` and show the output.
   - If auth is red (not authenticated / token expired / exit != 0), run `gog auth add "$USER_EMAIL" --services gmail,calendar,drive,contacts,docs,sheets` via Bash tool with `run_in_background: true` (it opens a browser for the OAuth flow). Tell the user: "Opening browser for Gmail OAuth — complete the sign-in there, then type 'done'." Use `AskUserQuestion`: `[Done — authenticated]`, `[Skip email]`.
   - If auth is green, probe with:
     ```bash
     gog gmail labels list --json 2>&1 | head -5
     ```
     If this returns JSON containing a `labels` array, gog is authenticated and the Gmail API is working. Report ✓. If the output is an error or empty, treat as broken and instruct the user to re-run `gog auth add <email> --services gmail,calendar,drive,contacts,docs,sheets`.
   - Record `channels.email = "gog"` in `$PREFS_PATH` and stop here.

#### Fallback: Claude Gmail MCP connector

If `gog` is not on PATH, look at the detector's `mcp_configured` array for any entry matching (case-insensitive) `gmail`, `google-mail`, or `claude_ai_Gmail` — these are the common names for Anthropic's Gmail connector or user-installed Gmail MCP servers.

3. **If a Gmail MCP is configured**, ask `AskUserQuestion`:
   - `[Use Gmail MCP (read-only fallback)]`
   - `[Install gog instead — show docs]`
   - `[Skip email]`
4. On "Use Gmail MCP", record `channels.email = "mcp:<name>"` in `$PREFS_PATH` (where `<name>` is the actual MCP server name you found) and **print this warning verbatim**:
   ```
   ⚠  Using the Gmail MCP connector as a fallback.
      Read operations (list inbox, search, fetch) will work.
      SEND operations will fail until you explicitly grant send permissions
      in Claude Desktop → Settings → Connectors → Gmail → Permissions.
      The ops plugin cannot grant those permissions for you — it's a Claude
      Desktop-side setting tied to your account.
      If you want unattended sending from ops-comms, install `gog` instead.
   ```
5. On "Install gog instead", print the OS-appropriate install command:

   | OS            | Command                                                       |
   |---------------|---------------------------------------------------------------|
   | macOS / Linuxbrew | `brew install gogcli`                                     |
   | Windows       | `winget install -e --id steipete.gogcli`                      |
   | Arch Linux    | `yay -S gogcli`                                               |
   | From source   | `git clone https://github.com/steipete/gogcli.git && cd gogcli && make` |

   Docs: <https://gogcli.sh/> · Repo: <https://github.com/steipete/gogcli>

   After install, authorise once per account:
   ```bash
   gog auth credentials /path/to/client_secret.json
   gog auth add you@example.com --services gmail,calendar,drive,contacts,docs,sheets
   ```
   Refresh tokens are stored in the OS keyring (Keychain on macOS, Secret Service / libsecret on Linux, Credential Manager on Windows). Then stop this sub-flow and wait for the user to re-run `/ops:setup email`.

#### Neither available

6. **If `gog` is missing AND no Gmail MCP is configured**, ask `AskUserQuestion`:
   - `[Install gog — show docs]`
   - `[Add a Gmail MCP — show docs]` → print `claude mcp add gmail` and tell the user to re-run `/ops:setup email` after
   - `[Skip email for now]`
7. Whatever the user picks, record the resulting state in `$PREFS_PATH` (either `channels.email = "gog"`, `channels.email = "mcp:<name>"`, or omit the key entirely).

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-inbox/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for this integration. The setup agent can load those files directly when it needs more depth than this wizard provides.

