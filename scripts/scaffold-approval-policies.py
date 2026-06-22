#!/usr/bin/env python3
"""Scaffold Cursor Approval Agent policy files across portfolio repos."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Literal

Profile = Literal[
    "healify-core",
    "healify-api",
    "healify-agentcore",
    "healify-web",
    "healify-mobile",
    "healify-docs",
    "healify-ops",
    "claude-ops",
    "infra",
    "mcp",
    "web-saas",
    "shelved",
    "generic",
]

PROJECTS_ROOT = Path("/Users/samrenders/Projects")
SKIP_IF_EXISTS = True

PROFILE_RULES: list[tuple[re.Pattern[str], Profile]] = [
    (re.compile(r"healify-agentcore|healify-llm", re.I), "healify-agentcore"),
    (re.compile(r"healify-api(-mcp|-work)?$|healify-api/", re.I), "healify-api"),
    (re.compile(r"healify-web|healify\.ai$", re.I), "healify-web"),
    (re.compile(r"^healify$|/healify$", re.I), "healify-mobile"),
    (re.compile(r"meditation-service", re.I), "healify-core"),
    (re.compile(r"healify-(docs|partner-docs|press|knowledge|dataroom)", re.I), "healify-docs"),
    (re.compile(r"healify-(marketing|b2b-leadgen|blocks-automations|org|multiplatform)", re.I), "healify-docs"),
    (re.compile(r"healify-(admin|operating-dashboard|grafana|storybook)|testflight", re.I), "healify-ops"),
    (re.compile(r"claude-ops", re.I), "claude-ops"),
    (re.compile(r"network-operations|mcp-gateway|mcp-proxy", re.I), "infra"),
    (re.compile(r"-mcp|api-mcp|esimmcp", re.I), "mcp"),
    (re.compile(r"_shelved/", re.I), "shelved"),
    (re.compile(r"internal/", re.I), "infra"),
]


def classify_repo(repo_path: Path) -> Profile:
    text = str(repo_path)
    for pattern, profile in PROFILE_RULES:
        if pattern.search(text):
            return profile
    return "generic"


def repo_display_name(repo_path: Path) -> str:
    return repo_path.name


def root_policy(profile: Profile, name: str) -> str:
    common_auto = """- Bugbot Review Context reports no findings requiring human review
- Security Review Context reports no findings requiring human review (when enabled)
- Risk score is at or below the agent's configured maximum threshold
- CI checks required for the changed paths are green
- PR does not modify approval policy files or routing files"""

    common_never = """- GitHub Actions workflow changes that weaken CI, skip tests, or broaden deploy permissions
