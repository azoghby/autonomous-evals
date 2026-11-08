import pathlib,json,hashlib
r=pathlib.Path.cwd();o=r/'docs/naive-operator-current-integration';m=json.loads((o/'manifest.json').read_text());s=pathlib.Path(m['stage']);pins=json.loads((o/'evidence/SUPPORT-PINS.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
for p in pins:assert sha((s/p['path']).read_bytes())==p['sha256'],p['path']
for p in m['files']:assert sha((s/p['path']).read_bytes())==p['afterSha256'],p['path']
(o/'evidence/postbuild-hashes.json').write_text(json.dumps(dict(baseCommit=m['baseCommit'],trackedPinsVerified=len(pins),postimagesVerified=len(m['files']),allMatched=True),indent=2)+'\n')
print('All tracked pins and candidate postimages match')
