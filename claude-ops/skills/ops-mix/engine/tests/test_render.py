import unittest
from unittest.mock import patch
import numpy as np
from mixforge.audio import match_tempo
from mixforge.models import Entry, Plan, Track
from mixforge.render import render_array


class RenderRegressionTests(unittest.TestCase):
    def test_fractional_overlap_uses_shared_sample_boundary(self):
        sr = 44100
        duration = 15.969456494638438
        overlap = duration / 2
        track = Track('synthetic.wav', 30, 120, '8A', 5)
        plan = Plan(20.123456, [
            Entry(track, 120, 0, duration, 0),
            Entry(track, 120, 0, 20.123456 - overlap, overlap, overlap),
        ])
        audio = render_array(plan, loader=lambda path, rate: np.ones((30 * rate, 2), dtype=np.float32) * 0.1)
        self.assertEqual(len(audio), round(plan.duration * sr))
        self.assertTrue(np.isfinite(audio).all())
        self.assertGreater(float(np.min(audio)), 0)

    def test_missing_pitch_preserving_backend_never_resamples(self):
        audio = np.zeros((4410, 2), dtype=np.float32)
        for backend, module in [('librosa', 'librosa'), ('rubberband', 'pyrubberband')]:
            with self.subTest(backend=backend), patch.dict('sys.modules', {module: None}):
                with self.assertRaisesRegex(ValueError, 'vereist'):
                    match_tempo(audio, 120, 128, backend)
