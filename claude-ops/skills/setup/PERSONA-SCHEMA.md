# Persona Schema — `preferences.json .persona`

The setup wizard and every ops touchpoint read `preferences.json` as a **rich, continuously-updated snapshot of the user** so we hyper-personalize and _never ask a question we could have answered ourselves_. This file documents the `.persona` block: how it's built, its shape, and the read/write contract.

This is **generic for any user** — every field is _discovered_ (git identity, env var names, detected OS, transcript mining, web search), never hardcoded to one person.

## How it's populated (layered, highest-confidence wins)

1. **Install-time local scan** — `bin/ops-user-profiler` → `profile.scan.json` (OS, shell, tooling present, MCPs configured, env vendor NAMES, Doppler project names, repo dir names, Claude-config style hints). Offline, no secrets, token-frugal.
2. **Optional web enrichment** — after an explicit `AskUserQuestion` consent step, `agents/user-profiler.md` (Haiku + WebSearch) consumes the scan, searches from the user's git email / name / GitHub account, and writes only unconfirmed suggestions to `profile.prefill.json` until the wizard review screen accepts them. If the user declines, setup must skip external lookups and continue with local-only signals.
3. **Transcript mining** — scans `~/.claude/projects/**/*.jsonl` for recurring frustrations, style corrections ("be terse", "stop asking"), and tools/hooks/plugins in active use → `persona.signals`.
4. **Wizard confirmations** — anything the user confirms or corrects in the GUI is written back with `source: "confirmed"` (highest trust).
5. **Ongoing** — ops skills append observed signals over time (it's a living snapshot, not a one-time form).

## Shape

```jsonc
{
  "persona": {
    "schema": "ops-persona/1",
    "updated_at": "<ISO8601>",
    "identity": {
      "display_name": "Owner", // what we CALL them in briefings
      "full_name": "Owner Example", // resolved, may differ from git name
      "emails": ["..."],
      "gh_account": "...",
      "confidence": "high|medium|low",
      "source": "websearch|git|confirmed|transcript",
    },
    "location": {
      "city": "Example City",
      "country": "XX",
      "timezone": "Etc/UTC",
      "confidence": "...",
      "source": "...",
    },
    "roles": {
      // ranked; drives relevance-prune
      "primary": "founder",
      "secondary": ["developer", "creator", "marketer"],
      "evidence": "repo names, tooling, web persona",
      "confidence": "...",
    },
    "interests": ["preventive-health", "music/A&R", "AI agents"],
    "working_style": {
      "verbosity": "compact|full|minimal",
      "autonomy": "careful|auto|yolo", // see "Autonomy determination" below
      "yolo_enabled": true, // convenience mirror of autonomy=="yolo"
      "preferred_model": "opus|sonnet|haiku",
      "tone": "terse-direct",
      "source": "transcript|claude-config|confirmed",
      "autonomy_evidence": "settings.permissions.defaultMode=bypassPermissions + 0 denials in last 200 tool calls",
    },
    "frustrations": [
      // mined — what annoys them, so we avoid it
      { "text": "verbosity / preamble", "source": "transcript", "seen": 4 },
    ],
    "environment": {
      "os": "linux",
      "pkg_mgr": "dnf",
      "shell": "bash",
      "profile_file": "~/.bashrc",
      "hooks_installed": ["block-outbound-comms", "gh-watch-guard"],
      "plugins_installed": ["gsd", "superpowers", "gstack"],
      "mcps_configured": ["linear", "slack", "whatsapp", "..."],
      "clis_present": ["gh", "aws", "doppler", "..."],
    },
    "relevant_services": ["telegram", "whatsapp", "slack", "email", "stripe", "..."],
    "pruned_services": ["postnl", "ups", "fedex", "dpd"], // hidden from flow, shown in review
    "recommended_tooling": [
      // worth installing, with why + how
      { "tool": "stripe", "why": "you have STRIPE_* keys but no stripe CLI", "install": "dnf install stripe" },
    ],
    "command_expertise": {
      // per ops:command familiarity signal — drives how much the wizard explains
      // each command and which it surfaces first. Keyed by command id (no slash).
      // familiarity: "core"     = always-relevant (ops:setup, ops:go) — never pruned
      //              "familiar" = a dependency the command needs is present (CLI/MCP/
      //                           env-vendor/hook detected) → user likely uses it
      //              "new"      = no detected dependency → introduce it, don't assume
      // source: confidence tier of THIS entry (see merge contract). The profiler
      //         writes "scan_inferred"; the wizard upgrades to "confirmed" when the
      //         user corrects/acknowledges it.
      "ops:setup":   { "familiarity": "core",     "source": "scan_inferred" },
      "ops:deploy":  { "familiarity": "familiar", "source": "scan_inferred" },
      "ops:revenue": { "familiarity": "new",      "source": "scan_inferred" },
    },
  },
}
```

## Autonomy determination (careful / auto / yolo)

Establish the user's risk appetite from **Claude settings + observed behaviour**, not by asking. This sets `working_style.autonomy` and seeds the wizard's default confirm-vs-act posture + the plugin's `yolo_enabled`.

Signals (combine; behaviour outweighs config when they conflict):

- **`~/.claude/settings.json`** — `permissions.defaultMode`: `bypassPermissions` → **yolo**; `acceptEdits`/`dontAsk`/`auto` → **auto**; `default`/`plan` or unset → **careful**. Also weigh the size of `permissions.allow` vs `permissions.ask`/`deny` (large allow-list, empty deny → leans auto/yolo).
- **Launch flags / env** — evidence of `--dangerously-skip-permissions` usage, `CLAUDE_*` autonomy env.
- **Behaviour from transcripts** — denial/approval ratio in recent tool calls: near-zero denials + many auto-approved edits → yolo; frequent "no/stop/let me check" → careful. Frustration signals like "stop asking me" → push toward auto/yolo; "always confirm first" → careful.
- **Existing plugin pref** — a prior `yolo_enabled`/`autonomy` value (source `confirmed`) wins unless behaviour strongly contradicts it (then re-confirm, don't silently flip).

Map to behaviour:

- **careful** → wizard confirms every action; ops skills never auto-execute irreversible/outbound steps.
- **auto** → wizard auto-confirms low-risk; still gates outbound comms + destructive bulk (hard guards always apply regardless).
- **yolo** → fast-path everything low/medium-risk with reasons logged; hard guards (outbound-comms token, rm-rf anchor) STILL apply — autonomy never disables safety hooks.

The wizard presents this as a confirm too: "You run Claude in **yolo** mode (bypassPermissions, ~0 denials) — want ops to match that and auto-act on low-risk steps? [Yes, match it] [No, keep me in the loop]".

## Read/write contract

- **Never clobber** `confirmed`-source fields with lower-confidence scans. Merge by confidence + recency.
- **Never promote enriched identity/location automatically** — web-enriched values remain `source: "unconfirmed"` in `profile.prefill.json` until the user accepts them in the wizard.
- **Never store secret VALUES** in `.persona` — only names/presence. Secrets live in their own keys (file backend) or the keychain via `credential-store.sh`.
- Preserve sibling keys (`partner_registry`, `channels`, behavioral toggles) on every write — merge with `jq`, write tmp, `mv`.
- The wizard's confirm screens read `.persona.identity` / `.location` / `.roles` and present them as "Did I get this right?" — **confirm, don't ask**. Only fall back to a blank prompt when confidence is `low` or a field is absent.
- Relevance-prune reads `.persona.relevant_services` vs `pruned_services`; the pre-completion review screen surfaces `pruned_services` + `recommended_tooling` + any service whose credential wasn't found.
