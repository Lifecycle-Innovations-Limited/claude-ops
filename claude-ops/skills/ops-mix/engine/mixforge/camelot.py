"""Camelot-notatie en expliciete harmonische moves."""

import re

_MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"]
_MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
_ENHARMONIC = {"C#": "Db", "D#": "Eb", "G#": "Ab", "A#": "Bb", "Gb": "F#", "Cb": "B"}


def normalize_key(value: str) -> str:
    text = str(value).strip().replace("♯", "#").replace("♭", "b")
    if re.fullmatch(r"(?:[1-9]|1[0-2])[aAbB]", text):
        return text.upper()
    match = re.fullmatch(r"([A-Ga-g])([#b]?)(?:\s*)(major|minor|maj|min|m)?", text)
    if not match:
        raise ValueError(f"Onbekende toonsoort: {value!r}")
    note = match[1].upper() + match[2]
    minor = match[3] in {"minor", "min", "m"}
    notes = _MINOR if minor else _MAJOR
    if note not in notes:
        note = _ENHARMONIC.get(note, note)
    if minor and note == "Db":
        note = "C#"
    if note not in notes:
        raise ValueError(f"Onbekende toonsoort: {value!r}")
    return f"{notes.index(note) + 1}{'A' if minor else 'B'}"


def move(source: str, target: str, allow_boost: bool = True) -> str | None:
    source, target = normalize_key(source), normalize_key(target)
    a, b = int(source[:-1]), int(target[:-1])
    distance = (b - a) % 12
    if source == target:
        return "same"
    if a == b:
        return "relative"
    if source[-1] == target[-1]:
        if distance == 1:
            return "+1"
        if distance == 11:
            return "-1"
        if allow_boost and distance == 7:
            return "+7"
    return None
