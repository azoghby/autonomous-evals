import {createHash} from 'node:crypto';
import {stageComplete} from '../complete-workflow-integration/stage.mjs';
import {files} from './stage.mjs';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),{stage}=stageComplete(),tmp=mkdtempSync(join(tmpdir(),'resume-diff-'));
let patch='';
for(const p of files(join(here,'source'))) {
 let prior;try{prior=readFileSync(join(stage,p))}catch{}
 const before=join(tmp,'before'),after=join(tmp,'after');
 if(prior)writeFileSync(before,prior);writeFileSync(after,readFileSync(join(here,'source',p)));
 const r=spawnSync('git',['diff','--no-index',prior?before:'/dev/null',after],{encoding:'utf8'});
 if(r.status!==0&&r.status!==1)throw Error(r.stderr);
 patch+=r.stdout.replaceAll('a'+before,'a/'+p).replaceAll('b'+after,'b/'+p).replaceAll('a'+after,'a/'+p);
}
writeFileSync(join(here,'resumption.patch'),patch);

const sha256={};
for(const p of [...files(join(here,'source')).map(p=>'docs/workflow-resumption-integration/source/'+p),'docs/workflow-resumption-integration/resumption.patch','docs/complete-workflow-integration/SERIES.json','docs/complete-workflow-integration/combined.patch'])sha256[p]=createHash('sha256').update(readFileSync(join(here,'../..',p))).digest('hex');
writeFileSync(join(here,'SERIES.json'),JSON.stringify({parent:'687b5086e6bd204fe82809672c0511e2ee3e6f52',trackA:'f0068733ca49c37f40fd7de279325f21a4b5fbbb',core:'e61ad9719a1f7cfc844523cffbd72253dcdcb30b',sha256},null,2)+'\n');
