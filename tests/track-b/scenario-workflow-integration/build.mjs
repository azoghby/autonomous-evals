import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const checked=JSON.parse(readFileSync(join(here,'RESULTS.json'),'utf8'));const stage=checked.stage;
if(checked.typecheck!==0||checked.tests!==0)throw Error('Passing applied-source stage required');
const inputs=join(here,'../current-company-main-adoption/harness-inputs');
for(const name of ['offline.cjs','offline-fonts.cjs'])copyFileSync(join(inputs,name),join(stage,name));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',CI:'1',NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',NODE_OPTIONS:'--require '+join(stage,'offline.cjs'),NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(stage,'offline-fonts.cjs')};
writeFileSync(join(stage,'packages/core/tsconfig.scenario-production.json'),JSON.stringify({extends:'./tsconfig.json',compilerOptions:{strict:true,noEmit:true},exclude:['node_modules','**/*.test.ts','**/*.test.tsx','**/*.spec.ts']}));
const commands=[['next-typegen','apps/web',['node_modules/next/dist/bin/next','typegen']],['application-types','',['node_modules/typescript/bin/tsc','-p','apps/web','--noEmit']],['core-types','',['node_modules/typescript/bin/tsc','-p','packages/core/tsconfig.scenario-production.json','--noEmit']],['production-build','apps/web',['node_modules/next/dist/bin/next','build','--webpack']]];
const results=[];
for(const [name,dir,[entry,...args]]of commands){
 const r=spawnSync(process.execPath,[join(stage,entry),...args],{cwd:join(stage,dir),env,encoding:'utf8',maxBuffer:64*1024*1024});
 const output=(r.stdout||'')+(r.stderr||'');writeFileSync(join(here,name+'.log'),output);results.push({name,exit:r.status,error:r.error?.message,logSha256:createHash('sha256').update(output).digest('hex')});
 writeFileSync(join(here,'BUILD-RESULTS.json'),JSON.stringify({base:checked.base,stage,commands:results,offline:true,live:false},null,2)+'\n');console.log(name+': '+r.status);console.log(output.slice(-1200));
}
if(results.some(x=>x.exit!==0))process.exitCode=1;
