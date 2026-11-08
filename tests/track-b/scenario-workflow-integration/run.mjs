import {createHash} from 'node:crypto';
import {adaptBaseline} from './compat.mjs';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,symlinkSync,cpSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../../..');
const base='5cf5e67501bab8d8d5bd66852acf92ca24ebb083';
const stage=process.env.SCENARIO_STAGE || mkdtempSync('/tmp/scenario-workflow-');
const cache=process.env.SCENARIO_DEPS || '/private/tmp/current-company-main-adoption-2df6782-final-20261107/node_modules';
function run(cmd,args,opts={}) {const r=spawnSync(cmd,args,{cwd:stage,encoding:'utf8',...opts});if(r.error)throw r.error;return r;}
if(!existsSync(join(stage,'package.json'))) {
 const a=spawnSync('git',['archive','--format=tar','--output',join(stage,'source.tar'),base,'apps/web','packages/core','test','vitest.config.ts','package.json','scripts','data'],{cwd:repo,encoding:'utf8'});if(a.status!==0)throw Error(a.stderr);
 const b=run('tar',['-xf','source.tar']);if(b.status!==0)throw Error(b.stderr);
}
// Only B's reviewed nullable suite binding changes relative to the pinned base.
cpSync(join(repo,'packages/core/src/evals/sandbox/scenario-dispatch'),join(stage,'packages/core/src/evals/sandbox/scenario-dispatch'),{recursive:true});
const artifact=join(repo,'docs/scenario-workflow-integration');
const manifest=JSON.parse(readFileSync(join(artifact,'MANIFEST.json'),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
if(manifest.base!==base)throw Error('Wrong patch base');
for(const [name,pin] of Object.entries(manifest.files)) {
 const p=join(stage,name);
 if(pin.beforeSha256===null?existsSync(p):!existsSync(p)||sha(readFileSync(p))!==pin.beforeSha256)throw Error('Patch preimage mismatch: '+name);
 if(sha(readFileSync(join(artifact,'source',name)))!==pin.afterSha256)throw Error('Postimage artifact mismatch: '+name);
}
const apply=run('git',['apply','--check',join(artifact,'owner.patch')]);if(apply.status!==0)throw Error(apply.stderr);
const applied=run('git',['apply',join(artifact,'owner.patch')]);if(applied.status!==0)throw Error(applied.stderr);
for(const [name,pin] of Object.entries(manifest.files))if(sha(readFileSync(join(stage,name)))!==pin.afterSha256)throw Error('Applied source mismatch: '+name);
const compatibility=adaptBaseline(stage);
writeFileSync(join(here,'BASELINE-COMPATIBILITY.json'),JSON.stringify(compatibility,null,2)+'\n');
mkdirSync(join(stage,'node_modules'),{recursive:true});
for(const name of readdirSync(cache))if(name!=='@ae'&&(!name.startsWith('.')||name==='.bin')&&!existsSync(join(stage,'node_modules',name)))symlinkSync(join(cache,name),join(stage,'node_modules',name));
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});if(!existsSync(join(stage,'node_modules/@ae/core')))symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
const appDeps='/tmp/workflow-bootstrap.JpxCTM/apps/web/node_modules';if(existsSync(appDeps)&&!existsSync(join(stage,'apps/web/node_modules')))symlinkSync(appDeps,join(stage,'apps/web/node_modules'));
cpSync(here,join(stage,'tests/track-b/scenario-workflow-integration'),{recursive:true});
const tests=['tests/track-b/scenario-workflow-integration/*.test.ts','apps/web/src/server/sandbox/pipeline.test.ts'];
writeFileSync(join(stage,'scenario-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'test/stubs/server-only.ts')}},test:{include:tests,maxWorkers:1,testTimeout:60000,hookTimeout:60000}}));
writeFileSync(join(stage,'tsconfig.scenario.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ESNext','DOM'],module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:tests}));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',TZ:'UTC',NODE_ENV:'test'};
const types=run(process.execPath,[join(cache,'typescript/bin/tsc'),'-p','tsconfig.scenario.json'],{env});
writeFileSync(join(stage,'types.log'),types.stdout+types.stderr);
const testsRun=run(process.execPath,[join(cache,'vitest/vitest.mjs'),'run','--config','scenario-vitest.config.mjs','--reporter=json','--outputFile=scenario-results.json'],{env});
writeFileSync(join(stage,'tests.log'),testsRun.stdout+testsRun.stderr);
const report=existsSync(join(stage,'scenario-results.json'))?JSON.parse(readFileSync(join(stage,'scenario-results.json'),'utf8')):null;
for(const [name,pin] of Object.entries(manifest.files))if(sha(readFileSync(join(stage,name)))!==pin.afterSha256)throw Error('Post-test source drift: '+name);
const result={base,stage,patchSha256:sha(readFileSync(join(artifact,'owner.patch'))),verifiedPostimages:Object.keys(manifest.files).length,compatibility,typecheck:types.status,tests:testsRun.status,passed:report?.numPassedTests,failed:report?.numFailedTests,pending:report?.numPendingTests};
writeFileSync(join(here,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
if(types.status!==0)console.log(types.stdout+types.stderr);
if(testsRun.status!==0)console.log(testsRun.stdout+testsRun.stderr);
if(!report?.numPassedTests||report?.numPendingTests||report?.numFailedTests||types.status!==0||testsRun.status!==0)process.exitCode=1;
