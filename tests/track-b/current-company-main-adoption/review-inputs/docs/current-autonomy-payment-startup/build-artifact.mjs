import {stagePayment,artifact,integrated,parent} from './stage.mjs';
import {stageCurrent} from '../current-autonomy-integration/stage.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const old=await stagePayment({baseline:true}),current=await stagePayment();
let patch='';
for(const path of [...Object.keys(current.changes),...Object.keys(current.additions)]){
 const before=join(old.stage,path),after=join(current.stage,path);
 const r=spawnSync('git',['diff','--no-index','--binary',existsSync(before)?before:'/dev/null',after],{cwd:old.stage,encoding:'utf8',maxBuffer:16*1024*1024});
 if(![0,1].includes(r.status))throw Error(r.stderr);
 patch+=r.stdout.replaceAll('a'+old.stage+'/','a/').replaceAll('b'+current.stage+'/','b/').replaceAll('a'+current.stage+'/','a/');
}
write(join(here,'application.patch'),patch);
const r=spawnSync('git',['apply','--check','--unsafe-paths','-'],{cwd:old.stage,input:patch,encoding:'utf8'});
if(r.status)throw Error(r.stderr);
const applied=spawnSync('git',['apply','--unsafe-paths','-'],{cwd:old.stage,input:patch,encoding:'utf8'});
if(applied.status)throw Error(applied.stderr);
for(const path of [...Object.keys(current.changes),...Object.keys(current.additions)])if(!read(join(old.stage,path)).equals(read(join(current.stage,path))))throw Error('patch_postimage_drift:'+path);
write(join(here,'APPLICATION.json'),JSON.stringify({artifact,integrated,parent,changes:current.changes,additions:current.additions,sql:'sql/001-current-payment.sql',releaseAccepted:false,liveRunPerformed:false},null,2)+'\n');
console.log('Exact-current patch checked, applied, postimages compared.');
