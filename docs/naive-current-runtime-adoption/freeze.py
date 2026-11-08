"""Freeze cumulative source delta; never applies it to the repository."""
import difflib,hashlib,io,json,pathlib,subprocess,tarfile,tempfile,zlib
A=pathlib.Path(__file__).resolve().parent;R=A.parent.parent
BASE='fbedc75d1ede96e792a72119ac606d10ade41fe4'; REVIEW='f03edc8'; C=pathlib.Path('/tmp/naive-run-recovery-final-v2')
sha=lambda b:hashlib.sha256(b).hexdigest()
def snapshot():
 review=json.loads(subprocess.check_output(['git','show',REVIEW+':docs/naive-run-recovery-integration/manifest.json'],cwd=R));neededSql=set(review['inheritedSqlHashes'])|{'docs/naive-run-recovery-integration/'+e['path'] for e in review['sql']}
 rows=subprocess.check_output(['git','ls-tree','-r','-z',BASE],cwd=R).split(b'\0');entries={};modes={};tree={}
 proc=subprocess.Popen(['git','cat-file','--batch'],cwd=R,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
 for row in rows:
  if not row:continue
  meta,name=row.split(b'\t',1);mode,kind,oid=meta.split();p=name.decode()
  if kind!=b'blob' or mode not in (b'100644',b'100755'):raise RuntimeError('Unsupported tracked entry: '+p)
  tree[p]={'gitBlob':oid.decode(),'mode':mode.decode()}
  if p.startswith('docs/') and p not in neededSql:continue
  working=R/p
  current=working.read_bytes() if working.is_file() else None
  if current is not None and hashlib.sha1(b'blob '+str(len(current)).encode()+b'\0'+current).hexdigest()==oid.decode():
   entries[p]=current;modes[p]=int(mode,8)&0o777;continue
  loose=R/'.git/objects'/oid[:2].decode()/oid[2:].decode()
  if loose.is_file():
   raw=zlib.decompress(loose.read_bytes());head,data=raw.split(b'\0',1)
   if head!=b'blob '+str(len(data)).encode() or hashlib.sha1(raw).hexdigest()!=oid.decode():raise RuntimeError('Git object integrity mismatch: '+p)
   entries[p]=data
  else:
   proc.stdin.write(oid+b'\n');proc.stdin.flush();header=proc.stdout.readline();size=int(header.split()[2]);entries[p]=proc.stdout.read(size);proc.stdout.read(1)
  modes[p]=int(mode,8)&0o777
 proc.stdin.close();proc.wait()
 snapshot.modes=modes;snapshot.tree=tree
 return entries
def source(p):return p.startswith(('apps/','packages/','scripts/'))
if __name__=='__main__':
 baseline=snapshot();reviewedManifest=subprocess.check_output(['git','show',REVIEW+':docs/naive-run-recovery-integration/manifest.json'],cwd=R);m=json.loads(reviewedManifest)
 expected=dict(m['baselineHashes']);expected.update({e['path']:e['afterSha256'] for e in m['files']})
 cp={p for p in m['baselineHashes'] if source(p)}|{e['path'] for e in m['files'] if source(e['path'])}
 for p in cp:
  if not (C/p).is_file() or sha((C/p).read_bytes())!=expected[p]:raise RuntimeError('Reviewed candidate hash mismatch: '+p)
 final=dict(baseline);files=[];patch=[];comparison=[]
 for p in sorted({p for p in baseline if source(p)}|cp):
  before=baseline.get(p);after=(C/p).read_bytes() if p in cp and (C/p).is_file() else before
  comparison.append({'path':p,'baselineSha256':sha(before) if before is not None else None,'reviewedCandidateSha256':sha((C/p).read_bytes()) if (C/p).is_file() else None,'action':'preserve-current' if after==before else 'adopt-reviewed-postimage'})
  if after==before:continue
  if after is None:raise RuntimeError('Deletion forbidden: '+p)
  final[p]=after;out=A/'postimages'/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(after)
  files.append({'path':p,'postimage':'postimages/'+p,'beforeSha256':sha(before) if before is not None else None,'afterSha256':sha(after)})
  patch.append('diff --git a/'+p+' b/'+p+'\n')
  if before is None:patch.append('new file mode 100644\n')
  patch.extend(difflib.unified_diff((before or b'').decode().splitlines(True),after.decode().splitlines(True),fromfile='a/'+p if before is not None else '/dev/null',tofile='b/'+p))
 sqlpaths=set(m['inheritedSqlHashes'])|{'docs/naive-run-recovery-integration/'+e['path'] for e in m['sql']}
 sqlpaths.update(p for p in baseline if p.startswith('packages/core/') and p.endswith('.sql'))
 sql=[]
 for p in sorted(sqlpaths):
  data=baseline[p];origin=baseline.get(p)
  if origin!=data:raise RuntimeError('SQL must already be committed exactly: '+p)
  sql.append({'path':p,'sha256':sha(data),'status':'tracked-review-material-only','migrationAuthorizationRequired':True,'identicalContentAliases':[q for q in sorted(sqlpaths) if q!=p and baseline.get(q)==data]})
 manifest={'status':'unapplied-cumulative-source-candidate','baselineCommit':BASE,'reviewedComposedCommit':REVIEW,'reviewedManifestSha256':sha(reviewedManifest),'reviewedComposedAssembly':str(C),'baselineTree':snapshot.tree,'baselineModes':snapshot.modes,'baselineHashes':{p:sha(b) for p,b in sorted(baseline.items())},'files':files,'sourceComparison':comparison,'finalSourceHashes':{p:sha(b) for p,b in sorted(final.items()) if source(p)},'sqlInventorySha256':None,'deletions':[],'preservation':'All committed paths pinned by Git blob and mode; offline assembly exports current source/config/test/data plus only required reviewed SQL docs, omitting other historical docs. Actual scoped patch preserves every other current committed path. SQL is review material, never migration authorization.'}
 (A/'sql-inventory.json').write_text(json.dumps({'liveActions':False,'applyMigrations':False,'ordering':'Alphabetical inventory only; no executable migration order. Requires manual dependency review and separate authorization.','entries':sql},indent=2)+'\n');manifest['sqlInventorySha256']=sha((A/'sql-inventory.json').read_bytes())
 (A/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(A/'owner.patch').write_text(''.join(patch))
 print(json.dumps({'changedSourcePaths':len(files),'baselinePaths':len(baseline),'finalSourcePaths':len(manifest['finalSourceHashes']),'sqlReviewPaths':len(sql)}))