- Deletions or relaxations of auth, security, or safety guardrails
- Changes that remove tests, disable lint/typecheck, or bypass pre-commit hooks
- PRs labeled `security`, `breaking`, or `do-not-auto-approve`"""

    purposes = {
        "healify-core": f"{name} is part of the Healify health platform. Treat health data, user safety, and production deploy paths as high sensitivity.",
        "healify-api": f"{name} is a Healify backend API. Database schema, auth, and PHI-handling paths require strict review.",
        "healify-agentcore": f"{name} hosts Healify AI agents (Anna). Crisis escalation, prompt safety, and model routing are P0.",
        "healify-web": f"{name} is the Healify web app. Auth flows, subscription gates, and crisis UI paths are sensitive.",
        "healify-mobile": f"{name} is the Healify mobile app (React Native/Expo). HealthKit, releases, and in-app safety flows are sensitive.",
        "healify-docs": f"{name} holds Healify documentation or marketing content. Lower runtime risk; still avoid secrets and inaccurate health claims.",
        "healify-ops": f"{name} is Healify internal ops/dashboard tooling. Production visibility and auth boundaries matter.",
        "claude-ops": f"{name} is Claude Code ops infrastructure. Hooks, deploy automation, and credentials are high risk.",
        "infra": f"{name} is infrastructure or platform code. Network, IAM, and secrets changes require human review.",
        "mcp": f"{name} is an MCP server or integration. New tools, scopes, and outbound calls are medium–high risk.",
        "web-saas": f"{name} is a web/SaaS product. Auth, billing, and production config changes need review.",
        "shelved": f"{name} is shelved/archived. Prefer conservative auto-approval; no production deploy assumptions.",
        "generic": f"{name} default approval policy for Cursor Approval Agents.",
    }

    extra_auto = {
        "healify-core": "- Small scoped fixes with tests; no auth/PHI/crisis logic changes",
        "healify-api": "- Docs and test-only changes with no schema or auth impact",
        "healify-agentcore": "- Eval/test-only changes with no prompt, crisis, or tool-scope changes",
        "healify-web": "- Docs, copy, and visual tweaks with no auth/subscription/crisis path changes",
        "healify-mobile": "- Non-release test/docs changes with no HealthKit or native module changes",
        "healify-docs": "- Markdown/copy-only PRs with no embedded secrets",
        "healify-ops": "- Dashboard copy and read-only query tweaks with tests",
        "generic": "- Documentation-only or test-only PRs (≤ 300 lines excluding lockfiles)",
        "shelved": "- Documentation-only changes",
    }

    extra_never = {
        "healify-core": "- Any PHI logging, health data export, or HIPAA-sensitive log changes",
        "healify-api": "- `prisma` migrations, auth middleware, or raw health data exposure\n- Never run or approve `prisma db pull` in PR descriptions as a fix",
        "healify-agentcore": "- Crisis escalation paths, 988 routing, mental-health guardrails\n- Prompt changes that weaken scope or safety refusals\n- Production model ID or Bedrock guardrail changes without review",
        "healify-web": "- Crisis support UI, subscription gates on safety features\n- Auth/session handling and magic-link flows",
        "healify-mobile": "- App Store release config, HealthKit entitlements, production API endpoints\n- Fastlane/EAS production profile changes",
        "healify-docs": "- Medical claims, HIPAA statements, or regulatory copy without review",
        "healify-ops": "- Production dashboard auth or cross-tenant data access",
        "infra": "- IAM policy broadening, public exposure, or secret handling changes",
        "mcp": "- New MCP tools, expanded filesystem/network access, or auth bypass",
        "web-saas": "- Payment/checkout, auth, and PII handling changes",
    }

    auto_lines = [common_auto, extra_auto.get(profile, extra_auto["generic"])]
    never_lines = [common_never]
    if profile in extra_never:
        never_lines.append(extra_never[profile])

    return f"""# {name} — default approval policy

Repository-wide rules for Cursor Approval Agents evaluating pull requests in this repo.

## Purpose

{purposes[profile]}

Default posture: **approve only when risk is low and automated review is clean**.

## Auto-approve when ALL are true

{chr(10).join(f"- {line.lstrip('- ')}" if not line.startswith("-") else line for block in auto_lines for line in block.strip().splitlines())}

## Never auto-approve

{chr(10).join(f"- {line.lstrip('- ')}" if not line.startswith("-") else line for block in never_lines for line in block.strip().splitlines())}

## Reviewer routing

When auto-approval is not allowed, request repo maintainers or the appropriate team for the changed area. Leave the PR unapproved with a short comment if reviewer assignment is unavailable.

## Deploy expectations

For changes shipping dev → staging → main → production: do not auto-approve solely on green CI if production paths, migrations, or release config changed.

## Conflict resolution

Follow the most specific applicable policy. If unclear, follow the stricter rule and do not auto-approve.
"""


def routing_yaml(profile: Profile) -> str:
    base = """- product: Documentation
  boundary: "{docs/**,**/README.md,**/CHANGELOG.md,**/*.md}"
  policies:
    - .cursor/approval-policies/docs-policy.md

- product: CI and workflows
  boundary: ".github/workflows/**"
  policies:
    - .cursor/approval-policies/ci-policy.md

- product: Tests
  boundary: "{**/test/**,**/tests/**,**/*.test.*,**/*.spec.*,e2e/**}"
  policies:
    - .cursor/approval-policies/tests-policy.md

- product: Application runtime
  boundary: "{src/**,app/**,lib/**,packages/**,convex/**,agents/**,lambdas/**}"
  policies:
    - .cursor/approval-policies/runtime-policy.md
"""
    extras = {
        "healify-api": """
- product: Database and migrations
  boundary: "{prisma/**,**/migrations/**,**/schema.prisma}"
  policies:
    - .cursor/approval-policies/migrations-policy.md

- product: Authentication and authorization
  boundary: "{**/auth/**,**/middleware/**,**/guards/**}"
  policies:
    - .cursor/approval-policies/auth-policy.md
""",
        "healify-agentcore": """
- product: Anna agent and prompts
  boundary: "{agents/**,**/prompts/**,evals/**}"
  policies:
    - .cursor/approval-policies/agent-policy.md

- product: Crisis and safety
  boundary: "{**/crisis/**,**/guardrails/**,**/mental_health/**}"
  policies:
    - .cursor/approval-policies/crisis-policy.md
""",
        "healify-web": """
