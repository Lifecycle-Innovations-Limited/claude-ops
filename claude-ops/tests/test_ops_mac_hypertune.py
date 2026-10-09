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


class LoadedForbiddenJobTests(unittest.TestCase):
    """A loaded forbidden job: launchctl is a state-file mock, never the real one."""

    def run_loaded(self, bootout_rc=0, bootout_unloads=True, disable_rc=0):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        la = root / 'Library/LaunchAgents'
        la.mkdir(parents=True)
        (la / 'com.example.forbidden.plist').write_text('fixture')
        (root / 'loaded').touch()
        policy = root / 'policy.sh'
        policy.write_text('NEVER_AUTO=(com.example.forbidden)\nKEEP_LABEL=\nMESH_LABEL=\n')
        mocks = root / 'mocks.sh'
        mocks.write_text('''launchctl() {
  printf '%s\\n' "$*" >>"$HOME/actions"
  case "$1" in
    print) [ -e "$HOME/loaded" ] ;;
    list) [ -e "$HOME/loaded" ] ;;
    bootout) [ "$BOOTOUT_UNLOADS" = 1 ] && /bin/rm -f "$HOME/loaded"; return "$BOOTOUT_RC" ;;
    disable) return "$DISABLE_RC" ;;
    *) return 0 ;;
  esac
}
rm() { echo rm >>"$HOME/actions"; return 99; }
pgrep() { return 1; }
sysctl() { echo 0; }
orbctl() { echo 0; }
''')
        env = dict(os.environ, HOME=str(root), OPS_MAC_POLICY=str(policy), BASH_ENV=str(mocks),
                   BOOTOUT_RC=str(bootout_rc), BOOTOUT_UNLOADS=str(int(bootout_unloads)),
                   DISABLE_RC=str(disable_rc))
        result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True)
        log = (root / '.local/share/agent-logs/hypertune-guard.log').read_text()
        plist = la / 'com.example.forbidden.plist'
        return result, log, plist

    def test_verified_bootout_archives_and_succeeds(self):
        result, log, plist = self.run_loaded()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(plist.exists())
        self.assertIn('booted out com.example.forbidden (verified)', log)
        self.assertIn('archived com.example.forbidden.plist', log)

    def test_failed_bootout_keeps_plist_and_fails(self):
        result, log, plist = self.run_loaded(bootout_rc=5, bootout_unloads=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(plist.exists(), 'plist must be kept for a clean retry')
        self.assertNotIn('booted out com.example.forbidden', log.replace('NOT booted out', ''))
        self.assertNotIn('archived com.example.forbidden.plist', log)
        self.assertIn('guard failed', log)

    def test_bootout_success_but_still_loaded_fails_closed(self):
        result, log, plist = self.run_loaded(bootout_rc=0, bootout_unloads=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(plist.exists())
        self.assertNotIn('archived com.example.forbidden.plist', log)

    def test_failed_disable_keeps_plist_and_fails(self):
        result, log, plist = self.run_loaded(disable_rc=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(plist.exists())
        self.assertNotIn('archived com.example.forbidden.plist', log)


@unittest.skipUnless(os.path.exists('/usr/libexec/PlistBuddy'), 'SKIP: mesh enforcement needs macOS PlistBuddy')
class MeshEnforcementTests(unittest.TestCase):
    """Real PlistBuddy on a temporary plist; launchctl is a state-file mock."""

    def run_mesh(self, bootstrap_ok=True, loads_after=True,
                 plist_commands=('Add :RunAtLoad bool true', 'Add :StartInterval integer 60')):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        la = root / 'Library/LaunchAgents'
        la.mkdir(parents=True)
        mesh = la / 'com.example.mesh.plist'
        command = ['/usr/libexec/PlistBuddy', '-c', 'Add :Label string com.example.mesh']
        for entry in plist_commands:
            command += ['-c', entry]
        subprocess.run(command + [str(mesh)], check=True, capture_output=True)
        (root / 'loaded').touch()
        policy = root / 'policy.sh'
        policy.write_text('NEVER_AUTO=()\nKEEP_LABEL=\nMESH_LABEL=com.example.mesh\n')
        mocks = root / 'mocks.sh'
        mocks.write_text('''launchctl() {
  printf '%s\\n' "$*" >>"$HOME/actions"
  case "$1" in
    print) [ -e "$HOME/loaded" ] ;;
    bootout) rm -f "$HOME/loaded" ;;
    bootstrap) [ "$BOOTSTRAP_OK" = 1 ] || return 5; [ "$LOADS_AFTER" = 1 ] && touch "$HOME/loaded"; return 0 ;;
    *) return 0 ;;
  esac
}
pgrep() { return 1; }
sysctl() { echo 0; }
orbctl() { echo 0; }
''')
        env = dict(os.environ, HOME=str(root), OPS_MAC_POLICY=str(policy), BASH_ENV=str(mocks),
                   BOOTSTRAP_OK=str(int(bootstrap_ok)), LOADS_AFTER=str(int(loads_after)))
        result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True)
        log = (root / '.local/share/agent-logs/hypertune-guard.log').read_text()
        values = [subprocess.run(['/usr/libexec/PlistBuddy', '-c', 'Print :' + key, str(mesh)],
                                 capture_output=True, text=True).stdout.strip()
                  for key in ('RunAtLoad', 'StartInterval')]
        return result, log, values

    def test_verified_mesh_enforcement_succeeds(self):
        result, log, values = self.run_mesh()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('mesh policy enforced', log)
        self.assertEqual(values, ['false', '600'])

    def test_malformed_or_missing_values_are_repaired_not_trusted(self):
        cases = {
            'malformed both': ('Add :RunAtLoad string unexpected', 'Add :StartInterval string unexpected'),
            'missing both': (),
            'missing interval': ('Add :RunAtLoad bool false',),
            'malformed interval': ('Add :RunAtLoad bool false', 'Add :StartInterval string soon'),
        }
        for name, commands in cases.items():
            with self.subTest(case=name):
                result, log, values = self.run_mesh(plist_commands=commands)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('mesh policy enforced', log)
                self.assertEqual(values, ['false', '600'])

    def test_compliant_values_are_left_alone(self):
        result, log, values = self.run_mesh(plist_commands=('Add :RunAtLoad bool false', 'Add :StartInterval integer 900'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('mesh policy enforced', log)
        self.assertEqual(values, ['false', '900'])

    def test_failed_bootstrap_is_not_logged_as_enforced(self):
        result, log, _ = self.run_mesh(bootstrap_ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('mesh policy enforced', log)
        self.assertIn('NOT enforced', log)

    def test_unverified_load_is_not_logged_as_enforced(self):
        result, log, _ = self.run_mesh(loads_after=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('mesh policy enforced', log)


if __name__ == '__main__':
    unittest.main()
