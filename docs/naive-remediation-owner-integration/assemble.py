"""Reproduce the pinned unified candidate plus remediation owner increment."""
import argparse,hashlib,json,pathlib,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('destination');args=p.parse_args()
A=pathlib.Path(__file__).resolve().parent;M=json.loads((A/'manifest.json').read_text());P=A.parent/M['requires'];D=pathlib.Path(args.destination).resolve()
sha=lambda b:hashlib.sha256(b).hexdigest()
for path,expected in M['dependencyHashes'].items():
 if sha((P/path).read_bytes())!=expected:raise RuntimeError('Dependency changed: '+path)
subprocess.run([sys.executable,str(P/'assemble.py'),str(D)],check=True,stdout=subprocess.DEVNULL)
for path,expected in {**M['baselineHashes'],**M['inheritedSqlHashes']}.items():
 if sha((D/path).read_bytes())!=expected:raise RuntimeError('Inherited path changed: '+path)
for e in M['files']:
 out=D/e['path'];before=sha(out.read_bytes()) if out.is_file() else None
 if before!=e['beforeSha256']:raise RuntimeError('Preimage mismatch: '+e['path'])
 data=(A/e['postimage']).read_bytes()
 if sha(data)!=e['afterSha256']:raise RuntimeError('Postimage mismatch: '+e['path'])
 out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
for e in M['sql']:
 data=(A/e['path']).read_bytes()
 if sha(data)!=e['sha256'] or sha((D/e['origin']).read_bytes())!=e['sha256']:raise RuntimeError('SQL dependency mismatch')
 out=D/'docs'/A.name/e['path'];out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
print(D)
