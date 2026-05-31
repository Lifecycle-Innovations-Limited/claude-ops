#!/usr/bin/env python3
"""WhatsApp voice-note transcriber — makes voice notes first-class in ops-inbox.

Finds WhatsApp messages with media_type='audio' and empty content, downloads
them via the bridge /api/download endpoint, transcribes with OpenAI whisper-1,
and writes '[voice] <text>' back into messages.content — but ONLY where content
is still empty, so it never clobbers real text and is fully idempotent.

Run by the whatsapp-transcribe.timer (systemd --user) every few minutes so new
voice notes are transcribed automatically before any inbox scan reads them.

Guards (per global cost-leak + no-stacking rules):
  * mkdir-based single-instance lock (defense-in-depth on top of systemd oneshot)
  * --max cap per run (rate-floor on the metered Whisper API)
  * idempotent: only ever touches empty-content audio rows

Env: OPENAI_API_KEY (from ~/.config/systemd/env/mcp-secrets.env).
     WHATSAPP_BRIDGE_DB (same default as wa-inbox-fresh / ops tooling).
Args: --days N (lookback window, default 2)  --max N (cap per run, default 80)
"""

import argparse
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request

DB = os.path.expanduser(
    os.environ.get(
        "WHATSAPP_BRIDGE_DB",
        "~/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db",
    )
)
BRIDGE = "http://127.0.0.1:8080/api/download"
LOCKDIR = "/tmp/.wa-transcribe.lock"
PIDFILE = os.path.join(LOCKDIR, "pid")
FAIL_MARKER = "[voice] (transcription unavailable)"


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def release_lock(signum=None, frame=None):
    shutil.rmtree(LOCKDIR, ignore_errors=True)
    if signum is not None:
        sys.exit(128 + signum)


def acquire_lock():
    try:
        os.mkdir(LOCKDIR)
    except FileExistsError:
        try:
            with open(PIDFILE) as f:
                old = int(f.read().strip())
            if _pid_alive(old):
                return False
        except (FileNotFoundError, ValueError, OSError):
            pass
        shutil.rmtree(LOCKDIR, ignore_errors=True)
        try:
            os.mkdir(LOCKDIR)
        except FileExistsError:
            return False
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    return True


def mark_unavailable(con, mid, jid):
    con.execute(
        "UPDATE messages SET content=? WHERE id=? AND chat_jid=? "
        "AND (content='' OR content IS NULL)",
        (FAIL_MARKER, mid, jid),
    )
    con.commit()


def download(msg_id, chat_jid):
    body = json.dumps({"message_id": msg_id, "chat_jid": chat_jid}).encode()
    req = urllib.request.Request(
        BRIDGE, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    return d.get("path") if d.get("success") else None


def transcribe(path, key):
    out = subprocess.run(
        [
            "curl",
            "-s",
            "-m",
            "180",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H",
            f"Authorization: Bearer {key}",
            "-F",
            f"file=@{path}",
            "-F",
            "model=whisper-1",
        ],
        capture_output=True,
        text=True,
        timeout=200,
    )
    try:
        return json.loads(out.stdout).get("text", "").strip()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--max", type=int, default=80)
    args = ap.parse_args()

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("transcriber: OPENAI_API_KEY not set — abort", flush=True)
        sys.exit(1)
    if not os.path.isfile(DB):
        print(f"transcriber: db not found {DB} — abort", flush=True)
        sys.exit(2)
    if not acquire_lock():
        print("transcriber: another run holds the lock — exit", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, release_lock)
    signal.signal(signal.SIGINT, release_lock)

    try:
        con = sqlite3.connect(DB, timeout=15)
        con.execute("PRAGMA busy_timeout=8000;")
        rows = con.execute(
            "SELECT id, chat_jid, is_from_me FROM messages "
            "WHERE media_type='audio' AND (content='' OR content IS NULL) "
            "AND timestamp >= datetime('now', ?) "
            "ORDER BY timestamp DESC LIMIT ?",
            (f"-{args.days} days", args.max),
        ).fetchall()
        if not rows:
            print(f"transcriber: nothing to do (last {args.days}d)", flush=True)
            return
        print(
            f"transcriber: {len(rows)} voice note(s) to transcribe (last {args.days}d, cap {args.max})",
            flush=True,
        )
        ok = fail = 0
        for i, (mid, jid, mine) in enumerate(rows, 1):
            try:
                path = download(mid, jid)
                if not path or not os.path.exists(path):
                    fail += 1
                    mark_unavailable(con, mid, jid)
                    print(f"  [{i}] {mid[:8]} download-fail", flush=True)
                    continue
                text = transcribe(path, key)
                if not text:
                    fail += 1
                    mark_unavailable(con, mid, jid)
                    print(f"  [{i}] {mid[:8]} transcribe-fail", flush=True)
                    continue
                con.execute(
                    "UPDATE messages SET content=? WHERE id=? AND chat_jid=? "
                    "AND (content='' OR content IS NULL)",
                    (f"[voice] {text}", mid, jid),
                )
                con.commit()
                ok += 1
                print(f"  [{i}] {mid[:8]} ({'me' if mine else 'them'}) ok", flush=True)
            except Exception as e:
                fail += 1
                mark_unavailable(con, mid, jid)
                print(f"  [{i}] {mid[:8]} err {e}", flush=True)
            time.sleep(0.2)
        con.close()
        print(f"transcriber: done — {ok} transcribed, {fail} failed", flush=True)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
