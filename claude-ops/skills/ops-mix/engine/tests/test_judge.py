"""Synthetic evidence: catch skipped audio, false coverage and overwritten inputs."""
import hashlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import wave

import numpy as np
from mixforge import judge
from mixforge.cli import main


def wav(path, samples, rate=44100):
    samples = np.asarray(samples)
    if samples.ndim == 1:
        samples = np.column_stack([samples, samples])
    with wave.open(str(path), 'wb') as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes((samples * 32767).astype('<i2').tobytes())


class JudgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / 'mix ; $(no shell).wav'
        wav(self.audio, np.r_[np.full(44100, .2), np.zeros(44100),
                              np.ones(44100), np.full(44100, .02)])

    def test_entire_audio_metrics_packet_and_delivery_are_separate(self):
        brief = {'duration_seconds': 5, 'unresolved_requirements': ['listen'],
                 'ready_for_final_delivery': False}
        with patch.object(socket, 'socket', side_effect=AssertionError('network')):
            report = judge.judge_mix(self.audio, brief=brief,
                                     setlist={'transitions': [1, 3]}, output=self.root / 'packet')
        self.assertEqual(report['source']['sha256'], hashlib.sha256(self.audio.read_bytes()).hexdigest())
        self.assertEqual(report['local']['frames'], 176400)
        self.assertEqual(report['local']['duration_seconds'], 4)
        self.assertEqual(report['local']['clipped_samples'], 88200)
        self.assertAlmostEqual(report['local']['longest_silence']['duration_seconds'], 1)
        self.assertEqual(report['duration_check']['matches'], False)
        self.assertEqual(report['musical']['status'], 'unknown')
        self.assertEqual(report['delivery']['status'], 'not_assessed')
        self.assertEqual(report['delivery']['supplied']['unresolved_requirements'], ['listen'])
        self.assertEqual(len(report['packet']['items']), 3)
        self.assertEqual(report['transitions']['coverage'], 'all_supplied')
        for item in report['packet']['items']:
            path = Path(item['path'])
            self.assertTrue(path.is_file())
            self.assertEqual(item['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        persisted = json.loads((self.root / 'packet' / 'report.json').read_text())
        self.assertEqual(persisted, report)
        windows = [json.loads(x) for x in (self.root / 'packet' / 'measurements.jsonl').read_text().splitlines()]
        self.assertEqual(len(windows), 4)
        self.assertEqual(windows[-1]['end_seconds'], 4)

    def test_truncated_wav_never_claims_whole_file(self):
        import subprocess
        # Leave an incomplete final PCM frame: ordinary ffmpeg logs a decode
        # error but returns zero after emitting the preceding valid samples.
        self.audio.write_bytes(self.audio.read_bytes()[:-1])
        result = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(self.audio),
                                 '-f', 'null', '-'], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'Decoding error', result.stderr)
        with self.assertRaises(ValueError):
            judge.judge_mix(self.audio, output=self.root / 'truncated')
        self.assertFalse((self.root / 'truncated').exists())

    def test_native_brief_tracks_path_does_not_hide_timing_metadata(self):
        for timing in ({'entries': [{'start': 0}, {'start': 2}]},
                       {'workout_blocks': [{'from': 0}, {'from': 2}]}):
            with self.subTest(timing=timing):
                report = judge.judge_mix(self.audio, brief={'tracks': '/music'}, setlist=timing)
                self.assertEqual(report['transitions']['items'][0]['at_seconds'], 2)
        report = judge.judge_mix(self.audio, brief={'tracks': '/music',
                                 'workout_blocks': [{'from': 0}, {'from': 2}]})
        self.assertEqual(report['transitions']['items'][0]['at_seconds'], 2)
        for tracks in ([], [{}], [None], 42, None):
            with self.subTest(tracks=tracks), self.assertRaises(ValueError):
                judge.judge_mix(self.audio, brief={'tracks': tracks})

    def test_near_silence_is_not_a_level_jump(self):
        import subprocess
        raw = np.repeat(np.r_[np.full(44100, .1), np.full(44100, 1e-5)], 2).astype('<f4')
        # Preserve the nonzero quiet amplitude rather than quantizing to PCM16 zero.
        self.audio.unlink()
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2',
                        '-i', 'pipe:0', '-c:a', 'pcm_f32le', str(self.audio)],
                       input=raw.tobytes(), check=True, capture_output=True)
        report = judge.judge_mix(self.audio)
        self.assertTrue(report['local']['flags']['silence'])
        self.assertFalse(report['local']['flags']['level_change'])
        self.assertIsNone(report['local']['largest_level_change'])

    def test_every_renderer_entry_has_a_transition(self):
        report = judge.judge_mix(self.audio, setlist={'entries': [
            {'start': 0}, {'start': 1.5}, {'start': 3.5}]}, output=self.root / 'packet')
        self.assertEqual([x['at_seconds'] for x in report['transitions']['items']], [1.5, 3.5])
        report = judge.judge_mix(self.audio, brief={'tracks': [
            {'audible_start': 0}, {'audible_start': 2.5}]})
        self.assertEqual(report['transitions']['items'][0]['at_seconds'], 2.5)

    def test_missing_timestamps_are_unknown_and_bad_timestamps_rejected(self):
        self.assertEqual(judge.judge_mix(self.audio)['transitions']['coverage'], 'unknown')
        bad = ([1, 1], [2, 1], [-1], [0], [4], [float('nan')], [True], ['1'])
        for values in bad:
            with self.subTest(values=values), self.assertRaises(ValueError):
                judge.judge_mix(self.audio, setlist={'transitions': values}, output=self.root / 'bad')
            self.assertFalse((self.root / 'bad').exists())
        for value in ({'entries': [{'start': 0}, {}]}, {'tracks': [{}, {}]}, {'transitions': None}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                judge.judge_mix(self.audio, setlist=value)

    def test_output_never_overwrites_or_mutates_input(self):
        before = self.audio.read_bytes()
        destination = self.root / 'existing'
        destination.mkdir()
        (destination / 'keep').write_text('unchanged')
        with self.assertRaises((ValueError, FileExistsError)):
            judge.judge_mix(self.audio, output=destination)
        with self.assertRaises((ValueError, FileExistsError)):
            judge.judge_mix(self.audio, output=self.audio)
        self.assertEqual(self.audio.read_bytes(), before)
        self.assertEqual((destination / 'keep').read_text(), 'unchanged')

    def test_nonfinite_and_failed_decodes_leave_no_packet(self):
        # Float WAV is passed through ffmpeg without integer clipping masking NaN.
        import subprocess
        invalid = self.root / 'invalid.wav'
        raw = np.array([[.1, .1], [np.nan, .2]], dtype='<f4')
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2',
                        '-i', 'pipe:0', '-c:a', 'pcm_f32le', str(invalid)],
                       input=raw.tobytes(), check=True, capture_output=True)
        for source in (invalid, self.root / 'absent.wav'):
            with self.assertRaises(ValueError):
                judge.judge_mix(source, output=self.root / 'failed')
            self.assertFalse((self.root / 'failed').exists())
        invalid.write_bytes(b'not audio')
        with self.assertRaises(ValueError):
            judge.judge_mix(invalid)

    def test_threshold_validation_and_configured_silence(self):
        report = judge.judge_mix(self.audio, silence_db=-20, silence_seconds=.5,
                                 clip_level=.9, level_jump_db=3)
        self.assertEqual(report['thresholds']['silence_db'], -20)
        for kwargs in ({'clip_level': 0}, {'silence_seconds': -1}, {'level_jump_db': float('nan')},
                       {'silence_db': 1}, {'window_seconds': 0}):
            with self.assertRaises(ValueError):
                judge.judge_mix(self.audio, **kwargs)

    def test_silence_crosses_windows_and_level_changes_have_timestamps(self):
        wav(self.audio, np.r_[np.full(44100, .2), np.zeros(88200),
                              np.full(44100, .2), np.full(44100, .02)])
        report = judge.judge_mix(self.audio, window_seconds=.4)
        self.assertAlmostEqual(report['local']['longest_silence']['start_seconds'], 1)
        self.assertAlmostEqual(report['local']['longest_silence']['duration_seconds'], 2)
        self.assertTrue(report['local']['flags']['level_change'])
        self.assertGreater(report['local']['largest_level_change']['at_seconds'], 0)

    def test_stream_reads_are_bounded_and_late_decode_error_is_rejected(self):
        import io
        class Reader(io.BytesIO):
            def read(self, size=-1):
                if not 0 < size <= 441 * 8:
                    raise AssertionError('unbounded decode read')
                return super().read(size)
        class Process:
            def __init__(self, code):
                self.stdout = Reader(np.full((44100, 2), .2, dtype='<f4').tobytes())
                self.code = code
            def wait(self):
                return self.code
            def poll(self):
                return self.code
        with patch('mixforge.judge.subprocess.Popen', return_value=Process(0)):
            report = judge.judge_mix(self.audio, window_seconds=.01)
        self.assertEqual(report['local']['frames'], 44100)
        self.assertEqual(report['local']['measurement_windows'], 100)
        with patch('mixforge.judge.subprocess.Popen', return_value=Process(1)):
            with self.assertRaises(ValueError):
                judge.judge_mix(self.audio, window_seconds=.01, output=self.root / 'late-fail')
        self.assertFalse((self.root / 'late-fail').exists())

    def test_packet_never_replaces_a_concurrent_output_file(self):
        import os
        original = os.link
        def race(source, target):
            target = Path(target)
            if target.name == 'report.json':
                target.write_text('other writer')
            return original(source, target)
        with patch('mixforge.judge.os.link', race):
            with self.assertRaises(FileExistsError):
                judge.judge_mix(self.audio, output=self.root / 'raced')
        self.assertEqual((self.root / 'raced' / 'report.json').read_text(), 'other writer')

    def test_judge_cli_writes_new_report_and_never_renders(self):
        with patch('mixforge.cli.render', side_effect=AssertionError('renderer')):
            with patch('builtins.print'):
                code = main(['judge', str(self.audio), '-o', str(self.root / 'cli')])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((self.root / 'cli' / 'report.json').read_text())['musical']['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
