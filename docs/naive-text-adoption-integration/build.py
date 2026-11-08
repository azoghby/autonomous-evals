from pathlib import Path
import subprocess,json,hashlib,difflib
root=Path(__file__).resolve().parents[2];out=Path(__file__).resolve().parent
base='06d8a15';base=subprocess.check_output(['git','rev-parse',base],cwd=root,text=True).strip()
names=['expert-workflow-integration','naive-rich-contract-integration','naive-text-runtime-integration','naive-workflow-schema-integration']
sha=lambda b:hashlib.sha256(b).hexdigest()
original={};current={};dependencies=[]
for name in names:
 folder=root/'docs'/name;raw=(folder/'manifest.json').read_bytes();m=json.loads(raw)
 dependencies.append({'artifact':name,'manifestSha256':sha(raw),'patchSha256':sha((folder/'owner.patch').read_bytes())})
 for f in m['files']:
  path=f['path'];before=f.get('preimage_sha256',f.get('beforeSha256'));after=f.get('postimage_sha256',f.get('afterSha256'))
  if path not in current:
   r=subprocess.run(['git','show',f'{base}:{path}'],cwd=root,capture_output=True)
   original[path]=r.stdout if r.returncode==0 else None;current[path]=original[path]
  if (sha(current[path]) if current[path] is not None else None)!=before:raise Exception('Preimage mismatch '+name+' '+path)
  source=folder/'source'/path
  if not source.exists():source=folder/'postimages'/path
  data=source.read_bytes()
  if sha(data)!=after:raise Exception('Postimage mismatch '+name+' '+path)
  current[path]=data
patch='';files=[]
for path,after in sorted(current.items()):
 before=original[path]
 if before==after:continue
 dest=out/'postimages'/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(after)
 files.append({'path':path,'beforeSha256':sha(before) if before is not None else None,'afterSha256':sha(after)})
 patch+='diff --git a/'+path+' b/'+path+'\n'
 if before is None:patch+='new file mode 100644\n'
 for line in difflib.unified_diff((before or b'').decode().splitlines(True),after.decode().splitlines(True),fromfile='a/'+path if before is not None else '/dev/null',tofile='b/'+path):
  patch+=line if line.endswith('\n') else line+'\n\\ No newline at end of file\n'
(out/'owner.patch').write_text(patch)
(out/'manifest.json').write_text(json.dumps({'baseCommit':base,'files':files,'dependencies':dependencies,'patchSha256':sha(patch.encode()),'actualApplicationModified':False,'productionActivated':False},indent=2)+'\n')
print(json.dumps({'base':base,'files':len(files),'patchSha256':sha(patch.encode())}))
