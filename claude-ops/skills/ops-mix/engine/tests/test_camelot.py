import unittest
from mixforge.camelot import move, normalize_key
from mixforge.models import Track, Profile


class CamelotTests(unittest.TestCase):
    def test_wheel_wrap_relative_and_boost(self):
        for source, target, expected in [("12A", "1A", "+1"), ("1A", "12A", "-1"),
                                         ("8A", "8B", "relative"), ("8A", "3A", "+7"),
                                         ("8A", "9B", None)]:
            self.assertEqual(move(source, target), expected)
        self.assertIsNone(move("8A", "3A", allow_boost=False))

    def test_key_names(self):
        for text, expected in [("Am", "8A"), ("C", "8B"), ("G# minor", "1A"),
                               ("Gb", "2B"), ("12b", "12B")]:
            with self.subTest(text=text):
                self.assertEqual(normalize_key(text), expected)

    def test_invalid_metadata(self):
        with self.assertRaises(ValueError):
            Track("x", 20, float("nan"), "8A", 5)
        with self.assertRaises(ValueError):
            Profile(energy_curve=[11])
