import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stageRemediation } from '../stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const {stage}=stageRemediation({apply:false});
const files=join(here,'files');
function walk(root){return readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(root,e.name)):[join(root,e.name)]);}
let patch='';
for(const source of walk(files)){
 const path=relative(files,source),before=join(stage,path);
 const result=execFileSync('python3',['-c',`import difflib,pathlib,sys
before=pathlib.Path(sys.argv[1]);after=pathlib.Path(sys.argv[2]);path=sys.argv[3]
a=before.read_text() if before.exists() else ''
print(''.join(difflib.unified_diff(a.splitlines(True),after.read_text().splitlines(True),fromfile='a/'+path if a else '/dev/null',tofile='b/'+path)),end='')`,before,source,path],{encoding:'utf8'});
 patch+=result;
}
writeFileSync(join(here,'003-remediation.patch'),patch);
console.log(`Generated append-only patch from ${stage}`);
