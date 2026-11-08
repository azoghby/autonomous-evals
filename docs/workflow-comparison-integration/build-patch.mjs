import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stageComparison} from './stage.mjs';
const here=dirname(fileURLToPath(import.meta.url)),repo=join(here,'../..');
const {stage}=stageComparison({apply:false});
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):[join(p,e.name)]);}
let patch='';for(const file of walk(join(here,'app/files'))){const path=relative(join(here,'app/files'),file);let old='';try{old=readFileSync(join(stage,path),'utf8');}catch{}
const a=join(stage,'before.tmp'),b=join(stage,'after.tmp');writeFileSync(a,old);writeFileSync(b,readFileSync(file));let diff;try{diff=execFileSync('diff',['-u',a,b],{encoding:'utf8'});}catch(e){if(e.status!==1)throw e;diff=e.stdout;}
patch+=diff.replace(/^--- .*\n\+\+\+ .*\n/,`--- ${old?'a/'+path:'/dev/null'}\n+++ b/${path}\n`);}
writeFileSync(join(here,'app/004-rich-comparison.patch'),patch);
const m=JSON.parse(readFileSync(join(here,'SERIES.json'),'utf8'));m.sha256[m.patch]=createHash('sha256').update(patch).digest('hex');writeFileSync(join(here,'SERIES.json'),JSON.stringify(m,null,2)+'\n');
