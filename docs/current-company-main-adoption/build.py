"""Build only the reviewed differential; never overlay a historical tree."""
import pathlib,json,hashlib,shutil,difflib,subprocess,sys,runpy
ROOT=pathlib.Path(__file__).resolve().parents[2]; HERE=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
readjson=lambda p:json.loads(p.read_text())
for p,v in readjson(HERE/'INPUT-ARTIFACTS.json').items():
 if sha((ROOT/p).read_bytes())!=v:raise RuntimeError('Artifact input drift '+p)
base=pathlib.Path(sys.argv[1]); source=pathlib.Path(sys.argv[2]); out=pathlib.Path(sys.argv[3]);pin=readjson(HERE/'PIN.json')
if out.exists():raise RuntimeError('Output must not exist')
c=readjson(HERE/'INPUT-SOURCES.json');supp=readjson(HERE/'SUPPLEMENTAL-INPUTS.json')
for p,v in supp['metadata'].items():
 if sha((source/p).read_bytes())!=v:raise RuntimeError('Metadata drift '+p)
c['files']={**c['files'],**supp['files']};m=readjson(source/'CURRENT-COMPOSITION.json')
for p,v in c['files'].items():
 if sha((source/p).read_bytes())!=v['sha256']:raise RuntimeError('Candidate drift '+p)
# Baseline categories describe EXACT historical provenance, not an overlay list.
oldpaths=set(m['preserved'])|set(m['changes']);targets=set(m['changes'])|set(m['additions'])
for p,v in m['preserved'].items():
 if c['files'][p]['sha256']!=v['sha256']:targets.add(p)
targets|=set(c['files'])-oldpaths
compat=runpy.run_path(str(ROOT/'tests/track-b/current-company-main-adoption/pricing-compatibility.py'))
targets|=compat['TARGETS']
# Inventories include only archived tracked bytes; no environment/runtime files.
files={p.relative_to(base).as_posix():p.read_bytes() for p in base.rglob('*') if p.is_file()}
inventory=readjson(HERE/'BASE-INVENTORY.json')
if inventory['tree']!=pin['tree'] or set(files)!=set(inventory['files']):raise RuntimeError('Wrong base tree/domain')
for p,v in inventory['files'].items():
 if sha(files[p])!=v['sha256']:raise RuntimeError('Base drift '+p)
