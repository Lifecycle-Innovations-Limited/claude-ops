import unittest
import numpy as np
from mixforge.dj import phrase_cue, bass_envelopes, split_bands, eq_exchange


class DJTest(unittest.TestCase):
    def test_grid_phase(self):
        cue = phrase_cue(.113, 127, 31)
        self.assertAlmostEqual(((cue - .113) * 127 / 60) % 32, 0, places=8)
        with self.assertRaises(ValueError):
            phrase_cue(0, 0)

    def test_lowband_handoff(self):
        sr = 4000
        t = np.arange(sr * 8) / sr
        left = np.column_stack([np.sin(t * 2 * np.pi * 60)] * 2)
        right = -left
        a, b = bass_envelopes(len(t), sr, 4)
        np.testing.assert_allclose(a + b, 1, atol=1e-7)
        self.assertTrue(np.all(b[:sr * 3] == 0))
        self.assertTrue(np.all(a[sr * 5:] == 0))
        out = eq_exchange(left, right, sr, 4)
        self.assertLess(np.max(abs(out)), 1.01)
        np.testing.assert_allclose(out[sr:sr*2], left[sr:sr*2], atol=.005)
        np.testing.assert_allclose(out[sr*6:sr*7], right[sr*6:sr*7], atol=.005)

    def test_bands_reconstruct_and_high_layer_holds(self):
        sr = 4000
        t = np.arange(sr * 8) / sr
        x = np.column_stack([np.sin(t * 2*np.pi*800)] * 2).astype('float32')
        lo, hi = split_bands(x, sr)
        np.testing.assert_allclose(lo + hi, x, atol=1e-6)
        out = eq_exchange(x, x, sr, 4)
        self.assertGreater(np.sqrt(np.mean(out[sr*3:sr*5]**2)), 1.3)
        self.assertTrue(np.isfinite(out).all())
