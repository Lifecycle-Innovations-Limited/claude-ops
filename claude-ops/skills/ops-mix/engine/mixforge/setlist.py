"""Deterministische Camelot-planner met expliciete weigering bij te weinig tracks."""

from pathlib import Path
import numpy as np
from .analyze import analyze
from .camelot import move
from .models import Entry, Plan, Profile, Track, positive
from .reference import import_setlist

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aiff", ".aif", ".m4a", ".ogg"}


def scan_tracks(directory: Path, metadata: Path | None = None) -> list[Track]:
    if not directory.is_dir():
        raise ValueError("Trackmap bestaat niet")
    rows = import_setlist(metadata) if metadata else []
    tracks = []
    for path in sorted(directory.rglob("*")):
        if path.suffix.lower() not in AUDIO_EXTENSIONS or not path.is_file():
            continue
        track = analyze(path)
        matching = [r for r in rows if r["title"].casefold() in {path.stem.casefold(), track.title.casefold()}]
        if len(matching) > 1:
            raise ValueError(f"Dubbele exporttitel: {path.stem}")
        if matching:
            row = matching[0]
            track = Track(track.path, track.duration, row["bpm"], row["key"], row["energy"],
                          row["title"], row["artist"], track.beats, track.downbeats, track.cue,
                          {"bpm": "export", "key": "export", "energy": "export"})
        tracks.append(track)
    if not tracks:
        raise ValueError("Geen ondersteunde audiotracks gevonden")
    return tracks


def plan_tracks(tracks: list[Track], profile: Profile, seconds: float,
                backend: str = "numpy") -> Plan:
    seconds = positive(seconds, "seconds")
    if backend not in {"numpy", "librosa", "rubberband"}:
        raise ValueError("Onbekende tempo-backend")
    remaining = list(tracks)
    entries = []
    end = 0.0
    while end < seconds - 1e-6:
        position = min(1, end / seconds)
        bpm = float(np.interp(position, np.linspace(0, 1, len(profile.bpm_curve)), profile.bpm_curve))
        energy = float(np.interp(position, np.linspace(0, 1, len(profile.energy_curve)), profile.energy_curve))
        candidates = []
        for track in remaining:
            # Numpy resampling verandert de key. Harmonisch plannen is alleen betrouwbaar
            # bij dezelfde BPM; pitchvaste backends mogen tempo's wel aanpassen.
            if backend == "numpy" and abs(track.bpm - bpm) > 0.6:
                continue
            key_move = move(entries[-1].track.key, track.key) if entries else "first"
            if key_move is None:
                continue
            available = (track.duration - track.cue) * track.bpm / bpm
            score = abs(track.energy - energy) + abs(track.bpm - bpm) / 4
            score -= 0.25 * profile.key_moves.get(key_move, 0) / max(1, sum(profile.key_moves.values()))
            candidates.append((score, track.path, track, key_move, available))
        if not candidates:
            raise ValueError("Onvoldoende harmonisch passende tracks voor de gevraagde lengte. "
                             "Numpy vereist vrijwel dezelfde BPM om de Camelot-key te behouden; "
                             "voeg tracks toe of gebruik --backend librosa/rubberband met geïnstalleerde backend.")
        _, _, track, key_move, available = min(candidates, key=lambda x: (x[0], x[1]))
        remaining.remove(track)
        beat = 60 / bpm
        overlap = 0.0
        if entries:
            desired = profile.transition_bars * 4 * beat
            overlap = min(desired, entries[-1].duration / 2, available / 2)
            overlap = max(0, np.floor(overlap / (4 * beat)) * 4 * beat)
        start = end - overlap
        preferred = max(profile.play_seconds, overlap + 4 * beat)
        duration = min(available, preferred, seconds - start)
        if start + duration <= end + 1e-6:
            continue
        if start + duration < seconds:
            duration = max(4 * beat, np.floor(duration / (4 * beat)) * 4 * beat)
            duration = min(available, duration)
        entries.append(Entry(track, bpm, track.cue, duration, start, overlap, key_move))
        end = start + duration
    return Plan(seconds, entries, notes=[f"tempo_backend={backend}",
                "Beatfase geschat uit onsets; 4/4 aangenomen.",
                "Numpy-resampling verschuift pitch; BPM-afwijking beperkt voor harmonische planning."])
