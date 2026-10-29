#!/usr/bin/env python3
"""Run the operator's single Mixforge engine without shell interpolation."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def engine_command():
    executable = os.environ.get('MIXFORGE_EXECUTABLE')
    if executable:
        resolved = shutil.which(os.path.expanduser(executable))
        if not resolved:
            raise ValueError('MIXFORGE_EXECUTABLE is not an executable file')
        return [resolved]
    source = os.environ.get('MIXFORGE_SOURCE')
    if source:
        root = Path(source).expanduser().resolve()
        if not (root / 'mixforge' / '__main__.py').is_file():
            raise ValueError('MIXFORGE_SOURCE must name the directory containing mixforge/__main__.py')
        interpreter = os.environ.get('MIXFORGE_PYTHON', sys.executable)
        resolved = shutil.which(os.path.expanduser(interpreter))
        if not resolved:
            raise ValueError('MIXFORGE_PYTHON is not an executable file')
        return [resolved, '-I', '-c',
                'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); '
                'runpy.run_module("mixforge",run_name="__main__")', str(root)]
    bundled = Path(__file__).resolve().parent.parent / 'skills' / 'ops-mix' / 'engine'
    if (bundled / 'mixforge' / '__main__.py').is_file():
        interpreter = shutil.which(os.path.expanduser(os.environ.get('MIXFORGE_PYTHON', sys.executable)))
        if not interpreter:
            raise ValueError('MIXFORGE_PYTHON is not an executable file')
        return [interpreter, '-I', '-c',
                'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); '
                'runpy.run_module("mixforge",run_name="__main__")', str(bundled)]
    executable = shutil.which('mixforge')
    if not executable:
        raise ValueError('Mixforge is unavailable: configure MIXFORGE_EXECUTABLE or MIXFORGE_SOURCE with MIXFORGE_PYTHON')
    return [executable]


def main():
    try:
        command = engine_command()
        return subprocess.run(command + sys.argv[1:], check=False).returncode
    except (ValueError, OSError) as error:
        print(f'ops-mix: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
