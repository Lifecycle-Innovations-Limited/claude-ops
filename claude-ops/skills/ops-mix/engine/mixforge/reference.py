"""Referentiemixen en generieke Mixed In Key/Density-setlists."""

from collections import Counter
import csv
import json
from pathlib import Path
import numpy as np
from .analyze import analyze_array, energy_curve
from .audio import decode
from .camelot import move, normalize_key
from .models import Profile


def import_setlist(path: Path) -> list[dict]:
    path = Path(path)
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        rows = data if isinstance(data, list) else data.get("tracks", data.get("setlist", []))
    else:
        text = path.read_text(encoding="utf-8-sig")
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.DictReader(text.splitlines(), dialect=dialect))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Export moet een niet-lege CSV/JSON-setlist bevatten")
    result = []
    for row in rows:
        clean = {str(k).strip().lower().replace(" ", "_"): v for k, v in row.items()}
        def value(*names, default=None):
            return next((clean[k] for k in names if clean.get(k) not in (None, "")), default)
        bpm = float(str(value("bpm", "tempo")).replace(",", "."))
        energy = float(str(value("energy", "energy_level", default=5)).replace(",", "."))
        if not np.isfinite(bpm) or bpm <= 0 or not np.isfinite(energy) or not 1 <= energy <= 10:
            raise ValueError("Ongeldige BPM of energie in export")
        result.append({"title": str(value("title", "name", "track", default="")),
                       "artist": str(value("artist", default="")), "bpm": bpm,
                       "key": normalize_key(value("key", "camelot", "initial_key")),
                       "energy": energy})
    return result


def profile_from_references(paths: list[Path], mik: Path | None = None) -> Profile:
    bpms, energies, keys, plays, transitions = [], [], [], [], []
    sources, caveats = [], ["Audioanalyse is een heuristiek; downbeats zijn niet structureel bewezen.",
                           "Zonder brontracks is transitielengte een geschatte waarde, geen reconstructie."]
    for path in paths:
        if path.suffix.lower() in {".csv", ".json"}:
            rows = import_setlist(path)
            bpms.extend(r["bpm"] for r in rows)
            energies.extend(r["energy"] for r in rows)
            keys.extend(r["key"] for r in rows)
        else:
            audio = decode(path)
            windows = []
            for start in range(0, len(audio), 30 * 44100):
                chunk = audio[start:start + 30 * 44100]
                if len(chunk) < 2 * 44100:
                    continue
                track = analyze_array(chunk, 44100)
                bpms.append(track.bpm)
                energies.extend(energy_curve(chunk, 44100, track.bpm))
                keys.append(track.key)
                windows.append((start / 44100, track))
            boundaries = [0.0]
            for (start, current), (_, previous) in zip(windows[1:], windows):
                if abs(current.bpm - previous.bpm) > 3 or current.key != previous.key:
                    boundaries.append(start)
                    transitions.append(8.0)
            boundaries.append(len(audio) / 44100)
            plays.extend(np.diff(boundaries).tolist())
        sources.append(str(path.resolve()))
    if mik:
        rows = import_setlist(mik)
        bpms = [r["bpm"] for r in rows]
        energies = [r["energy"] for r in rows]
        keys = [r["key"] for r in rows]
        sources.append(str(mik.resolve()))
        caveats.append("Exportmetadata vervangt geschatte BPM/key/energie; Density-formaat is generieke CSV/JSON.")
    if not bpms:
        raise ValueError("Geen bruikbare referenties; geef audio of een CSV/JSON-export")
    moves = Counter(move(a, b) or "other" for a, b in zip(keys, keys[1:]))
    return Profile(bpms, energies, dict(moves),
                   transition_bars=float(np.median(transitions)) if transitions else 16,
                   play_seconds=float(np.median(plays)) if plays else 180,
                   sources=sources, caveats=caveats)
