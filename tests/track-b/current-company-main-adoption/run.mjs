import {readFileSync as read, writeFileSync as write, mkdirSync as mkdir, readdirSync as ls, existsSync as exists, symlinkSync as link, realpathSync, statSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const owned=dirname(fileURLToPath(import.meta.url));
const stage=resolve(process.argv[2]||'/private/tmp/current-company-main-adoption-20261107');
const reference='/private/tmp/track-b-company-composed-y74pmmb8';
const cache=join(reference,'node_modules');
const frozen=join(owned,'harness-inputs');
if(!exists(join(stage,'package.json')))throw Error('Stage must already exist');
if(exists(join(stage,'.git')))throw Error('Validation requires a disposable stage without Git');
const sha=b=>createHash('sha256').update(b).digest('hex');
const selected=process.argv.slice(3);
const reviewMode=selected.some(x=>x.startsWith('review-'));
const evidence=join(owned,reviewMode?(exists(join(stage,'docs/current-company-payment-fixes/sql/002-payment-recovery.sql'))?'review-payment-fixes-evidence':'review-evidence'):'evidence'); mkdir(evidence,{recursive:true});
const runtime=join(stage,'node_modules');mkdir(runtime,{recursive:true});
for(const name of ls(cache))if(name!=='@ae'&&(!name.startsWith('.')||name==='.bin')&&!exists(join(runtime,name)))link(join(cache,name),join(runtime,name));
const appDeps='/tmp/workflow-bootstrap.JpxCTM/apps/web/node_modules';
if(exists(appDeps)&&!exists(join(stage,'apps/web/node_modules')))link(appDeps,join(stage,'apps/web/node_modules'));
mkdir(join(runtime,'@ae'),{recursive:true});
if(!exists(join(runtime,'@ae/core')))link(join(stage,'packages/core'),join(runtime,'@ae/core'));
if(JSON.parse(read(join(runtime,'ipaddr.js/package.json'))).version!=='2.5.0')throw Error('ipaddr.js 2.5.0 required');
for(const name of ['offline.cjs','offline-fonts.cjs','empty-server-only.mjs'])write(join(stage,name),read(join(frozen,name)));
const includes=['tests/track-b/autonomous-company/**/*.test.ts','tests/track-b/autonomy-release-adoption/**/*.test.ts','tests/track-b/autonomy-paid-app-integration/**/*.test.ts','tests/track-b/current-autonomy-integration/**/*.test.ts','tests/track-b/current-autonomy-calendar/**/*.test.ts','tests/track-b/current-autonomy-payment-startup/**/*.test.ts','packages/core/src/evals/calendar-integration/**/*.test.ts'];
write(join(stage,'combined-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'empty-server-only.mjs')}},test:{include:includes,maxWorkers:1,testTimeout:60000,hookTimeout:60000}})+';\n');
write(join(stage,'tsconfig.combined-tests.json'),read(join(frozen,'tsconfig.combined-tests.json')));
if(reviewMode){
 const reviewed=JSON.parse(read(join(owned,'REVIEW-INPUTS.json')));
 const withFixes=exists(join(stage,'docs/current-company-payment-fixes/sql/002-payment-recovery.sql'));
 const compatibility=reviewed.fixtureCompatibilityVariants[withFixes?'paymentFixes':'baseline'];
 for(const entry of compatibility)if(sha(read(join(stage,entry.stagePath??entry.path)))!==entry.afterSha256)throw Error('Compatibility input drift: '+entry.path);
 if(withFixes){
  const fixes=JSON.parse(read(join(owned,'PAYMENT-FIX-INPUTS.json')));
  for(const entry of fixes.fixtureInputs??[])if(sha(read(join(stage,entry.stagePath)))!==entry.sha256)throw Error('Regression SQL fixture drift: '+entry.stagePath);
  for(const entry of fixes.files.filter(x=>x.kind==='payment-regression'))if(sha(read(join(stage,entry.stagePath??entry.path)))!==(entry.stageSha256??entry.sha256))throw Error('Payment regression drift: '+entry.path);
 }
 for(const entry of reviewed.mapping.filter(x=>x.kind==='immutable-review')){
  const expected=compatibility.find(x=>x.path===entry.path)?.afterSha256??entry.sha256;
  if(sha(read(join(stage,entry.stagePath??entry.path)))!==expected)throw Error('Reviewer input drift: '+entry.path);
 }
}
const reviewIncludes=[...includes,'tests/track-b/current-company-adoption-review/**/*.test.ts','tests/track-b/current-company-adoption-payment-fixes/**/*.test.ts'];
write(join(stage,'review-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'empty-server-only.mjs')}},test:{include:reviewIncludes,maxWorkers:1,testTimeout:60000,hookTimeout:60000}})+';\n');
write(join(stage,'tsconfig.review.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:['tests/track-b/current-company-adoption-review/**/*.ts','tests/track-b/current-company-adoption-payment-fixes/**/*.ts']}));
const acceptanceIncludes=[...includes,'tests/track-b/current-company-adoption-review/**/*.invariants.test.ts','tests/track-b/current-company-adoption-review/**/findings.test.ts','tests/track-b/current-company-adoption-review/**/*.repro.test.ts','tests/track-b/current-company-adoption-payment-fixes/**/*.test.ts'];
write(join(stage,'review-acceptance-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'empty-server-only.mjs')}},test:{include:acceptanceIncludes,maxWorkers:1,testTimeout:60000,hookTimeout:60000}})+';\n');
const fonts=[...read(join(stage,'offline-fonts.cjs'),'utf8').matchAll(/url\(([^)]+\.woff2)\)/g)].map(x=>x[1]);
const fontHashes=Object.fromEntries([...new Set(fonts)].map(p=>[p,sha(read(p))]));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',CI:'1',WORKFLOW_STAGE:stage,EXTENSION_STAGE:stage,npm_config_offline:'true',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:'--require '+join(stage,'offline.cjs'),NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(stage,'offline-fonts.cjs')};
write(join(stage,'packages/core/tsconfig.current-main-production.json'),JSON.stringify({extends:'./tsconfig.json',compilerOptions:{strict:true,noEmit:true},exclude:['node_modules','**/*.test.ts','**/*.test.tsx','**/*.spec.ts']}));
const pinPath=resolve(owned,'../../../docs/current-company-main-adoption/PIN.json');
const pin=exists(pinPath)?JSON.parse(read(pinPath)):null;
const results={stage,pin,offline:true,providers:false,installs:false,includes,fontHashes,dependencies:{cache,ipaddr:realpathSync(join(runtime,'ipaddr.js')),analytics:{path:realpathSync(join(stage,'apps/web/node_modules/@vercel/analytics')),version:JSON.parse(read(join(stage,'apps/web/node_modules/@vercel/analytics/package.json'))).version,packageSha256:sha(read(join(stage,'apps/web/node_modules/@vercel/analytics/package.json')))}},commands:[]};
const previousPath=join(evidence,'RESULTS.json');
if(exists(previousPath)){const previous=JSON.parse(read(previousPath));if(previous.stage===stage)results.commands=previous.commands||[];}
// Bind all executed source and every generated harness byte before commands run.
const inputInventory=JSON.parse(read(join(stage,'CURRENT-COMPOSITION.json')));
const inputFiles={};
for(const kind of ['preserved','changes','additions'])for(const [path,record]of Object.entries(inputInventory[kind])){
 const bytes=read(join(stage,path)),hash=sha(bytes);
 if(hash!==record.sha256)throw Error('Executed source drift: '+path);
 inputFiles[path]={sha256:hash,bytes:bytes.length,kind};
}
for(const path of ['combined-vitest.config.mjs','tsconfig.combined-tests.json','review-vitest.config.mjs','review-acceptance-vitest.config.mjs','tsconfig.review.json','offline.cjs','offline-fonts.cjs','empty-server-only.mjs','packages/core/tsconfig.current-main-production.json']){
 const bytes=read(join(stage,path));inputFiles[path]={sha256:sha(bytes),bytes:bytes.length,kind:'generated-harness'};
}
write(join(evidence,'TEST-INPUTS.json'),JSON.stringify({stage,parent:inputInventory.parent,files:inputFiles,harnessRunnerSha256:sha(read(fileURLToPath(import.meta.url))),fontHashes,allDeclaredSourceVerified:true},null,2)+'\n');
results.testInputsSha256=sha(read(join(evidence,'TEST-INPUTS.json')));
const commands=[
 ['review-acceptance',process.execPath,[join(runtime,'vitest/vitest.mjs'),'run','--config','review-acceptance-vitest.config.mjs','--reporter=default','--reporter=json','--outputFile.json='+join(evidence,'review-acceptance.json')]],
 ['review-types',process.execPath,[join(runtime,'typescript/bin/tsc'),'-p','tsconfig.review.json','--noEmit']],
 ['review-tests',process.execPath,[join(runtime,'vitest/vitest.mjs'),'run','--config','review-vitest.config.mjs','--reporter=default','--reporter=json','--outputFile.json='+join(evidence,'review-tests.json')]],
 ['combined-tests',process.execPath,[join(runtime,'vitest/vitest.mjs'),'run','--config','combined-vitest.config.mjs','--reporter=default','--reporter=json','--outputFile.json='+join(evidence,'combined-tests.json')]],
 ['combined-types',process.execPath,[join(runtime,'typescript/bin/tsc'),'-p','tsconfig.combined-tests.json','--noEmit']],
 ['core-types',process.execPath,[join(runtime,'typescript/bin/tsc'),'-p','packages/core/tsconfig.current-main-production.json','--noEmit']],
 ['next-typegen',process.execPath,[join(runtime,'next/dist/bin/next'),'typegen']],
 ['application-types',process.execPath,[join(runtime,'typescript/bin/tsc'),'-p','apps/web','--noEmit']],
 ['root-tests','npm',['test','--','--maxWorkers=2','--reporter=default','--reporter=json','--outputFile.json='+join(evidence,'root-tests.json')]],
 ['production-build',process.execPath,[join(runtime,'next/dist/bin/next'),'build','--webpack']],
];
for(const [name,command,args]of commands){
 if(selected.length&&!selected.includes(name))continue;
 if(!selected.length&&name.startsWith('review-'))continue;
 const start=new Date().toISOString();
 const cwd=['next-typegen','production-build'].includes(name)?join(stage,'apps/web'):stage;
 const run=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:600000});
 const output=(run.stdout||'')+(run.stderr||'');
 if(exists(join(evidence,name+'.log')))write(join(evidence,name+'.previous.log'),read(join(evidence,name+'.log')));
 write(join(evidence,name+'.log'),output);
 let testSummary;
 if(['combined-tests','root-tests','review-tests','review-acceptance'].includes(name)&&exists(join(evidence,name+'.json'))){const report=JSON.parse(read(join(evidence,name+'.json')));testSummary={total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,todo:report.numTodoTests};}
 results.commands.push({name,testSummary,command,args,cwd,started:start,finished:new Date().toISOString(),exitCode:run.status,signal:run.signal,error:run.error?.message,logSha256:sha(output)});
 write(join(evidence,'RESULTS.json'),JSON.stringify(results,null,2)+'\n');
 console.log(name+': '+run.status);console.log(output.slice(-1500));
}
results.finalGates=Object.fromEntries(results.commands.map(x=>[x.name,{exitCode:x.exitCode,testSummary:x.testSummary}]));
write(join(evidence,'RESULTS.json'),JSON.stringify(results,null,2)+'\n');
if(Object.values(results.finalGates).some(x=>x.exitCode!==0))process.exitCode=1;
