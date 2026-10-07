"""Offline contracts exercise shipped release code; external effects are sentinels."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'bin/ops-release'


def block(start, end):
    return RELEASE.read_text().split(start, 1)[1].split(end, 1)[0]


class ReleaseTests(unittest.TestCase):
    def test_no_hook_bypass_or_destructive_cleanup(self):
        text = RELEASE.read_text()
        self.assertNotIn('commit --no-verify', text)
        self.assertNotIn('worktree remove --force', text)
        self.assertNotIn('branch -D', text)
        self.assertIn('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', text)

    def test_required_skipped_ci_is_rejected(self):
        # Exercise the production jq acceptance predicate, not a duplicate policy.
        text = RELEASE.read_text()
        predicate = next(line for line in text.splitlines() if line.strip().startswith('all_finished='))
        import json
        for bucket in ('skipping', 'neutral', 'pending', 'fail', 'cancel', 'pass'):
            expected = 'true' if bucket == 'pass' else 'false'
            value = json.dumps([{'name': 'required', 'bucket': bucket}])
            code = 'checks_json=\'' + value + '\'; ' + predicate + '; test "$all_finished" = ' + expected
            self.assertEqual(subprocess.run(['bash', '-c', code]).returncode, 0, bucket)
        required_line = next(line for line in text.splitlines() if line.strip().startswith('required_seen='))
        code = 'checks_json=\'[{"name":"one","bucket":"pass"}]\'; required_checks=\'["one","missing"]\'; ' + required_line + '; test "$required_seen" = false'
        self.assertEqual(subprocess.run(['bash', '-c', code]).returncode, 0)

    def test_lockfile_bump_and_merge_sha_are_explicit(self):
        text = RELEASE.read_text()
        self.assertIn('package-lock.json', text)
        self.assertIn('packages[""].version', text)
        tagging = block('  if [ "$do_tag" -eq 1 ]; then', '\n  # ----- wiki:')
        self.assertIn('merge_commit_sha', tagging)
        self.assertNotIn('rev-parse origin/main', tagging)
        self.assertNotIn('/commits/main', tagging)

    def test_inventory_failure_and_open_prs_stop_before_bump(self):
        inventory = block('# ----- read-only pre-release inventory -----', '# ----- version base -----')
        for body in ('return 1', 'echo "#7 unfinished requested fix"'):
            code = 'set -e; do_sweep=1; dry_run=0; sweep_only=0; GH_REPO=fixture; gh() { ' + body + '; }; ' + inventory + '\necho BUMP'
            result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('BUMP', result.stdout)

    def test_tag_uses_pr_merge_sha_not_concurrent_main(self):
        tag = block('    merged_pr=', '\n  # ----- wiki:')
        tag = 'merged_pr=' + tag.rsplit('\n  fi', 1)[0]
        code = '''set -e; PR_URL=https://example.com/pull/7; GH_REPO=fixture; REPO_ROOT=fixture; NEW=1.0.1
 gh() { echo '{"merged":true,"merge_commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; }
 git() { case "$*" in *show-ref*) return 1;; *tag*) printf '%s\\n' "$*";; *fetch*|*push*) return 0;; *) echo WRONG_MAIN; return 92;; esac; }
''' + tag
        result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result.stdout)
        self.assertNotIn('WRONG_MAIN', result.stdout)

    def test_version_and_lock_bump_actual_code(self):
        bump = block('# 1+2+3. bump version in plugin.json, the marketplace registry, and package.json', '\nwHERMES=')
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, body in {'plugin.json': '{"version":"1.0.0"}', 'market.json': '{"plugins":[{"name":"ops","version":"1.0.0"}]}', 'package.json': '{"version":"0.1.0"}', 'package-lock.json': '{"version":"0.1.0","packages":{"":{"version":"0.1.0"},"node_modules/fixture":{"version":"7.0.0"}}}'}.items():
                (root / name).write_text(body)
            code = 'set -e; WT="$1"; wPLUGIN="$WT/plugin.json"; wMKT="$WT/market.json"; NEW=1.0.1; PLUGIN_NAME=ops; PACKAGE_REL=package.json; ' + bump
            result = subprocess.run(['bash', '-c', code, 'test', str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            import json
            lock = json.loads((root / 'package-lock.json').read_text())
            self.assertEqual(lock['version'], '1.0.1')
            self.assertEqual(lock['packages']['']['version'], '1.0.1')
            self.assertEqual(lock['packages']['node_modules/fixture']['version'], '7.0.0')

    def test_existing_branch_and_worktree_are_preserved(self):
        guard = block('WT="$REPO_ROOT/.worktrees/$BR"', '\nwPLUGIN=')
        with tempfile.TemporaryDirectory() as d:
            for existing in (True, False):
                path = Path(d) / ('existing' if existing else 'missing')
                if existing:
                    path.mkdir()
                    (path / 'work').write_text('untouched')
                code = 'set -e; WT="$1"; BR=release/fixture; REPO_ROOT=fixture; main_sha=fixture; git() { case "$*" in *show-ref*) return 0;; *) echo MUTATION; return 92;; esac; }; ' + guard
                result = subprocess.run(['bash', '-c', code, 'test', str(path)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('MUTATION', result.stdout)
                if existing:
                    self.assertEqual((path / 'work').read_text(), 'untouched')

    def test_dry_run_is_read_only_and_uses_remote_main(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            log = root / 'calls'
            for name, body in {
                'git': '''echo "git $*" >> "$CALL_LOG"; case " $* " in *' fetch '*|*' worktree '*|*' commit '*|*' push '*) exit 90;; esac; exec /usr/bin/git "$@"''',
                'gh': '''echo "gh $*" >> "$CALL_LOG"
case "$*" in
 *'/commits/main'*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;;
 *'contents/'*'plugin.json'*) echo '{"version":"99.0.0"}';;
 *'contents/'*'CHANGELOG.md'*) printf '## Unreleased\\n\\n### Fixed\\n- remote pending fix\\n';;
 *) exit 91;;
esac''',
                'claude': 'echo AI >> "$CALL_LOG"; exit 92',
                'curl': 'echo curl >> "$CALL_LOG"; exit 93',
            }.items():
                p = root / name
                p.write_text('#!/bin/sh\n' + body + '\n')
                p.chmod(0o755)
            before = subprocess.check_output(['/usr/bin/git', 'status', '--porcelain'], cwd=ROOT)
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'], CALL_LOG=str(log))
            result = subprocess.run(['bash', str(RELEASE), '--dry-run'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('99.0.0 -> 99.0.1', result.stdout)
            self.assertIn('remote pending fix', result.stdout)
            calls = log.read_text()
            self.assertNotIn('fetch', calls)
            self.assertNotIn('AI', calls)
            self.assertNotIn('curl', calls)
            self.assertIn('ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', calls)
            self.assertEqual(subprocess.check_output(['/usr/bin/git', 'status', '--porcelain'], cwd=ROOT), before)


if __name__ == '__main__':
    unittest.main()
