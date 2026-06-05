#!/usr/bin/env python3
"""WhatsApp media enricher — makes ALL media first-class in ops-inbox.

Generalizes the voice-note transcriber to every media type so that no audio,
video, image, or document message is ever silently dropped during inbox triage.
For each recent media message whose `content` is still empty, it:

  1. downloads the media via the bridge /api/download endpoint
     (the bridge now self-heals 403/404/410 via SendMediaRetryReceipt — Fix I),
  2. analyzes it by type:
       audio    -> OpenAI whisper-1            -> "[voice] <transcript>"
       video    -> ffmpeg keyframes + vision    -> "[video] <visual> | speech: <whisper of audio track>"
       image    -> OpenAI vision (gpt-4o-mini)  -> "[image] <description + any on-screen text>"
       document -> pdftotext / strings (best-eff)-> "[document] <filename>: <text excerpt>"
  3. writes the result back into messages.content — ONLY where content is still
     empty, so it never clobbers real text and is fully idempotent.

The fuller analysis (untruncated) is also written to a sidecar JSON cache at
store/<chat>/<msgid>.enrich.json so an agent can read the complete description
later without re-billing the vision/whisper APIs.

Run by wa-inbox-fresh.sh (pre-scan) and the whatsapp-enrich.timer so new media
is enriched automatically before any inbox scan reads it.

Guards (per global cost-leak + no-stacking rules):
  * mkdir-based single-instance lock
  * --max cap per run (rate-floor on metered APIs)
  * idempotent: only ever touches empty-content media rows
  * per-type size ceilings; vision frames capped per video

Env: OPENAI_API_KEY (from ~/.config/systemd/env/mcp-secrets.env).
     WHATSAPP_BRIDGE_DB  (default ~/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db)
Args: --days N (lookback, default 2)  --max N (cap per run, default 40)
      --types audio,video,image,document (default all)
"""

import argparse
import base64
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

DB = os.path.expanduser(
    os.environ.get(
        "WHATSAPP_BRIDGE_DB",
        "~/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db",
    )
)
BRIDGE = "http://127.0.0.1:8080/api/download"
LOCKDIR = "/tmp/.wa-enrich.lock"
PIDFILE = os.path.join(LOCKDIR, "pid")

VISION_MODEL = os.environ.get("WA_ENRICH_VISION_MODEL", "gpt-4o-mini")
MAX_VIDEO_BYTES = int(
    os.environ.get("WA_ENRICH_MAX_VIDEO_BYTES", str(200 * 1024 * 1024))
)
VIDEO_FRAMES = int(os.environ.get("WA_ENRICH_VIDEO_FRAMES", "4"))


# ---------------------------------------------------------------- lock ------
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


# ------------------------------------------------------------- helpers ------
def download(msg_id, chat_jid):
    body = json.dumps({"message_id": msg_id, "chat_jid": chat_jid}).encode()
    req = urllib.request.Request(
        BRIDGE, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    return d.get("path") if d.get("success") else None


def _openai_chat(key, messages, max_tokens=400):
    payload = json.dumps(
        {"model": VISION_MODEL, "messages": messages, "max_tokens": max_tokens}
    ).encode()
    out = subprocess.run(
        [
            "curl",
            "-s",
            "-m",
            "180",
            "https://api.openai.com/v1/chat/completions",
            "-H",
            f"Authorization: Bearer {key}",
            "-H",
            "Content-Type: application/json",
            "-d",
            "@-",
        ],
        input=payload.decode(),
        capture_output=True,
        text=True,
        timeout=200,
    )
    try:
        return json.loads(out.stdout)["choices"][0]["message"]["content"].strip()
    except Exception:
        return None


def whisper(path, key):
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


def _ffprobe_duration(path):
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _extract_frames(path, n, workdir):
    dur = _ffprobe_duration(path)
    frames = []
    if dur <= 0:
        # single grab at 1s
        fp = os.path.join(workdir, "f0.jpg")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                "1",
                "-i",
                path,
                "-frames:v",
                "1",
                "-vf",
                "scale=512:-1",
                fp,
            ],
            capture_output=True,
            timeout=60,
        )
        if os.path.exists(fp):
            frames.append(fp)
        return frames
    for i in range(n):
        t = dur * (i + 0.5) / n
        fp = os.path.join(workdir, f"f{i}.jpg")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{t:.2f}",
                "-i",
                path,
                "-frames:v",
                "1",
                "-vf",
                "scale=512:-1",
                fp,
            ],
            capture_output=True,
            timeout=60,
        )
        if os.path.exists(fp):
            frames.append(fp)
    return frames


def _extract_audio(path, workdir):
    ap = os.path.join(workdir, "audio.mp3")
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "64k",
            ap,
        ],
        capture_output=True,
        timeout=180,
    )
    return ap if os.path.exists(ap) and os.path.getsize(ap) > 0 else None


def _b64_data_uri(path):
    with open(path, "rb") as f:
        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


# ----------------------------------------------------------- analyzers ------
def analyze_image(path, key):
    desc = _openai_chat(
        key,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Describe this image concisely for someone triaging a WhatsApp "
                        "inbox. Note the main subject, context, and transcribe any visible "
                        "text verbatim. 1-3 sentences.",
                    },
                    {"type": "image_url", "image_url": {"url": _b64_data_uri(path)}},
                ],
            }
        ],
    )
    return f"[image] {desc}" if desc else None


