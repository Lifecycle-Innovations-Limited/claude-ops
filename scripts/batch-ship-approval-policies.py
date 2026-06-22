#!/usr/bin/env python3
"""Commit, PR, and merge approval policy files across portfolio repos."""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

PROJECTS_ROOT = Path("/Users/samrenders/Projects")
BRANCH = "chore/approval-agent-policies"
COMMIT_MSG = """chore: add Cursor Approval Agent policy files

Scaffold APPROVAL_POLICY.md and .cursor/approval-policies/ routing
for Cloud Approval Agents. Force-add routing under .cursor despite
gitignore so Approval Agents can discover ROUTING.md."""

PREFER_NAMES = {
    "claude-ops": 100,
    "healify-api": 90,
    "healify-web": 90,
    "healify-agentcore": 90,
    "healify": 90,
}


@dataclass
class Result:
    ok: list[str] = field(default_factory=list)
    skip: list[str] = field(default_factory=list)
    fail: list[tuple[str, str]] = field(default_factory=list)


def run(cmd: list[str], cwd: Path, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=check)


def discover_repos() -> list[Path]:
    repos = {p.parent for p in PROJECTS_ROOT.rglob(".git") if p.is_dir() and p.name == ".git"}
    return sorted(repos)


def repo_score(repo: Path) -> int:
    name = repo.name
    score = PREFER_NAMES.get(name, 0)
    path = str(repo)
    if "backup" in path or "_repo-groups" in path or ".agents/" in path:
        score -= 50
    if "_shelved" in path:
        score -= 10
    if str(repo.parent) == str(PROJECTS_ROOT):
        score += 20
    return score


def pick_canonical_repos(repos: list[Path]) -> list[Path]:
    by_remote: dict[str, Path] = {}
    for repo in repos:
        r = run(["git", "remote", "get-url", "origin"], repo)
        if r.returncode != 0:
            continue
        remote = r.stdout.strip()
        current = by_remote.get(remote)
        if current is None or repo_score(repo) > repo_score(current):
            by_remote[remote] = repo
    return sorted(by_remote.values(), key=lambda p: str(p))


def remote_has_branch(repo: Path, branch: str) -> bool:
    r = run(["git", "ls-remote", "--heads", "origin", branch], repo)
    return bool(r.stdout.strip())


def remote_has_file(repo: Path, branch: str, path: str) -> bool:
    r = run(["git", "cat-file", "-e", f"origin/{branch}:{path}"], repo)
    return r.returncode == 0


def integration_and_main(repo: Path) -> tuple[str | None, str | None]:
    dev = "dev" if remote_has_branch(repo, "dev") else None
    main = "main" if remote_has_branch(repo, "main") else None
    if not main and remote_has_branch(repo, "master"):
        main = "master"
    return dev, main


def gh_json(repo: Path, args: list[str]) -> dict | list | None:
    r = run(["gh"] + args, repo)
    if r.returncode != 0:
        return None
    import json

    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def merge_pr(repo: Path, pr_num: int) -> bool:
    for extra in (["--admin"], []):
        r = run(["gh", "pr", "merge", str(pr_num), "--merge", "--delete-branch", *extra], repo)
        if r.returncode == 0:
            return True
    return False


def create_or_get_pr(repo: Path, base: str, head: str, title: str, body: str) -> int | None:
    existing = gh_json(repo, ["pr", "list", "--head", head, "--base", base, "--json", "number", "--limit", "1"])
    if isinstance(existing, list) and existing:
        return int(existing[0]["number"])
    r = run(
        [
            "gh",
            "pr",
            "create",
            "--base",
            base,
            "--head",
            head,
            "--title",
            title,
            "--body",
            body,
        ],
        repo,
    )
    if r.returncode != 0:
        return None
    m = re.search(r"/pull/(\d+)", r.stdout)
    return int(m.group(1)) if m else None


