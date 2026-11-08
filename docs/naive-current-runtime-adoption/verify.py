"""Independent git apply and two fresh assemblies, checking all committed paths."""
import argparse,hashlib,json,pathlib,subprocess,sys,tempfile
sys.dont_write_bytecode=True
from assemble import A,M,export,check
p=argparse.ArgumentParser();p.add_argument('--destination',action='append',default=[]);args=p.parse_args()
if args.destination and len(args.destination)!=2:p.error('Supply exactly two fresh destinations')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for e in M['files']:
 if sha(A/e['postimage'])!=e['afterSha256']:raise RuntimeError('Postimage changed: '+e['path'])
if sha(A/'sql-inventory.json')!=M['sqlInventorySha256']:raise RuntimeError('SQL inventory changed')
with tempfile.TemporaryDirectory(prefix='current-adoption-verify-') as temp:
 t=pathlib.Path(temp);d=t/'independent';export(d)
 subprocess.run(['git','apply','--check',str(A/'owner.patch')],cwd=d,check=True);subprocess.run(['git','apply',str(A/'owner.patch')],cwd=d,check=True);count=check(d)
 checks=[]
 for name in args.destination or [str(t/'one'),str(t/'two')]:
  dest=pathlib.Path(name).resolve();subprocess.run([sys.executable,str(A/'assemble.py'),str(dest)],check=True,stdout=subprocess.DEVNULL);checks.append({'assembly':str(dest),'checkedFiles':check(dest),'mismatches':[]})
 result={'baselineCommit':M['baselineCommit'],'manifestSha256':sha(A/'manifest.json'),'ownerPatchSha256':sha(A/'owner.patch'),'ownerPatchApplied':True,'independentPatchCheckedFiles':count,'sourcePathsChecked':len(M['finalSourceHashes']),'cumulativeChangedSourcePaths':len(M['files']),'deletions':[],'checks':checks,'reproducible':True,'liveActions':False,'migrationApplied':False}
 (A/'validation/verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