- product: Authentication
  boundary: "{src/**/auth/**,e2e/**/auth/**}"
  policies:
    - .cursor/approval-policies/auth-policy.md

- product: E2E and functional tests
  boundary: "e2e/**"
  policies:
    - .cursor/approval-policies/e2e-policy.md
""",
        "healify-mobile": """
- product: Native and release
  boundary: "{ios/**,android/**,fastlane/**,eas.json,app.json}"
  policies:
    - .cursor/approval-policies/mobile-release-policy.md

- product: HealthKit and health data
  boundary: "{**/healthkit/**,**/HealthKit/**,**/health/**}"
  policies:
    - .cursor/approval-policies/health-data-policy.md
""",
        "healify-core": """
- product: Health data handling
  boundary: "{**/health/**,**/hipaa/**,**/phi/**}"
  policies:
    - .cursor/approval-policies/health-data-policy.md
""",
        "infra": """
- product: Infrastructure as code
  boundary: "{terraform/**,infra/**,cloudformation/**,**/iam/**}"
  policies:
    - .cursor/approval-policies/infra-policy.md
""",
        "mcp": """
- product: MCP tools and server
  boundary: "{src/**,server/**,tools/**}"
  policies:
    - .cursor/approval-policies/mcp-policy.md
""",
        "claude-ops": """
- product: Hooks and safety
  boundary: "{hooks/**,.cursor/hooks/**,**/hooks/**}"
  policies:
    - .cursor/approval-policies/hooks-policy.md

- product: MCP servers
  boundary: "**/mcp-servers/**"
  policies:
    - .cursor/approval-policies/mcp-policy.md

- product: Repository automation scripts
  boundary: "{scripts/**,claude-ops/scripts/**}"
  policies:
    - .cursor/approval-policies/scripts-policy.md
""",
    }
    return base + extras.get(profile, "")


POLICY_SNIPPETS: dict[str, str] = {
    "docs-policy.md": """# Documentation approval policy

## Auto-approve when
- Markdown/copy-only changes with no executable code
- Bugbot and Security Agent report no findings

## Never auto-approve
- Embedded secrets, tokens, or private infrastructure endpoints
- Bundled runtime changes in the same PR
""",
    "ci-policy.md": """# CI workflow approval policy

## Default posture
Never auto-approve workflow changes.

## Human review must verify
- Required checks are not removed without replacement
- Permissions blocks are not unnecessarily broadened
- Deploy/release gates remain intact
""",
    "tests-policy.md": """# Tests approval policy

## Auto-approve when
- Test-only changes with unchanged production logic
- CI green; Bugbot/Security clean

## Never auto-approve
- Disabled/skipped tests paired with production logic changes
""",
    "runtime-policy.md": """# Application runtime approval policy

## Auto-approve when
- Small localized fix with tests and clean automated review
- No auth, billing, health-data, or deploy config impact

## Never auto-approve
- Broad refactors, new external integrations, or removed guardrails
""",
    "auth-policy.md": """# Authentication approval policy

## Default posture
Never auto-approve auth changes.

## Human review must verify
- Session/token validation unchanged or strengthened
- No bypass of dev-login or magic-link safeguards in production paths
- OAuth/OIDC callback URLs and scopes are correct
""",
    "migrations-policy.md": """# Database migration approval policy

## Default posture
Never auto-approve schema migrations.

## Human review must verify
- TimescaleDB hypertable constraints include partition columns
- No `prisma db pull` workflow introduced
- Rollback plan exists for production deploy window
- Shared DATABASE_URL contract with healify-langgraphs preserved if applicable
""",
    "agent-policy.md": """# AI agent approval policy

## Default posture
Never auto-approve agent prompt, tool-scope, or routing changes.

## Human review must verify
- Crisis escalation and 988 routing unchanged or strengthened
- Scope guardrails (clinical overreach, prompt injection) intact
- Eval coverage updated for behavior changes
""",
    "crisis-policy.md": """# Crisis and safety approval policy

## Default posture
Never auto-approve.

## Human review must verify
- P0 crisis paths remain accessible to all user tiers (not subscription-gated)
- `escalate_crisis` tool behavior and 988 copy requirements preserved
- No regression in mental-health guardian structured outputs
""",
    "e2e-policy.md": """# E2E test approval policy

## Auto-approve when
- Selector/assertion fixes only; no app behavior change
- CI E2E green

## Never auto-approve
- Weakened assertions on auth, crisis, or subscription flows
""",
    "mobile-release-policy.md": """# Mobile release approval policy

