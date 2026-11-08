"""Assemble isolated exact-base operator + factual candidate source. No env files or live services."""
from pathlib import Path
import subprocess,json,hashlib,os,shutil
root=Path.cwd(); artifact=root/'docs/naive-factual-gap-entry-integration'
base='35fbcab1b0035ffb447f3766ec43f4363a03c3fd'
stage=Path('/tmp/naive-factual-gap-current-stage')
if stage.exists():shutil.rmtree(stage)
stage.mkdir()
inventory=json.loads((root/'docs/naive-generic-text-adoption-integration/validation/committed-blob-inventory.json').read_text())
assert inventory['commit']==base
pins=[]
for path,oid in inventory['verifiedBlobs'].items():
 if not (path.startswith(('apps/web/','packages/core/','data/','test/')) or path in ('package.json','package-lock.json','vitest.config.ts')):continue
 source=root/path;data=source.read_bytes()
 assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==oid,path+' differs from pinned base'
 destination=stage/path;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
 pins.append({'path':path,'gitBlob':oid,'sha256':hashlib.sha256(data).hexdigest()})
(artifact/'evidence/BASELINE-PINS.json').write_text(json.dumps({'baseCommit':base,'files':pins},indent=2)+'\n')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
operator=json.loads((root/'docs/naive-operator-current-integration/manifest.json').read_text())
for f in operator['files']:
 dest=stage/f['path'];assert sha(dest)==f['beforeSha256'],f['path']
 src=root/'docs/naive-operator-current-integration'/f['postimage'];assert sha(src)==f['afterSha256']
 dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
manifest=json.loads((artifact/'manifest.json').read_text())
subprocess.run(['git','apply','--check',str(artifact/'owner.patch')],cwd=stage,check=True)
subprocess.run(['git','apply',str(artifact/'owner.patch')],cwd=stage,check=True)
for f in manifest['files']:assert sha(stage/f['path'])==f['postimageSha256'],f['path']
(stage/'node_modules').mkdir()
for p in (root/'node_modules').iterdir():
 if p.name!='@ae':os.symlink(p,stage/'node_modules'/p.name)
(stage/'node_modules/@ae').mkdir();os.symlink(stage/'packages/core',stage/'node_modules/@ae/core')
for workspace in ['apps/web','packages/core']:
 dest=stage/workspace/'node_modules';dest.mkdir(exist_ok=True)
 for p in (root/workspace/'node_modules').iterdir():os.symlink(p,dest/p.name)
receipt={'baseCommit':base,'baselineFiles':len(pins),'operatorFiles':len(operator['files']),'entryFiles':len(manifest['files']),'stage':str(stage),'operatorPreimages':'all matched exact base','patchApplyCheck':'passed','postimages':'all matched manifest','envFilesCopied':False}
(artifact/'evidence/composed-patch-application.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
