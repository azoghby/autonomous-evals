import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync as read, writeFileSync as write, mkdirSync, readdirSync, symlinkSync, existsSync, cpSync, mkdtempSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const out=resolve(process.env.PAYMENT_STARTUP_EVIDENCE??join(here,'evidence'));
mkdirSync(out,{recursive:true});
const stage=resolve(process.env.PAYMENT_STARTUP_STAGE??mkdtempSync(join(tmpdir(),'current-autonomy-check-')));
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM');
const cache=resolve(process.env.AUTONOMY_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules');
const deps=join(installed,'node_modules');
const summary={stage,node:process.version,parent:'039851736eabb94e85c2c111bbccc78374716275',commands:[],releaseAccepted:false,liveRunPerformed:false};
const persist=()=>write(join(out,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n');
// Deliberately allowlist environment. No .env or process credentials are read or copied.
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',PNPM_CONFIG_OFFLINE:'true',WORKFLOW_STAGE:stage,EXTENSION_STAGE:stage,PAYMENT_PINNED_BASE:process.env.PAYMENT_PINNED_BASE,CHAT_REVIEW_COMPOSITION:process.env.CHAT_REVIEW_COMPOSITION};
function run(label,args,cwd=stage,customEnv=env,executable=process.execPath){
 console.log('Running '+label);
 const r=spawnSync(executable,args,{cwd,env:customEnv,encoding:'utf8',maxBuffer:96*1024*1024});
 write(join(out,label+'.log'),(r.stdout??'')+(r.stderr??'')+(r.error?.stack??''));
 summary.commands.push({label,command:[executable,...args],exit:r.status});persist();
 console.log(label+': '+r.status);
 return r.status===0;
}
if(!process.env.PAYMENT_STARTUP_STAGE&&!run('stage',[join(root,'docs/current-autonomy-payment-startup/stage.mjs'),'--out',stage],root))process.exit(1);
for(const tree of [deps,cache]){
 if(!existsSync(tree))throw Error('Missing offline cache '+tree);
 mkdirSync(join(stage,'node_modules'),{recursive:true});
 for(const entry of readdirSync(tree)){
  if(entry==='@ae')continue;
  if(entry.startsWith('@')){mkdirSync(join(stage,'node_modules',entry),{recursive:true});for(const n of readdirSync(join(tree,entry)))if(!existsSync(join(stage,'node_modules',entry,n)))symlinkSync(join(tree,entry,n),join(stage,'node_modules',entry,n));}
  else if(!existsSync(join(stage,'node_modules',entry)))symlinkSync(join(tree,entry),join(stage,'node_modules',entry));
 }
}
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});
if(!existsSync(join(stage,'node_modules/@ae/core')))symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
for(const sub of ['apps/web','packages/core'])if(existsSync(join(installed,sub,'node_modules'))&&!existsSync(join(stage,sub,'node_modules')))symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'));
cpSync(here,join(stage,'tests/track-b/current-autonomy-payment-startup'),{recursive:true,filter:p=>!p.includes('/evidence')});
cpSync(join(root,'docs/current-autonomy-payment-startup'),join(stage,'docs/current-autonomy-payment-startup'),{recursive:true});
write(join(stage,'empty-server-only.mjs'),'export {};\n');
write(join(stage,'current-autonomy-vitest.config.mjs'),`export default {resolve:{alias:{'@ae/core':${JSON.stringify(join(stage,'packages/core/src'))},'@':${JSON.stringify(join(stage,'apps/web/src'))},'server-only':${JSON.stringify(join(stage,'empty-server-only.mjs'))}}},test:{exclude:['tests/track-b/autonomy-paid-app-integration/acceptance-baseline.test.ts'],include:['tests/track-b/autonomous-company/**/*.test.ts','tests/track-b/autonomy-release-adoption/**/*.test.ts','tests/track-b/autonomy-paid-app-integration/**/*.test.ts','tests/track-b/current-autonomy-payment-startup/**/*.test.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}};`);
write(join(stage,'tsconfig.current-autonomy-tests.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:['tests/track-b/autonomous-company/**/*.ts','tests/track-b/autonomy-release-adoption/**/*.ts','tests/track-b/autonomy-paid-app-integration/**/*.ts','tests/track-b/current-autonomy-payment-startup/**/*.ts']}));
const guard=join(stage,'offline-current-autonomy.cjs');cpSync(join(root,'tests/track-b/current-autonomy-integration/offline.cjs'),guard);env.NODE_OPTIONS='--require='+JSON.stringify(guard);
run('test-typecheck',[join(deps,'typescript/bin/tsc'),'-p','tsconfig.current-autonomy-tests.json']);
run('runtime-tests',[join(deps,'vitest/vitest.mjs'),'run','--config','current-autonomy-vitest.config.mjs','--reporter=json','--outputFile.json='+join(out,'tests.json')]);
run('parent-npm-test',['test','--','--maxWorkers=2','--reporter=json','--outputFile.json='+join(out,'parent-tests.json')],stage,env,'npm');
// Full production core source, strict; only test source excluded, no compile shims.
write(join(stage,'packages/core/tsconfig.current-autonomy.json'),JSON.stringify({extends:'./tsconfig.json',compilerOptions:{strict:true,noEmit:true},exclude:['node_modules','**/*.test.ts','**/*.test.tsx','**/*.spec.ts']},null,2));
run('core-typecheck',[join(deps,'typescript/bin/tsc'),'-p','tsconfig.current-autonomy.json'],join(stage,'packages/core'));
run('next-typegen',[join(deps,'next/dist/bin/next'),'typegen'],join(stage,'apps/web'));
run('app-typecheck',[join(deps,'typescript/bin/tsc'),'-p','apps/web','--noEmit']);
if(!process.argv.includes('--tests-only')){
 const fonts=resolve(process.env.CHAT_FONT_CACHE??'/private/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-real-current-uS8sgP/apps/web/.next');
 if(existsSync(join(fonts,'static/css'))){
  const css=readdirSync(join(fonts,'static/css')).filter(n=>n.endsWith('.css')).map(n=>read(join(fonts,'static/css',n),'utf8')).join('\n');
  const blocks=(css.match(/@font-face\{[^}]+\}/g)??[]).filter(b=>/font-family:Geist(?: Mono)?;/.test(b)).map(b=>b.replaceAll('/_next/static/media/',join(fonts,'static/media')+'/'));
  if(!blocks.length)throw Error('No retained Geist font faces');
  write(join(stage,'offline-fonts.cjs'),`module.exports=new Proxy({}, {get:(_,url)=>String(url).includes('Geist+Mono')?${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist Mono;')).join('\n'))}:${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist;')).join('\n'))}});`);
  env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES=join(stage,'offline-fonts.cjs');
  summary.fontBoundary='Retained real local Geist CSS/woff2 cache; not a clean uncached install/build';
  run('next-workflow-build',[join(deps,'next/dist/bin/next'),'build','--webpack'],join(stage,'apps/web'));
 }else{summary.commands.push({label:'next-workflow-build',exit:null,blocked:'Missing retained font cache; set CHAT_FONT_CACHE. No network fallback.'});}
}
const composition=JSON.parse(read(join(stage,'CURRENT-COMPOSITION.json')));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const drift=[];
const payment=JSON.parse(read(join(stage,'PAYMENT-COMPOSITION.json')));
for(const [kind,entries] of Object.entries({preserved:Object.fromEntries(Object.entries(composition.preserved).filter(([p])=>!payment.changes[p]&&!payment.reviewChanges?.[p])),changes:{...composition.changes,...payment.changes},additions:{...composition.additions,...payment.reviewChanges,...payment.changes,...payment.additions}}))for(const [path,record] of Object.entries(entries)){
 if(!existsSync(join(stage,path))||digest(read(join(stage,path)))!==record.sha256)drift.push({kind,path});
}
summary.finalAppliedSource={preservedFiles:Object.keys(composition.preserved).length,preservedBytes:composition.preservedBytes,changedFiles:Object.keys(composition.changes).length,addedFiles:Object.keys(composition.additions).length,compositionSha256:digest(read(join(stage,'CURRENT-COMPOSITION.json'))),drift};
if(drift.length)summary.commands.push({label:'final-applied-source-integrity',exit:1});
summary.versions=Object.fromEntries(['next','react','react-dom','typescript','workflow','@usenaive-sdk/managed-agents'].map(n=>[n,JSON.parse(read(join(deps,n,'package.json'))).version]));
summary.appliedSourceSha256={};
const source=join(root,'docs/current-autonomy-payment-startup/bridge/source');
const walk=(d,p='')=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]);
if(existsSync(source))for(const path of walk(source)){
 const bytes=read(join(source,path));
 if(!bytes.equals(read(join(stage,path))))throw Error('Applied source drift: '+path);
 summary.appliedSourceSha256[path]=createHash('sha256').update(bytes).digest('hex');
}
if(existsSync(join(out,'tests.json'))){const t=JSON.parse(read(join(out,'tests.json')));summary.tests={passed:t.numPassedTests,failed:t.numFailedTests,skipped:t.numPendingTests};if(!t.numPassedTests||t.numFailedTests||t.numPendingTests||t.numFailedTestSuites)summary.commands.push({label:'runtime-test-completeness',exit:1});}
if(existsSync(join(out,'parent-tests.json'))){const t=JSON.parse(read(join(out,'parent-tests.json')));summary.parentTests={passed:t.numPassedTests,failed:t.numFailedTests,skipped:t.numPendingTests};}
if(existsSync(join(here,'sql.test.mjs')))run('native-sql',[join(here,'sql.test.mjs')],root,env);
persist();
if(summary.commands.some(c=>c.exit!==0))process.exitCode=1;
