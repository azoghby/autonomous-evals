import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));const repo=resolve(here,'../..');
export function stageComparison({apply=true}={}) {
 const m=JSON.parse(readFileSync(join(here,'SERIES.json'),'utf8'));
 for(const [path,sha] of Object.entries(m.sha256))if(createHash('sha256').update(readFileSync(join(repo,path))).digest('hex')!==sha)throw new Error(`Pin mismatch: ${path}`);
 const stage=mkdtempSync(join(tmpdir(),'workflow-comparison-'));
 const archive=(ref,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024})});
 const patch=path=>{const flags=path.includes('002-workflow-producers')||path.includes('0002-app-source-compatibility')||path.includes('0003-explicit-benchmark-refusal')?['--exclude=packages/core/**']:[];execFileSync('git',['apply',...flags,'--check',join(repo,path)],{cwd:stage});execFileSync('git',['apply',...flags,join(repo,path)],{cwd:stage});};
 archive(m.trackA);for(const p of m.beforeCorePatches)patch(p);archive(m.core,m.coreOverlay);for(const p of m.prerequisites)patch(p);if(apply)patch(m.patch);
 return {stage,trackA:m.trackA,core:m.core};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageComparison()));
