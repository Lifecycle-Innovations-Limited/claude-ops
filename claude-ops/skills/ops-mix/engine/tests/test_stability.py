import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mixforge.stability import generate_bridge


class StabilityKeyTests(unittest.TestCase):
    def test_key_with_newline_falls_back_without_exception(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STABILITY_API_KEY": "abc\r\nX-Evil: 1\n"}), \
                mock.patch("urllib.request.OpenerDirector.open", side_effect=ValueError("bad header")):
            note = generate_bridge("p", 5, Path(tmp) / "b.wav")
        self.assertIn("normale overgang", note)

    def test_blank_key_counts_as_missing(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"STABILITY_API_KEY": " \n"}):
            note = generate_bridge("p", 5, Path(tmp) / "b.wav")
        self.assertIn("ontbreekt", note)


if __name__ == "__main__":
    unittest.main()
