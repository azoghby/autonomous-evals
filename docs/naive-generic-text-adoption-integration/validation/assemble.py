"""Assemble an isolated tracked-source stage; never copies secrets or changes root source."""
import hashlib,json,os,pathlib,subprocess,sys,tarfile,tempfile
root=pathlib.Path(__file__).resolve().parents[3]
artifact=root/'docs/naive-generic-text-adoption-integration'
sha=subprocess.check_output(['git','rev-parse',sys.argv[1]],cwd=root,text=True).strip()
stage=pathlib.Path('/tmp')/('naive-generic-text-adoption-current-'+sha[:12]+'-verified')
if stage.exists(): stage.rmdir()  # only the confirmed empty, terminated archive attempt
stage.mkdir()
if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=sha: raise RuntimeError('HEAD changed')
tree=subprocess.check_output(['git','ls-tree','-r','-z',sha],cwd=root)
entries={}
for record in tree.split(b'\0'):
 if not record:continue
 meta,path=record.split(b'\t',1);mode,kind,blob=meta.decode().split();path=path.decode()
 if kind=='blob':entries[path]=blob
hashfile=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
baseline={};excluded={};blobInventory={}
for rel,blob in entries.items():
 if rel.startswith('docs/') or rel.startswith('tests/track-b/') and rel != 'tests/track-b/trace-acceptance.json':
  excluded[rel]='historical documentation/standalone Track B harness excluded; standard test filesystem reference audit requires only trace-acceptance.json from Track B'
  continue
 source=root/rel
 data=source.read_bytes()
 gitBlob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
 if gitBlob!=blob:raise RuntimeError('Tracked bytes differ from commit: '+rel)
 if pathlib.Path(rel).name in {'.env','.env.local','.env.production','.env.development'}: raise RuntimeError('Unexpected tracked secret file: '+rel)
 dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
 baseline[rel]=hashlib.sha256(data).hexdigest();blobInventory[rel]=blob
(artifact/'validation/committed-blob-inventory.json').write_text(json.dumps({'commit':sha,'verifiedBlobs':blobInventory,'exclusions':excluded},indent=2)+'\n')
posts=sorted(p for p in (artifact/'postimages').rglob('*') if p.is_file())
assert len(posts)==16
for post in posts:
 rel=post.relative_to(artifact/'postimages');dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(post.read_bytes())
(stage/'node_modules').mkdir()
for dependency in (root/'node_modules').iterdir():
 if dependency.name=='@ae':continue
 (stage/'node_modules'/dependency.name).symlink_to(dependency,target_is_directory=dependency.is_dir())
(stage/'node_modules/@ae').mkdir();(stage/'node_modules/@ae/core').symlink_to(stage/'packages/core',target_is_directory=True)
for nested in ['apps/web/node_modules','packages/core/node_modules']:
 assert (root/nested).is_dir();(stage/nested).symlink_to(root/nested,target_is_directory=True)
(stage/'font-mock.cjs').write_text("module.exports = new Proxy({}, {get: () => \"@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400 500; src: url(data:font/woff2;base64,d09GMgABAAAAAA==) format('woff2'); }\"});\n")
(artifact/'validation/baseline-source-hashes.json').write_text(json.dumps(baseline,indent=2)+'\n')
(artifact/'validation/assembly.json').write_text(json.dumps({'baseCommit':sha,'stage':str(stage),'trackedFiles':len(baseline),'postimages':len(posts),'environmentFilesCopied':False,'assemblyMode':'git ls-tree pinned blob hashes checked against current tracked bytes; docs and standalone Track B harness inventory explicitly excluded after terminated cloud-blocked archive','dependencyMode':'actual root and matching app/core nested installed dependencies; stage @ae/core workspace binding'},indent=2)+'\n')
print(stage)
