import { execFileSync as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const parent='883d186';
export async function stageBase() {
 const snapshot=mkdtempSync(join(tmpdir(),'judging-input-'));
 exec('tar',['-x','-C',snapshot],{input:exec('git',['archive',parent],{cwd:root,maxBuffer:256*1024*1024})});
 symlinkSync(exec('git',['rev-parse','--absolute-git-dir'],{cwd:root,encoding:'utf8'}).trim(),join(snapshot,'.git'),'dir');
 const {stageFinal}=await import(pathToFileURL(join(snapshot,'docs/track-b-final-composition/stage.mjs')));
 return stageFinal();
}
export async function stageJudging() {
 const manifest=JSON.parse(readFileSync(join(root,'docs/workflow-judging-integration/SERIES.json'),'utf8'));
 if(exec('git',['rev-parse',parent],{cwd:root,encoding:'utf8'}).trim()!==manifest.parent)throw Error('Parent pin drift');
 for(const [path,expected] of Object.entries(manifest.sha256))if(createHash('sha256').update(readFileSync(join(root,'docs/workflow-judging-integration',path))).digest('hex')!==expected)throw Error('Judging pin drift: '+path);
 const result=await stageBase();
 const comparison=exec('git',['show','bf7e63a:docs/workflow-comparison-integration/app/004-rich-comparison.patch'],{cwd:root});
 exec('git',['apply','--check','-'],{cwd:result.stage,input:comparison});exec('git',['apply','-'],{cwd:result.stage,input:comparison});
 const patch=join(root,'docs/workflow-judging-integration/app/005-judging.patch');
 exec('git',['apply','--check',patch],{cwd:result.stage});exec('git',['apply',patch],{cwd:result.stage});
 const extension=join(root,'docs/workflow-judging-integration/app/006-comparison-judging.patch');
 exec('git',['apply','--check',extension],{cwd:result.stage});exec('git',['apply',extension],{cwd:result.stage});
 for(const name of ['judge-accounting','rich-judge','rich-services','rich-remediation','rich-comparison','comparison-production']){const path='apps/web/src/server/'+name+'.ts';if(!readFileSync(join(result.stage,path)).equals(readFileSync(join(root,'docs/workflow-judging-integration/app/files',path))))throw Error('Applied judging source mismatch: '+path);}
 return {...result,judgingParent:parent,judgingPatch:patch,comparisonExtension:extension};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await stageJudging()));
