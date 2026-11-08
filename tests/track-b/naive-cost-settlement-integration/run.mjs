import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,symlinkSync,cpSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../../..');
const artifact=join(repo,'docs/naive-cost-settlement-integration');
const manifest=JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8'));
const pins=Object.fromEntries(manifest.files.map(p=>[p.path,p]));
const stage=mkdtempSync('/tmp/naive-cost-owner-');
const cache=process.env.NAIVE_COST_DEPS || '/tmp/sandbox-generation-deps.cBCEai/node_modules';
const fallback=process.env.NAIVE_COST_FALLBACK || '/tmp/workflow-bootstrap.JpxCTM/node_modules';
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
mkdirSync(join(stage,'node_modules'),{recursive:true});
for(const root of [cache,fallback])for(const name of readdirSync(root)) {
 if(name.startsWith('.')||name==='@ae')continue;
 const target=join(stage,'node_modules',name);
 if(name.startsWith('@')) {mkdirSync(target,{recursive:true});for(const sub of readdirSync(join(root,name)))if(!existsSync(join(target,sub)))symlinkSync(join(root,name,sub),join(target,sub));}
 else if(!existsSync(target))symlinkSync(join(root,name),target);
}
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
cpSync(here,join(stage,'tests/track-b/naive-cost-settlement-integration'),{recursive:true});
const tests=['tests/track-b/naive-cost-settlement-integration/*.test.ts'];
writeFileSync(join(stage,'cost-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'test/stubs/server-only.ts')}},test:{include:tests,maxWorkers:1,testTimeout:60000,hookTimeout:60000}}));
writeFileSync(join(stage,'tsconfig.cost.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ESNext','DOM'],module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:[...tests,'apps/web/src/server/cost-settlement.ts','packages/core/src/db/schema.ts']}));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',TZ:'UTC',NODE_ENV:'test'};
const types=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','tsconfig.cost.json'],{env});
writeFileSync(join(stage,'types.log'),types.stdout+types.stderr);
const testsRun=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','cost-vitest.config.mjs','--reporter=json','--outputFile=cost-results.json'],{env});
writeFileSync(join(stage,'tests.log'),testsRun.stdout+testsRun.stderr);
const report=existsSync(join(stage,'cost-results.json'))?JSON.parse(readFileSync(join(stage,'cost-results.json'),'utf8')):null;
verify();
const result={base:manifest.baseCommit,stage,patchSha256:sha(readFileSync(join(artifact,'owner.patch'))),verifiedPostimages:Object.keys(pins).length,typecheck:types.status,tests:testsRun.status,passed:report?.numPassedTests,failed:report?.numFailedTests,pending:report?.numPendingTests};
writeFileSync(join(here,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
if(types.status!==0)console.log(types.stdout+types.stderr);
if(testsRun.status!==0)console.log(testsRun.stdout+testsRun.stderr);
if(!report?.numPassedTests||report?.numPendingTests||report?.numFailedTests||types.status!==0||testsRun.status!==0)process.exitCode=1;
