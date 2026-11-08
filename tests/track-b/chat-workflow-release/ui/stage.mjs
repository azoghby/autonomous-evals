// Exact immutable Workflow series, reconstructed only in a disposable archive.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:dirname(fileURLToPath(import.meta.url)),encoding:'utf8'}).trim();
const pin='5f513d1';
const show=p=>execFileSync('git',['show',`${pin}:${p}`],{cwd:repo,maxBuffer:128*1024*1024});
export function stageSeries(){
 const series=JSON.parse(show('docs/workflow-integration/SERIES.json'));
 const stage=mkdtempSync(join(tmpdir(),'chat-workflow-ui-'));
 const archive=(ref,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024})});
 const patches=[];
 const apply=(p,ref=pin)=>{const file=join(stage,'.ui-inputs',p);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,maxBuffer:128*1024*1024}));execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});patches.push(p);};
 archive(series.trackA);for(const p of series.beforeCorePatches)apply(p);archive(series.core,series.coreOverlay);for(const p of series.patches)apply(p);
 const serverCompatibility="a54ab05341856eb59a42f1e204a6cf89df19356b";
 apply("docs/chat-workflow-release/servercompat/0001-current-core-server.patch",serverCompatibility);
 return {stage,serverCompatibility,seriesPin:execFileSync('git',['rev-parse',pin],{cwd:repo,encoding:'utf8'}).trim(),...series,applied:patches};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageSeries()));
