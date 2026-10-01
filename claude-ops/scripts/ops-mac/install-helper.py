#!/usr/bin/env python3
"""Install one verified helper without starting jobs or changing local policy.

Requires an expected hash of the current destination. Prints its backup path.
Reaper installation also requires its adjacent safety library to be installed
first. Rollback uses the recorded backup; no service is restarted here.
"""
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import shutil
import stat
import tempfile

HELPERS = {"agent-log-rotate", "brain-recall-seed", "mac-hypertune-guard",
           "claude-reaper.sh", "reaper-safety.sh"}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def install(source, target, expected):
    source, target = Path(source), Path(target)
    if expected == "absent":
        if target.exists() or target.is_symlink():
            raise ValueError("destination already exists")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".install.", delete=False) as fh:
                temporary = Path(fh.name)
                fh.write(source.read_bytes())
            temporary.chmod(stat.S_IMODE(source.stat().st_mode))
            # Link a fully written file exclusively; never leave a partial target.
            os.link(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return None
    if target.is_symlink() or not target.is_file():
        raise ValueError("destination must be an existing plain file")
    if digest(target) != expected:
        raise ValueError("current destination bytes differ; refusing install")
    original_stat = target.stat()
    original_mode = stat.S_IMODE(original_stat.st_mode)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = Path(str(target) + ".bak." + stamp)
    shutil.copy2(target, backup)
    os.chown(backup, original_stat.st_uid, original_stat.st_gid)
    if digest(backup) != expected or digest(target) != expected:
        raise ValueError("destination changed during backup; refusing install")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".install.", delete=False) as fh:
            temporary = Path(fh.name)
            fh.write(source.read_bytes())
        os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        temporary.chmod(original_mode)
        staged_stat = temporary.stat()
        if (staged_stat.st_uid, staged_stat.st_gid) != (original_stat.st_uid, original_stat.st_gid):
            raise ValueError("could not preserve destination ownership")
        source_hash = digest(source)
        if digest(temporary) != source_hash or digest(target) != expected:
            raise ValueError("bytes changed before install")
        os.replace(temporary, target)
        if digest(target) != source_hash:
            # Only restore our own failed replacement, never overwrite a peer.
            raise RuntimeError("installed bytes differ; backup retained for controlled rollback")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("helper", choices=sorted(HELPERS))
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback-from", type=Path)
    args = parser.parse_args()
    source = args.rollback_from or Path(__file__).resolve().parent / args.helper
    if not source.is_file() or source.is_symlink():
        parser.error("source must be a plain file")
    if not args.apply:
        if args.expected_sha256 == "absent":
            if args.target.exists() or args.target.is_symlink():
                parser.error("destination already exists")
        elif digest(args.target) != args.expected_sha256:
            parser.error("destination bytes changed")
        print("verified; dry-run only, no files installed")
        return 0
    if args.helper == "claude-reaper.sh" and not args.rollback_from:
        safety = args.target.parent / "reaper-safety.sh"
        canonical = Path(__file__).resolve().parent / "reaper-safety.sh"
        if not safety.is_file() or digest(safety) != digest(canonical):
            parser.error("install verified adjacent reaper-safety.sh first")
    backup = install(source, args.target, args.expected_sha256)
    print(backup if backup is not None else "created previously absent destination; no prior version")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
