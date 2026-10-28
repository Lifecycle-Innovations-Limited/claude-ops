"""Stereo-audio via ffmpeg, met een optionele pitchvaste backend."""

from pathlib import Path
import shutil
import subprocess
import wave
import numpy as np

SAMPLE_RATE = 44100


def decode(path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    if not Path(path).is_file():
        raise ValueError(f"Audiobestand ontbreekt: {path}")
    if not shutil.which("ffmpeg"):
        raise ValueError("ffmpeg ontbreekt; installeer ffmpeg voor audio-I/O")
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(Path(path).resolve()),
         "-f", "f32le", "-ac", "2", "-ar", str(sample_rate), "pipe:1"],
        capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError(f"Kan audio niet lezen: {path}")
    audio = np.frombuffer(result.stdout, dtype="<f4").reshape(-1, 2).copy()
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError(f"Lege of ongeldige audio: {path}")
    return audio


def encode(audio: np.ndarray, path: Path, sample_rate: int = SAMPLE_RATE):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "wb") as output:
            output.setnchannels(2)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    elif path.suffix.lower() == ".mp3":
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ac", "2",
             "-ar", str(sample_rate), "-i", "pipe:0", "-codec:a", "libmp3lame",
             "-b:a", "320k", str(path.resolve())],
            input=np.asarray(audio, dtype="<f4").tobytes(), capture_output=True,
        )
        if result.returncode:
            raise ValueError("ffmpeg kon de mp3 niet schrijven")
    else:
        raise ValueError("Uitvoer moet .wav of .mp3 zijn")


def match_tempo(audio: np.ndarray, source_bpm: float, target_bpm: float,
                backend: str = "numpy", sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    rate = target_bpm / source_bpm
    if not np.isfinite(rate) or rate <= 0:
        raise ValueError("Tempoverhouding moet positief zijn")
    if backend == "rubberband":
        try:
            import pyrubberband
        except ImportError as error:
            raise ValueError("Backend rubberband vereist pyrubberband en de rubberband-binary") from error
        if not shutil.which("rubberband"):
            raise ValueError("Backend rubberband vereist de rubberband-binary")
        return pyrubberband.time_stretch(audio, sample_rate, rate).astype(np.float32)
    elif backend == "librosa":
        try:
            import librosa
        except ImportError as error:
            raise ValueError("Backend librosa vereist het geïnstalleerde librosa-pakket") from error
        return librosa.effects.time_stretch(audio.T, rate=rate).T.astype(np.float32)
    elif backend != "numpy":
        raise ValueError("Onbekende tempo-backend")
    positions = np.arange(int(round(len(audio) / rate))) * rate
    return np.column_stack([np.interp(positions, np.arange(len(audio)), audio[:, c])
                            for c in range(audio.shape[1])]).astype(np.float32)
