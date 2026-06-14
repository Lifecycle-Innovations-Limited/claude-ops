### 3h — Password Manager (credential vault)

Ops agents frequently need to look up credentials (API keys, database passwords, service tokens) on your behalf. This step wires up a password manager so those queries can be automated via a standard command template stored in `$PREFS_PATH`.

#### Step 3h.1 — Auto-detect installed managers

Run these in parallel:

```bash
command -v op 2>/dev/null && op account list --format=json 2>&1    # 1Password CLI
command -v dcli 2>/dev/null && dcli sync 2>&1                       # Dashlane CLI
command -v bw 2>/dev/null && bw status --raw 2>&1                   # Bitwarden CLI
security find-generic-password -s "test" 2>&1 | head -1             # macOS Keychain (always available)
```

Parse each result to classify as `authenticated`, `needs_unlock`, `not_installed`, or `available` (Keychain is always `available`).

#### Step 3h.2 — Present findings

Show only what was detected via `AskUserQuestion`. **Max 4 options per call.** Since macOS Keychain and Skip are always shown, you have room for at most 2 detected managers per call. If all 3 CLIs (1Password, Dashlane, Bitwarden) are installed, batch into two calls:

**If <=2 CLI managers detected (common case — fits in one call):**

```
Password managers found:
  [1Password — authenticated as <account>]
  [Dashlane — needs unlock]
  [macOS Keychain — always available]
  [Skip — don't connect a password manager]
```

**If all 3 CLI managers detected (rare — batch into two calls):**
Call 1:

```
  [1Password — authenticated as <account>]
  [Dashlane — needs unlock]
  [Bitwarden — <status>]
  [More options...]
```

Call 2:

```
  [macOS Keychain — always available]
  [Skip — don't connect a password manager]
```

Never show managers that aren't installed. Always show macOS Keychain and Skip. If none of the CLIs are installed, skip straight to showing just `[macOS Keychain — always available]` and `[Skip]`.

#### Step 3h.3 — Configure selected manager

**1Password (`op`):**

1. Check auth: `op account list --format=json`
2. If the output is empty or exits non-zero (not signed in), print:
   ```
   1Password CLI is installed but not signed in.
   Run `op signin` via Bash tool with `run_in_background: true`, then re-run /ops:setup vault.
   ```
   Stop this sub-flow.
3. If authed, list vaults for the user to pick a default:
   ```bash
   op vault list --format=json
   ```
   Use `AskUserQuestion` (single select) to present the vault names. The selected vault becomes `password_manager_config.vault`.
4. Record query syntax:
   ```
   op item get "{{name}}" --fields label=password --format=json
   ```

**Dashlane (`dcli`):**

1. Check auth: `dcli sync`
2. If `dcli sync` fails or returns a not-configured error, print:
   ```
   Dashlane CLI is installed but not configured.
   Run `dcli configure` via Bash tool, then re-run /ops:setup vault.
   ```
   Stop this sub-flow.
3. Record query syntax:
   ```
   dcli password --filter "{{name}}" --output json
   ```
4. No vault selection needed — Dashlane has a flat namespace.

**Bitwarden (`bw`):**

1. Check auth: `bw status --raw` and parse the JSON `status` field.
   - `"unauthenticated"` → print:
     ```
     Bitwarden CLI is installed but not logged in.
     Run `bw login` via Bash tool with `run_in_background: true`, then re-run /ops:setup vault.
     ```
     Stop this sub-flow.
   - `"locked"` → print:
     ```
     Bitwarden vault is locked.
     Run `bw unlock --raw` via Bash tool, capture the session token, and export it as `BW_SESSION` for subsequent commands. Then continue /ops:setup vault.
     ```
     Stop this sub-flow.
   - `"unlocked"` → continue.
2. Record query syntax:
   ```
   bw get item "{{name}}" --pretty
   ```
3. No vault selection — Bitwarden uses a single unlocked vault per session.

**macOS Keychain:**

1. No auth check needed — always available.
2. Note for the user:
   ```
   macOS Keychain is always available but is limited to items stored locally.
   No cross-device sync. Best for machine-specific secrets (API keys added via
   `security add-generic-password`).
   ```
3. Record query syntax:
   ```
   security find-generic-password -s "{{name}}" -w
   ```

#### Step 3h.4 — Write to preferences

After the user selects and configures a manager, write to `$PREFS_PATH`:

```json
{
  "password_manager": "<1password|dashlane|bitwarden|keychain>",
  "password_manager_config": {
    "vault": "<vault name, or omit if not applicable>",
    "query_cmd": "<template with {{name}} placeholder>"
  }
}
```

Merge with the existing file (`jq '. + { ... }'`) — never overwrite. Example for 1Password:

```json
{
  "password_manager": "1password",
  "password_manager_config": {
    "vault": "Private",
    "query_cmd": "op item get \"{{name}}\" --fields label=password --format=json"
  }
}
```

If the user picks Skip, write `"password_manager": "none"` so subsequent runs don't re-prompt unless the user explicitly runs `/ops:setup vault`.

#### Step 3h.5 — Document for agents

After saving, print this note once:

```
All ops skills can now query credentials via your configured password manager.
The query command template is in preferences.json under password_manager_config.query_cmd.
Replace {{name}} with the item name — e.g. "GitHub PAT", "AWS root key", "my-project-db".

To query manually:
  op item get "GitHub PAT" --fields label=password --format=json   (1Password example)
  security find-generic-password -s "my-project-db" -w               (Keychain example)
```

#### Dashboard display

Update the Step 0b status header to include vault status:

```
 Vault:       ✓ 1password (vault: Private)
```

Use `○ none` if skipped, `✗ locked` if the manager is installed but inaccessible.

#### Completion summary (Step 8)

Include in the final summary block:

```
 ✓ Vault:      1password → Private vault
```

Omit this line entirely if `password_manager` is `"none"` or unset.

#### Invocation shortcut

Add to the shortcuts table: `vault`, `password-manager`, `pm` → Step 3h

> **Deep-dive:** no dedicated skill ships with the password manager integration — see `${CLAUDE_PLUGIN_ROOT}/docs/memories-system.md` (Runtime Context section) for how downstream skills resolve `password_manager` + related vault references from `$PREFS_PATH`. Privacy-and-security guidance lives in this SKILL.md (keychain-only storage of API hashes/session strings, `umask 077` for bridge files). The setup agent can load that file directly when it needs more depth than this wizard provides.

---
