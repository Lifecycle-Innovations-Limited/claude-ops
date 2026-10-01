"""Mock every service/process command; never affect live launchd."""
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(os.getenv('OPS_MAC_GUARD_SOURCE', str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/ops-mac/mac-hypertune-guard')))


class GuardTests(unittest.TestCase):
    def run_guard(self, failure=False, matches='', empty_policy=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        (root / 'Library/LaunchAgents').mkdir(parents=True)
        (root / 'Library/LaunchAgents/com.example.forbidden.plist').write_text('fixture')
        policy = root / 'policy.sh'
        policy.write_text('NEVER_AUTO=()\nKEEP_LABEL=\nMESH_LABEL=\n' if empty_policy else 'NEVER_AUTO=(com.example.forbidden)\nKEEP_LABEL=com.example.keepawake\nMESH_LABEL=\n')
        mocks = root / 'mocks.sh'
        mocks.write_text('''launchctl() { printf '%s\\n' "$*" >>"$HOME/actions"; return 1; }
mv() { if [ "$FAIL_MOVE" = 1 ]; then return 1; fi; /bin/mv "$@"; }
rm() { echo rm >>"$HOME/actions"; return 99; }
pgrep() { if [ -n "$MATCHES" ]; then printf '%s\\n' "$MATCHES"; else return 1; fi; }
killall() { echo killall >>"$HOME/actions"; return 99; }
sysctl() { echo 0; }
orbctl() { echo 0; }
''')
        env = dict(os.environ, HOME=str(root), OPS_MAC_POLICY=str(policy), BASH_ENV=str(mocks), FAIL_MOVE=str(int(failure)), MATCHES=matches)
        result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True)
        actions = (root / 'actions').read_text() if (root / 'actions').exists() else ''
        return result, root, actions

    def test_failed_archive_preserves_file_and_never_deletes(self):
        result, root, actions = self.run_guard(True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((root / 'Library/LaunchAgents/com.example.forbidden.plist').exists())
        self.assertNotIn('rm\n', actions)

    def test_empty_policy_is_bash32_safe(self):
        result, root, _ = self.run_guard(empty_policy=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((root / 'Library/LaunchAgents/com.example.forbidden.plist').exists())

    def test_zero_matches_is_normal(self):
        result, _, _ = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_multiple_unowned_sleep_protectors_never_killed(self):
        result, _, actions = self.run_guard(matches='100\n200')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('killall', actions)
        self.assertNotIn('kickstart', actions)


if __name__ == '__main__':
    unittest.main()
