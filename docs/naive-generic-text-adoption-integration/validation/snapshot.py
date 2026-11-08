"""Refresh reviewable patch and verify staged tracked-source ownership after validation."""
import difflib,hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[3];artifact=root/'docs/naive-generic-text-adoption-integration';validation=artifact/'validation'
a=json.loads((validation/'assembly.json').read_text());stage=pathlib.Path(a['stage']);base=a['baseCommit']
hashdata=lambda data:hashlib.sha256(data).hexdigest()
hashfile=lambda path:hashdata(path.read_bytes())
files=[];patch=[]
for post in sorted(p for p in (artifact/'postimages').rglob('*') if p.is_file()):
 rel=str(post.relative_to(artifact/'postimages'));before=(root/rel).read_bytes() if (root/rel).exists() else None;after=post.read_bytes();assert (stage/rel).read_bytes()==after,rel
 files.append({'path':rel,'operation':'add' if before is None else 'modify','preimageSha256':hashdata(before) if before is not None else None,'postimageSha256':hashdata(after),'role':'test' if '.test.' in rel else 'source'})
 patch.append('diff --git a/'+rel+' b/'+rel+'\n')
 if before is None:patch.append('new file mode 100644\n')
 patch.extend(difflib.unified_diff((before or b'').decode().splitlines(keepends=True),after.decode().splitlines(keepends=True),fromfile='/dev/null' if before is None else 'a/'+rel,tofile='b/'+rel))
manifest={'baseCommit':base,'branch':'track-a','status':'candidate-only; source approval, application recovery wiring/migration and activation separate','sourceFiles':sum(x['role']=='source' for x in files),'testFiles':sum(x['role']=='test' for x in files),'files':files}
(artifact/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(artifact/'owner.patch').write_text(''.join(patch))
owned={x['path'] for x in files};baseline=json.loads((validation/'baseline-source-hashes.json').read_text())
diff=[p for p,h in baseline.items() if p not in owned and (not (stage/p).is_file() or hashfile(stage/p)!=h)]
assert not diff,diff
apply=subprocess.run(['git','apply','--check',str(artifact/'owner.patch')],cwd=root,capture_output=True,text=True);assert apply.returncode==0,apply.stderr
actual=[]
for f in files:
 p=root/f['path'];current=hashfile(p) if p.exists() else None
 if current!=f['preimageSha256']:actual.append(f['path'])
assert not actual,actual
receipt={'baseCommit':base,'trackedFiles':len(baseline),'unownedStageDifferences':diff,'exactPostimageMatches':len(files),'actualRootPreimageMismatches':actual,'manifestSha256':hashfile(artifact/'manifest.json'),'ownerPatchSha256':hashfile(artifact/'owner.patch'),'gitApplyCheckExitCode':apply.returncode,'stage':str(stage)}
(validation/'postbuild-verification.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
