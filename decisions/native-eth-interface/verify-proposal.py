"""Verify the proposal using only disposable files inside its assigned write boundary."""
import hashlib,json,pathlib,subprocess,tempfile
folder=pathlib.Path(__file__).resolve().parent
manifest=json.loads((folder/'proposal.json').read_text())
raw=subprocess.check_output(['git','show',manifest['baseCommit']+':specs/requirements.json'])
assert hashlib.sha256(raw).hexdigest()==manifest['baseRequirementsSha256']
patch=folder/'revision-71.patch'
assert hashlib.sha256(patch.read_bytes()).hexdigest()==manifest['patchSha256']
with tempfile.TemporaryDirectory(prefix='verify-',dir=folder) as temporary:
    directory=pathlib.Path(temporary)
    (directory/'specs').mkdir()
    (directory/'specs/requirements.json').write_bytes(raw)
    relative=directory.relative_to(pathlib.Path.cwd())
    subprocess.run(['git','apply','--check','--directory='+str(relative),str(patch)],check=True)
    subprocess.run(['git','apply','--directory='+str(relative),str(patch)],check=True)
    result=(directory/'specs/requirements.json').read_bytes()
assert hashlib.sha256(result).hexdigest()==manifest['proposedRequirementsSha256']
a=json.loads(raw);b=json.loads(result)
assert a['revision']==70 and b['revision']==71
assert [r['id'] for r in a['requirements']]==[r['id'] for r in b['requirements']]
changed=set()
for old,new in zip(a['requirements'],b['requirements']):
    assert {k:v for k,v in old.items() if k in ['id','kind','title','module','status']}=={k:v for k,v in new.items() if k in ['id','kind','title','module','status']}
    if old!=new:
        assert old['status']=='approved'
        changed.add(old['id'])
assert changed=={x['requirementId'] for x in manifest['changes']}
assert not changed.intersection([manifest['unchangedCollectorRequirement'],*manifest['preservedHistoricalRequirements']])
ownership=json.loads((folder/'write-ownership.json').read_text())
paths=[p for lane in ownership['lanes'] for p in lane['existingPaths']+lane['proposedNewPaths']]
assert len(paths)==len(set(paths))
print(json.dumps({'patchAppliesExactly':True,'changedRequirements':len(changed),'unchangedRequirements':len(a['requirements'])-len(changed),'disjointOwnedPaths':len(paths),'resultSha256':hashlib.sha256(result).hexdigest()}))