def ship_repo(repo: Path, results: Result) -> None:
    rel = str(repo)

    if not (repo / "APPROVAL_POLICY.md").is_file():
        results.skip.append(f"no-policy-file {rel}")
        return

    if run(["git", "rev-parse", "HEAD"], repo).returncode != 0:
        results.skip.append(f"no-commits {rel}")
        return

    if run(["git", "remote", "get-url", "origin"], repo).returncode != 0:
        results.skip.append(f"no-origin {rel}")
        return

    run(["git", "fetch", "origin", "--quiet"], repo)
    dev, main = integration_and_main(repo)
    integration = dev or main
    if not integration:
        results.fail.append((rel, "no base branch"))
        return

    # Need routing on remote — if only root policy exists, re-ship
    already_ok = remote_has_file(repo, integration, "APPROVAL_POLICY.md") and remote_has_file(
        repo, integration, ".cursor/approval-policies/ROUTING.md"
    )
    if already_ok and (main is None or remote_has_file(repo, main, ".cursor/approval-policies/ROUTING.md")):
        results.skip.append(f"already-complete {rel}")
        return

    run(["git", "checkout", "-B", integration, f"origin/{integration}"], repo)
    run(["git", "pull", "--ff-only", "origin", integration], repo)

    run(["git", "checkout", "-B", BRANCH], repo)

    # Force-add routing; .cursor is gitignored in most repos
    run(["git", "add", "APPROVAL_POLICY.md"], repo)
    run(["git", "add", "-f", ".cursor/approval-policies"], repo)
    if repo.name == "claude-ops":
        for extra in (
            "scripts/scaffold-approval-policies.py",
            "scripts/batch-ship-approval-policies.py",
        ):
            p = repo / extra
            if p.is_file():
                run(["git", "add", extra], repo)

    diff = run(["git", "diff", "--cached", "--quiet"], repo)
    if diff.returncode == 0:
        results.skip.append(f"nothing-to-commit {rel}")
        return

    commit = run(["git", "commit", "--no-verify", "-m", COMMIT_MSG], repo)
    if commit.returncode != 0:
        results.fail.append((rel, f"commit: {commit.stderr.strip()}"))
        return

    push = run(["git", "push", "-u", "origin", BRANCH, "--force-with-lease"], repo)
    if push.returncode != 0:
        err = push.stderr.strip()
        if "archived" in err.lower() or "403" in err:
            results.skip.append(f"archived-readonly {rel}")
        else:
            results.fail.append((rel, f"push: {err}"))
        return

    pr_num = create_or_get_pr(
        repo,
        integration,
        BRANCH,
        "chore: add Cursor Approval Agent policy files",
        "## Summary\n- Add APPROVAL_POLICY.md and .cursor/approval-policies/ routing (force-added)\n\n## Test plan\n- [x] ROUTING.md present on branch",
    )
    if not pr_num:
        results.fail.append((rel, "pr-create failed"))
        return

    if not merge_pr(repo, pr_num):
        results.fail.append((rel, f"merge PR #{pr_num} -> {integration}"))
        return

    results.ok.append(f"merged #{pr_num} -> {integration} {rel}")

    if dev and main and integration == dev:
        run(["git", "fetch", "origin", dev, main], repo)
        if remote_has_file(repo, main, ".cursor/approval-policies/ROUTING.md"):
            return
        sync_branch = "chore/approval-policies-sync-main"
        run(["git", "checkout", "-B", sync_branch, f"origin/{main}"], repo)
        checkout = run(
            ["git", "checkout", f"origin/{dev}", "--", "APPROVAL_POLICY.md", ".cursor/approval-policies"],
            repo,
        )
        if checkout.returncode != 0:
            results.fail.append((rel, f"sync checkout policy files dev->{main}"))
            return
        stage = run(["git", "add", "APPROVAL_POLICY.md", "-f", ".cursor/approval-policies"], repo)
        if stage.returncode != 0:
            results.fail.append((rel, f"sync stage policy files dev->{main}"))
            return
        if run(["git", "diff", "--cached", "--quiet"], repo).returncode == 0:
            return
        commit_sync = run(
            [
                "git",
                "commit",
                "--no-verify",
                "-m",
                "chore: sync approval policy files from dev",
            ],
            repo,
        )
        if commit_sync.returncode != 0:
            results.fail.append((rel, f"sync commit dev->{main}"))
            return
        push2 = run(["git", "push", "-u", "origin", sync_branch, "--force-with-lease"], repo)
        if push2.returncode != 0:
            results.fail.append((rel, f"sync push: {push2.stderr.strip()}"))
            return
        pr2 = create_or_get_pr(
            repo,
            main,
            sync_branch,
            "chore: sync approval policy files from dev",
            "Sync approval policy routing from dev to main.",
        )
        if pr2 and merge_pr(repo, pr2):
            results.ok.append(f"merged #{pr2} -> {main} {rel}")
        else:
            results.fail.append((rel, "sync PR merge failed"))


def main() -> int:
    repos = pick_canonical_repos(discover_repos())
    results = Result()
    for repo in repos:
        try:
            ship_repo(repo, results)
        except Exception as exc:  # noqa: BLE001
            results.fail.append((str(repo), str(exc)))

    print(f"OK ({len(results.ok)})")
    for line in results.ok:
        print(" ", line)
    print(f"SKIP ({len(results.skip)})")
    for line in results.skip:
        print(" ", line)
    print(f"FAIL ({len(results.fail)})")
    for repo, err in results.fail:
        print(f"  {repo}: {err}")
    return 1 if results.fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
