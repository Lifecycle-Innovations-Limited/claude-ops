"""Ownership tests call only sourced predicates with mocked process tools."""
import os
import pathlib
import subprocess
import tempfile
import unittest

LIB = pathlib.Path(os.getenv('OPS_MAC_REAPER_LIBRARY', str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/ops-mac/reaper-safety.sh')))


class ReaperTests(unittest.TestCase):
    def predicate(self, body, call):
        return subprocess.run(['/bin/bash', '-c', 'set -uo pipefail; source "$1"; ' + body + '; ' + call, 'test', str(LIB)], capture_output=True).returncode

    def test_alive_non_claude_parent_protected(self):
        self.assertNotEqual(self.predicate('ps() { echo 42; return 0; }', 'ops_reaper_parent_absent 42'), 0)

    def test_dead_parent_permitted(self):
        self.assertEqual(self.predicate('ps() { return 1; }', 'ops_reaper_parent_absent 42'), 0)

    def test_unknown_parent_protected(self):
        self.assertNotEqual(self.predicate('ps() { return 2; }', 'ops_reaper_parent_absent 42'), 0)

    def test_user_managed_pid1_protected(self):
        body = 'ps() { echo 1; }; launchctl() { if [ "$1" = list ]; then printf "PID Status Label\\n100 0 com.example.worker\\n"; else echo system; fi; }'
        self.assertNotEqual(self.predicate(body, 'ops_reaper_unmanaged_orphan 100'), 0)

    def test_system_managed_pid1_protected(self):
        body = 'ps() { echo 1; }; launchctl() { if [ "$1" = list ]; then echo "PID Status Label"; else echo "pid = 100"; fi; }'
        self.assertNotEqual(self.predicate(body, 'ops_reaper_unmanaged_orphan 100'), 0)

    def test_unmanaged_pid1_permitted(self):
        body = 'ps() { echo 1; }; launchctl() { echo "PID Status Label"; }'
        self.assertEqual(self.predicate(body, 'ops_reaper_unmanaged_orphan 100'), 0)

    def test_missing_launchd_inventory_protected(self):
        self.assertNotEqual(self.predicate('ps() { echo 1; }; launchctl() { return 1; }', 'ops_reaper_unmanaged_orphan 100'), 0)

    def test_invalid_identity_protected(self):
        self.assertNotEqual(self.predicate('ps() { return 1; }', 'ops_reaper_parent_absent ""'), 0)

    def integration(self, parent, managed, age='10:00', tty='?', protected=False, reused=False):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / '.claude').mkdir()
            if protected:
                (root / '.claude/.no-auto-kill-work').touch()
            policy = root / 'policy.sh'
            policy.write_text('ORPHAN_PAT=orphan-allow\nSTATEFUL_PAT=stateful-allow\nSINGLETON_NAMES=(example-singleton)\n')
            mocks = root / 'mocks.sh'
            mocks.write_text('''pgrep() { case "$*" in *orphan-allow*|*stateful-allow*) echo 100;; *example-singleton*) printf '200\n201\n';; *) return 1;; esac; }
ps() { case "$*" in *tty=*) echo "${MOCK_TTY:-?}";; *lstart=*) if [ "$REUSED" = 1 ]; then echo start >>"$HOME/starts"; wc -l <"$HOME/starts"; else echo 'fixture-start node'; fi;; *etime=*) echo "$AGE";; *ppid=*) echo "$PARENT";; *command=*) echo node;; *pid=*) return 0;; *) return 1;; esac; }
launchctl() { if [ "$MANAGED" = 1 ] && [ "$1" = list ]; then echo '100 0 com.example.worker'; else echo 'PID Status Label'; fi; }
kill() { echo "kill $*" >>"$HOME/actions"; }
pkill() { echo "pkill $*" >>"$HOME/actions"; }
find() { return 0; }
lsof() { return 1; }
sleep() { return 0; }
''')
            env = dict(os.environ, HOME=str(root), BASH_ENV=str(mocks), OPS_MAC_POLICY=str(policy), PARENT=str(parent), MANAGED=str(int(managed)), AGE=age, MOCK_TTY=tty, REUSED=str(int(reused)))
            result = subprocess.run(['/bin/bash', str(LIB.parent / 'claude-reaper.sh')], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return (root / 'actions').read_text() if (root / 'actions').exists() else ''

    def test_full_reaper_protects_live_non_claude_parent(self):
        self.assertEqual(self.integration(42, False), '')

    def test_full_reaper_protects_managed_pid1(self):
        self.assertEqual(self.integration(1, True), '')

    def test_full_reaper_allows_old_unmanaged_orphan(self):
        self.assertIn('kill 100', self.integration(1, False))

    def test_full_reaper_protects_fresh_orphan(self):
        self.assertEqual(self.integration(1, False, '00:10'), '')

    def test_interactive_process_protected(self):
        self.assertEqual(self.integration(1, False, tty='ttys001'), '')

    def test_existing_active_work_guard_protected(self):
        self.assertEqual(self.integration(1, False, protected=True), '')

    def test_changed_process_identity_protected(self):
        self.assertEqual(self.integration(1, False, reused=True), '')


if __name__ == '__main__':
    unittest.main()
