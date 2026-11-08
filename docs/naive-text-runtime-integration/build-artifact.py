#!/usr/bin/env python3
import pathlib, subprocess, hashlib, json, difflib
here=pathlib.Path(__file__).resolve().parent
root=here.parents[1]
base=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
sha=lambda b:hashlib.sha256(b).hexdigest()
files=[];patch=[]
for file in sorted((here/'source').rglob('*')):
 if not file.is_file():continue
 rel=file.relative_to(here/'source').as_posix()
 dependency=root/'docs/expert-workflow-integration/source'/rel
 if dependency.exists(): old=dependency.read_bytes(); origin='docs/expert-workflow-integration/source/'+rel
 else:
  result=subprocess.run(['git','show',f'{base}:{rel}'],cwd=root,capture_output=True)
  old=result.stdout if result.returncode==0 else b'';origin=base
 new=file.read_bytes()
 files.append({'path':rel,'beforeSha256':sha(old) if old else None,'afterSha256':sha(new),'postimage':'source/'+rel,'preimageSource':origin})
 patch.append(f'diff --git a/{rel} b/{rel}\n'+('new file mode 100644\n' if not old else '')+''.join(difflib.unified_diff(old.decode().splitlines(True),new.decode().splitlines(True),fromfile='a/'+rel if old else '/dev/null',tofile='b/'+rel)))
(here/'owner.patch').write_text(''.join(patch))
(here/'manifest.json').write_text(json.dumps({'baseCommit':base,'files':files,'patchSha256':sha((here/'owner.patch').read_bytes()),'applyAfter':['docs/expert-workflow-integration/manifest.json','docs/naive-rich-contract-integration/manifest.json'],'requires':['current core retained data orchestration/resume and SQL persistence support','hardened expert owner + global atomic cost sink adoption','text integration checkpoint SQL, agent session/budget SQL, expert_workflow 0025 and explicit 0026 owner migration registration','EVAL_SERVICES=real; actual Naive agent configuration; NAIVE_JUDGE_MODEL, NAIVE_JUDGE_RESERVATION_MICRO_USD, NAIVE_JUDGE_MAX_OUTPUT_TOKENS; proxy:write audit:read permissions'],'activation':'Owner review artifact only. Text run/investigation consumption; remediation, rerun, workflow and comparison remain separate Phase 1 work.'},indent=2)+'\n')
manifest=json.loads((here/'manifest.json').read_text())
manifest['dependencyManifestHashes']=[{'path':rel,'sha256':sha((root/rel).read_bytes())} for rel in manifest['applyAfter']]
(here/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(len(files),'postimages')
