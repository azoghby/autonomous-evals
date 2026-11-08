// Real dependency/application checks, never structural SDK or session substitutions.
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const out=process.env.CHAT_COMPAT_OUTPUT??mkdtempSync(join(tmpdir(),'chat-real-app-'));
mkdirSync(out,{recursive:true});
const pins={pinned:'2dff9d8af8cccdd171d78760a0d74136d138fcb4',current:'f0068733ca49c37f40fd7de279325f21a4b5fbbb'};
const summary={releaseAccepted:false,node:process.version,core:'de6a7985e72b57fce79ef7f69f533b0b2da126a7',results:[]};
for(const [name,ref] of Object.entries(pins)){
 const stage=mkdtempSync(join(tmpdir(),`chat-real-${name}-`));
 const archive=(pin,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',pin,...paths],{cwd:repo,maxBuffer:128*1024*1024})});
 const apply=file=>{execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});};
 archive(ref);apply(join(repo,'docs/progress-chat-integration/combined.patch'));archive(summary.core,['packages/core/src']);apply(join(repo,'docs/structured-progress-integration/backend/structured-progress.patch'));
 const result={name,ref,stage,inputHashes:Object.fromEntries(['package-lock.json','apps/web/package.json'].map(file=>[file,createHash('sha256').update(readFileSync(join(stage,file))).digest('hex')])),commands:[]};summary.results.push(result);
 function run(label,args){const r=spawnSync('npm',args,{cwd:stage,encoding:'utf8',maxBuffer:20*1024*1024,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});writeFileSync(join(out,`${name}-${label}.log`),(r.stdout??'')+(r.stderr??''));result.commands.push({label,args,exit:r.status});return r.status;}
 if(run('install',['ci','--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--fetch-timeout=20000'])===0){
 result.versions=Object.fromEntries(['next','react','react-dom','typescript','@neondatabase/serverless'].map(n=>[n,JSON.parse(readFileSync(join(stage,'node_modules',n,'package.json'))).version]));
 run('typegen',['exec','-w','web','--','next','typegen']);
 run('typecheck',['run','typecheck','-w','web']);
 run('build',['run','build','-w','web']);
 run('webpack-build',['exec','-w','web','--','next','build','--webpack']);
 apply(join(repo,'docs/chat-release-verification/app-ui/next-esm-compatibility.patch'));
 apply(join(repo,'docs/chat-release-verification/app-ui/restore-history.patch'));
 result.correctedTypecheck=run('corrected-typecheck',['run','typecheck','-w','web']);
 result.correctedBuild=run('corrected-build',['run','build','-w','web']);
 }
 writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));
 console.log(name+' completed: '+stage);
}
console.log('Real app compatibility evidence '+out);

if(summary.results.some(r=>r.correctedTypecheck!==0||r.correctedBuild!==0))process.exitCode=1;
