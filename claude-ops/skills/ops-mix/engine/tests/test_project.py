import unittest
from mixforge.models import Profile, Track
from mixforge.project import constrained_plan

class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.tracks = [Track(f'{name}.wav', 40, bpm, '8A', 5, name) for name, bpm in [('a',120),('b',120),('c',120),('fast',130)]]
        self.profile = Profile(play_seconds=12, transition_bars=1)

    def test_required_excluded_and_endpoints(self):
        plan = constrained_plan(self.tracks, self.profile, 30, 119, 121, ['b'], ['fast'], 'a', 'c')
        titles = [e.track.title for e in plan.entries]
        self.assertEqual(titles, ['a','b','c'])
        self.assertAlmostEqual(plan.entries[-1].start + plan.entries[-1].duration,30)
        self.assertTrue(all(119 <= e.target_bpm <=121 for e in plan.entries))

    def test_impossible_required_never_silently_dropped(self):
        with self.assertRaises(ValueError):
            constrained_plan(self.tracks,self.profile,5,119,121,['a','b'])

    def test_out_of_range_required_rejected(self):
        with self.assertRaisesRegex(ValueError,'BPM'):
            constrained_plan(self.tracks,self.profile,20,119,121,['fast'])

    def test_string_false_is_never_generation_approval(self):
        import tempfile, json
        from pathlib import Path
        from mixforge.project import load_project
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'brief.json'
            path.write_text(json.dumps(dict(version=1, minutes=10, bpm_range=[120,124],
                                            tracks='tracks', output='mix.wav', generation_approved='false')))
            with self.assertRaisesRegex(ValueError, 'true of false'):
                load_project(path)

    def test_conflicting_requirements_rejected(self):
        with self.assertRaisesRegex(ValueError,'uitgesloten'):
            constrained_plan(self.tracks,self.profile,20,119,121,['a'],['a'])
