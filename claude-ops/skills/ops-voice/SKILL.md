---
name: ops-voice
description: Voice operations — make phone calls (Bland AI), text-to-speech (ElevenLabs), transcribe audio (Whisper/Groq). Replace OpenClaw voice capabilities.
argument-hint: "[call|tts|transcribe|setup]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - WebFetch
---

# OPS:VOICE — Voice Operations

Voice interface commands. All API calls via curl — no SDK dependencies.

**Credential resolution order:** userConfig → env vars → Doppler secrets

---

## Sub-commands

Parse `$ARGUMENTS` for the command keyword, then execute:

---

### `call [phone] [prompt]` — Bland AI phone call

**Requires:** `bland_ai_api_key` in userConfig or `BLAND_AI_API_KEY` env or Doppler.

```bash
BLAND_KEY="${BLAND_AI_API_KEY:-$(doppler secrets get BLAND_AI_API_KEY --plain 2>/dev/null || true)}"
PHONE="<extracted from $ARGUMENTS>"
PROMPT="<extracted from $ARGUMENTS or ask user>"
MAX_DURATION="${BLAND_MAX_DURATION:-300}"  # seconds
VOICE="${BLAND_VOICE:-male}"

# Make the call
RESPONSE=$(curl -s -X POST "https://api.bland.ai/v1/calls" \
  -H "authorization: $BLAND_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"phone_number\": \"$PHONE\",
    \"task\": \"$PROMPT\",
    \"voice\": \"$VOICE\",
    \"max_duration\": $MAX_DURATION,
    \"record\": true
  }")

CALL_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('call_id',''))" 2>/dev/null)

# Poll for completion (up to 5 min)
if [ -n "$CALL_ID" ]; then
  echo "Call initiated: $CALL_ID"
  for i in $(seq 1 30); do
    sleep 10
    STATUS=$(curl -s "https://api.bland.ai/v1/calls/$CALL_ID" \
      -H "authorization: $BLAND_KEY" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''), d.get('transcripts','')[-1].get('text','') if d.get('transcripts') else '')" 2>/dev/null)
    echo "Status: $STATUS"
    [[ "$STATUS" == completed* ]] && break
  done
fi
```

**Output:** Call ID, live status, transcript when complete.

---

### `tts [text] [--voice voice_id] [--out file.mp3]` — ElevenLabs text-to-speech

**Requires:** `elevenlabs_api_key` in userConfig or `ELEVENLABS_API_KEY` env or Doppler.

```bash
EL_KEY="${ELEVENLABS_API_KEY:-$(doppler secrets get ELEVENLABS_API_KEY --plain 2>/dev/null || true)}"
VOICE_ID="${ELEVENLABS_VOICE_ID:-21m00Tcm4TlvDq8ikWAM}"  # Rachel (default)
TEXT="<extracted from $ARGUMENTS>"
OUT_FILE="${OUT_FILE:-/tmp/ops-tts-$(date +%s).mp3}"

# List voices if voice name provided (not an ID)
# Synthesize
curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: $EL_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"$TEXT\",
    \"model_id\": \"eleven_monolingual_v1\",
    \"voice_settings\": {\"stability\": 0.5, \"similarity_boost\": 0.75}
  }" \
  --output "$OUT_FILE"

echo "Audio saved to: $OUT_FILE"
# Auto-play on macOS
command -v afplay &>/dev/null && afplay "$OUT_FILE" &
```

**Output:** Audio file path. Auto-plays on macOS via `afplay`.

---

### `transcribe [file_path]` — Groq Whisper transcription

**Requires:** `groq_api_key` in userConfig or `GROQ_API_KEY` env or Doppler.

```bash
GROQ_KEY="${GROQ_API_KEY:-$(doppler secrets get GROQ_API_KEY --plain 2>/dev/null || true)}"
AUDIO_FILE="<extracted from $ARGUMENTS>"

if [ ! -f "$AUDIO_FILE" ]; then
  echo "ERROR: File not found: $AUDIO_FILE"
  exit 1
fi

TRANSCRIPT=$(curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" \
  -H "Authorization: Bearer $GROQ_KEY" \
  -F "file=@$AUDIO_FILE" \
  -F "model=whisper-large-v3" \
  -F "response_format=json" | \
  python3 -c "import json,sys; print(json.load(sys.stdin).get('text',''))" 2>/dev/null)

echo "$TRANSCRIPT"
```

**Output:** Transcript text printed to stdout.

---

### `setup` — Configure voice API keys

Walk through credential setup interactively. Check which keys are missing, then prompt for each:

1. Check `BLAND_AI_API_KEY` → if missing, prompt and add to Doppler or shell profile
2. Check `ELEVENLABS_API_KEY` → if missing, prompt
3. Check `GROQ_API_KEY` → if missing, prompt
4. Verify each key with a lightweight API call (list voices for ElevenLabs, check balance for Bland AI, list models for Groq)
5. Report status for all three services

---

## Execution

1. Resolve the sub-command from `$ARGUMENTS` (first word: call / tts / transcribe / setup)
2. Resolve credentials in order: env → Doppler
3. Execute the matching curl block above
4. If a required key is missing and `setup` was not invoked, suggest `/ops:ops-voice setup`
