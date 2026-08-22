# CLI/API reference

## CLI/API Reference

### bin/ops-dash

| Command                                                                         | Usage                                | Output                                     |
| ------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-dash`                                            | Render hybrid live command center    | 12-section live dashboard                  |
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-dash 2>/dev/null \|\| echo "DASH_RENDER_FAILED"` | Render with failure detection        | Dashboard or `DASH_RENDER_FAILED` sentinel |
| `OPS_MOBILE=1 ${CLAUDE_PLUGIN_ROOT}/bin/ops-dash`                               | Plain-text compact mode (SSH/mobile) | No ANSI boxes, single-line sections        |

The bin script fires all 12 data probes in parallel (background subshells writing to a tmpdir), renders an animated loading bar while they run, then renders sections sequentially top-to-bottom. Each section degrades to `(no data)` if its probe fails — the script never crashes.

**Live data rendered per section:**

1. **HERO** — pixel-art logo (gradient cyan→violet), vitals strip: fires · unread · PRs · MRR · GSD active
2. **FIRES** — CI failures across registry repos (via `gh run list --repo`)
3. **INBOX** — WhatsApp `recent_chats`, Email `inbox_count`, Slack workspaces, Telegram, Notion
4. **OPEN PRs** — all orgs via GraphQL (`gh api graphql`), no git-cwd required; shows age, CI state, review state
5. **PORTFOLIO** — git dirty/ahead status per registered project path
6. **REVENUE & COSTS** — FinOps dashboard (requires `FINOPS_DASHBOARD_URL` + `FINOPS_OPS_API_TOKEN`), Shopify health
7. **MARKETING** — `bin/ops-marketing-dash` health score per project
8. **LINEAR** — in-progress + urgent issues (requires `LINEAR_API_KEY`)
9. **DEPLOYS** — ECS Fargate desired/running/pending per cluster (requires AWS CLI)
10. **COMPETITOR INTEL** — latest report from `${OPS_DATA_DIR}/reports/competitor-intel/`
11. **YOLO REPORTS** — `/tmp/yolo-*/` directories with verdict summaries
12. **QUICK ACTIONS** — keyboard shortcuts 1-9, 0, a-h (where `h` = smart-home if `home_automation` is configured in `$PREFS_PATH`; FAQ moves to `?`). Status indicator next to `h`: green if all Homey devices online and no alarms, yellow if any device offline, red if active critical alarm. Hidden entirely if `home_automation` is not configured.

**Schema fixes vs previous version:**

- Unread: was reading `.whatsapp.count` / `.email.count` (always 0). Now reads `.channels.whatsapp.recent_chats` / `.channels.email.inbox_count`.
- PRs: was using `gh pr list` without `--repo` (fails outside git cwd). Now uses `gh api graphql` — works from any directory.

The skill reads `preferences.json` separately to check for warnings before invoking the script.

---

