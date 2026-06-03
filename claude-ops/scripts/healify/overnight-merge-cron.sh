#!/usr/bin/env bash
# Overnight autonomous merge + sync + deploy-watch across Healify repos.
# Runs every 5 min. Idempotent. Uses GraphQL primarily, REST as fallback.
set -euo pipefail

source "$HOME/.claude/scripts/lib/once.sh"
claude_once healify-overnight 240 || exit 0

LOG=~/.claude/logs/healify-overnight.log
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) tick ====="

OWNER="Lifecycle-Innovations-Limited"
REPOS=("healify-api" "healify-agentcore")  # add more as we open PRs there

# 0. Budget check
REST_LEFT=$(gh api rate_limit --jq .resources.core.remaining 2>/dev/null || echo 0)
GQL_LEFT=$(gh api rate_limit --jq .resources.graphql.remaining 2>/dev/null || echo 0)
echo "REST: $REST_LEFT | GraphQL: $GQL_LEFT"
if [[ "$GQL_LEFT" -lt 100 && "$REST_LEFT" -lt 50 ]]; then
  echo "Both budgets exhausted — skip"; exit 0
fi

merge_ready_prs() {
  local owner=$1 repo=$2 base=$3
  # BASE-HEALTH GATE (2026-06-03): never pile PRs onto a base whose own CI is red.
  # Individually-green PRs can combine into a broken base; once red, --admin-merging
  # more PRs onto it only compounds the breakage. Gate on the base HEAD rollup.
  local base_state
  base_state=$(gh api graphql -f query='
    query($o:String!,$r:String!,$b:String!){
      repository(owner:$o,name:$r){
        ref(qualifiedName:$b){target{... on Commit{statusCheckRollup{state}}}}}}' \
    -f o="$owner" -f r="$repo" -f b="refs/heads/$base" \
    --jq '.data.repository.ref.target.statusCheckRollup.state // "NONE"' 2>/dev/null || echo NONE)
  if [[ "$base_state" == "FAILURE" || "$base_state" == "ERROR" ]]; then
    echo "  ⛔ BASE $owner/$repo:$base CI rollup=$base_state — HALTING merges to this base this cycle (would compound a broken base)"
    mkdir -p ~/.claude/logs 2>/dev/null || true
    touch ~/.claude/logs/healify-overnight-BASE-RED-"$repo"-"$base".flag 2>/dev/null || true
    return
  fi
  # GraphQL: list open PRs with author + branch info. Allowlist applied below.
  # Only auto-merge:
  #   (a) PRs whose head ref starts with `sync(dev` or `sync/dev` (dev→main sync PRs WE opened), OR
  #   (b) PRs authored by the loop owner (the configured loop owner) AND head branch starts with `fix/` or `feat/` or `chore/` or `sync(`.
  # Skip everything else — humans review.
  local nodes
  nodes=$(gh api graphql -f query='
    query($owner:String!,$repo:String!,$base:String!){
      repository(owner:$owner,name:$repo){
        pullRequests(states:OPEN,baseRefName:$base,first:30){
          nodes{number isDraft mergeable mergeStateStatus headRefName
            author{login}
            commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}' \
    -f owner="$owner" -f repo="$repo" -f base="$base" 2>/dev/null || echo '{}')

  BASE="$base" NODES_JSON="$nodes" python3 <<'PYEOF' | while IFS=$'\t' read -r pr head author; do
import json, os, sys
ALLOWED_AUTHORS = set(filter(None, os.environ.get("OPS_ALLOWED_AUTHORS", "").split(",")))  # e.g. OPS_ALLOWED_AUTHORS=user1,user2
base = os.environ["BASE"]
try:
    d = json.loads(os.environ["NODES_JSON"])
    prs = d["data"]["repository"]["pullRequests"]["nodes"]
except Exception:
    sys.exit(0)
for pr in prs:
    if pr.get("isDraft"):
        continue
    if pr.get("mergeable") != "MERGEABLE":
        continue
    rollup = pr["commits"]["nodes"][0]["commit"].get("statusCheckRollup")
    if not rollup or not isinstance(rollup, dict):
        continue
    ci = rollup.get("state")
    if ci not in ("SUCCESS", "NEUTRAL", "SKIPPED"):
        continue
    # Note: BLOCKED mergeStateStatus (review_required) IS admin-mergeable,
    # so we don't filter on mergeStateStatus. We only require:
    #   - mergeable=MERGEABLE (filtered above)
    #   - CI green
    # --admin bypasses required-reviewer rules. Confirmed manually 2026-05-21
    # on PRs #3885, #3889 (mergeStateStatus=BLOCKED, --admin merged fine).
    author = (pr.get("author") or {}).get("login", "")
    head = pr.get("headRefName", "")
    number = pr["number"]
    is_sync = base == "main" and (
        head == "dev"
        or head.startswith("sync(dev")
        or head.startswith("sync/dev")
    )
    is_owned = author in ALLOWED_AUTHORS and (
        head.startswith("fix/")
        or head.startswith("feat/")
        or head.startswith("chore/")
        or head.startswith("sync(")
        or head.startswith("sync/dev")
    )
    if is_sync or is_owned:
        print(f"{number}\t{head}\t{author}")
    else:
        print(f"SKIP\t{number}\thead={head}\tauthor={author}", file=sys.stderr)
PYEOF
    [[ "$pr" == "SKIP" ]] && continue
    [[ -z "$pr" ]] && continue
    local style="--squash"
    [[ "$base" == "main" ]] && style="--merge"
    echo "  → merge $owner/$repo PR #$pr to $base ($style) [head=$head author=$author]"
    gh pr merge "$pr" --repo "$owner/$repo" $style --admin 2>&1 | head -3 || echo "    merge failed"
  done
}

ensure_sync_pr() {
  local owner=$1 repo=$2
  # Check dev ahead of main via REST (cheap, single call)
  local repo_dir
  case "$repo" in
    healify-api) repo_dir=~/healify-api ;;
    healify-agentcore) repo_dir=~/Projects/healify-agentcore ;;
    *) echo "    unknown repo $repo"; return ;;
  esac
  [[ -d "$repo_dir/.git" ]] || { echo "    no local clone for $repo"; return; }
  git -C "$repo_dir" fetch origin dev main --quiet 2>&1 || true
  local ahead
  ahead=$(git -C "$repo_dir" rev-list --count origin/main..origin/dev 2>/dev/null || echo 0)
  echo "  $repo: dev ahead of main by $ahead"
  if [[ "$ahead" -gt 0 ]]; then
    # Check if sync PR already open
    local sync_pr
    sync_pr=$(gh api graphql -f query='
      query($o:String!,$r:String!){
        repository(owner:$o,name:$r){
          pullRequests(states:OPEN,baseRefName:"main",headRefName:"dev",first:1){
            nodes{number}}}}' -f o="$owner" -f r="$repo" \
      --jq '.data.repository.pullRequests.nodes[0].number // empty' 2>/dev/null)
    if [[ -z "$sync_pr" ]]; then
      echo "  → opening dev→main sync PR for $repo"
      local repo_node_id
      repo_node_id=$(gh api graphql -f query='query($o:String!,$r:String!){repository(owner:$o,name:$r){id}}' -f o="$owner" -f r="$repo" --jq '.data.repository.id')
      gh api graphql -f query='
        mutation($repo:ID!,$title:String!){
          createPullRequest(input:{repositoryId:$repo,baseRefName:"main",headRefName:"dev",title:$title,body:"Overnight automated sync."}){
            pullRequest{number}
          }
        }' -f repo="$repo_node_id" -f title="sync(dev→main): $(date -u +%Y-%m-%d) overnight" 2>&1 | head -3 || echo "    open failed"
    else
      echo "  $repo sync PR #$sync_pr already open"
    fi
  fi
}

watch_ecs() {
  local cluster=$1 service=$2
  local state
  state=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].deployments[0].[status,rolloutState,runningCount,desiredCount]' --output text 2>/dev/null || echo "?")
  echo "  ECS $service: $state"
  if [[ "$state" == *"FAILED"* || "$state" == *"ROLLED_BACK"* ]]; then
    echo "  🔥 DEPLOY FAILURE on $service"
    touch ~/.claude/logs/healify-overnight-FAILURE-"$service".flag
  fi
}

for repo in "${REPOS[@]}"; do
  echo "[$repo]"
  merge_ready_prs "$OWNER" "$repo" "dev"
  ensure_sync_pr "$OWNER" "$repo"
  merge_ready_prs "$OWNER" "$repo" "main"
done

echo "[ECS]"
watch_ecs healify-staging healify-api-staging
watch_ecs healify-production healify-api-prod

echo "===== tick done ====="
