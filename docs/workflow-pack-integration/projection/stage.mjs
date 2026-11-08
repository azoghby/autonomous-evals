import {execFileSync as exec} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export function stageProjection(applyProjection=true) {
 const root=resolve(here,'../../..');
 const series=JSON.parse(readFileSync(join(root,'docs/workflow-integration/SERIES.json'),'utf8'));
 const core=exec('git',['rev-parse','48519bf^{commit}'],{cwd:root,encoding:'utf8'}).trim();
 exec('git',['merge-base','--is-ancestor','c63a67a',core],{cwd:root});
 const stage=mkdtempSync(join(tmpdir(),'workflow-pack-projection-'));
 const archive=(ref,paths=[])=>exec('tar',['-x','-C',stage],{input:exec('git',['archive',ref,...paths],{cwd:root,maxBuffer:128*1024*1024})});
 const apply=p=>{const path=resolve(root,p);exec('git',['apply','--check',path],{cwd:stage});exec('git',['apply',path],{cwd:stage});};
 archive(series.trackA);series.beforeCorePatches.forEach(apply);archive(core,series.coreOverlay);series.patches.forEach(apply);
 if(applyProjection)apply('docs/workflow-pack-integration/projection/003-pack-projection.patch');
 return {stage,core,trackA:series.trackA};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageProjection()));
