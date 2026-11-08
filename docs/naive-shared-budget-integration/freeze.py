"""Freeze incremental pre/postimages against repository + prior MCP/dispatch layers."""
import difflib, hashlib, json, pathlib, subprocess
a=pathlib.Path(__file__).resolve().parent
r=a.parent.parent
p=a.parent/'naive-copilot-dispatch-integration'
base='09997e4'
sha=lambda data:hashlib.sha256(data).hexdigest()
prior={}
for name in ['naive-internal-mcp-integration','naive-copilot-dispatch-integration']:
    layer=a.parent/name
    for entry in json.loads((layer/'manifest.json').read_text())['files']:
        data=(layer/entry['postimage']).read_bytes()
        if sha(data)!=entry['afterSha256']:raise RuntimeError('Changed dependency')
        prior[entry['path']]=data
files=[];patch=[]
for source in sorted((a/'postimages').rglob('*.ts')):
    path=source.relative_to(a/'postimages').as_posix()
    if path in prior:before=prior[path]
    else:
        result=subprocess.run(['git','show',base+':'+path],cwd=r,capture_output=True)
        before=result.stdout if result.returncode==0 else None
    after=source.read_bytes()
    files.append({'path':path,'postimage':source.relative_to(a).as_posix(),
                  'beforeSha256':sha(before) if before is not None else None,'afterSha256':sha(after)})
    patch.append('diff --git a/'+path+' b/'+path+'\n')
    if before is None:patch.append('new file mode 100644\n')
    patch.extend(difflib.unified_diff((before or b'').decode().splitlines(True),after.decode().splitlines(True),
                                    fromfile='a/'+path if before is not None else '/dev/null',tofile='b/'+path))
m={'reviewedRepositoryCommit':base,'status':'unapplied_incremental_candidate',
   'requires':'naive-copilot-dispatch-integration',
   'dependencyHashes':{name:sha((p/name).read_bytes()) for name in ['manifest.json','assemble.py']},
   'files':files,'sql':[{'path':path.relative_to(a).as_posix(),'sha256':sha(path.read_bytes())} for path in sorted((a/'sql').glob('*.sql'))]}
(a/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
(a/'owner.patch').write_text(''.join(patch))
print(len(files),'incremental source/test paths; SQL separate')
