### 3g — Doppler (secrets management)

Doppler is a secrets manager that injects environment variables at runtime. When configured, all ops skills can query secrets via `doppler secrets get` instead of reading from dotfiles or keychain. The wizard checks presence, auth status, and default project context.

#### Step 3g.1 — Presence

```bash
command -v doppler
```

If missing, detect the host OS via `uname -s` / `$OSTYPE` / `$OS` and pick the right install command. Ask via `AskUserQuestion`:

```
Doppler CLI is not installed.
  [Install now — <os-specific command>]
  [Skip Doppler]
```

Where the OS-specific command is:

| OS                  | Install command                                                                     |
|---------------------|-------------------------------------------------------------------------------------|
| macOS / Linuxbrew   | `brew install dopplerhq/cli/doppler`                                                |
| Debian / Ubuntu     | `curl -Ls https://cli.doppler.com/install.sh \| sudo sh`                            |
| Fedora / RHEL       | `sudo rpm --import https://packages.doppler.com/public.key && sudo dnf install -y doppler` |
| Arch Linux          | `yay -S doppler-cli`                                                                |
| Alpine              | `apk add --no-cache doppler-cli`                                                    |
| Windows (winget)    | `winget install Doppler.doppler`                                                    |
| Windows (scoop)     | `scoop bucket add doppler https://github.com/DopplerHQ/scoop-doppler.git; scoop install doppler` |

Run the chosen command in the background, capture stdout/stderr, and report success/failure. If the user skips, record `secrets_manager: "none"` in `$PREFS_PATH` and end this sub-flow.

#### Step 3g.2 — Auth status

Run:

```bash
doppler me --json 2>&1
```

Parse the JSON. If the output contains `"error"` or a non-zero exit code, the user is not authenticated. Print:

```
Doppler is not authenticated. Running `doppler login` now...
```

Run `doppler login` via Bash tool with `run_in_background: true` (it opens a browser for the OAuth flow). Tell the user: "Opening browser for Doppler OAuth — complete the sign-in there, then type 'done'." Use `AskUserQuestion`: `[Done — authenticated]`, `[Skip Doppler]`. On Done, re-run `doppler me --json` to verify. If authenticated, `doppler me` will return JSON with `name` and `email` — confirm:

```
✓ Doppler authenticated as <name> (<email>)
```

Never display the name or email unless they came from `doppler me` output in this session.

#### Step 3g.3 — Project context

If authenticated, list available projects:

```bash
doppler projects --json 2>&1
```

Parse the array of project objects. Present them via `AskUserQuestion` with `singleSelect`. **Max 4 options per call** — if there are more than 3 projects, paginate: show 3 projects + `[More projects...]` per page, with `[Skip — don't set a default project]` always as the last option on the final page.

```
Select your default Doppler project (page 1):
  [ ] my-app
  [ ] my-api
  [ ] my-service
  [ ] More projects...
```

If the user selects a project, fetch its configs:

```bash
doppler configs --project <selected_project> --json 2>&1
```

Present available configs via `AskUserQuestion` with `singleSelect` (max 4 options — paginate if needed):

```
Select the default config for <project>:
  [ ] dev
  [ ] staging
  [ ] production
```

Write the selection to `$PREFS_PATH` (merge, don't overwrite):

```json
{
  "secrets_manager": "doppler",
  "doppler": {
    "project": "<selected>",
    "config": "<selected>"
  }
}
```

Print confirmation:

```
✓ Doppler default context set: <project>/<config>
```

#### Step 3g.4 — Document for agents

Print this note so it's visible in the session:

```
All ops skills can now query secrets via:

  doppler secrets get <KEY> --plain --project <project> --config <config>

For example:
  doppler secrets get TELEGRAM_BOT_TOKEN --plain --project my-app --config dev

The project and config above are the defaults saved to preferences.
Individual skills can override with --project / --config flags.
```

> **Deep-dive:** no dedicated skill ships with Doppler — see `${CLAUDE_PLUGIN_ROOT}/docs/memories-system.md` (Runtime Context section) for how downstream skills consume the `secrets_manager` / `doppler.*` values from `$PREFS_PATH` and resolve `doppler:KEY_NAME` references at runtime. The setup agent can load that file directly when it needs more depth than this wizard provides.

#### Step 3g.5 — Doppler MCP Server

After the CLI is configured and authenticated, offer to set up the official `@dopplerhq/mcp-server` MCP integration. This gives Claude direct tool access to Doppler secrets without shelling out.

1. **Check availability**: Run `npx -y @dopplerhq/mcp-server --help 2>&1` in the background. If it exits 0, the package is available.

2. **Generate a service token**: If the user selected a project/config in Step 3g.3, generate a scoped token:
   ```bash
   doppler configs tokens create mcp-server-token --project <project> --config <config> --plain 2>/dev/null
   ```
   If the command fails or if no project/config was selected, ask:
   ```
   Doppler MCP Server needs a token. Options:
     [Generate from CLI (requires project/config)]
     [Paste a token manually]
     [Skip MCP server]
   ```

3. **Save token to userConfig**: Write the token to `doppler_token` in the plugin's `userConfig` (this feeds `.mcp.json` at runtime via `${user_config.doppler_token}`). Also save `doppler_project` and `doppler_config` if selected.

4. **Smoke test**: Verify the MCP server can start:
   ```bash
   DOPPLER_TOKEN="<token>" timeout 10 npx -y @dopplerhq/mcp-server --help 2>&1
   ```
   If it exits 0, the server is functional.

5. **Confirmation**:
   ```
   ✓ Doppler MCP Server configured — secrets accessible via MCP tools (mcp__doppler__*)
   ```

6. **Note for agents**:
   ```
   With the MCP server configured, skills can now query secrets directly via
   MCP tool calls (mcp__doppler__*) instead of shelling out to `doppler secrets get`.
   The Doppler CLI remains available as a fallback when the MCP server is unavailable.
   ```

