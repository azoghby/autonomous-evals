#!/usr/bin/env node
// Offline release evidence only. Does not install, migrate, fetch or contact a service.
import {spawnSync, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync, cpSync, symlinkSync, readdirSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const root=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const out=resolve(process.env.CHAT_RELEASE_OUTPUT??mkdtempSync(join(tmpdir(),'chat-release-evidence-')));
mkdirSync(out,{recursive:true});
const deps=resolve(process.env.STRUCTURED_NODE_MODULES??'/tmp/track-b-harness/node_modules');
const uiDeps=resolve(process.env.CHAT_UI_NODE_MODULES??'/tmp/progress-chat-ui-verification/node_modules');
const steps=[];
function run(name,script,args=[],env={},cwd=root) {
  const result=spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,...env}});
  const log=(result.stdout??'')+(result.stderr??'')+(result.error?`\n${result.error.message}`:'');
  writeFileSync(join(out,`${name}.log`),log);
  steps.push({name,status:result.status===0?'passed':'failed',exitCode:result.status,log:`${name}.log`,testSummaries:[...log.matchAll(/Tests\s+([^\n]+)/g)].map(m=>m[1].trim())});
  console.log(`${name}: ${steps.at(-1).status}`);
  return {ok:result.status===0,log};
}
const files=['docs/progress-chat-integration/core-security.patch','docs/progress-chat-integration/server.patch','docs/progress-chat-integration/client.patch','docs/progress-chat-integration/combined.patch','docs/progress-chat-integration/server/001-private-conversations.sql','docs/structured-progress-integration/backend/structured-progress.patch','docs/structured-progress-integration/backend/001-structured-progress.sql','docs/structured-progress-integration/verification/validate.mjs'];
function ownedFiles(dir){return readdirSync(join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?ownedFiles(`${dir}/${e.name}`):[`${dir}/${e.name}`]);}
files.push(...ownedFiles('tests/track-b/chat-release'),...ownedFiles('docs/chat-release-verification/app-ui').filter(f=>f.endsWith('.patch')));
const manifest={runtime:process.version,dependencies:Object.fromEntries([['core',deps],['ui',uiDeps]].map(([label,path])=>[label,Object.fromEntries(['vitest','typescript','zod','react','jsdom','@electric-sql/pglite'].flatMap(name=>{try{return [[name,JSON.parse(readFileSync(join(path,name,'package.json'),'utf8')).version]];}catch{return [];}}))])),artifactAppPin:'2dff9d8af8cccdd171d78760a0d74136d138fcb4',priorAppPin:'96cb4adcea8c55ae4d8cc353deb059996245aa77',corePin:'de6a7985e72b57fce79ef7f69f533b0b2da126a7',observedHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),observedTrackA:execFileSync('git',['rev-parse','origin/track-a'],{cwd:root,encoding:'utf8'}).trim(),sha256:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(root,f))).digest('hex')]))};
const componentText=['core-security.patch','server.patch','client.patch'].map(f=>readFileSync(join(root,'docs/progress-chat-integration',f),'utf8')).join('');
if(componentText!==readFileSync(join(root,'docs/progress-chat-integration/combined.patch'),'utf8'))throw Error('Combined artifact differs from components');
const structured=run('structured',join(root,'docs/structured-progress-integration/verification/validate.mjs'),[],{STRUCTURED_NODE_MODULES:deps});
const stage=structured.log.match(/^Staging (.+)$/m)?.[1];
if(stage&&structured.ok){
  manifest.stage=stage;
  mkdirSync(join(stage,'validation'),{recursive:true});
  for(const f of ['current-policy.test.ts','sql.test.ts'])copyFileSync(join(root,'docs/progress-chat-integration/validation',f),join(stage,'validation',f));
  copyFileSync(join(root,'docs/progress-chat-integration/server/001-private-conversations.sql'),join(stage,'validation/001-private-conversations.sql'));
  const config=join(stage,'vitest.release-baseline.config.mjs');
  writeFileSync(config,`export default {test:{include:['validation/*.test.ts','packages/core/src/reporting/chat/answers.test.ts','packages/core/src/reporting/chat/file-conversations.test.ts'],maxWorkers:1,minWorkers:1}};`);
  run('baseline-current-policy-sql',join(deps,'vitest/vitest.mjs'),['run','--config',config],{CHAT_PERSISTENCE_TEST_DATABASE_URL:''},stage);
  // Copy earlier server fixtures, preserving their explicit fixture boundaries.
  const serverScratch=mkdtempSync(join(tmpdir(),'chat-release-server-'));
  cpSync(join(root,'docs/progress-chat-integration/server'),serverScratch,{recursive:true});
  symlinkSync(deps,join(serverScratch,'node_modules'),'dir');
  // Structured dispatch requires the real job package/environment columns absent
  // from the older Trace-only fixture. Adapt only the copied fixture, not source.
  const compositionTest=join(serverScratch,'composition.test.ts');
  writeFileSync(compositionTest,readFileSync(compositionTest,'utf8').replace("customer_id:'owner',state:","customer_id:'owner',package:'trace_audit',environment:'test',state:"));
  const serverConfig=join(serverScratch,'vitest.config.ts');
  // Earlier Trace-only config needs the new structured core imports resolved too.
  writeFileSync(serverConfig,readFileSync(serverConfig,'utf8').replace('alias: [',()=>`alias: [{find:new RegExp('^@ae/core/(.*)$'),replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}},`));
  run('server-regression',join(deps,'vitest/vitest.mjs'),['run','--config',serverConfig],{CHAT_STAGE_DIR:stage},serverScratch);
  run('structured-targeted-types',join(root,'docs/structured-progress-integration/verification/typecheck.mjs'),[stage,deps]);
  run('client-interactions-types',join(root,'docs/progress-chat-integration/client/tests/run.mjs'),[],{CHAT_STAGE_DIR:stage,CHAT_UI_NODE_MODULES:uiDeps});
  run('independent-ui-regressions',join(here,'app-ui/run.mjs'),[stage],{CHAT_UI_NODE_MODULES:uiDeps});
  const security=join(here,'security/run.mjs');
  try { readFileSync(security); run('independent-security',security,[stage,deps]); } catch(error) {steps.push({name:'independent-security',status:'missing',reason:error.message});}
}
const result={...manifest,createdAt:new Date().toISOString(),steps,offlinePassed:steps.length===7&&steps.every(s=>s.status==='passed'),releaseAccepted:false,boundary:'Local SQL, fixture auth/pool, and jsdom only. Full app and rendered/live evidence reported separately.'};
writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(`Evidence: ${out}\nStage: ${stage??'not reconstructed'}\nRelease accepted: false (live/runtime gates are separate)`);
process.exitCode=result.offlinePassed?0:1;
