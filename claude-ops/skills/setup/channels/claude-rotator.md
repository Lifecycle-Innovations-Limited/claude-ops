### 3o — Claude account rotator OAuth (if selected)

**Gate:** Only run this section if the userConfig flag `account_rotation_setup_oauth_each` is `true` (default). Skip if false.

**Pre-skip optimization:** If every account in the rotation config already has a keychain token, print one line and continue:

```bash
USER_CFG="$HOME/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json"
REPO_CFG="${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/config.json"
CFG="$([[ -f "$USER_CFG" ]] && echo "$USER_CFG" || echo "$REPO_CFG")"
CRED="${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh"

MISSING=()
for id in $(jq -r '.accounts[].id // empty' "$CFG" 2>/dev/null); do
  bash "$CRED" get "Claude-Rotation" "$id" >/dev/null 2>&1 || MISSING+=("$id")
done

if [[ ${#MISSING[@]} -eq 0 ]] && [[ "$(jq -r '.accounts | length' "$CFG" 2>/dev/null)" != "0" ]]; then
  echo "✓ Claude rotator: all accounts have keychain tokens — skipping OAuth"
fi
```

**If accounts list is empty OR `MISSING` has entries:** delegate to the `/ops:rotate-setup` wizard. This skill embeds the same flow, so call it inline rather than duplicating logic:

> Invoke the `ops-rotate-setup` skill at this point, passing the same userConfig context. The wizard handles add-loop, OAuth init, 2FA prompts, and keychain writes per Rule 4 (background by default).

After it returns, print:

```
✓ Claude rotator: <N> account(s) initialized
  Enable autorotation in /plugins → claude-ops → settings (account_rotation_enabled)
```

Do NOT auto-flip `account_rotation_enabled`. The user enables it explicitly.

---

