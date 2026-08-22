# ops-socials — detailed reference

Loaded from the parent SKILL.md. Follow `ops-rules`.

## Routing recipes

**Personal Typefully only:** Every `typefully_*` snippet below that passes `social_set_id: "$SOCIAL_SET_ID"` is for the personal/founder path **after** identity resolution rules out a named project brand; for project-brand intents, use that project's registered engine — never these Typefully calls as a substitute.

### "What's hot in AI Twitter right now"

Invoke `x-research-skill` with a curated query, e.g.:

```
claude code OR "opus 4.7" OR "agent skills" -is:retweet -is:reply min_likes:50 since:24h
```

The skill iterates: searches, follows threads, deep-dives linked content, returns a sourced briefing.

### "Search X for <topic>" / "Find tweets about <topic>"

For one-shot surgical reads, skip x-research-skill and call directly:

```
mcp__x-mcp__search_tweets({ query: "<topic> -is:retweet", max_results: 20, sort_order: "relevancy" })
```

### "Monitor @<handle>"

```
mcp__x-mcp__get_user({ username: "<handle>" })   # one-time to grab user_id
mcp__x-mcp__get_timeline({ user_id: "...", max_results: 25 })
```

### "Anyone @-ing me?"

```
mcp__x-mcp__get_mentions({ user_id: "<your-user-id>" })
```

Resolve `<your-user-id>` once via `get_user({ username: "<your-handle>" })` and cache for the session.

### "Draft a tweet about <topic>" / "Make this a thread"

First consume the performance learnings (see "Auto-consume performance learnings" above) and bias tone/format accordingly. Then stage a Typefully draft. For threads, use `---` on its own line to split posts:

```
mcp__typefully__typefully_create_draft({
  content: "Hook tweet.\n---\nSecond tweet.\n---\nThird tweet.",
  social_set_id: "$SOCIAL_SET_ID",
  platforms: ["x"]
})
```

Return `https://typefully.com/?a=$SOCIAL_SET_ID&d=<draft_id>` and wait for `ok`.

### "Post this to X _and_ LinkedIn"

ONE draft, both platforms:

```
mcp__typefully__typefully_create_draft({
  content: "...",
  social_set_id: "$SOCIAL_SET_ID",
  platforms: ["x", "linkedin"]
})
```

If platform-tailored content is needed, create with primary platform then `typefully_edit_draft` to add the other with different text — still ONE draft, never multiple.

### "Write a LinkedIn post about <topic>"

1. Invoke `linkedin-skills` for tone/structure (human-sounding, not corporate).
2. Push the drafted text to Typefully:
   ```
   mcp__typefully__typefully_create_draft({ content, social_set_id: "$SOCIAL_SET_ID", platforms: ["linkedin"] })
   ```
3. Don't try to publish from inside `linkedin-skills` — it's craft-only.

### "Mention <company> on LinkedIn"

```
mcp__typefully__typefully_linkedin_resolve_linkedin_organization_from_url({ organization_url: "https://www.linkedin.com/company/<slug>/" })
# → returns mention_text like @[Name](urn:li:organization:12345)
# Include that verbatim in the Typefully draft's content.
```

### "Schedule for tomorrow 9am" / "Next available slot"

```
mcp__typefully__typefully_create_draft({ content, social_set_id: "$SOCIAL_SET_ID", schedule_date: "next-free-slot" })
# or ISO: "YYYY-MM-DDTHH:MM:SSZ"
mcp__typefully__typefully_get_queue({ social_set_id: "$SOCIAL_SET_ID", start_date, end_date })  # inspect
```

### "How did last week's posts do?"

```
mcp__typefully__typefully_list_social_set_analytics_posts({
  social_set_id: "$SOCIAL_SET_ID",
  start_date: "YYYY-MM-DD",
  end_date: "YYYY-MM-DD"
})
```

Per-tweet drill-down on impressions/engagement: `mcp__x-mcp__get_metrics({ id })`.

### "Publish a markdown article to X" — not the safe path

`x-article-publisher-skill` automates X's web UI via Playwright. Hard rule 3 forbids that from this router. Instead: stage a Typefully draft that's a hook + summary + a link to the full piece (your blog, Substack, static page). If you genuinely need a native X Article, publish it manually in the X client.

### "Show me the autopilot status" / "/ops-socials my-project" / owner-autopilot read-out

