"""Beatgematchte stereo-render met equal-power overgangen en exacte samplelengte."""

from pathlib import Path
import tempfile
import numpy as np
from .audio import decode, encode, match_tempo
from .models import Plan, save_json
from .stability import generate_bridge, DEFAULT_ENDPOINT


def crossfade(left: np.ndarray, right: np.ndarray, bass_swap: bool = False,
              sample_rate: int = 44100) -> np.ndarray:
    if left.shape != right.shape:
        raise ValueError("Crossfade vereist even lange stereoblokken")
    x = np.linspace(0, 1, len(left))[:, None]
    if bass_swap and len(left):
        freqs = np.fft.rfftfreq(len(left), 1 / sample_rate)
        low_left = np.fft.irfft(np.fft.rfft(left, axis=0) * (freqs < 180)[:, None], n=len(left), axis=0)
        low_right = np.fft.irfft(np.fft.rfft(right, axis=0) * (freqs < 180)[:, None], n=len(right), axis=0)
        high = (left - low_left) * np.cos(x * np.pi / 2) + (right - low_right) * np.sin(x * np.pi / 2)
        # Korte bass-wissel rond het midden voorkomt dubbel laag.
        swap = np.clip((x - 0.45) / 0.1, 0, 1)
        return (high + low_left * (1 - swap) + low_right * swap).astype(np.float32)
    return (left * np.cos(x * np.pi / 2) + right * np.sin(x * np.pi / 2)).astype(np.float32)


def render_array(plan: Plan, loader=decode, backend: str = "numpy", bass_swap: bool = False,
                 bridge_loader=None) -> np.ndarray:
    sr = plan.sample_rate
    output = np.zeros((round(plan.duration * sr), 2), dtype=np.float32)
    previous_end = 0
    for index, entry in enumerate(plan.entries):
        start = round(entry.start * sr)
        length = min(round(entry.duration * sr), len(output) - start)
        if start < 0 or length <= 0 or start > previous_end:
            raise ValueError("Setlist bevat een gat of een ongeldige starttijd")
        source = loader(Path(entry.track.path), sr)
        cue = round(entry.cue * sr)
        source = match_tempo(source[cue:], entry.track.bpm, entry.target_bpm, backend, sr)
        if len(source) < length:
            raise ValueError(f"Track is te kort voor setlist: {entry.track.title}")
        chunk = source[:length]
        overlap = min(round(entry.overlap * sr), length)
        if index:
            actual_overlap = previous_end - start
            if abs(actual_overlap - overlap) > 1 or not 0 <= actual_overlap <= length:
                raise ValueError("Setlist-overlap sluit niet aan op vorige track")
            overlap = actual_overlap
        if overlap:
            mixed = crossfade(output[start:start + overlap], chunk[:overlap], bass_swap, sr)
            if bridge_loader:
                bridge = bridge_loader(index, entry, overlap / sr)
                if bridge is not None:
                    if len(bridge) < overlap:
                        raise ValueError("Gegenereerd tussenstuk is te kort")
                    envelope = np.sin(np.linspace(0, np.pi, overlap))[:, None] * 0.4
                    mixed = mixed * (1 - envelope) + bridge[:overlap] * envelope
            output[start:start + overlap] = mixed
        output[start + overlap:start + length] = chunk[overlap:]
        previous_end = start + length
    if previous_end != len(output):
        raise ValueError("Setlist vult niet de gevraagde lengte")
    peak = float(np.max(np.abs(output)))
    if peak > 0.98:
        output *= 0.98 / peak
    return output


def cue_sheet(plan: Plan, audio_name: str) -> str:
    def quoted(text):
        return str(text).replace('"', "'").replace("\n", " ").replace("\r", " ")
    kind = "MP3" if audio_name.lower().endswith(".mp3") else "WAVE"
    lines = [f'FILE "{quoted(audio_name)}" {kind}']
    for i, entry in enumerate(plan.entries, 1):
        frames = round(entry.start * 75)
        minutes, rest = divmod(frames, 60 * 75)
        seconds, frames = divmod(rest, 75)
        lines.extend([f"  TRACK {i:02d} AUDIO", f'    TITLE "{quoted(entry.track.title)}"',
                      f'    PERFORMER "{quoted(entry.track.artist)}"',
                      f"    INDEX 01 {minutes:02d}:{seconds:02d}:{frames:02d}"])
    return "\n".join(lines) + "\n"


def render(plan: Plan, output: Path, *, generate: bool = False, mp3: bool = False,
           backend: str = "numpy", bass_swap: bool = False, endpoint: str = DEFAULT_ENDPOINT,
           model: str | None = None, max_seconds: float = 190) -> list[str]:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    notes = []
    with tempfile.TemporaryDirectory(prefix="mixforge-") as temporary:
        def bridges(index, entry, seconds):
            path = Path(temporary) / f"bridge-{index}.wav"
            note = generate_bridge(f"Instrumental DJ transition, {entry.target_bpm:.1f} BPM, "
                                   f"Camelot {entry.track.key}, energy {entry.track.energy:.1f}, no vocals",
                                   seconds, path, endpoint=endpoint, model=model, max_seconds=max_seconds)
            if note:
                notes.append(note)
                return None
            bridge = decode(path, plan.sample_rate)
            if len(bridge) < round(seconds * plan.sample_rate):
                notes.append("Gegenereerd tussenstuk te kort; normale overgang gebruikt.")
                return None
            return bridge
        audio = render_array(plan, backend=backend, bass_swap=bass_swap,
                             bridge_loader=bridges if generate else None)
    encode(audio, output, plan.sample_rate)
    if mp3 and output.suffix.lower() != ".mp3":
        encode(audio, output.with_suffix(".mp3"), plan.sample_rate)
    save_json(plan, output.parent / "setlist.json")
    output.with_suffix(".cue").write_text(cue_sheet(plan, output.name), encoding="utf-8")
    return notes
