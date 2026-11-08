"""Maintainer freeze of reviewed postimages over the exact unified candidate."""
import difflib, hashlib, json, pathlib, subprocess, sys, tempfile
A=pathlib.Path(__file__).resolve().parent
P=A.parent/'naive-unified-integration'
R=A.parent.parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def inherited_paths(layer):
 m=json.loads((layer/'manifest.json').read_text())
 paths=set();sql=set()
 if m.get('requires'):
  paths,sql=inherited_paths(A.parent/m['requires'])
 elif (layer/'validation/baseline-pins.json').exists():
  paths={e['path'] for e in json.loads((layer/'validation/baseline-pins.json').read_text())}
 paths.update(e['path'] for e in m.get('files',[]))
 paths.update(e['path'] for e in m.get('baselineOverrides',[]))
 for e in m.get('sql',[]):
  sql.add('docs/'+layer.name+'/'+e['path'])
  if e.get('origin'):sql.add(e['origin'])
 return paths,sql
with tempfile.TemporaryDirectory(prefix='remediation-freeze-') as temp:
 d=pathlib.Path(temp)/'baseline'
 subprocess.run([sys.executable,str(P/'assemble.py'),str(d)],check=True,stdout=subprocess.DEVNULL)
 paths,sqlpaths=inherited_paths(P)
 baseline={p:sha((d/p).read_bytes()) for p in sorted(paths)}
 inheritedSql={p:sha((d/p).read_bytes()) for p in sorted(sqlpaths)}
 if len(baseline)!=2350:raise RuntimeError('Expected all 2350 inherited baseline/source paths')
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
  origin='packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql'
  if source.read_bytes()!=(d/origin).read_bytes():raise RuntimeError('Core accounting SQL provenance mismatch')
  sql.append(dict(path=source.relative_to(A).as_posix(),sha256=sha(source.read_bytes()),origin=origin))
 manifest=dict(reviewedRepositoryCommit='6fa1fe7',preservedMain='ef368fc',status='unapplied_incremental_candidate',requires=P.name,
  dependencyHashes={n:sha((P/n).read_bytes()) for n in ['manifest.json','assemble.py']},baselineOverrides=[],baselineHashes=baseline,inheritedSqlHashes=inheritedSql,files=files,sql=sql)
 (A/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 (A/'owner.patch').write_text(''.join(patch))
 print(json.dumps({'incrementalPaths':len(files),'inheritedSourceAndBaselinePaths':len(baseline),'inheritedSqlPaths':len(inheritedSql)}))
