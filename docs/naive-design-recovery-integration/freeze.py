"""Maintainer freeze of reviewed postimages over the exact remediation candidate."""
import difflib, hashlib, json, pathlib, subprocess, sys, tempfile
A=pathlib.Path(__file__).resolve().parent
P=A.parent/'naive-remediation-owner-integration'
REVIEWED='ba9f4c417add517ea971502a1d5427b38f767dc9'
R=A.parent.parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def inherited_paths(layer):
 m=json.loads((layer/'manifest.json').read_text())
 paths=set();sql=set()
 if m.get('requires'):
  paths,sql=inherited_paths(A.parent/m['requires'])
 elif (layer/'validation/baseline-pins.json').exists():
  paths={e['path'] for e in json.loads((layer/'validation/baseline-pins.json').read_text())}
 paths.update(m.get('baselineHashes',{}))
 sql.update(m.get('inheritedSqlHashes',{}))
 paths.update(e['path'] for e in m.get('files',[]))
 paths.update(e['path'] for e in m.get('baselineOverrides',[]))
 for e in m.get('sql',[]):
  sql.add('docs/'+layer.name+'/'+e['path'])
  if e.get('origin'):sql.add(e['origin'])
 return paths,sql
for name in ['manifest.json','assemble.py']:
 pinned=subprocess.check_output(['git','show',REVIEWED+':'+(P/name).relative_to(R).as_posix()],cwd=R)
 if pinned!=(P/name).read_bytes():raise RuntimeError('Reviewed parent changed: '+name)
with tempfile.TemporaryDirectory(prefix='design-recovery-freeze-') as temp:
 d=pathlib.Path(temp)/'baseline'
 subprocess.run([sys.executable,str(P/'assemble.py'),str(d)],check=True,stdout=subprocess.DEVNULL)
 paths,sqlpaths=inherited_paths(P)
 baseline={p:sha((d/p).read_bytes()) for p in sorted(paths)}
 inheritedSql={p:sha((d/p).read_bytes()) for p in sorted(sqlpaths)}
 if not baseline or not inheritedSql:raise RuntimeError('Missing recursive parent baseline/SQL pins')
 files=[];patch=[]
 for source in sorted((A/'postimages').rglob('*')):
  if not source.is_file():continue
  path=source.relative_to(A/'postimages').as_posix();out=d/path
  before=out.read_bytes() if out.is_file() else None;after=source.read_bytes()
  files.append(dict(path=path,postimage=source.relative_to(A).as_posix(),beforeSha256=sha(before) if before is not None else None,afterSha256=sha(after)))
  patch.append('diff --git a/'+path+' b/'+path+'\n')
  if before is None:patch.append('new file mode 100644\n')
  patch.extend(difflib.unified_diff((before or b'').decode().splitlines(True),after.decode().splitlines(True),fromfile='a/'+path if before is not None else '/dev/null',tofile='b/'+path))
 sql=[]
 for source in sorted((A/'sql').glob('*.sql')):
  sql.append(dict(path=source.relative_to(A).as_posix(),sha256=sha(source.read_bytes())))
  path='docs/'+A.name+'/'+source.relative_to(A).as_posix()
  patch.extend(['diff --git a/'+path+' b/'+path+'\n','new file mode 100644\n'])
  patch.extend(difflib.unified_diff([],source.read_text().splitlines(True),fromfile='/dev/null',tofile='b/'+path))
 manifest=dict(reviewedRepositoryCommit=REVIEWED,preservedMain='ef368fc',status='unapplied_incremental_candidate',requires=P.name,
  dependencyHashes={n:sha((P/n).read_bytes()) for n in ['manifest.json','assemble.py']},baselineOverrides=[],baselineHashes=baseline,inheritedSqlHashes=inheritedSql,files=files,sql=sql)
 (A/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 (A/'owner.patch').write_text(''.join(patch))
 print(json.dumps({'incrementalPaths':len(files),'inheritedSourceAndBaselinePaths':len(baseline),'inheritedSqlPaths':len(inheritedSql)}))
