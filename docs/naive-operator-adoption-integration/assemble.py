import pathlib,subprocess,json,hashlib,shutil,os
r=pathlib.Path.cwd(); out=r/'docs/naive-operator-adoption-integration'; s=pathlib.Path('/tmp/naive-operator-combined-stage');s.mkdir(exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=r)
head=git('rev-parse','HEAD').decode().strip(); rows=[]
for d in ['expert-review-surface-integration','naive-proxy-recovery-integration']:
 p=r/'docs'/d;m=json.loads((p/'manifest.json').read_text())
 for f in m['files']:
  path=f['path'];pre=f.get('beforeSha256',f.get('preimage_sha256'));post=f.get('afterSha256',f.get('postimage_sha256'));b=(p/f['postimage']).read_bytes();assert sha(b)==post
  exists=subprocess.run(['git','cat-file','-e',head+':'+path],cwd=r,stderr=subprocess.DEVNULL).returncode==0
  assert (sha(git('show',head+':'+path)) if exists else None)==pre
  dest=out/'source'/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
  rows.append(dict(path=path,beforeSha256=pre,afterSha256=post,postimage='source/'+path,upstreamArtifact=d))
(out/'owner.patch').write_bytes((r/'docs/expert-review-surface-integration/owner.patch').read_bytes()+(r/'docs/naive-proxy-recovery-integration/owner.patch').read_bytes())
subprocess.run(['git','apply','--check',str(out/'owner.patch')],cwd=r,check=True)
# Copy retained app/core/data files, excluding generated app outputs and dependency trees.
base=pathlib.Path('/tmp/expert-review-api-stage')
for top in ['apps','packages','data','test']:
 shutil.copytree(base/top,s/top,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','.next','*.tsbuildinfo'))
shutil.copy2(base/'package.json',s/'package.json')
if not (s/'node_modules').exists():os.symlink(base/'node_modules',s/'node_modules')
# Upgrade the three core source differences to current HEAD, obtaining exact tracked Git blobs.
changed=git('diff','--name-only','9eb9e4c',head,'--','apps/web','packages/core').decode().splitlines()
for path in changed:
 dest=s/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(git('show',head+':'+path))
for f in rows:
 dest=s/f['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(out/f['postimage'],dest)
# Verify all tracked app/core files against current Git blob identity, allowing only ten proposed postimages.
files=git('ls-tree','-r',head,'--','apps/web','packages/core').decode().splitlines();over={f['path']:f for f in rows};pins=[]
for line in files:
 meta,path=line.split('\t');oid=meta.split()[2];dest=s/path
 if not dest.exists():dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(git('cat-file','blob',oid))
 b=dest.read_bytes()
 if path in over:assert sha(b)==over[path]['afterSha256']
 else:assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==oid,path
 pins.append(dict(path=path,gitBlob=oid,sha256=sha(b),candidateOverride=path in over))
for f in rows:assert sha((s/f['path']).read_bytes())==f['afterSha256']
(out/'evidence/SUPPORT-PINS.json').write_text(json.dumps(pins,indent=2)+'\n')
m=dict(baseCommit=head,files=rows,patchSha256=sha((out/'owner.patch').read_bytes()),stage=str(s),sourceFilesVerified=len(pins),coreUpgrades=changed)
(out/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(json.dumps(m,indent=2))
