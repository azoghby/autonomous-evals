"""Append hash-bound reviewed test coverage and optional owner payment correction.
Only writes a fresh disposable stage and the NEW adoption artifact directory.
"""
import pathlib,json,hashlib,sys,difflib,shutil,runpy
ROOT=pathlib.Path(__file__).resolve().parents[2];HERE=pathlib.Path(__file__).resolve().parent
load=lambda p:json.loads(p.read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
source=pathlib.Path(sys.argv[1]);base=pathlib.Path(sys.argv[2]);out=pathlib.Path(sys.argv[3])
if out.exists():raise RuntimeError('Output must not exist')
a=load(HERE/'APPLICATION.json');original={**a['preserved'],**a['changes'],**a['additions']}
for p,v in original.items():
 data=(source/p).read_bytes()
 if sha(data)!=v['sha256']:raise RuntimeError('Source drift '+p)
 (out/p).parent.mkdir(parents=True,exist_ok=True);(out/p).write_bytes(data)
updates={};mapping=load(ROOT/'tests/track-b/current-company-main-adoption/REVIEW-INPUTS.json')
for entry in mapping['mapping']:
 # Docs fixture snapshots are evidence only; never roll back corrected docs/SQL.
 if not entry['path'].startswith('tests/'):continue
 data=(ROOT/entry['payload']).read_bytes()
 if sha(data)!=entry['sha256']:raise RuntimeError('Review input drift '+entry['path'])
 fixture=runpy.run_path(str(ROOT/'tests/track-b/current-company-main-adoption/reviewer-fixture-compatibility.py'))
 updates[entry['path']]=fixture['transform'](entry['path'],data.decode(),payment_fixes=len(sys.argv)>4).encode()
# Reusable executed harness is part of final source inventory as well.
for name in ['run.mjs','REVIEW-INPUTS.json']+(['PAYMENT-FIX-INPUTS.json'] if len(sys.argv)>4 else []):
 p='tests/track-b/current-company-main-adoption/'+name;updates[p]=(ROOT/p).read_bytes()
if len(sys.argv)>4:
 pay=load(ROOT/'tests/track-b/current-company-main-adoption/PAYMENT-FIX-INPUTS.json')
 for entry in pay['files']:
  if entry['kind']!='payment-regression':continue
  data=(ROOT/entry['payload']).read_bytes()
  if sha(data)!=entry['sha256']:raise RuntimeError('Payment regression drift')
  updates[entry['path']]=data
 p='tests/track-b/current-autonomy-payment-startup/bridge.test.ts'
 text=(out/p).read_text()
 updates[p]=(fixture['transform'](p,text,payment_fixes=True) if '../../../docs/current-autonomy-payment-startup/bridge/source/apps/web/src/server/current-payment' in text else text).encode()
for payload in (ROOT/'tests/track-b/current-company-main-adoption/harness-inputs').rglob('*'):
 if payload.is_file():updates[payload.relative_to(ROOT).as_posix()]=payload.read_bytes()
# Optional payment correction is a separate reviewed extension with its own input pins.
if len(sys.argv)>4:
 ext=load(pathlib.Path(sys.argv[4]))
 for entry in ext['files']:
  p=entry['path'];data=(ROOT/entry['source']).read_bytes()
  if sha(data)!=entry['sha256']:raise RuntimeError('Payment extension drift '+p)
  if entry.get('beforeSha256') and sha((out/p).read_bytes()) not in [entry['beforeSha256'],entry['sha256']]:raise RuntimeError('Payment preimage drift '+p)
  updates[p]=data
for p,data in updates.items():
 if p.startswith('/') or '..' in pathlib.PurePosixPath(p).parts:raise RuntimeError('Unsafe extension path')
 (out/p).parent.mkdir(parents=True,exist_ok=True);(out/p).write_bytes(data)
# Recompute a single owner differential against exact immutable current main.
basepin=load(HERE/'BASE-INVENTORY.json');paths=set(original)|set(updates);preserved={};changes={};additions={};diff=[]
for p in sorted(paths):
 after=(out/p).read_bytes();before=(base/p).read_bytes() if p in basepin['files'] else None;record={'sha256':sha(after),'bytes':len(after)}
 if before==after:preserved[p]=record;continue
 if before is None:additions[p]=record
 else:changes[p]={**record,'preimageSha256':sha(before),'preimageBytes':len(before)}
 diff.extend(difflib.unified_diff([] if before is None else before.decode().splitlines(True),after.decode().splitlines(True),fromfile='/dev/null' if before is None else 'a/'+p,tofile='b/'+p))
patch=''.join(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n' for line in diff)
(HERE/'owner.patch').write_text(patch);a.update(preserved=preserved,changes=changes,additions=additions,patchSha256=sha(patch.encode()),reviewCommit=mapping['reviewCommit']);(HERE/'APPLICATION.json').write_text(json.dumps(a,indent=2)+'\n')
(out/'CURRENT-COMPOSITION.json').write_text(json.dumps(a,indent=2)+'\n');(out/'PAYMENT-COMPOSITION.json').write_bytes((HERE/'PAYMENT-COMPOSITION.json').read_bytes())
print(json.dumps({'stage':str(out),'reviewFiles':len(updates),'sourceFiles':len(paths),'preserved':len(preserved),'changes':len(changes),'additions':len(additions)}))
