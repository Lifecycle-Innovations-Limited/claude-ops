import unittest
from mixforge.models import Track, Entry, Plan
from mixforge.workout import timed_plan, delivery_checks

class WorkoutTests(unittest.TestCase):
    def setUp(self):
        self.tracks=[Track('a.wav',2000,126,'8A',5,'a'), Track('b.wav',2000,128,'8A',8,'b')]
        self.blocks=[dict(**{'from':0,'to':15},track='a',bpm_range=[126,126]),dict(**{'from':15,'to':30},track='b',bpm_range=[128,128])]

    def test_real_boundaries(self):
        plan=timed_plan(self.tracks,self.blocks,30)
        self.assertEqual([e.start for e in plan.entries],[0,15])
        self.assertEqual([e.target_bpm for e in plan.entries],[126,128])

    def test_gaps_and_wrong_bpm(self):
        self.blocks[1]['from']=16
        with self.assertRaises(ValueError): timed_plan(self.tracks,self.blocks,30)
        self.blocks[1]['from']=15
        self.blocks[1]['bpm_range']=[120,125]
        with self.assertRaises(ValueError): timed_plan(self.tracks,self.blocks,30)

    def test_cue_marker_is_not_musical_evidence(self):
        self.blocks[1]['requirements']=['drop']
        plan=timed_plan(self.tracks,self.blocks,30)
        data=dict(workout_blocks=self.blocks)
        self.assertFalse(delivery_checks(data,plan)['ready_for_delivery'])
        data['track_evidence']={'b.wav':{'cue_evidence':[dict(kind='drop',cue=0,reviewed=True,source='manual listening')]}}
        self.assertTrue(delivery_checks(data,plan)['ready_for_delivery'])

    def test_apple_unknown_and_collaborators(self):
        plan=Plan(3600,[Entry(self.tracks[0],126,0,1800,0),Entry(self.tracks[1],128,0,1800,1800)])
        data=dict(output='mix.wav',apple_delivery=dict(percentage_basis='duration',restricted_artists=['Bad Bunny']))
        self.assertFalse(delivery_checks(data,plan)['ready_for_delivery'])
        data['track_evidence']={name:dict(artists=['Example Artist'],artists_complete=True,apple_available=True,apple_source='https://music.apple.com/example') for name in ['a.wav','b.wav']}
        self.assertTrue(delivery_checks(data,plan)['ready_for_delivery'])
        data['track_evidence']['b.wav']['artists'].append('Bad Bunny')
        self.assertFalse(delivery_checks(data,plan)['ready_for_delivery'])
        data['apple_delivery']['percentage_basis']=None
        self.assertFalse(delivery_checks(data,plan)['ready_for_delivery'])
