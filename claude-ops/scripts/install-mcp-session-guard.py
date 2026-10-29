#!/usr/bin/env python3
"""Stage owner-only launcher and LaunchAgent. Never load or bootstrap it."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True, help='New owner-controlled staging directory')
    args = parser.parse_args()
    destination = args.destination.absolute()
    if destination.exists() or any(p.is_symlink() for p in [destination, *destination.parents]):
        parser.error('destination must be new and have no symlink components')
    os.umask(0o077)
    destination.mkdir(mode=0o700, parents=True)
    script = destination / 'ops-mcp-session.py'
    shutil.copyfile(Path(__file__).with_name(script.name), script)
    script.chmod(0o700)
    template = Path(__file__).resolve().parents[1] / 'launchd' / 'com.claude-ops.mcp-session.plist.template'
    value = plistlib.loads(template.read_bytes())
    value['ProgramArguments'] = [sys.executable, str(script), 'watchdog']
    with (destination / 'com.claude-ops.mcp-session.plist').open('xb') as output:
        plistlib.dump(value, output)
    print('Staged launcher and plist; launchd was not changed.')


if __name__ == '__main__':
    main()
