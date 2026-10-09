"""Run the actual audit helpers without AWS calls or audit output writes."""
import os
from pathlib import Path
import subprocess
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops-aws-audit.sh'


class DateTests(unittest.TestCase):
    def helpers(self, value, zone):
        text = SOURCE.read_text()
        helpers = text.split('# epoch helper:', 1)[1].split('# finding SEV', 1)[0]
        return subprocess.run(['bash', '-c', '# epoch helper:' + helpers + '\nNOW=1791460800; epoch "$1" && age_days "$1"', 'test', value], env=dict(os.environ, TZ=zone), capture_output=True, text=True)

    def test_timezone_independent_utc_and_offsets(self):
        for zone in ('UTC', 'EST5EDT', '<+09>-9'):
            for value in ('2026-10-07T12:00:00Z', '2026-10-07T14:00:00+02:00', '2026-10-07T12:00:00.000Z'):
                result = self.helpers(value, zone)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, '1791374400\n1\n')

    def test_invalid_or_naive_dates_never_become_epoch_zero(self):
        for value in ('invalid', 'N/A', '', '2026-10-07T12:00:00', '2026-02-30T12:00:00Z'):
            result = self.helpers(value, 'UTC')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertIn('age unknown', result.stderr)


if __name__ == '__main__':
    unittest.main()
