/** Offline exact-base validator patch application. Never modifies an owner tree. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
export function stageProtocol(){
 const manifest=JSON.parse(readFileSync(join(here,'identity/PATCH.json')));
 const source=execFileSync('git',['show',`${manifest.baseCommit}:${manifest.baseFile}`],{cwd:root});
 if(sha(source)!==manifest.baseFileSha256)throw Error('exact_base_preimage_drift');
 const patch=readFileSync(join(here,'identity/0001-v2-identity-compatibility.patch'));
 if(sha(patch)!==manifest.patchSha256)throw Error('patch_drift');
 const stage=mkdtempSync(join(tmpdir(),'acceptance-protocol-closure-'));
 mkdirSync(dirname(join(stage,manifest.baseFile)),{recursive:true});writeFileSync(join(stage,manifest.baseFile),source);
 mkdirSync(join(stage,'docs/acceptance-protocol-closure'),{recursive:true});
 cpSync(join(here,'identity'),join(stage,'docs/acceptance-protocol-closure/identity'),{recursive:true});
 writeFileSync(join(stage,'package.json'),'{"type":"module"}');
 execFileSync('git',['apply','--check','-'],{cwd:stage,input:patch});
 execFileSync('git',['apply','-'],{cwd:stage,input:patch});
 if(sha(readFileSync(join(stage,manifest.baseFile)))!==manifest.resultSha256)throw Error('postimage_drift');
 return {stage,baseCommit:manifest.baseCommit,validatorSha256:manifest.resultSha256,live:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageProtocol(),null,2));
