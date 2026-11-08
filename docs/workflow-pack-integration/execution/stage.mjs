import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
export function stageExecution({applyExecution=true}={}) {
 const series=JSON.parse(readFileSync(join(repo,'docs/workflow-integration/SERIES.json'),'utf8'));
 const core='48519bf16e04bce3397ceaeb8abea060d2636263';
 execFileSync('git',['merge-base','--is-ancestor','c63a67aa41e7c1da6f82835c009d711d01bd4dc7',core],{cwd:repo});
 const stage=mkdtempSync(join(tmpdir(),'workflow-pack-execution-'));
 const archive=(ref,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024})});
 const apply=p=>{const file=join(repo,p);execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});};
 archive(series.trackA);series.beforeCorePatches.forEach(apply);archive(core,series.coreOverlay);series.patches.forEach(apply);
 const projection='docs/workflow-pack-integration/projection/003-pack-projection.patch';
 if(existsSync(join(repo,projection)))apply(projection);
 else {const file=join(stage,'projection.patch');writeFileSync(file,execFileSync('git',['show',`010b68fc91b1974934af9b88cb5ff65fd20f781d:${projection}`],{cwd:repo}));execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});}
 if(applyExecution)apply('docs/workflow-pack-integration/execution/003-pack-execution.patch');
 return {stage,trackA:series.trackA,core};
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageExecution()));
