"""Reconcile the frozen 2df owner tree; only explicit prior differentials and Scout."""
import pathlib,json,hashlib,shutil,subprocess,difflib,sys
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parents[1]
sha=lambda b:hashlib.sha256(b).hexdigest();load=lambda p:json.loads(p.read_text())
PIN='2df678268926da50d0219889fd2190b7edb6f6e8';TREE='4be9ea6e53cbe19d043d6f2464f14df6fc7f83d4'
base,source,out=map(pathlib.Path,sys.argv[1:4]);inv=load(HERE/('BASE-INVENTORY-'+TREE+'.json'))
old=load(base/'docs/current-company-main-adoption/APPLICATION.json')
for p,v in inv['files'].items():
 if sha((base/p).read_bytes())!=v['sha256']:raise RuntimeError('Owner drift '+p)
for p,v in {**old['preserved'],**old['changes'],**old['additions']}.items():
 if sha((source/p).read_bytes())!=v['sha256']:raise RuntimeError('Prior candidate drift '+p)
if out.exists():raise RuntimeError('Output exists')
shutil.copytree(base,out)
route='apps/web/src/app/api/stripe/webhook/route.ts'
for p,v in {**old['changes'],**old['additions']}.items():
 before=(base/p).read_bytes() if p in inv['files'] else None;after=(source/p).read_bytes()
 if p==route:
  # Exact reviewed old receipt additions plus exact new owner notification additions.
  upstream=(base/p).read_text();previous=(source/p).read_text()
  import_line='import { notifyPlanPurchase } from "@/server/notify/hooks";\n'
  # Retain the complete newer owner suffix beginning at handlePlanSession.
  marker='async function handlePlanSession('
  after=(previous.split(marker)[0].replace('import { resumeJobForPayment }',import_line+'import { resumeJobForPayment }')+marker+upstream.split(marker)[1]).encode()
  # Everything outside the plan handler differs only by the historical receipt patch.
  old_base=pathlib.Path('/private/tmp/current-company-main-3f0bd8a-base-20261107')/p
  assert sha(old_base.read_bytes())==v['preimageSha256']
  assert upstream.replace(import_line,'').split(marker)[0]==old_base.read_text().split(marker)[0]
  assert after.decode().split(marker)[1]==upstream.split(marker)[1]
 elif before is not None and sha(before) not in [v['sha256'],v.get('preimageSha256')]:raise RuntimeError('Unreviewed collision '+p)
 if p=='tests/track-b/current-autonomy-payment-startup/composition.test.ts':after=after.replace(old['parent'].encode(),PIN.encode())
 target=out/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(after)
# New frozen-clock fairness regression: exact immutable source, import-only fixture alias.
p='tests/track-b/current-company-payment-fixes/receipt-fairness.test.ts';raw=(base/p).read_bytes();after=raw.replace(b'../current-company-review/',b'../current-company-adoption-review/')
target=out/'tests/track-b/current-company-adoption-payment-fixes/receipt-fairness.test.ts';target.write_bytes(after)
fixpath=ROOT/'tests/track-b/current-company-main-adoption/PAYMENT-FIX-INPUTS.json';fix=load(fixpath)
payload='tests/track-b/current-company-main-adoption/payment-fix-inputs/'+p
(ROOT/payload).parent.mkdir(parents=True,exist_ok=True);(ROOT/payload).write_bytes(raw)
entry={'path':p,'payload':payload,'sha256':sha(raw),'bytes':len(raw),'kind':'payment-regression','stagePath':str(target.relative_to(out)),'stageSha256':sha(after),'stageBytes':len(after),'authenticatedSourceCommit':PIN,'authenticatedSourceTree':TREE,'stageCompatibility':{'onlyChangedImportNamespace':True,'assertionsBefore':raw.count(b'expect('),'assertionsAfter':after.count(b'expect(')}}
fix['files']=[e for e in fix['files'] if e['path']!=p]+[entry];fixpath.write_text(json.dumps(fix,indent=2)+'\n')
# Only executable test harness inputs are revised inside the historical self domain.
for p in ['tests/track-b/current-company-main-adoption/run.mjs','tests/track-b/current-company-main-adoption/PAYMENT-FIX-INPUTS.json',payload]:
 t=out/p;t.parent.mkdir(parents=True,exist_ok=True);t.write_bytes((ROOT/p).read_bytes())
subprocess.run(['node',str(HERE/'scout-extension/apply.mjs'),str(out)],check=True)
preserved={};changes={};additions={};diff=[]
paths=sorted(p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file())
for p in paths:
 before=(base/p).read_bytes() if p in inv['files'] else None;after=(out/p).read_bytes();r={'sha256':sha(after),'bytes':len(after)}
 if before==after:preserved[p]=r;continue
 if before is None:additions[p]=r
 else:changes[p]={**r,'preimageSha256':sha(before),'preimageBytes':len(before)}
 diff.extend(difflib.unified_diff([] if before is None else before.decode().splitlines(True),after.decode().splitlines(True),fromfile='/dev/null' if before is None else 'a/'+p,tofile='b/'+p))
patch=''.join(x if x.endswith('\n') else x+'\n\\ No newline at end of file\n' for x in diff);(HERE/'owner.patch').write_text(patch)
a={**old,'parent':PIN,'preserved':preserved,'changes':changes,'additions':additions,'patchSha256':sha(patch.encode()),'wholeApplicationAccepted':False,'hostedAcceptance':False,'selfReferencePolicy':'Historical owner artifact metadata/evidence remain pinned2df bytes inside the candidate. Canonical reconciliation control-plane lives outside the staged source; only explicit runner/test inputs change.'}
(HERE/'APPLICATION.json').write_text(json.dumps(a,indent=2)+'\n');(HERE/'BASE-INVENTORY.json').write_text(json.dumps(inv,indent=2)+'\n')
pin=load(base/'docs/current-company-main-adoption/PIN.json');pin.update(currentMain=PIN,tree=TREE,previousAdoptionPin=old['parent'],scoutExcluded=False,scoutApprovedCommit='28c5f8b',priorEvidenceCommit='79a85e790459dd0b15049f20cea0a29ff4addb31',includedUpstream='d6203b61e157df3558e7d6a7df2d8637d82f821d');pin.pop('excludedUpstream',None);pin['adoptionPins'].append(PIN)
(HERE/'PIN.json').write_text(json.dumps(pin,indent=2)+'\n');(out/'CURRENT-COMPOSITION.json').write_text(json.dumps(a,indent=2)+'\n');(out/'PAYMENT-COMPOSITION.json').write_bytes((HERE/'PAYMENT-COMPOSITION.json').read_bytes())
print(json.dumps({'parent':PIN,'preserved':len(preserved),'changes':len(changes),'additions':len(additions),'total':len(paths),'patchSha256':a['patchSha256']}))
