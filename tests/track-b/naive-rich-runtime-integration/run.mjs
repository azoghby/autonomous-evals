import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,symlinkSync,cpSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const stage=mkdtempSync('/tmp/naive-rich-runtime-');
const cache=process.env.RICH_RUNTIME_DEPS||'/tmp/sandbox-generation-deps.cBCEai/node_modules';
const fallback=process.env.RICH_RUNTIME_FALLBACK||'/tmp/workflow-bootstrap.JpxCTM/node_modules';
function run(cmd,args,opts={}){const r=spawnSync(cmd,args,{cwd:stage,encoding:'utf8',...opts});if(r.error)throw r.error;return r;}
function ok(r){if(r.status!==0)throw Error(r.stdout+r.stderr);return r;}
const base=process.env.RICH_RUNTIME_BASE||'06d8a15';
const commit=ok(spawnSync('git',['rev-parse',base],{cwd:repo,encoding:'utf8'})).stdout.trim();
let archiveProvenance;
if(process.env.RICH_RUNTIME_ARCHIVE_CACHE){
 const cachePath=resolve(process.env.RICH_RUNTIME_ARCHIVE_CACHE),expected=process.env.RICH_RUNTIME_ARCHIVE_SHA256;
 const receiptPath=resolve(process.env.RICH_RUNTIME_ARCHIVE_RECEIPT||join(here,'FIRST-FULL-RESULTS.json')),receiptBytes=readFileSync(receiptPath),receipt=JSON.parse(receiptBytes);
 if(!expected||!/^[a-f0-9]{64}$/.test(expected)||sha(readFileSync(cachePath))!==expected||receipt.base!==commit||cachePath!==join(receipt.stage,'source.tar'))throw Error('Archive cache provenance mismatch');
 cpSync(cachePath,join(stage,'source.tar'));
 archiveProvenance={kind:'verified_completed_archive_cache',path:cachePath,sha256:expected,sourceCommit:commit,receiptPath,receiptSha256:sha(receiptBytes)};
}else{
 ok(spawnSync('git',['archive','--format=tar','--output',join(stage,'source.tar'),commit,'apps/web','packages/core','test','data','scripts','package.json','vitest.config.ts'],{cwd:repo,encoding:'utf8'}));
 archiveProvenance={kind:'git_archive',sourceCommit:commit,sha256:sha(readFileSync(join(stage,'source.tar')))};
}
ok(run('tar',['-xf','source.tar']));
const applied=[];
for(const name of ['expert-workflow-integration','naive-rich-contract-integration','naive-text-runtime-integration','naive-workflow-schema-integration']){
 const root=join(repo,'docs',name),mp=join(root,'manifest.json'),mb=readFileSync(mp),m=JSON.parse(mb),patch=join(root,'owner.patch'),pb=readFileSync(patch);
 if((m.patch_sha256??m.patchSha256)&&sha(pb)!==(m.patch_sha256??m.patchSha256))throw Error('Patch hash mismatch: '+name);
 const pins=m.files.map(p=>({path:p.path,before:p.preimage_sha256??p.beforeSha256??null,after:p.postimage_sha256??p.afterSha256}));
 for(const p of pins){const dest=join(stage,p.path),before=existsSync(dest)?sha(readFileSync(dest)):null;if(before!==p.before)throw Error('Preimage mismatch '+name+': '+p.path+' '+before+' != '+p.before);const source=join(root,existsSync(join(root,'source',p.path))?'source':'postimages',p.path);if(sha(readFileSync(source))!==p.after)throw Error('Artifact postimage mismatch '+p.path);}
 ok(run('git',['apply','--check',patch]));ok(run('git',['apply',patch]));
 for(const p of pins)if(sha(readFileSync(join(stage,p.path)))!==p.after)throw Error('Applied postimage mismatch '+p.path);
 applied.push({name,manifestSha256:sha(mb),patchSha256:sha(pb),files:pins});
}
const combinedPath=join(repo,'docs/naive-text-adoption-integration/manifest.json'),combinedBytes=readFileSync(combinedPath),combined=JSON.parse(combinedBytes);
if(combined.baseCommit!==commit)throw Error('Combined candidate base mismatch');
for(const p of combined.files)if(sha(readFileSync(join(stage,p.path)))!==p.afterSha256)throw Error('Combined candidate postimage mismatch '+p.path);
const support=[];
const fixturePath='tests/track-b/trace-acceptance.json',fixtureBlob=ok(spawnSync('git',['show',commit+':'+fixturePath],{cwd:repo})).stdout;
mkdirSync(dirname(join(stage,fixturePath)),{recursive:true});writeFileSync(join(stage,fixturePath),fixtureBlob);support.push({path:fixturePath,sha256:sha(fixtureBlob),sourceCommit:commit});
// Pin every source module in the archived base, including modules imported transitively.
function walk(dir){for(const ent of readdirSync(join(stage,dir),{withFileTypes:true})){const p=join(dir,ent.name);if(ent.isDirectory())walk(p);else if(/\.(ts|sql|json)$/.test(p))support.push({path:p,sha256:sha(readFileSync(join(stage,p)))});}}
walk('packages/core/src');walk('apps/web/src/server');walk('apps/web/src/workflows');
mkdirSync(join(stage,'node_modules'),{recursive:true});
for(const root of [cache,fallback,'/tmp/expert-validation-extra-deps/node_modules'])for(const name of readdirSync(root)){if(name.startsWith('.')||name==='@ae')continue;const target=join(stage,'node_modules',name);if(name.startsWith('@')){mkdirSync(target,{recursive:true});for(const sub of readdirSync(join(root,name)))if(!existsSync(join(target,sub)))symlinkSync(join(root,name,sub),join(target,sub));}else if(!existsSync(target))symlinkSync(join(root,name),target);}
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
const harnessPins=readdirSync(here).filter(p=>/\.(?:test\.ts|mjs)$/.test(p)).map(path=>({path,sha256:sha(readFileSync(join(here,path)))}));
cpSync(here,join(stage,'tests/track-b/naive-rich-runtime-integration'),{recursive:true});
const tests=['tests/track-b/naive-rich-runtime-integration/*.test.ts','packages/core/src/evals/naive-runtime-integration.test.ts','apps/web/src/workflows/steps/evaluate.test.ts','apps/web/src/server/regression-check.test.ts'];
writeFileSync(join(stage,'rich-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@workflow-test':join(stage,'apps/web/src/workflows'),'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'test/stubs/server-only.ts')}},test:{include:tests,maxWorkers:1,testTimeout:60000,hookTimeout:60000}}));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',TZ:'UTC',NODE_ENV:'test'};
console.log('STAGE='+stage);
const typegen=run(process.execPath,[join(fallback,'next/dist/bin/next'),'typegen'],{cwd:join(stage,'apps/web'),env});writeFileSync(join(stage,'typegen.log'),typegen.stdout+typegen.stderr);
const coreTypes=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','packages/core','--noEmit'],{env});writeFileSync(join(stage,'core-types.log'),coreTypes.stdout+coreTypes.stderr);
const types=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','apps/web','--noEmit'],{env});writeFileSync(join(stage,'types.log'),types.stdout+types.stderr);
const testsRun=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','rich-vitest.config.mjs','--reporter=json','--outputFile=rich-results.json'],{env});writeFileSync(join(stage,'tests.log'),testsRun.stdout+testsRun.stderr);
symlinkSync(join(cache,'.bin'),join(stage,'node_modules/.bin'));
const fullTests=run('npm',['test','--','--maxWorkers=2','--reporter=json','--outputFile=full-results.json'],{env});writeFileSync(join(stage,'full-tests.log'),fullTests.stdout+fullTests.stderr);
const fullReport=existsSync(join(stage,'full-results.json'))?JSON.parse(readFileSync(join(stage,'full-results.json'))):null;
const build=process.env.RICH_RUNTIME_SKIP_BUILD==='1'?{status:null,stdout:'Explicit build skip',stderr:''}:run(process.execPath,[join(fallback,'next/dist/bin/next'),'build','--webpack'],{cwd:join(stage,'apps/web'),env:{...env,NEXT_TELEMETRY_DISABLED:'1'}});writeFileSync(join(stage,'build.log'),build.stdout+build.stderr);
const report=existsSync(join(stage,'rich-results.json'))?JSON.parse(readFileSync(join(stage,'rich-results.json'))):null;
for(const p of support)if(sha(readFileSync(join(stage,p.path)))!==p.sha256)throw Error('Support changed during tests '+p.path);
for(const p of harnessPins)if(sha(readFileSync(join(here,p.path)))!==p.sha256)throw Error('Harness changed during validation '+p.path);
if(sha(readFileSync(combinedPath))!==sha(combinedBytes))throw Error('Combined candidate changed during validation');
for(const a of applied){const root=join(repo,'docs',a.name);if(sha(readFileSync(join(root,'manifest.json')))!==a.manifestSha256||sha(readFileSync(join(root,'owner.patch')))!==a.patchSha256)throw Error('Artifact changed during validation: '+a.name);}
const usedVersion=name=>JSON.parse(readFileSync(join(stage,'node_modules',name,'package.json'))).version;
const result={dependencies:{analytics:{declared:'^2.0.1',used:usedVersion('@vercel/analytics'),substitution:!usedVersion('@vercel/analytics').startsWith('2.')},aiSdkReact:{declared:'^4.0.169',used:usedVersion('@ai-sdk/react')}},base:commit,archiveProvenance,harnessPins,fullTests:{status:fullTests.status,passed:fullReport?.numPassedTests,failed:fullReport?.numFailedTests,pending:fullReport?.numPendingTests},combinedManifestSha256:sha(combinedBytes),combinedFiles:combined.files.length,stage,artifacts:applied,build:build.status,typegen:typegen.status,coreTypecheck:coreTypes.status,typecheck:types.status,tests:testsRun.status,passed:report?.numPassedTests,failed:report?.numFailedTests,pending:report?.numPendingTests};
writeFileSync(join(here,'SUPPORT-PINS.json'),JSON.stringify(support,null,2)+'\n');writeFileSync(join(here,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({base:commit,stage,artifacts:applied.map(a=>a.name),build:build.status,typegen:typegen.status,coreTypecheck:coreTypes.status,typecheck:types.status,tests:testsRun.status,passed:report?.numPassedTests,failed:report?.numFailedTests,pending:report?.numPendingTests},null,2));
if(fullTests.status!==0)console.log(fullTests.stdout+fullTests.stderr);
if(build.status!==0&&build.status!==null)console.log(build.stdout+build.stderr);
if(typegen.status!==0)console.log(typegen.stdout+typegen.stderr);
if(coreTypes.status!==0)console.log(coreTypes.stdout+coreTypes.stderr);
if(types.status!==0)console.log(types.stdout+types.stderr);
if(testsRun.status!==0)console.log(testsRun.stdout+testsRun.stderr);
if(fullTests.status!==0||fullReport?.numFailedTests||(build.status!==0&&build.status!==null)||typegen.status!==0||coreTypes.status!==0||types.status!==0||testsRun.status!==0||!report?.numPassedTests||report.numFailedTests||report.numPendingTests)process.exitCode=1;
