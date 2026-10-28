import unittest
import numpy as np
from mixforge.analyze import analyze_array, tempo_and_beats, detect_key, energy_curve


def clicks(bpm=120, seconds=12, sr=11025):
    audio = np.zeros(round(seconds * sr), dtype=np.float32)
    pulse = np.hanning(220).astype(np.float32)
    for start in np.arange(0.2, seconds - 0.03, 60 / bpm):
        i = round(start * sr)
        audio[i:i + len(pulse)] += pulse
    return audio


class AnalyzeTests(unittest.TestCase):
    def test_known_tempos_and_phase(self):
        for expected in (90, 120, 150):
            bpm, beats = tempo_and_beats(clicks(expected), 11025)
            self.assertAlmostEqual(bpm, expected, delta=1)
            self.assertAlmostEqual(beats[0], 0.2, delta=0.04)

    def test_c_major_chord(self):
        t = np.arange(11025 * 4) / 11025
        chord = sum(np.sin(2 * np.pi * f * t) for f in (261.6256, 329.6276, 391.9954)) / 4
        self.assertEqual(detect_key(chord, 11025), "8B")

    def test_energy_and_analysis(self):
        quiet = clicks() * 0.02
        loud = clicks() * 0.8
        self.assertLess(energy_curve(quiet, 11025, 120)[0], energy_curve(loud, 11025, 120)[0])
        track = analyze_array(np.column_stack([loud, loud]), 11025)
        self.assertAlmostEqual(track.bpm, 120, delta=1)
        self.assertEqual(track.duration, 12)
        self.assertGreater(len(track.beats), 20)

    def test_empty_input(self):
        with self.assertRaises(ValueError):
            analyze_array(np.array([]), 11025)
