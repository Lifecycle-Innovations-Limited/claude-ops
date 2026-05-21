---
name: ops-voice
description: Voice operations — native macOS Phone (Continuity), FaceTime, Zoom, Twilio voice + SMS, Bland AI agent calls, ElevenLabs TTS, Whisper transcription. All curl-based, no SDK deps.
argument-hint: "[phone|facetime|zoom|twilio-call|twilio-sms|bland-call|tts|transcribe|setup]"
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - WebFetch
---

# OPS:VOICE — Voice Operations

Voice / phone / video interface. All API calls via curl — no SDK dependencies. Native macOS handlers (Phone.app, FaceTime, Zoom) require no credentials; programmatic channels (Twilio, Bland, ElevenLabs, Groq, Zoom schedule) resolve credentials via:

**Credential resolution order:** env vars → `ops_cred_get` (lib/credential-store.sh / keychain) → `preferences.json` → Doppler CLI (`doppler secrets get <KEY> --plain`) → password manager.

All sub-commands have a thin bash wrapper at `bin/ops-voice` — prefer it over inline curl when scripting.

**Outbound comms guardrail (Rule 6):** `twilio-call`, `twilio-sms`, and `bland-call` are 1:1 outbound channels and MUST follow the per-message approval gate — stage final draft, show full target+body, wait for explicit approval (`AskUserQuestion` or single-word chat approval), send one, then stage the next. Never batch.

---

## Sub-commands

Parse `$ARGUMENTS` for the command keyword, then execute. Native handlers exit fast; API calls report status and (where relevant) a poll command.

---

### `phone <number>` — Native Phone.app via Continuity

Routes through the linked iPhone. Requires macOS + iPhone signed in to the same iCloud account with **Calls on Other Devices** enabled. No credentials.

```bash
bin/ops-voice phone "+1234567890" --json
# {"ok":true,"channel":"phone","detail":"dialing +1234567890 via Phone.app (Continuity)"}
```

Under the hood: `open "tel:<E.164>"`.

---

### `facetime <number-or-email> [--audio]` — FaceTime video/audio

Defaults to video. Pass `--audio` for FaceTime Audio (free, Apple↔Apple). Accepts phone numbers or Apple-ID emails.

```bash
bin/ops-voice facetime user@example.com               # video
bin/ops-voice facetime "+1234567890" --audio --json   # audio
```

Under the hood: `open "facetime://<handle>"` or `open "facetime-audio://<handle>"`.

---

### `zoom start|join|schedule` — Zoom meetings

```bash
# Open zoom.us app and start a new instant meeting
bin/ops-voice zoom start

# Join an existing meeting
bin/ops-voice zoom join 1234567890 --pwd <password>

# Schedule a meeting via Zoom REST API (requires ZOOM_API_TOKEN — Server-to-Server OAuth access token)
bin/ops-voice zoom schedule "<topic>" --start "2026-05-22T15:00:00Z" --duration 30 --json
# {"ok":true,"channel":"zoom","detail":"scheduled meeting 12345 — https://us05web.zoom.us/j/..."}
```

Native start/join use `zoommtg://` URL scheme. Schedule requires `ZOOM_API_TOKEN` resolved via the order above. Generate a Server-to-Server OAuth app in your Zoom Marketplace, then exchange for an access token.

---

### `join [--at now|next|HH:MM] [--window MIN] [--dry-run]` — Smart calendar-driven meeting joiner

Auto-joins the meeting that's happening **now** (within `±window` minutes, default 10) or the next future meeting if nothing is current. Reads `gog calendar events --all --today -j --sort start`, extracts a conference URL from `hangoutLink` → `conferenceData.entryPoints[]` → location → description scan (supports Zoom, Google Meet, Microsoft Teams, Webex), applies the smart AV policy below, and hands off to the native opener (which honors Rule 7 on SSH/mobile).

```bash
bin/ops-voice join                 # join current/next meeting
bin/ops-voice join --at next       # skip current, go to next future
bin/ops-voice join --window 5      # only consider events within ±5min of now
bin/ops-voice join --dry-run       # show what would happen — no launch
bin/ops-voice join --dry-run --json
```

**AV policy (smart heuristic):**

| Attendees | Camera | Microphone |
|-----------|--------|------------|
| 1–2       | ON     | ON         |
| 3–9       | ON     | MUTED      |
| 10+       | OFF    | MUTED      |

**Per-event overrides** — tag the event description (case-insensitive):

```
[cam:on] [mic:off]      → force camera on, mic muted
[cam:off]               → force camera off (keep heuristic mic)
[mic:muted]             → force mic muted
```

