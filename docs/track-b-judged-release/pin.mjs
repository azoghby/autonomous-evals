// Explicit maintainer regeneration; verification never updates pins.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const paths=new Set(['docs/track-b-judged-release/track-a-refresh.patch','docs/track-b-judged-release/core-report-snapshot.patch','docs/track-b-release-extensions/stage.mjs','docs/track-b-release-extensions/INTEGRITY.json','docs/comparison-cost-delivery-fix/fix.patch']);
for(const dir of ['docs/track-b-judged-release/source','docs/workflow-judging-integration','docs/workflow-rerun-integration','docs/controlled-remediation-targets']){
 function walk(p){for(const e of readdirSync(p,{withFileTypes:true}))if(e.isDirectory())walk(p+'/'+e.name);else paths.add(p+'/'+e.name);}walk(dir);
}
const commits={base:'d02c41d',judging:'2cc838f',rerun:'99d7479',remediation:'9abc8c3',runtimeFinding:'47a0f0c',coreSnapshot:'8e648e6',trackA:'aa94505'};
writeFileSync('docs/track-b-judged-release/INTEGRITY.json',JSON.stringify({commits:Object.fromEntries(Object.entries(commits).map(([k,v])=>[k,execFileSync('git',['rev-parse',v],{encoding:'utf8'}).trim()])),sha256:Object.fromEntries([...paths].sort().map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n');
