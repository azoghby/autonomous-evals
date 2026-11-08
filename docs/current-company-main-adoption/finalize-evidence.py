"""Summarize completed native validation; authenticate both composed and reproduced source."""
import json,pathlib,hashlib
h=pathlib.Path(__file__).resolve().parent;root=h.parents[1];load=lambda p:json.loads(p.read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();write=lambda n,x:(h/n).write_text(json.dumps(x,indent=2)+'\n')
a=load(h/'APPLICATION.json');b=load(h/'BASE-INVENTORY.json');e=root/'tests/track-b/current-company-main-adoption/final-2df-evidence';r=load(e/'RESULTS.json');scout=load(root/'tests/track-b/current-company-main-adoption/scout-extension/final-2df-evidence/result.json')
expected=['review-types','review-tests','combined-types','core-types','next-typegen','application-types','root-tests','production-build']
assert all(r['finalGates'].get(n,{}).get('exitCode')==0 for n in expected),r['finalGates']
assert all(v['exit']==0 for v in scout['checks'].values())
checks=[]
for name in ['final','reproduced']:
 d=pathlib.Path('/private/tmp/current-company-main-adoption-2df6782-'+name+'-20261107');drift=[]
 for p,v in {**a['preserved'],**a['changes'],**a['additions']}.items():
  if sha(d/p)!=v['sha256']:drift.append(p)
 assert not drift,drift
 checks.append({'stage':str(d),'verifiedFiles':sum(len(a[k]) for k in ['preserved','changes','additions']),'drift':drift})
record={'parent':a['parent'],'tree':b['tree'],'applicationSha256':sha(h/'APPLICATION.json'),'ownerPatchSha256':sha(h/'owner.patch'),'checks':checks,'gitMetadataMutated':False,'releaseAccepted':False}
write('REPRODUCTION.json',record);write('FINAL-SOURCE-VERIFICATION.json',record)
write('RESULTS.json',{**load(h/'PRESERVATION.json'),'applicationSha256':sha(h/'APPLICATION.json'),'ownerPatchSha256':sha(h/'owner.patch'),'gates':r['finalGates'],'scout':{'tests':46,'originalTests':38,'scoutChecks':8,'checks':scout['checks'],'sourceSha256':scout['svgSha256'],'browserVerified':False},'sourceVerification':checks,'evidence':'tests/track-b/current-company-main-adoption/final-2df-evidence/RESULTS.json','evidenceSha256':sha(e/'RESULTS.json'),'testInputsSha256':sha(e/'TEST-INPUTS.json'),'wholeApplicationAccepted':False,'hostedAcceptance':False,'activationBlock':'Concrete CurrentOwnerLoader code integration required: current export always returns blocked; environment keys alone do not activate.'})
owned=[]
for base in [h,root/'tests/track-b/current-company-main-adoption']:
 owned.extend(p for p in base.rglob('*') if p.is_file())
(h/'OWNED-FILES.txt').write_text('\n'.join(sorted(str(p.relative_to(root)) for p in owned))+'\n')
write('SHA256SUMS.json',{str(p.relative_to(root)):sha(p) for p in sorted(set(owned)) if p!=h/'SHA256SUMS.json'})
print(json.dumps({'files':len(owned),'applicationSha256':sha(h/'APPLICATION.json'),'ownerPatchSha256':sha(h/'owner.patch'),'checks':r['finalGates']}))