## Default posture
Never auto-approve release pipeline or native config changes.

## Human review must verify
- EAS/Fastlane profiles target correct environment
- HealthKit entitlements and privacy manifests accurate
- No production API keys embedded in app config
""",
    "health-data-policy.md": """# Health data approval policy

## Default posture
Never auto-approve PHI/health-data handling changes.

## Human review must verify
- No PHI in logs, prompts, commits, or analytics payloads
- HIPAA-sensitive data stays encrypted and access-controlled
- HealthKit/sync scopes are minimal necessary
""",
    "infra-policy.md": """# Infrastructure approval policy

## Default posture
Never auto-approve IaC changes.

## Human review must verify
- IAM least privilege; no public admin exposure
- Secrets via Doppler/vault, not committed plaintext
""",
    "mcp-policy.md": """# MCP server approval policy

## Default posture
Never auto-approve new tools or expanded scopes.

## Human review must verify
- Outbound hosts and filesystem access are justified
- Auth tokens handled server-side only
""",
    "hooks-policy.md": """# Hooks approval policy

## Default posture
Never auto-approve hook changes.
""",
}


def policies_for_profile(profile: Profile) -> dict[str, str]:
    files = {
        "docs-policy.md": POLICY_SNIPPETS["docs-policy.md"],
        "ci-policy.md": POLICY_SNIPPETS["ci-policy.md"],
        "tests-policy.md": POLICY_SNIPPETS["tests-policy.md"],
        "runtime-policy.md": POLICY_SNIPPETS["runtime-policy.md"],
    }
    extras = {
        "healify-api": ["auth-policy.md", "migrations-policy.md"],
        "healify-agentcore": ["agent-policy.md", "crisis-policy.md"],
        "healify-web": ["auth-policy.md", "e2e-" + "policy.md"],
        "healify-mobile": ["mobile-release-policy.md", "health-data-policy.md"],
        "healify-core": ["health-data-policy.md"],
        "infra": ["infra-policy.md"],
        "mcp": ["mcp-policy.md"],
        "claude-ops": ["hooks-policy.md", "mcp-policy.md"],
    }
    for key in extras.get(profile, []):
        files[key] = POLICY_SNIPPETS[key]
    return files


def discover_repos() -> list[Path]:
    repos: list[Path] = []
    for git_dir in PROJECTS_ROOT.rglob(".git"):
        if git_dir.is_dir() and git_dir.name == ".git":
            repos.append(git_dir.parent)
    return sorted(set(repos))


def already_scaffolded(repo: Path) -> bool:
    return (
        (repo / "APPROVAL_POLICY.md").is_file()
        and (repo / ".cursor/approval-policies/ROUTING.md").is_file()
    )


def scaffold_repo(repo: Path, dry_run: bool = False) -> str:
    if SKIP_IF_EXISTS and already_scaffolded(repo):
        return "skip"

    profile = classify_repo(repo)
    name = repo_display_name(repo)
    policy_dir = repo / ".cursor/approval-policies"

    files = {
        repo / "APPROVAL_POLICY.md": root_policy(profile, name),
        policy_dir / "ROUTING.md": routing_yaml(profile),
    }
    files.update({policy_dir / k: v for k, v in policies_for_profile(profile).items()})

    if dry_run:
        return f"would-write:{profile}:{len(files)}"

    policy_dir.mkdir(parents=True, exist_ok=True)
    for path, content in files.items():
        path.write_text(content if content.endswith("\n") else content + "\n", encoding="utf-8")
    return f"ok:{profile}:{len(files)}"


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    repos = discover_repos()
    stats = {"ok": 0, "would-write": 0, "skip": 0, "fail": 0}

    for repo in repos:
        try:
            result = scaffold_repo(repo, dry_run=dry_run)
            if result.startswith("ok"):
                stats["ok"] += 1
                print(f"{result}\t{repo}")
            elif result.startswith("would-write"):
                stats["would-write"] += 1
                print(f"{result}\t{repo}")
            elif result == "skip":
                stats["skip"] += 1
            else:
                stats["fail"] += 1
                print(f"unknown\t{repo}\t{result}", file=sys.stderr)
        except OSError as exc:
            stats["fail"] += 1
            print(f"fail\t{repo}\t{exc}", file=sys.stderr)

    wrote = stats["ok"] if not dry_run else stats["would-write"]
    print(
        f"\nSummary: wrote={wrote} skipped={stats['skip']} failed={stats['fail']} total={len(repos)}",
        file=sys.stderr,
    )
    return 1 if stats["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
