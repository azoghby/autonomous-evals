"""Freeze the reviewed unified increment; does not change application source."""
import difflib, hashlib, json, pathlib, subprocess, sys, tempfile
A=pathlib.Path(__file__).resolve().parent
R=A.parent.parent
P=A.parent/'naive-cancellation-integration'
BASE='7f28e20'
sha=lambda b:hashlib.sha256(b).hexdigest()
blob=lambda commit,path:subprocess.run(['git','cat-file','blob',commit+':'+path],cwd=R,capture_output=True)
with tempfile.TemporaryDirectory(prefix='unified-freeze-') as temp:
 d=pathlib.Path(temp)/'baseline'
 subprocess.run([sys.executable,str(P/'assemble.py'),str(d)],check=True,stdout=subprocess.DEVNULL)
 overrides=[]
 for path in subprocess.check_output(['git','diff','--name-only','c4fcf0f',BASE,'--','apps','packages','scripts'],cwd=R,text=True).splitlines():
  out=d/path;before=out.read_bytes() if out.is_file() else None
  result=blob(BASE,path)
  if result.returncode:raise RuntimeError('Deleted upstream source needs explicit handling: '+path)
  data=result.stdout
  overrides.append(dict(path=path,beforeSha256=sha(before) if before is not None else None,afterSha256=sha(data),commit=BASE))
  out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
 files=[];patch=[]
 for source in sorted((A/'postimages').rglob('*')):
  if not source.is_file():continue
  path=source.relative_to(A/'postimages').as_posix();out=d/path
  before=out.read_bytes() if out.is_file() else None;after=source.read_bytes()
  files.append(dict(path=path,postimage=source.relative_to(A).as_posix(),beforeSha256=sha(before) if before is not None else None,afterSha256=sha(after)))
  patch.append('diff --git a/'+path+' b/'+path+'\n')
  if before is None:patch.append('new file mode 100644\n')
  patch.extend(difflib.unified_diff((before or b'').decode().splitlines(True),after.decode().splitlines(True),fromfile='a/'+path if before is not None else '/dev/null',tofile='b/'+path))
 expected={entry['path'] for name in ['naive-factual-workflow-integration','naive-sourcing-authority-integration'] for entry in json.loads((A.parent/name/'manifest.json').read_text())['files']}
 missing=expected-{entry['path'] for entry in files}
 if missing:raise RuntimeError('Missing required input postimages: '+', '.join(sorted(missing)))
 provenance={}
 for name in ['naive-factual-workflow-integration','naive-sourcing-authority-integration']:
  layer=A.parent/name
  provenance[name]={'manifestSha256':sha((layer/'manifest.json').read_bytes()),'files':len(json.loads((layer/'manifest.json').read_text())['files'])}
 sqlOrigins={'001-expert-sourcing-authority.sql':'naive-sourcing-authority-integration/sql/001-expert-sourcing-authority.sql','0024_expert_automation.sql':'expert-adoption-integration/postimages/packages/core/src/db/migrations/0024_expert_automation.sql','0025_expert_workflow.sql':'naive-text-adoption-integration/postimages/packages/core/src/db/migrations/0025_expert_workflow.sql','0026_expert_text_runtime.sql':'naive-text-adoption-integration/postimages/packages/core/src/db/migrations/0026_expert_text_runtime.sql'}
 sql=[]
 for source in sorted((A/'sql').glob('*.sql')):
  origin=sqlOrigins[source.name]
  if source.read_bytes()!=(A.parent/origin).read_bytes():raise RuntimeError('SQL provenance mismatch')
  sql.append(dict(path=source.relative_to(A).as_posix(),sha256=sha(source.read_bytes()),origin='docs/'+origin))
 manifest=dict(reviewedRepositoryCommit=BASE,status='unapplied_incremental_candidate',requires=P.name,dependencyHashes={name:sha((P/name).read_bytes()) for name in ['manifest.json','assemble.py']},provenance=provenance,baselineOverrides=overrides,files=files,sql=sql)
 (A/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(A/'owner.patch').write_text(''.join(patch))
 print(len(files),'incremental source/test paths;',len(overrides),'upstream preservation overrides')
