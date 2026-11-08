"""Independent patch application, all inherited hashes, and two fresh reproductions."""
import argparse,hashlib,json,pathlib,subprocess,sys,tempfile
parser=argparse.ArgumentParser()
parser.add_argument('--destination',action='append',default=[],help='Unused persistent fresh assembly directory; pass exactly twice')
args=parser.parse_args()
if args.destination and len(args.destination)!=2:parser.error('Pass --destination exactly twice, or omit for temporary assemblies')
A=pathlib.Path(__file__).resolve().parent;M=json.loads((A/'manifest.json').read_text());P=A.parent/M['requires']
sha=lambda b:hashlib.sha256(b).hexdigest()
expected={**M['baselineHashes'],**M['inheritedSqlHashes']}
expected.update({e['path']:e['afterSha256'] for e in M['files']})
expected.update({'docs/'+A.name+'/'+e['path']:e['sha256'] for e in M['sql']})
def check(d,sql=True):
 bad=[p for p,h in expected.items() if (sql or not p.startswith('docs/'+A.name+'/')) and (not (d/p).is_file() or sha((d/p).read_bytes())!=h)]
 if bad:raise RuntimeError('Hash mismatches: '+', '.join(bad))
 return len(expected) if sql else len(expected)-len(M['sql'])
with tempfile.TemporaryDirectory(prefix='run-recovery-verify-') as temp:
 t=pathlib.Path(temp);patch=t/'patch'
 subprocess.run([sys.executable,str(P/'assemble.py'),str(patch)],check=True,stdout=subprocess.DEVNULL)
 for p,h in {**M['baselineHashes'],**M['inheritedSqlHashes']}.items():
  if sha((patch/p).read_bytes())!=h:raise RuntimeError('Inherited preimage mismatch: '+p)
 subprocess.run(['git','apply','--check',str(A/'owner.patch')],cwd=patch,check=True)
 subprocess.run(['git','apply',str(A/'owner.patch')],cwd=patch,check=True)
 patchCount=check(patch)
 checks=[]
 for name in args.destination or ['assembly-one','assembly-two']:
  d=pathlib.Path(name).resolve() if args.destination else t/name
  subprocess.run([sys.executable,str(A/'assemble.py'),str(d)],check=True,stdout=subprocess.DEVNULL)
  checks.append({'assembly':str(d) if args.destination else name,'checkedFiles':check(d),'mismatches':[]})
 sourcePaths=set(M['baselineHashes'])|{e['path'] for e in M['files']}
 result={'manifestSha256':sha((A/'manifest.json').read_bytes()),'ownerPatchSha256':sha((A/'owner.patch').read_bytes()),'ownerPatchApplied':True,'independentPatchCheckedFiles':patchCount,'inheritedSourceAndBaselinePaths':len(M['baselineHashes']),'incrementalPaths':len(M['files']),'composedSourceAndBaselinePaths':len(sourcePaths),'inheritedSqlPaths':len(M['inheritedSqlHashes']),'incrementalSqlPaths':len(M['sql']),'checks':checks,'reproducible':True}
 (A/'validation').mkdir(exist_ok=True)
 (A/'validation/verification.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
