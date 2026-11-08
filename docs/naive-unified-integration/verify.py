"""Independently apply owner.patch to the preserved cancellation baseline and compare bytes."""
import hashlib,json,pathlib,subprocess,sys,tempfile
A=pathlib.Path(__file__).resolve().parent;R=A.parent.parent
M=json.loads((A/'manifest.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
with tempfile.TemporaryDirectory(prefix='unified-patch-check-') as temp:
 d=pathlib.Path(temp)/'stage'
 subprocess.run([sys.executable,str(A.parent/M['requires']/'assemble.py'),str(d)],check=True,stdout=subprocess.DEVNULL)
 for entry in M['baselineOverrides']:
  out=d/entry['path'];before=sha(out.read_bytes()) if out.is_file() else None
  if before!=entry['beforeSha256']:raise RuntimeError('Upstream preimage mismatch: '+entry['path'])
  data=subprocess.check_output(['git','cat-file','blob',entry['commit']+':'+entry['path']],cwd=R)
  if sha(data)!=entry['afterSha256']:raise RuntimeError('Upstream postimage mismatch')
  out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
 subprocess.run(['git','apply','--check',str(A/'owner.patch')],cwd=d,check=True)
 subprocess.run(['git','apply',str(A/'owner.patch')],cwd=d,check=True)
 for entry in M['files']:
  actual=(d/entry['path']).read_bytes();expected=(A/entry['postimage']).read_bytes()
  if actual!=expected or sha(actual)!=entry['afterSha256']:raise RuntimeError('Patch postimage mismatch: '+entry['path'])
 print(json.dumps({'ownerPatchApplied':True,'postimagesVerified':len(M['files']),'upstreamOverridesVerified':len(M['baselineOverrides'])}))
