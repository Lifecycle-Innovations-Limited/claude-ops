"""JSON-contracten voor analyse, planning en rendering."""

from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path
from .camelot import normalize_key


def positive(value: float, name: str) -> float:
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} moet een eindig positief getal zijn")
    return value


@dataclass
class Track:
    path: str
    duration: float
    bpm: float
    key: str
    energy: float
    title: str = ""
    artist: str = ""
    beats: list[float] = field(default_factory=list)
    downbeats: list[float] = field(default_factory=list)
    cue: float = 0.0
    metadata_sources: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        self.duration = positive(self.duration, "duration")
        self.bpm = positive(self.bpm, "bpm")
        self.key = normalize_key(self.key)
        self.energy = float(self.energy)
        self.cue = float(self.cue)
        if not math.isfinite(self.energy) or not 1 <= self.energy <= 10:
            raise ValueError("energy moet tussen 1 en 10 liggen")
        if not math.isfinite(self.cue) or not 0 <= self.cue < self.duration:
            raise ValueError("cue moet binnen de track liggen")


@dataclass
class Profile:
    bpm_curve: list[float] = field(default_factory=lambda: [120.0])
    energy_curve: list[float] = field(default_factory=lambda: [5.0, 7.0, 8.0, 6.0])
    key_moves: dict[str, int] = field(default_factory=dict)
    transition_bars: float = 16.0
    play_seconds: float = 180.0
    mix_in_fraction: float = 0.0
    mix_out_fraction: float = 0.85
    sources: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.bpm_curve or not self.energy_curve:
            raise ValueError("Profielcurves mogen niet leeg zijn")
        self.bpm_curve = [positive(x, "bpm_curve") for x in self.bpm_curve]
        self.energy_curve = [float(x) for x in self.energy_curve]
        if any(not math.isfinite(x) or not 1 <= x <= 10 for x in self.energy_curve):
            raise ValueError("Energiecurve moet tussen 1 en 10 liggen")
        self.transition_bars = positive(self.transition_bars, "transition_bars")
        self.play_seconds = positive(self.play_seconds, "play_seconds")
        if not 0 <= self.mix_in_fraction < self.mix_out_fraction <= 1:
            raise ValueError("Ongeldige mix-in/mix-out-fracties")


@dataclass
class Entry:
    track: Track
    target_bpm: float
    cue: float
    duration: float
    start: float
    overlap: float = 0.0
    key_move: str = "first"

    def __post_init__(self):
        if isinstance(self.track, dict):
            self.track = Track(**self.track)
        self.target_bpm = positive(self.target_bpm, "target_bpm")
        self.duration = positive(self.duration, "duration")
        for name in ("cue", "start", "overlap"):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} moet eindig en niet-negatief zijn")
            setattr(self, name, value)


@dataclass
class Plan:
    duration: float
    entries: list[Entry]
    sample_rate: int = 44100
    notes: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.duration = positive(self.duration, "duration")
        self.entries = [Entry(**x) if isinstance(x, dict) else x for x in self.entries]
        if not self.entries:
            raise ValueError("Een plan moet tracks bevatten")
        if self.sample_rate not in {22050, 44100, 48000}:
            raise ValueError("sample_rate moet 22050, 44100 of 48000 zijn")


def save_json(value, destination: Path):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(asdict(value) if hasattr(value, "__dataclass_fields__") else value,
                                      indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def read_json(path: Path):
    return json.loads(Path(path).read_text())
