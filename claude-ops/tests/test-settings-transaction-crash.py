import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / 'scripts/lib'

class TransactionCrashes(unittest.TestCase):
    def test_crash_matrix(self):
        for background in (False, True):
            for stage in ('before-write', 'after-write', 'before-commit'):
                with self.subTest(background=background, stage=stage), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp) / ('job-settings' if background else 'foreground-settings')
                    code = '''
import importlib.util,os,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('store',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);stage=sys.argv[3];bg=sys.argv[4]=='1'
original_dump=m.json.dump;original_atomic=m.atomic

def dump(value,target,*a,**kw):
    if value.get('env',{}).get('KEY')=='synthetic':
        if stage=='before-write':os._exit(71)
        result=original_dump(value,target,*a,**kw);target.flush();os.fsync(target.fileno())
        if stage=='after-write':os._exit(72)
        return result
    return original_dump(value,target,*a,**kw)
def atomic(path,row):
    if row.get('phase')=='ready' and stage=='before-commit':os._exit(73)
    return original_atomic(path,row)
m.json.dump=dump;m.atomic=atomic
m.create_document(root,{'env':{'KEY':'synthetic'}},os.getpid(),'synthetic-owner-start',bg)
'''
                    child = subprocess.run([sys.executable, '-I', '-c', code, str(LIB / 'settings-record.py'), str(root), stage, str(int(background))])
                    self.assertIn(child.returncode, (71, 72, 73))
                    records = list(root.glob('*.json'))
                    self.assertEqual(len(records), 1)
                    row = json.loads(records[0].read_text())
                    self.assertEqual(row['phase'], 'intent')
                    if background:
                        result = subprocess.run([sys.executable, '-I', str(LIB / 'settings-record.py')], input=json.dumps({'root':str(root),'record':str(records[0]),'op':'cleanup'}), text=True, capture_output=True)
                        self.assertEqual(result.returncode,0,result.stderr)
                    else:
                        spec=importlib.util.spec_from_file_location('headless',LIB/'headless-settings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.recover(root)
                    self.assertFalse(Path(row['path']).exists())
                    self.assertFalse(records[0].exists())

unittest.main()
