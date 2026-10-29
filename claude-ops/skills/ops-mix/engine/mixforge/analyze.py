"""Heuristische tempo-, toonsoort- en energieanalyse met alleen numpy."""

from pathlib import Path
import numpy as np
from .audio import decode
from .camelot import normalize_key
from .models import Track

_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def mono_samples(audio: np.ndarray, sample_rate: int):
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Audio moet eindige samples bevatten")
    step = max(1, sample_rate // 11025)
    return audio[::step], sample_rate / step


def tempo_and_beats(audio: np.ndarray, sample_rate: int) -> tuple[float, list[float]]:
    mono, sr = mono_samples(audio, sample_rate)
    hop = max(1, int(sr * 0.01))
    usable = len(mono) // hop * hop
    if usable < hop * 200:
        raise ValueError("Minstens twee seconden audio nodig voor tempoanalyse")
    rms = np.sqrt(np.mean(mono[:usable].reshape(-1, hop) ** 2, axis=1))
    onset = np.maximum(np.diff(rms, prepend=rms[0]), 0)
    if float(onset.max()) < 1e-6:
        return 120.0, []
    centered = onset - onset.mean()
    size = 1 << (2 * len(centered) - 1).bit_length()
    spectrum = np.fft.rfft(centered, n=size)
    corr = np.fft.irfft(spectrum * spectrum.conj(), n=size)[:len(centered)]
    low = int(60 / 180 * sr / hop)
    high = min(len(corr) - 1, int(60 / 60 * sr / hop))
    lags = np.arange(low, high + 1)
    scores = corr[lags] / np.maximum(1, len(centered) - lags)
    lag = int(lags[np.argmax(scores)])
    offset = 0.0
    if 0 < lag < len(corr) - 1:
        a, b, c = corr[lag - 1:lag + 2]
        divisor = a - 2 * b + c
        if abs(divisor) > 1e-10:
            offset = float(np.clip(0.5 * (a - c) / divisor, -0.5, 0.5))
    period = (lag + offset) * hop / sr
    bpm = float(np.clip(60 / period, 60, 180))
    phase_scores = [onset[i::lag].sum() for i in range(lag)]
    phase = int(np.argmax(phase_scores)) * hop / sr
    return bpm, np.arange(phase, len(mono) / sr, 60 / bpm).tolist()


def chroma_vector(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    mono, sr = mono_samples(audio, sample_rate)
    size = 8192
    if len(mono) < size:
        mono = np.pad(mono, (0, size - len(mono)))
    frequencies = np.fft.rfftfreq(size, 1 / sr)
    mask = (frequencies >= 55) & (frequencies <= 4000)
    pitches = np.rint(69 + 12 * np.log2(frequencies[mask] / 440)).astype(int) % 12
    chroma = np.zeros(12)
    window = np.hanning(size)
    for start in range(0, len(mono) - size + 1, size // 2):
        magnitudes = np.abs(np.fft.rfft(mono[start:start + size] * window))[mask]
        chroma += np.bincount(pitches, weights=magnitudes, minlength=12)
    return chroma


def detect_key(audio: np.ndarray, sample_rate: int) -> str:
    chroma = chroma_vector(audio, sample_rate)
    if chroma.sum() <= 1e-9:
        return "8B"
    centered = chroma - chroma.mean()
    choices = []
    for mode, template in (("major", _MAJOR), ("minor", _MINOR)):
        for root in range(12):
            profile = np.roll(template, root)
            profile = profile - profile.mean()
            score = np.dot(centered, profile) / (np.linalg.norm(profile) * np.linalg.norm(centered) + 1e-12)
            choices.append((float(score), root, mode))
    _, root, mode = max(choices)
    return normalize_key(f"{_NOTES[root]} {mode}")


def energy_curve(audio: np.ndarray, sample_rate: int, bpm: float) -> list[float]:
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    window = max(1, round(8 * 4 * 60 / bpm * sample_rate))
    result = []
    for start in range(0, len(mono), window):
        rms = float(np.sqrt(np.mean(mono[start:start + window] ** 2)))
        db = 20 * np.log10(max(rms, 1e-9))
        result.append(float(np.clip(1 + (db + 48) * 9 / 42, 1, 10)))
    return result


def analyze_array(audio: np.ndarray, sample_rate: int, path: str = "memory") -> Track:
    bpm, beats = tempo_and_beats(audio, sample_rate)
    return Track(path, len(audio) / sample_rate, bpm, detect_key(audio, sample_rate),
                 float(np.mean(energy_curve(audio, sample_rate, bpm))),
                 title=Path(path).stem, beats=beats, downbeats=beats[::4],
                 cue=beats[0] if beats else 0.0,
                 metadata_sources={"bpm": "numpy-onset-autocorrelation",
                                   "key": "numpy-chroma-Krumhansl-Schmuckler",
                                   "energy": "RMS heuristic, not Mixed In Key"})


def analyze(path: Path) -> Track:
    return analyze_array(decode(path), 44100, str(Path(path).resolve()))
