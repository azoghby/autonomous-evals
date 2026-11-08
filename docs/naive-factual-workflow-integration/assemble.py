"""Create a private exact-baseline review tree. No install, migration, .env or live calls."""
import argparse, hashlib, json, pathlib, subprocess, shutil
p=argparse.ArgumentParser();p.add_argument('destination');a=p.parse_args()
artifact=pathlib.Path(__file__).resolve().parent
root=artifact.parent.parent
stage=pathlib.Path(a.destination).resolve()
manifest=json.loads((artifact/'manifest.json').read_text())
stage.mkdir(exist_ok=False)
blob=lambda data:hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
for pin in json.loads((artifact/'validation/baseline-pins.json').read_text()):
 rel=pin['path'];source=root/rel
 data=source.read_bytes() if source.is_file() else b''
 if blob(data)!=pin['baselineGitBlob']:
  data=subprocess.check_output(['git','show',f"{manifest['baseCommit']}:{rel}"],cwd=root)
 if blob(data)!=pin['baselineGitBlob']:raise RuntimeError('Baseline mismatch: '+rel)
 target=stage/rel;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
for entry in manifest['files']:
 target=stage/entry['path'];before=hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
 if before!=entry['beforeSha256']:raise RuntimeError('Preimage mismatch: '+entry['path'])
 data=(artifact/entry['postimage']).read_bytes()
 if hashlib.sha256(data).hexdigest()!=entry['afterSha256']:raise RuntimeError('Postimage mismatch: '+entry['path'])
 target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
# Retain the installed dependency graph without copying secrets or changing dependencies.
modules=stage/'node_modules';modules.mkdir()
for source in (root/'node_modules').iterdir():
 if source.name!='@ae':(modules/source.name).symlink_to(source,target_is_directory=source.is_dir())
(modules/'@ae').mkdir();(modules/'@ae/core').symlink_to(stage/'packages/core',target_is_directory=True)
for rel in ['apps/web/node_modules','packages/core/node_modules']:
 if (root/rel).exists():(stage/rel).symlink_to(root/rel,target_is_directory=True)
shutil.copyfile(artifact/'validation/font-mock.cjs',stage/'font-mock.cjs')
print(stage)