def analyze_video(path, key):
    with tempfile.TemporaryDirectory() as wd:
        frames = _extract_frames(path, VIDEO_FRAMES, wd)
        visual = None
        if frames:
            content = [
                {
                    "type": "text",
                    "text": "These are sequential keyframes from a WhatsApp video. In 2-4 "
                    "sentences describe what the video shows (subject, setting, "
                    "motion/edit style), and transcribe any on-screen text verbatim.",
                }
            ]
            for fp in frames:
                content.append(
                    {"type": "image_url", "image_url": {"url": _b64_data_uri(fp)}}
                )
            visual = _openai_chat(
                key, [{"role": "user", "content": content}], max_tokens=500
            )
        speech = None
        ap = _extract_audio(path, wd)
        if ap:
            speech = whisper(ap, key)
    parts = []
    if visual:
        parts.append(visual)
    if speech:
        parts.append(f"speech/audio: {speech}")
    if not parts:
        return None
    return "[video] " + " | ".join(parts)


def analyze_audio(path, key):
    text = whisper(path, key)
    return f"[voice] {text}" if text else None


def analyze_document(path, key, filename):
    text = ""
    if path.lower().endswith(".pdf") and shutil.which("pdftotext"):
        out = subprocess.run(
            ["pdftotext", "-l", "3", path, "-"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        text = out.stdout.strip()
    if not text:
        try:
            with open(path, "rb") as f:
                raw = f.read(4096)
            text = "".join(
                ch
                for ch in raw.decode("utf-8", "ignore")
                if ch.isprintable() or ch in "\n\t "
            )
        except Exception:
            text = ""
    excerpt = " ".join(text.split())[:600]
    if not excerpt:
        return f"[document] {filename}"
    return f"[document] {filename}: {excerpt}"


ANALYZERS = {
    "audio": lambda p, k, fn: analyze_audio(p, k),
    "video": lambda p, k, fn: analyze_video(p, k),
    "image": lambda p, k, fn: analyze_image(p, k),
    "document": lambda p, k, fn: analyze_document(p, k, fn),
}


# ---------------------------------------------------------------- main ------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--types", default="audio,video,image,document")
    args = ap.parse_args()

    want = [t.strip() for t in args.types.split(",") if t.strip() in ANALYZERS]
    if not want:
        print("enrich: no valid --types", flush=True)
        sys.exit(1)

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("enrich: OPENAI_API_KEY not set — abort", flush=True)
        sys.exit(1)
    if not os.path.isfile(DB):
        print(f"enrich: db not found {DB} — abort", flush=True)
        sys.exit(2)
    if not acquire_lock():
        print("enrich: another run holds the lock — exit", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, release_lock)
    signal.signal(signal.SIGINT, release_lock)

    try:
        con = sqlite3.connect(DB, timeout=15)
        con.execute("PRAGMA busy_timeout=8000;")
        placeholders = ",".join("?" for _ in want)
        rows = con.execute(
            f"SELECT id, chat_jid, is_from_me, media_type, COALESCE(filename,'') "
            f"FROM messages "
            f"WHERE media_type IN ({placeholders}) "
            f"AND (content='' OR content IS NULL) "
            f"AND timestamp >= datetime('now', ?) "
            f"ORDER BY timestamp DESC LIMIT ?",
            (*want, f"-{args.days} days", args.max),
        ).fetchall()
        if not rows:
            print(
                f"enrich: nothing to do (last {args.days}d, types={','.join(want)})",
                flush=True,
            )
            return
        print(
            f"enrich: {len(rows)} media item(s) (last {args.days}d, cap {args.max})",
            flush=True,
        )
        ok = fail = 0
        for i, (mid, jid, mine, mtype, fname) in enumerate(rows, 1):
            try:
                path = download(mid, jid)
                if not path or not os.path.exists(path):
                    fail += 1
                    print(f"  [{i}] {mid[:8]} {mtype} download-fail", flush=True)
                    continue
                if mtype == "video" and os.path.getsize(path) > MAX_VIDEO_BYTES:
                    fail += 1
                    print(f"  [{i}] {mid[:8]} video too large, skip", flush=True)
                    continue
                result = ANALYZERS[mtype](path, key, fname)
                if not result:
                    fail += 1
                    print(f"  [{i}] {mid[:8]} {mtype} analyze-fail", flush=True)
                    continue
                # truncated tag into content (idempotent); full text into sidecar
                content_val = result if len(result) <= 1000 else result[:997] + "..."
                con.execute(
                    "UPDATE messages SET content=? WHERE id=? AND chat_jid=? "
                    "AND (content='' OR content IS NULL)",
                    (content_val, mid, jid),
                )
                con.commit()
                try:
                    side = os.path.join(os.path.dirname(path), f"{mid}.enrich.json")
                    with open(side, "w") as f:
                        json.dump(
                            {
                                "id": mid,
                                "chat_jid": jid,
                                "media_type": mtype,
                                "full": result,
                            },
                            f,
                        )
                except Exception:
                    pass
                ok += 1
                print(
                    f"  [{i}] {mid[:8]} {mtype} ({'me' if mine else 'them'}) ok",
                    flush=True,
                )
            except Exception as e:
                fail += 1
                print(f"  [{i}] {mid[:8]} {mtype} err {e}", flush=True)
            time.sleep(0.2)
        con.close()
        print(f"enrich: done — {ok} enriched, {fail} failed", flush=True)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
