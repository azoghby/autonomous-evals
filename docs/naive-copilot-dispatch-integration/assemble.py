"""Reproduce pinned MCP baseline + dispatch candidate, without installing or activating."""
import argparse, hashlib, json, pathlib, subprocess, sys

parser = argparse.ArgumentParser()
parser.add_argument('destination')
args = parser.parse_args()
a = pathlib.Path(__file__).resolve().parent
p = a.parent / 'naive-internal-mcp-integration'
d = pathlib.Path(args.destination).resolve()
m = json.loads((a / 'manifest.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
for path, expected in m['dependencyHashes'].items():
    if sha((p / path).read_bytes()) != expected:
        raise RuntimeError('Dependency changed: ' + path)
subprocess.run([sys.executable, str(p / 'assemble.py'), str(d)], check=True)
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
print(d)
