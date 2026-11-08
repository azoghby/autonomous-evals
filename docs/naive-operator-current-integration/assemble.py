import pathlib,subprocess,json,hashlib,difflib,shutil
r=pathlib.Path.cwd();o=r/'docs/naive-operator-current-integration';s=pathlib.Path('/tmp/naive-operator-current-stage');base='7c610084dd9827e5cbecca27e09d5b8ca5e2ae8a'
def git(*a):return subprocess.check_output(['git',*a],cwd=r)
def sha(b):return hashlib.sha256(b).hexdigest()
# Pin source baseline explicitly; later documentation-only commits do not change it.
assert git('rev-parse',base).decode().strip()==base
s.mkdir(exist_ok=True);old=r/'docs/naive-operator-adoption-integration';m=json.loads((old/'manifest.json').read_text());rows=[];patch=''
for f in m['files']:
 p=f['path'];b=(old/f['postimage']).read_bytes();assert sha(b)==f['afterSha256']
 exists=subprocess.run(['git','cat-file','-e',base+':'+p],cwd=r,stderr=subprocess.DEVNULL).returncode==0
 pre=git('show',base+':'+p) if exists else b''
 if p.endswith('/operator-console.tsx'):
  current=pre.decode();historical=git('show',m['baseCommit']+':'+p).decode();candidate=b.decode()
  # The prior change adds only this link; transplant it onto the complete current console.
  link='      <Link href="/operator/expert-reviews" className="mb-6 inline-flex text-sm text-accent underline underline-offset-4">Review expert evidence</Link>\n'
  assert candidate==historical.replace('      <Tabs tab={tab}',link+'      <Tabs tab={tab}')
  b=current.replace('      <Tabs tab={tab}',link+'      <Tabs tab={tab}').encode()
 else:assert (sha(pre) if exists else None)==f['beforeSha256'],p
 dest=o/'source'/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
 rows.append(dict(path=p,beforeSha256=sha(pre) if exists else None,afterSha256=sha(b),postimage='source/'+p,upstreamArtifact=f['upstreamArtifact']))
 patch+='diff --git a/'+p+' b/'+p+'\n'+('new file mode 100644\n' if not exists else '')+''.join(difflib.unified_diff(pre.decode().splitlines(True),b.decode().splitlines(True),fromfile='a/'+p if exists else '/dev/null',tofile='b/'+p))
(o/'owner.patch').write_text(patch)
# Every stage input is an exact tracked baseline blob; no local environment or source overlays.
pins=[];over={f['path']:f for f in rows}
batch=subprocess.Popen(['git','cat-file','--batch'],cwd=r,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
def blob(oid):
 batch.stdin.write((oid+'\n').encode());batch.stdin.flush();header=batch.stdout.readline();size=int(header.split()[2]);b=batch.stdout.read(size);assert batch.stdout.read(1)==b'\n';return b
for line in git('ls-tree','-r',base).decode().splitlines():
 meta,p=line.split('\t');oid=meta.split()[2]
 if not (p.startswith(('apps/web/','packages/core/','data/','test/')) or p in ('package.json','package-lock.json','tsconfig.json','vitest.config.ts')):continue
 b=(r/p).read_bytes()
 if hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()!=oid:b=blob(oid)
 dest=s/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
 if p in over:b=(o/over[p]['postimage']).read_bytes();dest.write_bytes(b)
 pins.append(dict(path=p,gitBlob=oid,sha256=sha(b),candidateOverride=p in over))
for f in rows:
 dest=s/f['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(o/f['postimage'],dest)
(o/'evidence/SUPPORT-PINS.json').write_text(json.dumps(pins,indent=2)+'\n')
(o/'manifest.json').write_text(json.dumps(dict(baseCommit=base,files=rows,patchSha256=sha((o/'owner.patch').read_bytes()),stage=str(s),trackedBaselinePins=len(pins)),indent=2)+'\n')
subprocess.run(['git','apply','--check',str(o/'owner.patch')],cwd=r,check=True)
print('assembled',len(pins),'baseline pins and',len(rows),'postimages')

(s/'test/stubs').mkdir(parents=True,exist_ok=True)
(s/'test/stubs/server-only.ts').write_text('export {};\n')
