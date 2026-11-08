import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,symlinkSync,cpSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../..');
const artifact=join(repo,'docs/expert-adoption-integration');
const manifestBytes=readFileSync(join(artifact,'manifest.json'));
const manifest=JSON.parse(manifestBytes);
const patchBytes=readFileSync(join(artifact,'owner.patch'));
if(manifest.baseCommit!=='eaf7f6967f0d227b9826232afa9c368a2464e1be') throw Error('Unexpected owner base: '+manifest.baseCommit);
const pins=Object.fromEntries(manifest.files.map(p=>[p.path,p]));
for (const pin of manifest.supportFiles ?? []) { const committed=spawnSync('git',['show',manifest.supportCommit+':'+pin.path],{cwd:repo}); if(committed.status!==0||createHash('sha256').update(committed.stdout).digest('hex')!==pin.sha256) throw Error('Committed support pin mismatch: '+pin.path); }
const stage=mkdtempSync('/tmp/expert-owner-');
const cache=process.env.EXPERT_OWNER_DEPS || '/tmp/sandbox-generation-deps.cBCEai/node_modules';
const fallback=process.env.EXPERT_OWNER_FALLBACK || '/tmp/workflow-bootstrap.JpxCTM/node_modules';
const sha=value=>createHash('sha256').update(value).digest('hex');
function run(cmd,args,opts={}) {const r=spawnSync(cmd,args,{cwd:stage,encoding:'utf8',...opts});if(r.error)throw r.error;return r;}
function requireSuccess(result) {if(result.status!==0)throw Error(result.stdout+result.stderr);}
requireSuccess(spawnSync('git',['archive','--format=tar','--output',join(stage,'source.tar'),manifest.baseCommit,'apps/web','packages/core','test','package.json'],{cwd:repo,encoding:'utf8'}));
requireSuccess(run('tar',['-xf','source.tar']));
for(const [name,pin] of Object.entries(pins)) {
 const p=join(stage,name);
 if(pin.beforeSha256===null?existsSync(p):!existsSync(p)||sha(readFileSync(p))!==pin.beforeSha256)throw Error('Patch preimage mismatch: '+name);
 if(sha(readFileSync(join(artifact,'postimages',name)))!==pin.afterSha256)throw Error('Postimage artifact mismatch: '+name);
}
requireSuccess(run('git',['apply','--check',join(artifact,'owner.patch')]));
requireSuccess(run('git',['apply',join(artifact,'owner.patch')]));
function verify() {for(const [name,pin] of Object.entries(pins))if(sha(readFileSync(join(stage,name)))!==pin.afterSha256)throw Error('Applied source mismatch: '+name);}
verify();
const supportFile=join(repo,'tests/track-b/expert-automation-integration/SUPPORT-PINS.json');
const supportPins=existsSync(supportFile)?JSON.parse(readFileSync(supportFile,'utf8')):[];
if(JSON.stringify(supportPins)!==JSON.stringify(manifest.supportFiles))throw Error('Manifest and harness support pins differ');
function verifySupport(){for(const pin of supportPins)if(sha(readFileSync(join(stage,pin.path)))!==pin.sha256)throw Error('Staged B support changed: '+pin.path);}
for(const pin of supportPins){const src=join(repo,pin.path),dest=join(stage,pin.path);if(existsSync(dest))throw Error('Support path unexpectedly present in base: '+pin.path);if(sha(readFileSync(src))!==pin.sha256)throw Error('Current B support pin mismatch: '+pin.path);mkdirSync(dirname(dest),{recursive:true});cpSync(src,dest);}
verifySupport();
mkdirSync(join(stage,'node_modules'),{recursive:true});
for(const root of [cache,fallback])for(const name of readdirSync(root)) {
 if(name.startsWith('.')||name==='@ae')continue;
 const target=join(stage,'node_modules',name);
 if(name.startsWith('@')) {mkdirSync(target,{recursive:true});for(const sub of readdirSync(join(root,name)))if(!existsSync(join(target,sub)))symlinkSync(join(root,name,sub),join(target,sub));}
 else if(!existsSync(target))symlinkSync(join(root,name),target);
}
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
cpSync(join(repo,'tests/track-b/expert-automation-integration'),join(stage,'tests/track-b/expert-automation-integration'),{recursive:true});
cpSync(join(repo,'tests/track-b/naive-cost-settlement-integration'),join(stage,'tests/track-b/naive-cost-settlement-integration'),{recursive:true});
mkdirSync(join(stage,'tests/track-b/expert-adoption-integration'),{recursive:true});
cpSync(join(here,'hardening.test.ts'),join(stage,'tests/track-b/expert-adoption-integration/hardening.test.ts'));
const tests=['tests/track-b/expert-adoption-integration/*.test.ts','tests/track-b/expert-automation-integration/*.test.ts','tests/track-b/naive-cost-settlement-integration/*.test.ts'];
writeFileSync(join(stage,'expert-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'test/stubs/server-only.ts')}},test:{include:tests,maxWorkers:1,testTimeout:60000,hookTimeout:60000}}));
writeFileSync(join(stage,'tsconfig.expert.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ESNext','DOM'],module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:[...tests,'apps/web/src/server/automated-expert-owner.ts','packages/core/src/db/schema.ts']}));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',TZ:'UTC',NODE_ENV:'test'};
console.log('STAGE='+stage); const types=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','tsconfig.expert.json'],{env});
writeFileSync(join(stage,'types.log'),types.stdout+types.stderr);
const coreTypes=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','packages/core','--noEmit'],{env});
writeFileSync(join(stage,'core-types.log'),coreTypes.stdout+coreTypes.stderr);
const testsRun=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','expert-vitest.config.mjs','--reporter=json','--outputFile=expert-results.json'],{env});
writeFileSync(join(stage,'tests.log'),testsRun.stdout+testsRun.stderr);
const legacyConfig={resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'test/stubs/server-only.ts')}},test:{include:['apps/web/src/server/outreach-approve.test.ts'],maxWorkers:1,testTimeout:10000,hookTimeout:10000}};
writeFileSync(join(stage,'legacy-raw.config.mjs'),'export default '+JSON.stringify(legacyConfig));
const legacyRaw=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','legacy-raw.config.mjs','--reporter=json','--outputFile=legacy-raw-results.json'],{env});
writeFileSync(join(stage,'legacy-raw.log'),legacyRaw.stdout+legacyRaw.stderr);
legacyConfig.test.setupFiles=['tests/track-b/expert-automation-integration/legacy-compat.setup.ts'];
writeFileSync(join(stage,'legacy-compat.config.mjs'),'export default '+JSON.stringify(legacyConfig));
const legacyCompat=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','legacy-compat.config.mjs','--reporter=json','--outputFile=legacy-compat-results.json'],{env});
writeFileSync(join(stage,'legacy-compat.log'),legacyCompat.stdout+legacyCompat.stderr);
const legacyReport=JSON.parse(readFileSync(join(stage,'legacy-compat-results.json'),'utf8'));

