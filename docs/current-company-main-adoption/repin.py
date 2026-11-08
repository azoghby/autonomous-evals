"""Preserve every new owner byte, rebase only explicit prior differentials."""
import pathlib,json,hashlib,sys,shutil,difflib,runpy
HERE=pathlib.Path(__file__).resolve().parent;load=lambda p:json.loads(p.read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
source,base,out=map(pathlib.Path,sys.argv[1:4]);newsha,newtree=sys.argv[4:6];a=load(HERE/'APPLICATION.json');inventory=load(HERE/('BASE-INVENTORY-'+newtree+'.json'))
if inventory['tree']!=newtree:raise RuntimeError('Wrong tree')
if out.exists():raise RuntimeError('Output must not exist')
for p,v in {**a['preserved'],**a['changes'],**a['additions']}.items():
 if sha((source/p).read_bytes())!=v['sha256']:raise RuntimeError('Prior source drift '+p)
for p,v in inventory['files'].items():
 if sha((base/p).read_bytes())!=v['sha256']:raise RuntimeError('New owner drift '+p)
shutil.copytree(base,out)
ROOT=HERE.parents[1]
review=load(ROOT/'tests/track-b/current-company-main-adoption/REVIEW-INPUTS.json');payment=load(ROOT/'tests/track-b/current-company-main-adoption/PAYMENT-FIX-INPUTS.json')
remap={e['path']:e.get('stagePath',e['path']) for e in review['mapping'] if e['kind']=='immutable-review'}
remap.update({e['path']:e.get('stagePath',e['path']) for e in payment['files'] if e['kind']=='payment-regression'})
fixture=runpy.run_path(str(ROOT/'tests/track-b/current-company-main-adoption/reviewer-fixture-compatibility.py'))
review_entries={e['path']:e for e in review['mapping'] if e['kind']=='immutable-review'}
payment_entries={e['path']:e for e in payment['files'] if e['kind']=='payment-regression'}
for original_p,record in {**a['changes'],**a['additions']}.items():
 p=remap.get(original_p,original_p);after=(source/original_p).read_bytes()
 if original_p in review_entries:
  entry=review_entries[original_p];raw=(ROOT/entry['payload']).read_bytes()
  if sha(raw)!=entry['sha256']:raise RuntimeError('Review payload drift')
  after=fixture['transform'](original_p,raw.decode(),payment_fixes=True).encode()
 if original_p in payment_entries:
  entry=payment_entries[original_p];raw=(ROOT/entry['payload']).read_bytes()
  if sha(raw)!=entry['sha256']:raise RuntimeError('Payment regression payload drift')
  after=raw.replace(b'../current-company-review/',b'../current-company-adoption-review/')
 if p in ['tests/track-b/current-company-main-adoption/run.mjs','tests/track-b/current-company-main-adoption/REVIEW-INPUTS.json','tests/track-b/current-company-main-adoption/PAYMENT-FIX-INPUTS.json']:after=(ROOT/p).read_bytes()
 target=out/p
 if target.exists():
  before=target.read_bytes()
  if before!=after and sha(before) not in [record.get('preimageSha256'),record['sha256']]:raise RuntimeError('New owner collision requires explicit review: '+p)
 if p=='tests/track-b/current-autonomy-payment-startup/composition.test.ts':after=after.replace(a['parent'].encode(),newsha.encode())
 target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(after)
extra_paths=set()
for entry in payment.get('fixtureInputs',[]):
 p=entry.get('stagePath',entry['path']);data=(ROOT/entry['payload']).read_bytes()
 if sha(data)!=entry['sha256']:raise RuntimeError('Fixture payload drift')
 target=out/p
 if target.exists() and target.read_bytes()!=data:raise RuntimeError('Owner fixture alias collision: '+p)
 target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);extra_paths.add(p)
paths=extra_paths|set(inventory['files'])|{remap.get(p,p) for p in a['additions']}|set(a['changes']);preserved={};changes={};additions={};diff=[]
for p in sorted(paths):
 after=(out/p).read_bytes();before=(base/p).read_bytes() if p in inventory['files'] else None;r={'sha256':sha(after),'bytes':len(after)}
 if before==after:preserved[p]=r;continue
 if before is None:additions[p]=r
 else:changes[p]={**r,'preimageSha256':sha(before),'preimageBytes':len(before)}
 diff.extend(difflib.unified_diff([] if before is None else before.decode().splitlines(True),after.decode().splitlines(True),fromfile='/dev/null' if before is None else 'a/'+p,tofile='b/'+p))
patch=''.join(x if x.endswith('\n') else x+'\n\\ No newline at end of file\n' for x in diff);(HERE/'owner.patch').write_text(patch)
pin=load(HERE/'PIN.json');pin['previousAdoptionPin']=pin['currentMain'];pin['currentMain']=newsha;pin['tree']=newtree;(HERE/'PIN.json').write_text(json.dumps(pin,indent=2)+'\n');(HERE/'BASE-INVENTORY.json').write_text(json.dumps(inventory,indent=2)+'\n')
a.update(parent=newsha,preserved=preserved,changes=changes,additions=additions,patchSha256=sha(patch.encode()));(HERE/'APPLICATION.json').write_text(json.dumps(a,indent=2)+'\n');(out/'CURRENT-COMPOSITION.json').write_text(json.dumps(a,indent=2)+'\n');(out/'PAYMENT-COMPOSITION.json').write_bytes((HERE/'PAYMENT-COMPOSITION.json').read_bytes())
print(json.dumps({'parent':newsha,'stage':str(out),'preserved':len(preserved),'changes':len(changes),'additions':len(additions),'total':len(paths)}))
