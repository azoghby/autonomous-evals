"""Reproduce preserved cancellation chain plus unified factual/sourcing increment."""
import argparse, hashlib, json, pathlib, subprocess, sys

parser = argparse.ArgumentParser()
parser.add_argument('destination')
args = parser.parse_args()
a = pathlib.Path(__file__).resolve().parent
p = a.parent / 'naive-cancellation-integration'
d = pathlib.Path(args.destination).resolve()
m = json.loads((a / 'manifest.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
for name, provenance in m['provenance'].items():
    if sha((a.parent / name / 'manifest.json').read_bytes()) != provenance['manifestSha256']:
        raise RuntimeError('Provenance manifest changed: ' + name)
for path, expected in m['dependencyHashes'].items():
    if sha((p / path).read_bytes()) != expected:
        raise RuntimeError('Dependency changed: ' + path)
subprocess.run([sys.executable, str(p / 'assemble.py'), str(d)], check=True)
for item in m['baselineOverrides']:
    out=d/item['path']
    before=sha(out.read_bytes()) if out.is_file() else None
    if before!=item['beforeSha256']:raise RuntimeError('Upstream preimage mismatch: '+item['path'])
    data=subprocess.check_output(['git','cat-file','blob',item['commit']+':'+item['path']],cwd=a.parent.parent)
    if sha(data)!=item['afterSha256']:raise RuntimeError('Upstream postimage mismatch: '+item['path'])
    out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
for item in m['files']:
    out = d / item['path']
    before = sha(out.read_bytes()) if out.is_file() else None
    if before != item['beforeSha256']:
        raise RuntimeError('Preimage mismatch: ' + item['path'])
    data = (a / item['postimage']).read_bytes()
    if sha(data) != item['afterSha256']:
        raise RuntimeError('Postimage mismatch: ' + item['path'])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
for item in m['sql']:
    data = (a / item['path']).read_bytes()
    if sha(data) != item['sha256']:
        raise RuntimeError('SQL mismatch: ' + item['path'])
    out = d / 'docs' / a.name / item['path']
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    # Retain original candidate SQL paths used by the portable installer tests.
    origin = d / item['origin']
    if origin.is_file() and origin.read_bytes() != data:
        raise RuntimeError('Conflicting SQL dependency origin: ' + item['origin'])
    origin.parent.mkdir(parents=True, exist_ok=True)
    origin.write_bytes(data)
print(d)
