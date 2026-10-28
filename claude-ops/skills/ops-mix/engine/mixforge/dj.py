"""Explicit beat-grid and complementary band exchange for offline DJ drafts.

Independent signal model, not Density DSP emulation. Existing render APIs are
unchanged. Source phrase identity still needs listening review.
"""
import hashlib
import json
from pathlib import Path
import numpy as np


def import_manual_profile(path):
    """Read an existing private analysis JSON without copying it into the repo."""
    path = Path(path)
    data = json.loads(path.read_text())
    return {"source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "project_tracks": data["project"]["track_count"],
            "delivered_transitions": len(data.get("transitions", [])),
            "semantics": data["parameter_semantics"],
            "observations": data["learned_style"],
            "tracks": data["tracks"]}


def phrase_cue(anchor, bpm, requested=0, phrase_beats=32):
    """Nearest nonnegative phrase candidate relative to a supplied grid anchor."""
    values = (anchor, bpm, requested, phrase_beats)
    if not all(np.isfinite(v) for v in values) or bpm <= 0 or phrase_beats <= 0:
        raise ValueError("Invalid source grid")
    period = phrase_beats * 60 / bpm
    index = max(0, round((requested - anchor) / period))
    return anchor + index * period


def bass_envelopes(frames, sample_rate, switch_seconds, exchange_seconds=.02):
    """Complementary gains: only one full bass signal, never two full basses."""
    if frames < 1 or sample_rate <= 0 or exchange_seconds <= 0:
        raise ValueError("Invalid exchange duration")
    t = np.arange(frames) / sample_rate
    incoming = np.clip((t - switch_seconds) / exchange_seconds + .5, 0, 1)
    return (1 - incoming).astype(np.float32), incoming.astype(np.float32)


def split_bands(audio, sample_rate, crossover=180):
    """Complementary zero-phase FFT bands with a smooth 140–220Hz crossover.

    Reflection padding limits circular edge contamination. Both bands sum back
    to the input; this is deliberately independent of native normalized EQ knobs.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim != 2 or len(audio) < 2 or sample_rate <= 2 * crossover:
        raise ValueError("Invalid stereo band input")
    pad = min(len(audio) - 1, sample_rate)
    padded = np.pad(audio, ((pad, pad), (0, 0)), mode="reflect")
    freq = np.fft.rfftfreq(len(padded), 1 / sample_rate)
    weight = np.clip((crossover + 40 - freq) / 80, 0, 1)
    weight = .5 - .5 * np.cos(np.pi * weight)
    low = np.fft.irfft(np.fft.rfft(padded, axis=0) * weight[:, None],
                       n=len(padded), axis=0)[pad:-pad].astype(np.float32)
    return low, audio - low


def eq_exchange(left, right, sample_rate=44100, switch_seconds=None, bpm=128):
    """Layer tracks and exchange bass; no whole-signal musical crossfade.

    High band enters over 8 beats, holds, and leaves over the last 8 beats.
    Low band switches over 20ms at the chosen beat. Only 10ms edge declicks
    affect the complete signal. Caller owns output gain/headroom.
    """
    if left.shape != right.shape or len(left) < 2 or bpm <= 0:
        raise ValueError("Exchange requires equal nonempty stereo blocks")
    n = len(left)
    duration = n / sample_rate
    switch = duration / 2 if switch_seconds is None else switch_seconds
    if not 0 <= switch <= duration:
        raise ValueError("Bass switch outside overlap")
    outgoing, incoming = bass_envelopes(n, sample_rate, switch)
    t = np.arange(n) / sample_rate
    ramp = min(8 * 60 / bpm, duration / 3)
    high_in = .25 + .75 * np.clip(t / ramp, 0, 1)
    high_out = .25 + .75 * np.clip((duration - t) / ramp, 0, 1)
    edge = max(1, min(round(.01 * sample_rate), n // 2))
    enter = np.ones(n, dtype=np.float32)
    leave = enter.copy()
    enter[:edge] = np.linspace(0, 1, edge)
    leave[-edge:] = np.linspace(1, 0, edge)
    ll, lh = split_bands(left, sample_rate)
    rl, rh = split_bands(right, sample_rate)
    return ((ll * outgoing[:, None] + lh * high_out[:, None]) * leave[:, None]
            + (rl * incoming[:, None] + rh * high_in[:, None]) * enter[:, None]).astype(np.float32)