const report=existsSync(join(stage,'expert-results.json'))?JSON.parse(readFileSync(join(stage,'expert-results.json'),'utf8')):null;
verify();verifySupport();
if(sha(readFileSync(join(artifact,'owner.patch')))!==sha(patchBytes)||sha(readFileSync(join(artifact,'manifest.json')))!==sha(manifestBytes))throw Error('Owner artifact changed while tests were running');
const result={base:manifest.baseCommit,stage,supportPins,manifestSha256:sha(manifestBytes),patchSha256:sha(patchBytes),verifiedPostimages:Object.keys(pins).length,typecheck:types.status,coreTypecheck:coreTypes.status,tests:testsRun.status,legacyOriginalStatus:legacyRaw.status,legacyFixtureCompatibility:{status:legacyCompat.status,passed:legacyReport.numPassedTests,failed:legacyReport.numFailedTests,pending:legacyReport.numPendingTests},passed:report?.numPassedTests,failed:report?.numFailedTests,pending:report?.numPendingTests};
writeFileSync(join(here,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
if(legacyCompat.status!==0)console.log(legacyCompat.stdout+legacyCompat.stderr);
if(types.status!==0)console.log(types.stdout+types.stderr);
if(testsRun.status!==0)console.log(testsRun.stdout+testsRun.stderr);
if(!report?.numPassedTests||report?.numPendingTests||report?.numFailedTests||types.status!==0||coreTypes.status!==0||testsRun.status!==0||legacyCompat.status!==0)process.exitCode=1;
