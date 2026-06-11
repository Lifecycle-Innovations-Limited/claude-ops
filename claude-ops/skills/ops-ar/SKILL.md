---
name: ops-ar
description: A&R any record like a dance-pop label owner + master producer. Single track, batch, or full Gmail-inbox demo sweep — runs the audio-ar analysis stack (BPM/key/loudness/structure, CLAP mood/genre/hit-lean, Whisper lyrics, Cyanite/Music.ai pro layer) and delivers verdict cards. Can email the full verdict with listen links on request.
argument-hint: "<audio file | URL/Dropbox | \"latest\" | <file1> <file2> ... | inbox [from <sender>...]>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
effort: high
---

# /ops:ops-ar — A&R Command

A&R the given record(s) like a pop/dance-hit label owner + master producer. The deliverable is always the full A&R card per track:

**VERDICT (hit/10 + sign / develop / pass) → WHAT'S WORKING → WHAT'S HOLDING IT BACK → THE PLAN (producer moves) → REFERENCE & POSITIONING → NEXT.**

## Configuration (templatable — no hardcoded personal data)

| Setting | Source | Default |
|---|---|---|
| Audio analysis stack home | `$AUDIO_AR_HOME` env or `ar.stack_home` in `$PREFS_PATH` | `~/audio-ai` |
| Python venv | `$AUDIO_AR_HOME/venv/bin/python` | — |
| Music.ai workflow slug | `$MUSICAI_WORKFLOW` env or Doppler | (required for Music.ai) |
| Cyanite / Music.ai / Soundcharts keys | env / Doppler / `~/.mcp-secrets.env` | — |
| A&R taste profile (label lane, reference acts, tempo sweet spot) | `ar.profile` in `$PREFS_PATH` | dance-pop / feel-good house |

The skill must read these at runtime — never hardcode user names, mailboxes, label names, or absolute `/Users/...` paths.

## Modes

### 1. Single track — `/ops:ops-ar <file|url|latest>`
Spawn the **ar-producer** agent (Opus) with the track:
- Local file → pass the path directly.
- URL/Dropbox → agent downloads first (Dropbox: append `&dl=1`; YouTube: `yt-dlp -x --audio-format mp3`).
- `latest` / empty → newest audio file (`.mp3`, `.wav`, `.m4a`, `.aiff`, `.flac`, `.ogg`, `.aac`) in `~/.claude/jobs/*/tmp/` by mtime — ignore JSON, PNG, and other non-audio artifacts.
- **Subagent MCP rule:** the spawn prompt MUST name the audio-ar tools and include the literal instruction `ToolSearch select:mcp__audio-ar__full_ar_report,mcp__audio-ar__analyze_track,mcp__audio-ar__mood_score,mcp__audio-ar__transcribe_vocals,mcp__audio-ar__separate_stems,mcp__audio-ar__render_visuals,mcp__audio-ar__analyze_stems,mcp__audio-ar__cyanite_analyze,mcp__audio-ar__musicai_analyze,mcp__audio-ar__soundcharts_lookup` — subagents don't inherit MCP discovery.
- Relay the agent's A&R card back verbatim.

### 2. Batch — `/ops:ops-ar <file1> <file2> ...` (or multiple URLs)
A&R multiple local paths or URLs in one invocation:
1. **Collect inputs** — every argument after the skill name is a track (local file or URL/Dropbox). Download URLs first (same rules as single-track).
2. **Dedupe** by md5 (same file copied under different names counts once).
3. **Analyze per track** — spawn **ar-producer** (Opus) per deduped track, in waves of ≤2 (stem separation is CPU-heavy; check `nproc`/`uptime` first). Same subagent MCP rule as single-track mode (include the full `ToolSearch select:mcp__audio-ar__...` list). Relay each agent's full A&R card back verbatim.
4. **Summarize** — compile a ranked verdict table from the per-track cards.

