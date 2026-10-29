#!/usr/bin/env python3
"""Local plugin installer. Registry changes go exclusively through the Claude CLI."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

NAME = "local-just-do-it"
PLUGIN = "just-do-it@" + NAME
MARKER = ".ops-jdi-owner.json"
CATALOG = {"name": NAME, "owner": {"name": "local"}, "plugins": [
    {"name": "just-do-it", "source": "./plugins/just-do-it",
     "description": "Continue authorized work through verification and delivery."}]}


def cli(*args, data=False):
    result = subprocess.run(["claude", "plugin", *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"claude plugin {' '.join(args)} failed ({result.returncode}): "
                           + result.stderr.strip() + result.stdout.strip())
    if data:
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            raise RuntimeError("Unexpected CLI list JSON; refusing mutation")
        return rows
    if result.stdout.strip():
        print(result.stdout.strip())


def registered(market):
    rows = [r for r in cli("marketplace", "list", "--json", data=True)
            if r.get("name") == NAME]
    if len(rows) > 1 or (rows and (rows[0].get("source") != "directory"
            or Path(rows[0].get("path", "")).resolve() != market)):
        raise RuntimeError("Conflicting marketplace source; refusing mutation")
    return bool(rows)


def installed():
    rows = [r for r in cli("list", "--json", data=True) if r.get("id") == PLUGIN]
    if any(r.get("scope") != "user" for r in rows) or len(rows) > 1:
        raise RuntimeError("Conflicting plugin scope; refusing mutation")
    return rows[0] if rows else None


def safe_tree(root):
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise RuntimeError(f"Not an owned directory: {root}")
    if root.exists():
        for path in root.rglob("*"):
            if path.is_symlink() or path.stat().st_uid != os.getuid():
                raise RuntimeError(f"Symlink or foreign owner: {path}")
        if root.stat().st_uid != os.getuid():
            raise RuntimeError(f"Foreign owner: {root}")


def files(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file() and "runtime" not in p.relative_to(root).parts}


def copy_runtime(source, target, overwrite=False):
    if source.exists():
        safe_tree(source)
        safe_tree(target)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Current state wins over a snapshot, including on rollback.
        for path in source.rglob("*"):
            dest = target / path.relative_to(source)
            if path.is_dir():
                dest.mkdir(exist_ok=True, mode=path.stat().st_mode & 0o777)
            elif overwrite or not dest.exists():
                shutil.copy2(path, dest)


def restore_tree(snapshot, market):
    # Never replace runtime with older state. Preserve the displaced tree for inspection.
    displaced = snapshot.parent / "displaced"
    if market.exists():
        market.rename(displaced)
    if snapshot.exists():
        shutil.copytree(snapshot, market)
    runtime = Path("plugins/just-do-it/runtime")
    if (displaced / runtime).exists():
        if (market / runtime).exists():
            shutil.rmtree(market / runtime)
        shutil.copytree(displaced / runtime, market / runtime)


def run(action, market, rollback=None):
    if market == Path("/") or market == Path.home().resolve():
        raise RuntimeError("Unsafe marketplace destination")
    # Recheck after acquiring the lock; retain protection for direct callers too.
    for path in (market, *market.parents):
        if path.is_symlink():
            raise RuntimeError(f"Symlink destination: {path}")
    market = market.resolve()
    safe_tree(market)
    exists = market.exists()
    owner = market / MARKER
    if exists:
        if not owner.is_file():
            raise RuntimeError("Unowned existing marketplace; reconcile it manually before installing")
        record = json.loads(owner.read_text())
        if json.loads((market / ".claude-plugin/marketplace.json").read_text()) != CATALOG:
            raise RuntimeError("Marketplace catalog changed; refusing overwrite")
        if record.get("installer") != "ops-jdi" or record.get("market") != str(market):
            raise RuntimeError("Marketplace ownership mismatch")
    else:
        record = {"files": []}
    was_registered = registered(market)
    before = installed()
    if before and not was_registered:
        raise RuntimeError("Installed plugin has no matching marketplace")
    if action in ("update", "uninstall", "rollback") and not (exists and was_registered and before):
        raise RuntimeError(f"{action} requires an owned, registered user installation")
    if action == "install" and before:
        raise RuntimeError("Plugin already installed; use update")

    source = Path(__file__).parent / "plugin"
    if rollback:
        backup = Path(rollback).resolve()
        meta = json.loads((backup / "transaction.json").read_text())
        if meta.get("market") != str(market) or not (backup / "before").is_dir():
            raise RuntimeError("Rollback backup does not belong to this existing installation")
        if files(market) != meta.get("after"):
            raise RuntimeError("Rollback conflict: installed source changed; preserve both versions")
        source = backup / "before/plugins/just-do-it"
    safe_tree(source)
    payload = {str(p.relative_to(source)): p for p in source.rglob("*") if p.is_file()
               and not any(part.startswith("test") or part in ("__pycache__", "runtime")
                           for part in p.relative_to(source).parts)
               and p.name not in ("smoke.py", "repair_fixture.py")}
    if rollback:
        previous = json.loads((source.parents[1] / MARKER).read_text())
        payload = {rel: path for rel, path in payload.items() if rel in previous["files"]}
    dest = market / "plugins/just-do-it"
    managed = set(record["files"])
    if any(Path(p).is_absolute() or ".." in Path(p).parts or "runtime" in Path(p).parts
           for p in managed):
        raise RuntimeError("Invalid ownership file list")
    if action != "uninstall":
        # Check writes and deletions before creating backups or changing any files.
        # copy2 treats a directory target as a container, risking unowned children.
        for rel in managed | payload.keys():
            target = dest / rel
            if target.exists() and not target.is_file():
                raise RuntimeError(f"File type changed: {target}")
            for parent in target.parents:
                if parent == market:
                    break
                if (parent.exists() and not parent.is_dir()) or (
                        parent.is_relative_to(dest) and str(parent.relative_to(dest)) in managed):
                    raise RuntimeError(f"Parent directory collision: {parent}")
    for rel in payload:
        target = dest / rel
        if target.exists() and rel not in managed:
            raise RuntimeError(f"Unowned file would be overwritten: {target}")

    market.parent.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=market.name + ".backup-", dir=market.parent))
    if exists:
        shutil.copytree(market, backup / "before")
    old_runtime = None
    if before:
        old_root = Path(before["installPath"])
        safe_tree(old_root)
        old_runtime = old_root / "runtime"
        copy_runtime(old_runtime, backup / "installed-runtime")
    print(f"Backup: {backup}", flush=True)
    registry_started = False
    try:
        if action == "uninstall":
            registry_started = True
            cli("uninstall", PLUGIN, "--scope", "user", "--keep-data")
            cli("marketplace", "remove", NAME, "--scope", "user")
            if installed() or registered(market):
                raise RuntimeError("Uninstall readback did not match")
            copy_runtime(backup / "installed-runtime", dest / "runtime", overwrite=True)
        else:
            dest.mkdir(parents=True, exist_ok=True)
            for rel in managed - payload.keys():
                path = dest / rel
                if path.is_file():
                    path.unlink()
            for rel, path in payload.items():
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
            (market / ".claude-plugin").mkdir(exist_ok=True)
            (market / ".claude-plugin/marketplace.json").write_text(json.dumps(CATALOG) + "\n")
            owner.write_text(json.dumps({"installer": "ops-jdi", "market": str(market),
                                        "files": sorted(payload)}) + "\n")
            registry_started = True
            if not was_registered:
                cli("marketplace", "add", str(market))
            if not registered(market):
                raise RuntimeError("Marketplace registration missing after add")
            cli("update" if before else "install", PLUGIN, "--scope", "user")
            after = installed()
            if not after or not registered(market):
                raise RuntimeError("Plugin registration missing after operation")
            new_root = Path(after["installPath"])
            safe_tree(new_root)
            copy_runtime(backup / "installed-runtime", new_root / "runtime",
                         overwrite=new_root != old_root if before else False)
        (backup / "transaction.json").write_text(json.dumps({"market": str(market),
                                                             "after": files(market)}) + "\n")
    except Exception:
        # Remove only this newly created registration while its local source still exists.
        if registry_started and not before:
            try:
                if installed():
                    cli("uninstall", PLUGIN, "--scope", "user", "--keep-data")
                if not was_registered and registered(market):
                    cli("marketplace", "remove", NAME, "--scope", "user")
            except Exception as recovery:
                print(f"Registry recovery incomplete: {recovery}. Backup retained: {backup}", file=sys.stderr)
        restore_tree(backup / "before", market)
        if registry_started and before:
            try:
                if not registered(market):
                    cli("marketplace", "add", str(market))
                cli("update" if installed() else "install", PLUGIN, "--scope", "user")
                restored = installed()
                if not restored:
                    raise RuntimeError("Plugin missing after recovery")
                restored_root = Path(restored["installPath"])
                safe_tree(restored_root)
                copy_runtime(backup / "installed-runtime", restored_root / "runtime",
                             overwrite=restored_root != old_root)
            except Exception as recovery:
                print(f"Registry recovery incomplete: {recovery}. Backup retained: {backup}", file=sys.stderr)
        raise
    print("Source transaction complete; restart or /reload-plugins to load changes.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", default="install",
                        choices=("install", "update", "uninstall", "rollback"))
    parser.add_argument("backup", nargs="?")
    args = parser.parse_args()
    if (args.action == "rollback") != bool(args.backup):
        parser.error("rollback requires a backup directory; other actions take no backup")
    market = Path(os.environ.get("JDI_MARKET_DIR", str(Path.home() / ".claude/local-plugins/just-do-it-market"))).absolute()
    # Reject symlink components before resolve can hide them, including before '..'.
    for path in (market, *market.parents):
        if path.is_symlink():
            raise RuntimeError(f"Symlink destination: {path}")
    market = market.resolve()
    # Canonical aliases share one cross-process lock; no config files are edited here.
    lock_path = Path(tempfile.gettempdir()) / ("ops-jdi-" + hashlib.sha256(str(market).encode()).hexdigest() + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(args.action, market, args.backup)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"Installer failed: {error}", file=sys.stderr)
        sys.exit(1)
