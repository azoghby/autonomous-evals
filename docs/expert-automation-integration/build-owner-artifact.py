#!/usr/bin/env python3
"""Rebuild review artifact only. Never edits application source or applies migrations."""
from pathlib import Path
import subprocess, hashlib, json, difflib
root=Path(__file__).resolve().parents[2]
artifact=Path(__file__).resolve().parent
base='eaf7f6967f0d227b9826232afa9c368a2464e1be'
files=[];patch=[]
for source in sorted((artifact/'source').rglob('*')):
 if not source.is_file(): continue
 path=str(source.relative_to(artifact/'source'))
 result=subprocess.run(['git','show',f'{base}:{path}'],cwd=root,capture_output=True)
 before=result.stdout if result.returncode==0 else b''
 after=source.read_bytes()
 target=artifact/'postimages'/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(after)
 files.append({'path':path,'beforeSha256':hashlib.sha256(before).hexdigest() if result.returncode==0 else None,'afterSha256':hashlib.sha256(after).hexdigest()})
 patch.extend(difflib.unified_diff(before.decode().splitlines(keepends=True),after.decode().splitlines(keepends=True),fromfile=f'a/{path}' if result.returncode==0 else '/dev/null',tofile=f'b/{path}'))
(artifact/'owner.patch').write_text(''.join(patch))
(artifact/'manifest.json').write_text(json.dumps({'baseCommit':base,'files':files},indent=2)+'\n')