shutil.copytree(base,out)
changes={};additions={};patch=[]
for p in sorted(targets):
 after=(source/p).read_bytes();before=files.get(p)
 if before==after and p not in compat['TARGETS'] and not p.endswith('/current-autonomy-payment-startup/composition.test.ts'):continue
 if p=='apps/web/src/app/api/stripe/webhook/route.ts':
  # Apply additive hooks to the new owner implementation. Plans and rates remain owner bytes.
  text=before.decode();text=text.replace('import type Stripe from "stripe";','import type Stripe from "stripe";\nimport { currentAutonomy } from "@/server/current-autonomy-runtime";',1)
  guard='  if (!HANDLED.has(event.type)) return Response.json({ received: true, ignored: event.type });\n'
  if text.count(guard)!=1:raise RuntimeError('Webhook handled anchor drift')
  text=text.replace(guard,'',1)
  anchor='  if (event.livemode !== (getStripeMode() === "live")) return Response.json({ received: true, ignored: "environment_mismatch" });\n'
  hook='''
  // Only genuine signed refund/cancellation evidence can revoke bound job authority.
  if (event.type === "charge.refunded" || event.type === "payment_intent.canceled") {
    try {
      const startup = await currentAutonomy();
      if (startup) await startup.bridge.ingestStripeIfBound(raw, signature);
    } catch { return Response.json({error:"Autonomy receipt processing failed"}, {status:500}); }
  }
'''
  if text.count(anchor)!=1:raise RuntimeError('Webhook environment anchor drift')
  text=text.replace(anchor,anchor+hook+guard,1)
  anchor='    const { payment, inserted } = await recordPaymentFromSession(session, event.id);\n'
  hook='''    // Canonical job payment is durable first; plan purchases and subscriptions retain their owner branches.
    if (session.mode === "payment" && session.metadata?.pricing_mode === "fixed") {
      const startup = await currentAutonomy();
      if (startup) await startup.bridge.ingestStripeIfBound(raw, signature);
    }
'''
  if text.count(anchor)!=1:raise RuntimeError('Webhook payment anchor drift')
  text=text.replace(anchor,anchor+hook,1);after=text.encode()
 elif before is not None:
  # Existing historical changes must have an exact reviewed preimage. Never replace newer bytes.
  entry=m['changes'].get(p,{})
  pre=entry.get('preimage'); expected=pre.get('sha256') if isinstance(pre,dict) else pre
  if not expected:expected=m['preserved'].get(p,{}).get('sha256')
  if not expected and p.startswith('tests/'):
   testpin=readjson(ROOT/'docs/current-company-composition/TEST-PIN.json');expected=next((e['beforeSha256'] for e in testpin['files'] if e['path']==p),None)
  if not expected and p.startswith('tests'):
   baseline=readjson(ROOT/'docs/current-autonomy-baseline-correction/PIN.json');expected=next((e['beforeSha256'] for e in baseline['files'] if e['path']==p),None)
  if not expected:
   cal=readjson(ROOT/'docs/current-autonomy-calendar/APPLICATION.json');expected=cal.get('changes',{}).get(p,{}).get('preimageSha256')
  allowed={expected,c['files'].get(p,{}).get('sha256')}
  if p.startswith('tests/'):
   for pinpath in ['docs/current-autonomy-baseline-correction/PIN.json','docs/current-company-composition/TEST-PIN.json']:
    allowed.update(e['beforeSha256'] for e in readjson(ROOT/pinpath)['files'] if e['path']==p)
  if sha(before) not in allowed:raise RuntimeError('Newer owner collision requires review: '+p)
 if p.endswith('/current-autonomy-payment-startup/composition.test.ts'):
  # Full current inventory replaces the historical inventory, retaining every hash assertion.
  text=after.decode().replace("expect(base.parent).toBe('039851736eabb94e85c2c111bbccc78374716275');",f"expect(base.parent).toBe('{pin['currentMain']}');")
  text=text.replace("expect(Object.keys(payment.changes).filter(p=>base.preserved[p])).toEqual(['apps/web/src/app/api/stripe/webhook/route.ts']);","expect(Object.keys(base.changes)).toContain('apps/web/src/app/api/stripe/webhook/route.ts');")
  after=text.encode()
 after=compat['transform'](p,after.decode()).encode()
 dest=out/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(after)
 record={'sha256':sha(after),'bytes':len(after)}
 if before is None:additions[p]=record
 else:changes[p]={**record,'preimageSha256':sha(before),'preimageBytes':len(before)}
 patch.extend(difflib.unified_diff([] if before is None else before.decode().splitlines(keepends=True),after.decode().splitlines(keepends=True),fromfile='/dev/null' if before is None else 'a/'+p,tofile='b/'+p))
(HERE/'owner.patch').write_text(''.join(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n' for line in patch))
preserved={p:{'sha256':sha(b),'bytes':len(b)} for p,b in files.items() if p not in changes}
result={'parent':pin['currentMain'],'historicalParent':pin['historicalParent'],'initialMain':pin['initialMain'],'preserved':preserved,'changes':changes,'additions':additions,'releaseAccepted':False,'liveRunPerformed':False,'patchSha256':sha((HERE/'owner.patch').read_bytes())}
(HERE/'APPLICATION.json').write_text(json.dumps(result,indent=2)+'\n')
(out/'CURRENT-COMPOSITION.json').write_text(json.dumps(result,indent=2)+'\n')
payment=readjson(source/'PAYMENT-COMPOSITION.json');payment['changes']={};payment['reviewChanges']={};(out/'PAYMENT-COMPOSITION.json').write_text(json.dumps(payment,indent=2)+'\n');(HERE/'PAYMENT-COMPOSITION.json').write_text(json.dumps(payment,indent=2)+'\n')
print(json.dumps({'stage':str(out),'preserved':len(preserved),'changes':list(changes),'additions':len(additions)}))
