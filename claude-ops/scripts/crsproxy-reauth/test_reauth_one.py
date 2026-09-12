#!/usr/bin/env python3
"""Regression tests for same-email seat selection in cliproxy-reauth-one."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "cliproxy-hub" / "cliproxy-reauth-one.sh"


class TestReauthOneSeatIdentity(unittest.TestCase):
    def test_forwards_exact_auth_file_and_organization(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            auth_dir = root / "auths"
            auth_dir.mkdir()
            args_file = root / "args.json"
            auth_file = auth_dir / "claude-operator-max.json"
            auth_file.write_text(json.dumps({
                "email": "operator@example.com",
                "organization_uuid": "max-org",
                "organization_name": "Operator Max",
            }))
            (root / "reauth_seats.json").write_text(json.dumps({"seats": [
                {
                    "provider": "claude",
                    "email": "operator@example.com",
                    "auth_file": "claude-operator-team.json",
                    "profile_id": "team-profile",
                    "organization_uuid": "team-org",
                },
                {
                    "provider": "claude",
                    "email": "operator@example.com",
                    "auth_file": auth_file.name,
                    "profile_id": "max-profile",
                    "organization_uuid": "max-org",
                    "organization_name": "Operator Max",
                },
            ]}))
            (root / "bu_profile_reauth.py").write_text(
                "import json, os, sys\n"
                "open(os.environ['ARGS_FILE'], 'w').write(json.dumps(sys.argv[1:]))\n"
            )

            env = {
                **os.environ,
                "ARGS_FILE": str(args_file),
                "CLIPROXY_ROOT": str(root),
                "CLIPROXY_AUTH_DIR": str(auth_dir),
                "CLIPROXY_PYTHON": os.sys.executable,
            }
            result = subprocess.run(
                ["bash", str(SCRIPT), "claude", "operator-max", str(auth_file)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(args_file.read_text())
            self.assertEqual(args[args.index("-profile-id") + 1], "max-profile")
            self.assertEqual(args[args.index("-auth-file") + 1], auth_file.name)
            self.assertEqual(
                args[args.index("-expected-organization-uuid") + 1], "max-org")
            self.assertEqual(
                args[args.index("-expected-organization-name") + 1], "Operator Max")


if __name__ == "__main__":
    unittest.main()