**Mic source — lid state:**
- **macOS** via `ioreg AppleClamshellState` → `Yes`=closed (external mic), `No`=open (MacBook mic).
- **Linux** via `/proc/acpi/button/lid/*/state` → "open"/"closed".
- **Other OS / unknown** → reports `default`; the meeting app uses whatever the system has selected.

Note: the script reports the policy and launches Camera Hub when present, but it does **not** programmatically flip Zoom/FaceTime/Meet in-app device settings — those apps remember the last-selected device, so flipping it once per app is permanent. (A future patch could AppleScript Zoom's preferences pane.)

**Elgato Virtual Camera:** if Elgato Camera Hub is installed (any OS), it's launched before the meeting opens so the virtual cam is registered. Detection paths:
- macOS: `/Applications/Elgato Camera Hub.app`, `~/Applications/Elgato Camera Hub.app`, `/Applications/Camera Hub.app`
- Linux: `elgato-camera-hub` on PATH, or AppImage at `~/Applications/Elgato*CameraHub*.AppImage`
- Windows/WSL: `${PROGRAMFILES}/Elgato/CameraHub/CameraHub.exe`

**Zoom URL rewriting:** when the picked event has a `https://zoom.us/j/<ID>?pwd=<PWD>` link, it's converted to `zoommtg://zoom.us/join?confno=<ID>&pwd=<PWD>` so the desktop app opens directly (no browser prompt). If `cam=off` from the policy, `&zc=0` is appended.

**Dry-run output (text mode):**
```
dry-run: would join "Weekly Sync" (meet, 3 attendees)
  url=https://meet.google.com/abc-defg-hij
  cam=on mic=muted
  lid=closed mic_source=external
  elgato_hub=/Applications/Elgato Camera Hub.app
```

---

### `twilio-call <to> <from> --twiml <URL>` — Programmatic outbound voice

Real telco call (per-minute cost). Requires `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`. The `--twiml` URL must return TwiML XML describing call behavior — e.g. `https://demo.twilio.com/docs/voice.xml` or a custom Function/Studio flow.

```bash
bin/ops-voice twilio-call "+1234567890" "+15551234567" \
  --twiml "https://demo.twilio.com/docs/voice.xml" --json
```

---

### `twilio-sms <to> <from> "<body>"` — Programmatic outbound SMS

```bash
bin/ops-voice twilio-sms "+1234567890" "+15551234567" "<body>" --json
```

For inbound SMS / WhatsApp routing, point your Twilio webhook at the ops daemon (out of scope for v1).

---

### `bland-call <number> "<prompt>"` — Bland AI agent phone call

AI agent calls the number and follows the natural-language prompt. Recordings + transcripts available via the poll URL printed on success.

```bash
bin/ops-voice bland-call "+1234567890" "<task prompt>" --json
```

Poll with: `curl -H "authorization: $BLAND_AI_API_KEY" https://api.bland.ai/v1/calls/<call_id>`.

---

### `tts [text] [--voice voice_id] [--out file.mp3]` — ElevenLabs text-to-speech

**Requires:** `ELEVENLABS_API_KEY` (env / keychain / Doppler).

```bash
EL_KEY="${ELEVENLABS_API_KEY:-$(doppler secrets get ELEVENLABS_API_KEY --plain 2>/dev/null || true)}"
VOICE_ID="${ELEVENLABS_VOICE_ID:-21m00Tcm4TlvDq8ikWAM}"  # Rachel
TEXT="<from $ARGUMENTS>"
OUT_FILE="${OUT_FILE:-/tmp/ops-tts-$(date +%s).mp3}"

curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: $EL_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"$TEXT\",
    \"model_id\": \"eleven_monolingual_v1\",
    \"voice_settings\": {\"stability\": 0.5, \"similarity_boost\": 0.75}
  }" \
  --output "$OUT_FILE"

command -v afplay >/dev/null && afplay "$OUT_FILE" &
echo "Audio saved to: $OUT_FILE"
```

---

### `transcribe [file_path]` — Groq Whisper transcription

**Requires:** `GROQ_API_KEY` (env / keychain / Doppler).

```bash
GROQ_KEY="${GROQ_API_KEY:-$(doppler secrets get GROQ_API_KEY --plain 2>/dev/null || true)}"
AUDIO_FILE="<from $ARGUMENTS>"

[ -f "$AUDIO_FILE" ] || { echo "ERROR: $AUDIO_FILE not found"; exit 1; }

curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" \
  -H "Authorization: Bearer $GROQ_KEY" \
  -F "file=@$AUDIO_FILE" \
  -F "model=whisper-large-v3" \
  -F "response_format=json" | \
  jq -r '.text'
```

---

### `setup` — Configure voice channels

Before asking for anything, auto-scan ALL sources in one background batch (Rule 4: `run_in_background: true`):

```bash
# Env vars
printenv \
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM_NUMBER \
  BLAND_AI_API_KEY ELEVENLABS_API_KEY GROQ_API_KEY \
  ZOOM_API_TOKEN ZOOM_ACCOUNT_ID ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET 2>/dev/null

# Shell profiles
grep -hE 'TWILIO|BLAND|ELEVENLABS|GROQ|ZOOM' \
  ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler — ALL projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  for cfg in dev stg prd; do
    doppler secrets --project "$proj" --config "$cfg" --json 2>/dev/null | \
      jq -r --arg p "$proj" --arg c "$cfg" \
        'to_entries[]
         | select(.key | test("TWILIO|BLAND|ELEVENLABS|GROQ|ZOOM"; "i"))
         | "\(.key)=\(.value.computed | .[0:12])... (doppler:\($p)/\($c))"'
  done
done

# Keychain
for svc in twilio bland-ai elevenlabs groq zoom; do
  security find-generic-password -s "$svc" -w 2>/dev/null >/dev/null \
    && echo "[keychain] $svc ✓"
done

# Native macOS prerequisites
ls /Applications/zoom.us.app \
   /System/Applications/FaceTime.app \
   /System/Applications/Phone.app 2>/dev/null
```

Validate found keys (in parallel):

| Channel    | Probe                                                                              |
|------------|------------------------------------------------------------------------------------|
| Twilio     | `curl -u "$SID:$TOKEN" https://api.twilio.com/2010-04-01/Accounts/$SID.json`       |
| Bland      | `curl -H "authorization: $KEY" https://api.bland.ai/v1/me`                         |
| ElevenLabs | `curl -H "xi-api-key: $KEY" "https://api.elevenlabs.io/v1/voices?page_size=1"`     |
| Groq       | `curl -H "Authorization: Bearer $KEY" https://api.groq.com/openai/v1/models`       |
| Zoom       | `curl -H "Authorization: Bearer $TOKEN" https://api.zoom.us/v2/users/me`           |

Report each as `[service] ✓ connected` or `[service] ✗ <error>`. **Rule 3 applies — never silently skip a channel.** For each unset service, present `AskUserQuestion` with `[Paste manually]` / `[Deep hunt — spawn agent]` / `[Skip]`.

Persist to `preferences.json`:

```json
{
  "channels": {
    "voice": {
      "backend": "native+twilio+zoom+bland",
      "native": {"phone": true, "facetime": true, "zoom": true},
      "twilio": {"status": "configured", "from_number": "env:TWILIO_FROM_NUMBER"},
      "bland":  {"status": "configured"},
      "zoom":   {"status": "configured"}
    }
  },
  "default_channels": ["whatsapp", "email", "telegram", "slack", "voice"]
}
```

---

## Routing from `/ops:comms`

Voice is wired into `/ops:comms` send-flow. The router resolves intent like:

| User says                              | Resolves to                                |
|----------------------------------------|--------------------------------------------|
| `call <name>`                          | `ops-voice phone <number>`                 |
| `facetime <name>`                      | `ops-voice facetime <handle>`              |
| `start a zoom`                         | `ops-voice zoom start`                     |
| `text <name> "..."`                    | `ops-voice twilio-sms ... "..."`           |
| `have an AI call <name> and tell ...`  | `ops-voice bland-call <number> "..."`      |

Contact-number lookup uses the same contact resolver as WhatsApp (`mcp__whatsapp__search_contacts`) plus an optional `contacts.json` map in `preferences.json`.

---

## Mobile / SSH mode (Rule 7)

When `$SSH_CONNECTION$SSH_CLIENT$SSH_TTY` is set or `$OPS_MOBILE=1`:
- `bin/ops-voice` still works for API channels.
- Native channels (`phone`, `facetime`, `zoom start|join`) require a local macOS session — the script returns a plain-text instruction to open the URL on the host instead of calling `open` directly. The script must source `lib/opener.sh` and use `ops_open_url` for URL handoff.

(v1 of `bin/ops-voice` calls `/usr/bin/open` directly — Rule 7 adapter is a v1.1 follow-up; tracked in CHANGELOG.)

---

## Execution

1. Resolve the sub-command from `$ARGUMENTS` (first word).
2. For native handlers (phone/facetime/zoom start|join), shell out to `bin/ops-voice` — exit fast.
3. For API channels (twilio/bland/zoom-schedule/tts/transcribe), resolve credentials in order, then curl.
4. If a required key is missing, suggest `/ops:ops-voice setup`.
5. For 1:1 outbound channels (twilio-call/sms, bland-call): stage one draft → `AskUserQuestion` → send → next.
