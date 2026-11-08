// Resume correction checks on retained real-app archives without reinstalling.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:dirname(fileURLToPath(import.meta.url)),encoding:'utf8'}).trim();
const out=resolve(process.argv[2]);const summary=JSON.parse(readFileSync(join(out,'summary.json')));summary.releaseAccepted=false;
for(const r of summary.results){
 // Restore only disposable test inputs so this resume command also tests a revised artifact.
 for(const file of ['apps/web/package.json','apps/web/next.config.ts'])writeFileSync(join(r.stage,file),execFileSync('git',['show',r.ref+':'+file],{cwd:repo}));
 writeFileSync(join(r.stage,'apps/web/src/components/app/job-private-chat.tsx'),readFileSync(join(repo,'docs/progress-chat-integration/client/source/job-private-chat.tsx')));
 r.inputHashes=Object.fromEntries(['package-lock.json','apps/web/package.json'].map(file=>[file,createHash('sha256').update(execFileSync('git',['show',r.ref+':'+file],{cwd:repo})).digest('hex')]));
 r.commands=r.commands.filter(c=>!c.label.startsWith('corrected-'));

 for(const file of ['next-esm-compatibility.patch','restore-history.patch']){const patch=join(repo,'docs/chat-release-verification/app-ui',file);execFileSync('git',['apply','--check',patch],{cwd:r.stage});execFileSync('git',['apply',patch],{cwd:r.stage});}
 for(const [label,args] of [['corrected-typecheck',['run','typecheck','-w','web']],['corrected-build',['run','build','-w','web']]]){const p=spawnSync('npm',args,{cwd:r.stage,encoding:'utf8',maxBuffer:20*1024*1024,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});writeFileSync(join(out,`${r.name}-${label}.log`),(p.stdout??'')+(p.stderr??''));r.commands.push({label,args,exit:p.status});if(p.status!==0)process.exitCode=1;console.log(r.name,label,p.status);}
 writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));
}