Resolve the command in this order: (1) `$OPS_SOCIAL_AUTOPILOT_CMD` if set; (2) `$PREFS_PATH/preferences.json` → `ops_social.autopilot_cmd`. The value must be a **full shell command** (e.g. `python3 $HOME/tools/<owner>-social-autopilot/status.py`), not a bare `.py` path — the recipe runs it via `bash -c`.

```bash
CMD="${OPS_SOCIAL_AUTOPILOT_CMD:-}"
if [ -z "$CMD" ] && [ -f "$PREFS_PATH/preferences.json" ] && command -v jq >/dev/null 2>&1; then
  CMD="$(jq -r '.ops_social.autopilot_cmd // empty' "$PREFS_PATH/preferences.json" 2>/dev/null)"
fi
if [ -n "$CMD" ]; then bash -c "$CMD"; else echo "no autopilot wired — set OPS_SOCIAL_AUTOPILOT_CMD or ops_social.autopilot_cmd in $PREFS_PATH/preferences.json"; fi
```

Returns per-channel state: connected, queue depth, recent fires, next action. Read-only.

## Pre-flight check (run when troubleshooting)

```bash
# Typefully reachable?
"$HOME/.claude/skills/typefully/scripts/typefully.js" config:show

# x-mcp via proxy reachable? (mcp-proxy daemon must be up)
curl -s -m3 -o /dev/null -w "x-mcp: HTTP %{http_code}\n" http://127.0.0.1:8090/servers/x-mcp/mcp

# Proxy daemon up? (LaunchAgent label is user-specific; check by command rather than label)
pgrep -f "mcp-proxy --named-server" >/dev/null && echo "proxy: up" || echo "proxy: DOWN"
```

If x-mcp returns `000`/timeout: restart the local `mcp-proxy` LaunchAgent (label varies per machine — see the user's own setup).

## State (where things typically live — paths use `$HOME`, never absolute users)

- **x-mcp** code: `$HOME/tools/x-mcp` (built; dist/index.js)
- **x-mcp** keys: `$HOME/tools/x-mcp/.env` (chmod 600; dotenv auto-loads from `__dirname/../.env`)
- **x-mcp** via proxy: `http://127.0.0.1:8090/servers/x-mcp/mcp`
- **Typefully** config: `$HOME/.config/typefully/config.json` (key + default social set)
- **Sub-skills**: `$HOME/.claude/skills/x-research-skill/`, `$HOME/.claude/skills/x-article-publisher-skill/`, `$HOME/.claude/skills/linkedin-skills/`
- **Proxy LaunchAgent**: label is `com.<user>.mcp-proxy` (set by user's local setup); `servers.json` at `$HOME/.claude/mcp-proxy/servers.json`

## When to use this vs going direct

`/ops-socials` is for **mixed/ambiguous intent** ("post about today's AI news", "check X then draft a take", "audit my LinkedIn voice"). For single-purpose calls, go straight to the underlying skill or MCP — this router only adds value when routing IS the work.

## Windsor.ai (optional live data)

If Windsor.ai is connected (`mcp__*Windsor*__*` or a `windsor_api_key`), use it as the
live cross-channel source for organic reach, followers, and engagement per identity (Instagram, Facebook, TikTok, YouTube) — plus how organic feeds blended CAC.
Map accounts per project via `registry.json` → `.projects[].windsor`. Prefer **blended
ROAS** (store/analytics revenue ÷ total ad spend) over platform-reported ROAS. See
[docs/integrations/windsor-ai.md](../../../docs/integrations/windsor-ai.md) for the full playbook (REST + MCP modes,
registry mapping, analysis mandate, and caveats).
Data sanity: if Windsor returns only zeros across sources (Meta + Google spend/impressions and
Instagram reach all exactly 0 over 30d while accounts are connected), treat the data as unavailable —
the plan may be expired (check `get_current_user` → `is_paid`) — warn the user, and never present
zeros as real metrics. `scripts/windsor-data-sanity.sh` automates the check.

Windsor is optional. If Windsor is not connected, returns errors, or returns the
all-zero pattern, fall back to the free direct libraries:
`scripts/lib/ad-spend-aggregator.sh` (paid), `scripts/lib/ga4-data-api.sh`
(analytics), and `scripts/lib/organic-metrics-aggregator.sh` (organic + merchant).
See [docs/integrations/direct-channel-wiring.md](../../../docs/integrations/direct-channel-wiring.md).
Never present zeros from a dead source as real metrics.
