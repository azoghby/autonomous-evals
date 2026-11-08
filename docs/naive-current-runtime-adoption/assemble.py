"""Export committed baseline and apply the one cumulative source patch offline."""
import argparse,hashlib,io,json,pathlib,subprocess,tarfile,sys
sys.dont_write_bytecode=True
A=pathlib.Path(__file__).resolve().parent;R=A.parent.parent;M=json.loads((A/'manifest.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
def export(d):
 if d.exists():raise RuntimeError('Destination must not exist: '+str(d))
 from freeze import snapshot
 entries=snapshot()
 if {p:sha(b) for p,b in entries.items()}!=M['baselineHashes'] or snapshot.modes!=M['baselineModes'] or snapshot.tree!=M['baselineTree']:raise RuntimeError('Committed baseline inventory or modes mismatch')
 for p,b in entries.items():
  if pathlib.PurePosixPath(p).name.startswith('.env') and pathlib.PurePosixPath(p).name!='.env.example':raise RuntimeError('Secret-shaped tracked path: '+p)
  out=d/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(b);out.chmod(snapshot.modes[p])
def check(d):
 expected=dict(M['baselineHashes']);expected.update({e['path']:e['afterSha256'] for e in M['files']})
 bad=[p for p,h in expected.items() if not (d/p).is_file() or sha((d/p).read_bytes())!=h]
 actual={p.relative_to(d).as_posix() for p in d.rglob('*') if p.is_file()}
 if actual!=set(expected):raise RuntimeError('Unexpected or missing files: '+repr(sorted(actual^set(expected))))
 for p,mode in M['baselineModes'].items():
  if (d/p).stat().st_mode & 0o777 != mode:raise RuntimeError('Mode mismatch: '+p)
 if bad:raise RuntimeError('Snapshot mismatch: '+repr(bad))
 return len(expected)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('destination');args=p.parse_args();d=pathlib.Path(args.destination).resolve();export(d)
 subprocess.run(['git','apply','--check',str(A/'owner.patch')],cwd=d,check=True)
 subprocess.run(['git','apply',str(A/'owner.patch')],cwd=d,check=True)
 check(d);print(d)
