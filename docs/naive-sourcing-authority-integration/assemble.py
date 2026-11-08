"""Assemble exact current source + factual Workflow candidate + sourcing layer; no secrets/live calls."""
import argparse, hashlib, json, pathlib, shutil, subprocess
p=argparse.ArgumentParser();p.add_argument('destination');args=p.parse_args()
a=pathlib.Path(__file__).resolve().parent;r=a.parent.parent;d=pathlib.Path(args.destination).resolve()
m=json.loads((a/'manifest.json').read_text());previous=a.parent/'naive-factual-workflow-integration'
sha=lambda b:hashlib.sha256(b).hexdigest()
if sha((previous/'manifest.json').read_bytes())!=m['requires']['manifestSha256']:raise RuntimeError('Prerequisite manifest changed')
d.mkdir(exist_ok=False)
for pin in json.loads((a/'validation/baseline-pins.json').read_text()):
 rel=pin['path'];source=r/rel;data=source.read_bytes() if source.is_file() else b''
 if sha(data)!=pin['sha256']:data=subprocess.check_output(['git','show',m['baseCommit']+':'+rel],cwd=r)
 if sha(data)!=pin['sha256']:raise RuntimeError('Baseline mismatch: '+rel)
 out=d/rel;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
for artifact,manifest in [(previous,json.loads((previous/'manifest.json').read_text())),(a,m)]:
 for e in manifest['files']:
  out=d/e['path'];before=sha(out.read_bytes()) if out.is_file() else None
  if before!=e['beforeSha256']:raise RuntimeError('Preimage mismatch: '+e['path'])
  data=(artifact/e['postimage']).read_bytes()
  if sha(data)!=e['afterSha256']:raise RuntimeError('Postimage mismatch: '+e['path'])
  out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
for entry in m['sql']:
 data=(a/entry['path']).read_bytes()
 if sha(data)!=entry['sha256']:raise RuntimeError('SQL mismatch')
 out=d/'docs'/a.name/entry['path'];out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
modules=d/'node_modules';modules.mkdir()
for source in (r/'node_modules').iterdir():
 if source.name!='@ae':(modules/source.name).symlink_to(source,target_is_directory=source.is_dir())
(modules/'@ae').mkdir();(modules/'@ae/core').symlink_to(d/'packages/core',target_is_directory=True)
for rel in ['apps/web/node_modules','packages/core/node_modules']:
 if (r/rel).exists():(d/rel).symlink_to(r/rel,target_is_directory=True)
shutil.copyfile(previous/'validation/font-mock.cjs',d/'font-mock.cjs')
print(d)
