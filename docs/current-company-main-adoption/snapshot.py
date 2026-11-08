"""Read-only materialization: authenticate index entries to immutable commit tree without Git writes."""
import pathlib,hashlib,json,sys,os,subprocess
index=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);out=pathlib.Path(sys.argv[3]);expected=sys.argv[4]
obj=lambda kind,b:hashlib.sha1(kind.encode()+b' '+str(len(b)).encode()+b'\0'+b).digest()
tree={};entries=[]
for raw in index.read_bytes().split(b'\0'):
 if not raw:continue
 header,p=raw.split(b'\t',1);mode,oid,stage=header.split()
 if stage!=b'0':raise RuntimeError('Unmerged index')
 parts=p.decode().split('/');node=tree
 for part in parts[:-1]:node=node.setdefault(part,{})
 node[parts[-1]]=(mode,oid);entries.append((p.decode(),mode.decode(),oid.decode()))
def hash_tree(node):
 result=b''
 for name,value in sorted(node.items(),key=lambda item:(item[0]+('/' if isinstance(item[1],dict) else '')).encode()):
  mode,oid=(b'40000',hash_tree(value)) if isinstance(value,dict) else (value[0],bytes.fromhex(value[1].decode()))
  result+=mode+b' '+name.encode()+b'\0'+oid
 return obj('tree',result)
actual=hash_tree(tree).hex()
if actual!=expected:raise RuntimeError('Index does not match immutable commit tree: '+actual)
# Resume only individually authenticated blobs in this dedicated snapshot directory.
out.mkdir(parents=True,exist_ok=True);records={}
def materialize(entry):
 p,mode,oid=entry
 src=root/p
 # Prefer previously verified retained bytes only when the Git blob identity matches.
 data=None
 for candidate in [out/p,pathlib.Path('/private/tmp/current-company-main-b331cc9-base-20261107')/p,pathlib.Path('/private/tmp/current-company-main-parallel-snapshot-20261107')/p,pathlib.Path('/private/tmp/track-b-company-reproduced-20261107')/p]:
  if candidate.is_file():
   cached=candidate.read_bytes()
   if obj('blob',cached).hex()==oid:
    data=cached;break
 if data is None:
  print('READ '+p,flush=True)
  data=os.readlink(src).encode() if mode=='120000' else src.read_bytes()
 if obj('blob',data).hex()!=oid:
  print('PINNED_BLOB '+p,flush=True)
  data=subprocess.check_output(['git','cat-file','blob',oid],cwd=root)
 if obj('blob',data).hex()!=oid:raise RuntimeError('Pinned byte drift: '+p)
 dst=out/p;dst.parent.mkdir(parents=True,exist_ok=True)
 if mode=='120000':dst.symlink_to(data.decode())
 else:dst.write_bytes(data);dst.chmod(0o755 if mode=='100755' else 0o644)
 return p,{'gitBlob':oid,'mode':mode,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=32) as pool:
 records=dict(pool.map(materialize,entries))
print(json.dumps({'tree':actual,'files':len(records)}))
pathlib.Path(__file__).with_name('BASE-INVENTORY-'+actual+'.json').write_text(json.dumps({'tree':actual,'files':records},indent=2)+'\n')
