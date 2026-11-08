#!/usr/bin/env python3
"""Build review patch against the current committed A source; no adoption/migration is performed."""
import difflib, hashlib, json, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
here = pathlib.Path(__file__).resolve().parent
base = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
parts=[]; files=[]
for source in sorted((here/'source').rglob('*')):
    if not source.is_file(): continue
    rel=source.relative_to(here/'source').as_posix()
    previous=subprocess.run(['git','show',f'{base}:{rel}'],cwd=root,capture_output=True)
    old=previous.stdout.decode() if previous.returncode==0 else ''
    new=source.read_text()
    patch=list(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile=f'a/{rel}' if old else '/dev/null',tofile=f'b/{rel}'))
    parts.append(f'diff --git a/{rel} b/{rel}\n'+('new file mode 100644\n' if not old else '')+''.join(patch))
    files.append({'path':rel,'preimage_sha256':hashlib.sha256(old.encode()).hexdigest() if old else None,'postimage_sha256':hashlib.sha256(new.encode()).hexdigest()})
(here/'owner.patch').write_text(''.join(parts))
manifest={'base':base,'files':files,'patch_sha256':hashlib.sha256((here/'owner.patch').read_bytes()).hexdigest(),
 'requires':['combined expert-automation-cost-adoption hardened async knownSecrets owner','current core data source including resumeGeneration/resumeFreeze','owner migration registration and data persistence SQL','explicit EVAL_SERVICES=real, operator task/policy/qualification/permission/review provisioning'],
 'activation':'Ready frozen suite is held pending actual rich execution consumer adoption; no lite execution.'}
(here/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'{len(files)} review postimages, base {base}')