### 3. Inbox sweep — `/ops:ops-ar inbox [from <sender> ...]`
Pull every demo/song from the user's Gmail inbox and A&R them all:
1. **Find demos:** `gog gmail search 'has:attachment (filename:mp3 OR filename:wav OR filename:m4a OR filename:aiff OR filename:flac OR filename:ogg OR filename:aac)'` (add `from:` filters if senders given). Confirm scope with the user if the set is large (>10 threads).
2. **Download attachments to disk** without flooding context: per thread, `gog gmail thread get <tid> -j` → message ids from `thread.messages[].id` (envelope `{downloaded, thread: {messages: [...]}}` — NOT top-level `messages`) → `gog gmail raw <mid> -j` piped to `jq` for audio parts (filename + attachmentId) → `gog gmail attachment <mid> <aid> --out <dir>/<label>__<file>`. Also grep text parts for external links (postal.music, disco.ac, wetransfer, dropbox) — flag link-only demos that need a login as NOT ANALYZED and tell the user to request a file re-send.
3. **Dedupe** by md5 (forwarded demos repeat across threads).
4. **Analyze per track** — spawn **ar-producer** (Opus) per deduped demo, in waves of ≤2 (stem separation is CPU-heavy; check `nproc`/`uptime` first). Same subagent MCP rule as single-track mode (include the full `ToolSearch select:mcp__audio-ar__...` list). Relay each agent's full A&R card back verbatim.
5. **Summarize** — compile a ranked verdict table from the per-track cards.

### 4. Email delivery — "send the verdict to my email"
**House rule: every A&R email ALWAYS includes (a) a per-track DIRECT LISTEN LINK and (b) the FULL A&R card per track — never just the ranked summary.**
- DIRECT listen link (mandatory): a link that actually PLAYS the audio — any external streaming link found in the thread (postal.music, disco.ac, …), OR upload the demo to Google Drive (`gog drive upload <file>` → share → direct link). An email-thread link alone is NOT sufficient.
- Also include the Gmail deep-link (`gog gmail url <threadId>`) — both direct + email link is ideal.
- Rule 6 applies in full: stage the final draft, get explicit per-message approval, then send (one approval = one send).

## Pro APIs (Cyanite / Music.ai / Soundcharts) — operational notes
- **Cyanite** (`$AUDIO_AR_HOME/venv/bin/python pro_apis.py cyanite <file>`): returns genreTags, moodTags, bpmRangeAdjusted, era, voice gender, energyLevel, valence, arousal. **Free/trial plans have a LIFETIME library cap — deleting tracks does NOT free quota.** On `librarySizeLimitExceededError`, route through Music.ai instead.
- **Music.ai** (`pro_apis.py musicai <file>`, needs `$MUSICAI_WORKFLOW`, e.g. a "Metadata Suite" workflow): same Cyanite engine on separate billing + extras — `ai_voice` (Real vs AI-GENERATED — always flag AI guide vocals: they're placeholders needing a real singer), `voice_gender`, `instruments`. Implementation gotchas (already handled in pro_apis.py): requests need a browser `User-Agent` (Cloudflare 1010 blocks default python-urllib), and the upload-URL request must be a clean GET with no body. Convert `.m4a` to mp3 before upload.
- **Soundcharts** (`pro_apis.py soundcharts <query>`): released-catalogue lookup only — useless for unreleased demos; use it for reference-track benchmarking in the REFERENCE section.

## Interpretation guardrails (carry into every card)
- Demo bounces are loud and dull on top — judge song/topline/lane, not the demo master.
- Never infer missing verses / song incompleteness from a sparse Whisper transcript (low vocal in the bounce ≠ unwritten song).
- librosa BPM can read doubled/halved — trust the pro-layer `bpmRangeAdjusted` when available; otherwise confirm by groove.
- Verify hit-claims with data (CLAP commercial lean, valence/arousal), but the verdict is producer judgment, not a printout.

## Fallback
If `mcp__audio-ar__*` is unavailable, run the stack directly via Bash from `$AUDIO_AR_HOME` (`venv/bin/python analyze.py <file>`, `clap_score.py`, `transcribe.py`, `pro_apis.py`). Never fabricate analysis — if nothing ran, say so.
