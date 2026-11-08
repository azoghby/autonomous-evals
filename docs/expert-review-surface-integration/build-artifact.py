#!/usr/bin/env python3
"""Package exact proposed owner postimages; never adopt, migrate, deploy or call providers."""
import difflib,hashlib,json,pathlib,subprocess
here=pathlib.Path(__file__).resolve().parent
root=here.parents[1]
base='9eb9e4c82a69be2ae9e997efdb747e8b6d658acd'
sha=lambda value:hashlib.sha256(value).hexdigest()
files=[];patch=[]
for source in sorted((here/'source').rglob('*')):
 if not source.is_file():continue
 rel=source.relative_to(here/'source').as_posix()
 old_result=subprocess.run(['git','cat-file','blob',f'{base}:{rel}'],cwd=root,capture_output=True)
 old=old_result.stdout if old_result.returncode==0 else b'';new=source.read_bytes()
 files.append({'path':rel,'beforeSha256':sha(old) if old else None,'afterSha256':sha(new),'postimage':'source/'+rel})
 lines=difflib.unified_diff(old.decode().splitlines(True),new.decode().splitlines(True),fromfile='a/'+rel if old else '/dev/null',tofile='b/'+rel)
 body=''.join(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n' for line in lines)
 patch.append(f'diff --git a/{rel} b/{rel}\n'+('new file mode 100644\n' if not old else '')+body)
(here/'owner.patch').write_text(''.join(patch))
manifest={'baseCommit':base,'files':files,'patchSha256':sha((here/'owner.patch').read_bytes()),
 'requires':['adopted canonical expert workflow/text consumer and coherent0023-0026 source','actual agent/text/data sidecar migrations plus owner registered application migrations','EVAL_SERVICES=real and current authenticated OPERATOR_EMAILS session','owner-provisioned canonical plans/policies/consent/qualification grants and genuine retained candidate snapshots'],
 'activation':'Unapplied owner review artifact. No provider dispatch, sending, migration, deployment or automatic evidence approval.'}
(here/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'{len(files)} proposed postimages pinned at {base}')
