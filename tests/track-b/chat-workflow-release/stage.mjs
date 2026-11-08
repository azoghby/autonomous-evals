import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:dirname(fileURLToPath(import.meta.url)),encoding:'utf8'}).trim();
export function stageRelease() {
 const series=JSON.parse(readFileSync(join(root,'docs/chat-workflow-release/SERIES.json'),'utf8'));
 for(const ref of [series.trackA,series.core,series.workflow,series.chatCorrections]) {
  if(!/^[a-f0-9]{40}$/.test(ref))throw Error('Full immutable commit required');
  execFileSync('git',['cat-file','-e',`${ref}^{commit}`],{cwd:root});
 }
 const stage=mkdtempSync(join(tmpdir(),'chat-workflow-release-'));
 const archive=(ref,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',ref,...paths],{cwd:root,maxBuffer:128*1024*1024})});
 const applied=[];
 const apply=p=>{
  const bytes=readFileSync(join(root,p));
  if(createHash('sha256').update(bytes).digest('hex')!==series.sha256[p])throw Error(`Patch digest changed: ${p}`);
  execFileSync('git',['apply','--check','-'],{cwd:stage,input:bytes});
  execFileSync('git',['apply','-'],{cwd:stage,input:bytes});applied.push(p);
 };
 archive(series.trackA);series.beforeCorePatches.forEach(apply);
 archive(series.core,series.coreOverlay);series.patches.forEach(apply);
 return {stage,core:series.core,trackA:series.trackA,applied,releaseAccepted:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageRelease(),null,2));
