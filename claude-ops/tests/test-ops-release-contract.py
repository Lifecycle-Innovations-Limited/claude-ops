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
        tagging = block('release_tag_merge() {', '\nRELEASE_REQUIRED_CHECKS=')
        self.assertIn('merge_commit_sha', tagging)
        self.assertNotIn('rev-parse origin/main', tagging)
        self.assertNotIn('/commits/main', tagging)

    def test_status_query_failure_cannot_become_empty_success(self):
        function = 'pr_checks_json() {' + block('pr_checks_json() {', '\nwait_for_release_ci()')
        code = '''run_bounded() { return 1; }
 gh_api() { case "$*" in *check-runs*) echo '{"check_runs":[{"name":"required","status":"completed","conclusion":"success"}]}';; *) return 1;; esac; }
''' + function + '\npr_checks_json fixture head 1'
        result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, 'failed status read was accepted as empty statuses')

    def test_merge_gate_requires_review_proof(self):
        self.assertTrue('release_review_gate() {' in RELEASE.read_text(), 'same-head review/thread/Copilot gate is absent')

    def test_same_head_review_gate_negative_fixtures(self):
        import copy
        import json
        function = 'release_review_gate() {' + block('release_review_gate() {', '\nwait_for_release_ci()')
        required_line = next(line for line in RELEASE.read_text().splitlines() if line.startswith('RELEASE_REQUIRED_CHECKS='))
        head = 'a' * 40
        detail = {'state': 'open', 'draft': False, 'base': {'ref': 'main'}, 'head': {'sha': head}, 'mergeable': True, 'mergeable_state': 'clean'}
        reviews = [[{'commit_id': head, 'user': {'type': 'Bot', 'login': 'copilot-pull-request-reviewer[bot]'}, 'state': 'COMMENTED'}]]
        def page(resolved, more):
            return {'data': {'repository': {'pullRequest': {'headRefOid': head, 'reviewThreads': {'nodes': [{'isResolved': resolved}], 'pageInfo': {'hasNextPage': more, 'endCursor': 'next' if more else None}}}}}}
        threads = [page(True, True), page(True, False)]
        required = json.loads(required_line.split('=', 1)[1].strip("'"))
        checks = [{'name': name, 'bucket': 'pass'} for name in required]
        for case in ('valid', 'copilot_missing', 'copilot_stale', 'copilot_spoofed', 'unresolved_second_page', 'partial_pagination', 'graphql_error', 'graphql_head_changed', 'final_head_changed', 'conflict', 'unknown_mergeable', 'skipped_ci', 'missing_ci', 'reviews_read_error', 'threads_read_error', 'checks_read_error', 'final_read_error'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                current, final, r, t, c = (copy.deepcopy(value) for value in (detail, detail, reviews, threads, checks))
                if case == 'copilot_missing': r = [[]]
                elif case == 'copilot_stale': r[0][0]['commit_id'] = 'b' * 40
                elif case == 'copilot_spoofed': r[0][0]['user']['type'] = 'User'
                elif case == 'unresolved_second_page': t[1]['data']['repository']['pullRequest']['reviewThreads']['nodes'][0]['isResolved'] = False
                elif case == 'partial_pagination': t[-1]['data']['repository']['pullRequest']['reviewThreads']['pageInfo']['hasNextPage'] = True
                elif case == 'graphql_error': t[1]['errors'] = [{'message': 'read failed'}]
                elif case == 'graphql_head_changed': t[1]['data']['repository']['pullRequest']['headRefOid'] = 'b' * 40
                elif case == 'final_head_changed': final['head']['sha'] = 'b' * 40
                elif case == 'conflict': final['mergeable'] = False
                elif case == 'unknown_mergeable': final['mergeable'] = None
                elif case == 'skipped_ci': c[0]['bucket'] = 'skipping'
                elif case == 'missing_ci': c.pop()
                for name, value in {'detail': current, 'final': final, 'reviews': r, 'threads': t, 'checks': c}.items():
                    (root / name).write_text(json.dumps(value))
                mocks = '''run_bounded() { shift; "$@"; }
 gh() {
   case "$*" in
    *graphql*) [ "$CASE" != threads_read_error ] || return 1; cat "$FIX/threads" ;;
    *'/reviews?'*) [ "$CASE" != reviews_read_error ] || return 1; cat "$FIX/reviews" ;;
    *'/pulls/7'*) if [ -e "$FIX/first" ]; then [ "$CASE" != final_read_error ] || return 1; cat "$FIX/final"; else touch "$FIX/first"; cat "$FIX/detail"; fi ;;
    *) return 92 ;;
   esac
 }
 pr_checks_json() { [ "$CASE" != checks_read_error ] || return 1; cat "$FIX/checks"; }
'''
                code = 'set -euo pipefail; GH_REPO=fixture/repo; ' + required_line + '\n' + mocks + function + '\nrelease_review_gate https://example.com/pull/7 ' + head
                result = subprocess.run(['bash', '-c', code], env=dict(os.environ, FIX=str(root), CASE=case), capture_output=True, text=True)
                if case == 'valid': self.assertEqual(result.returncode, 0, result.stderr)
                else: self.assertNotEqual(result.returncode, 0, case)

    def test_inventory_failure_and_open_prs_stop_before_bump(self):
        inventory = block('# ----- read-only pre-release inventory -----', '# ----- version base -----')
        for body in ('return 1', 'echo "#7 unfinished requested fix"'):
            code = 'set -e; do_sweep=1; dry_run=0; sweep_only=0; GH_REPO=fixture; gh() { ' + body + '; }; ' + inventory + '\necho BUMP'
            result = subprocess.run(['bash', '-c', code], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('BUMP', result.stdout)

    def tag_run(self, failure=''):
        function = 'release_tag_merge() {' + block('release_tag_merge() {', '\nRELEASE_REQUIRED_CHECKS=')
        code = '''set -euo pipefail; GH_REPO=fixture/repo; REPO_ROOT=fixture
 gh() { [ "$FAIL" != pr-read ] || return 1
        [ "$FAIL" != no-sha ] || { echo '{"merged":true}'; return 0; }
        echo '{"merged":true,"merge_commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; }
 git() { case "$*" in
   *fetch*) [ "$FAIL" != fetch ] ;;
   *show-ref*) [ "$FAIL" = tag-differs ] ;;
   *rev-parse*) echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
   *'tag -a'*) [ "$FAIL" != tag-create ] && printf '%s\\n' "$*" ;;
   *push*) [ "$FAIL" != push ] ;;
   *) echo WRONG_MAIN; return 92 ;;
 esac; }
 push_tag_via_api() { [ "$FAIL" != push ]; }
''' + function + '\nrelease_tag_merge https://example.com/pull/7 1.0.1'
        return subprocess.run(['bash', '-c', code], env=dict(os.environ, FAIL=failure), capture_output=True, text=True)

    def test_tag_uses_pr_merge_sha_not_concurrent_main(self):
        result = self.tag_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result.stdout)
        self.assertNotIn('WRONG_MAIN', result.stdout)

    def test_tag_failures_report_merged_not_tagged_with_recovery(self):
        for failure in ('pr-read', 'no-sha', 'fetch', 'tag-differs', 'tag-create', 'push'):
            with self.subTest(failure=failure):
                result = self.tag_run(failure)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn('merged, NOT tagged', result.stderr)
                self.assertIn('recover with: ', result.stderr)
                self.assertIn('push origin v1.0.1', result.stderr)

    def test_release_exit_is_not_success_when_untagged(self):
        text = RELEASE.read_text()
        self.assertIn('release_tag_merge "$PR_URL" "$NEW" || tag_status=$?', text)
        tail = text.split('release_tag_merge "$PR_URL" "$NEW" || tag_status=$?', 1)[1]
        self.assertIn('if [ "$tag_status" -ne 0 ]', tail)
        self.assertIn('exit 3', tail.split('ops-release: done.', 1)[0])

    def test_wiki_failures_stay_warnings(self):
        wiki = block('  # ----- wiki:', '\n  if [ "$tag_status" -ne 0 ]')
        for failure in ('commit', 'push'):
            with self.subTest(failure=failure):
                code = '''set -euo pipefail; do_wiki=1; GH_REPO=fixture/repo; NEW=1.0.1; REL_DATE=2026-01-01; notes=x
 WT="$(mktemp -d)"; mkdir -p "$WT/claude-ops/skills" "$WT/claude-ops/agents"
 git() { case "$*" in
   *clone*) mkdir -p "${@: -1}"; echo page > "${@: -1}/Home.md" ;;
   *status*) echo ' M Home.md' ;;
   *'add -A'*) return 0 ;;
   *commit*) [ "$FAIL" != commit ] ;;
   *push*) [ "$FAIL" != push ] ;;
   *) return 0 ;;
 esac; }
#''' + wiki + '\necho REACHED_END'
                result = subprocess.run(['bash', '-c', code], env=dict(os.environ, FAIL=failure), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('REACHED_END', result.stdout)
                self.assertIn('WARNING wiki ' + failure + ' failed', result.stderr)

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
