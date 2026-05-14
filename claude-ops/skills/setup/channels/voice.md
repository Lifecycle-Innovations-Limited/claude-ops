### 3k — Voice (Bland AI, ElevenLabs, Groq)

**Before showing the service selector**, run the Universal Credential Auto-Scan for all voice vars simultaneously:

```bash
# Shell env
printenv BLAND_AI_API_KEY BLAND_API_KEY ELEVENLABS_API_KEY GROQ_API_KEY 2>/dev/null

# Shell profiles
grep -h 'BLAND\|ELEVENLABS\|GROQ' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler across all projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
    jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("BLAND|ELEVENLABS|GROQ")) | "\(.key)=\(.value.computed) (doppler:\($proj)/prd)"'
done

# Dashlane
dcli password "bland-ai" --output json 2>/dev/null
dcli password elevenlabs --output json 2>/dev/null
dcli password groq --output json 2>/dev/null

# OpenClaw (common location for AI service keys)
jq -r '.agents.defaults.env | to_entries[] | select(.key | test("BLAND|ELEVENLABS|GROQ")) | "\(.key)=\(.value)"' ~/.openclaw/openclaw.json 2>/dev/null
```

Cache these results — use them to pre-fill answers for each sub-step below. Check existing config in `$PREFS_PATH` under `voice.*` too. If a key is already set, show `✓ <service> — already configured` and offer `[Keep]` / `[Reconfigure]`.

Ask which voice services to configure via `AskUserQuestion` with `multiSelect: true`:

| Option      | Header      | Description                                    |
| ----------- | ----------- | ---------------------------------------------- |
| Bland AI    | bland       | Outbound AI phone calls — API key              |
| ElevenLabs  | elevenlabs  | Text-to-speech and voice cloning — API key     |
| Groq        | groq        | Fast LLM inference (Whisper, LLaMA) — API key  |

#### Bland AI

If `BLAND_AI_API_KEY` or `BLAND_API_KEY` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format. Only ask via free text if not found:
```
Enter your Bland AI API Key:
  To find it: https://app.bland.ai → Settings → API Key
```

Smoke test:
```bash
curl -s -H "Authorization: $KEY" "https://api.bland.ai/v1/me" | jq '.user.id'
```
Expect a non-null user ID.

#### ElevenLabs

If `ELEVENLABS_API_KEY` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format. Only ask via free text if not found:
```
Enter your ElevenLabs API Key:
  To find it: https://elevenlabs.io → Profile (top-right) → API Key
```

Smoke test:
```bash
curl -s -H "xi-api-key: $KEY" "https://api.elevenlabs.io/v1/user" | jq '.subscription.tier'
```
Expect a subscription tier string (e.g. `"free"`, `"starter"`).

#### Groq

If `GROQ_API_KEY` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format. Only ask via free text if not found:
```
Enter your Groq API Key:
  To generate one: https://console.groq.com → API Keys → Create API Key
  Key starts with "gsk_"
```

Smoke test:
```bash
curl -s -H "Authorization: Bearer $KEY" \
  "https://api.groq.com/openai/v1/models" | jq '.data | length'
```
Expect a positive integer (number of available models).

#### Save to preferences

Write to `$PREFS_PATH` (merge):
```json
{
  "voice": {
    "bland": { "api_key": "<key>" },
    "elevenlabs": { "api_key": "<key>" },
    "groq": { "api_key": "gsk_..." }
  }
}
```

Same Doppler-reference pattern — prefer `doppler:KEY_NAME` over raw tokens when Doppler is configured.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-voice/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for voice integrations (Bland AI call flows, ElevenLabs TTS, Groq transcription). The setup agent can load that file directly when it needs more depth than this wizard provides.

---

