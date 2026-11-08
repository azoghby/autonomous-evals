import {execFileSync as exec} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,symlinkSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {stageMetered} from '../../../docs/track-b-metered-acceptance/stage.mjs';
import {buildAppWorker} from '../../../docs/track-b-metered-acceptance/worker-parent.mjs';
const root=resolve(import.meta.dirname,'../../..'), out=join(root,'docs/acceptance-protocol-closure/verification');mkdirSync(out,{recursive:true});

const result=await stageMetered(),{stage}=result;
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM'),deps=join(installed,'node_modules');
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});
for(const n of readdirSync(deps))if(n!=='@ae')symlinkSync(join(deps,n),join(stage,'node_modules',n));
symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
for(const sub of ['apps/web','packages/core'])symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'));
for(const path of ['tests/track-b/metered-acceptance','tests/track-b/app-acceptance-integration','tests/track-b/workflow-judging-integration','docs/track-b-metered-acceptance','docs/app-acceptance-integration','docs/acceptance-protocol-closure','tests/track-b/acceptance-protocol-closure'])cpSync(join(root,path),join(stage,path),{recursive:true});
writeFileSync(join(stage,'package.json'),'{"type":"module","private":true}');
writeFileSync(join(stage,'tests/track-b/app-acceptance-integration/empty.ts'),'export {};');writeFileSync(join(stage,'empty.ts'),'export {};');writeFileSync(join(stage,'ambient.d.ts'),"declare module 'server-only';");
writeFileSync(join(stage,'tsconfig.metered.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,jsx:'react-jsx',esModuleInterop:true,resolveJsonModule:true,types:['node'],paths:{'@ae/core/*':[join(stage,'packages/core/src/*')],'@/*':[join(stage,'apps/web/src/*')]}},files:['ambient.d.ts','docs/track-b-metered-acceptance/app-phase.ts','tests/track-b/acceptance-protocol-closure/applied-source.test.ts','tests/track-b/acceptance-protocol-closure/calendar.test.ts',...['rich-services','rich-remediation','acceptance-runtime','rich-judge'].map(n=>'apps/web/src/server/'+n+'.ts')]}));
const aliases=[{find:'server-only',replacement:join(stage,'empty.ts')},{find:'@/',replacement:join(stage,'apps/web/src/')}];
writeFileSync(join(stage,'vitest.metered.config.mjs'),`export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['tests/track-b/metered-acceptance/*.test.ts','tests/track-b/app-acceptance-integration/adapter.test.ts','tests/track-b/workflow-judging-integration/*.test.ts','tests/track-b/acceptance-protocol-closure/*.test.ts'],maxWorkers:1,minWorkers:1,fileParallelism:false,testTimeout:120000}};`);
function run(name,args){try{const log=exec(process.execPath,args,{cwd:stage,encoding:'utf8',env:{...process.env,WORKFLOW_STAGE:stage,APP_ACCEPTANCE_STAGE:stage,APP_ACCEPTANCE_ROOT:root},maxBuffer:16*1024*1024});writeFileSync(join(out,name+'.log'),log);console.log(log);}catch(e){writeFileSync(join(out,name+'.log'),String(e.stdout??'')+String(e.stderr??''));throw e;}}
run('typecheck',[join(deps,'typescript/bin/tsc'),'-p','tsconfig.metered.json']);
buildAppWorker(stage);
run('tests',[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.metered.config.mjs','--reporter=default','--reporter=json','--outputFile.json='+join(out,'tests.json')]);
const tests=JSON.parse(readFileSync(join(out,'tests.json')));if(tests.numFailedTests||tests.numPendingTests)throw Error('offline test failure/skip');
const routeLog=exec(process.execPath,['tests/track-b/controlled-remediation-targets/run.mjs'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});writeFileSync(join(out,'controlled-route.log'),routeLog);
writeFileSync(join(out,'RESULTS.json'),JSON.stringify({source:'offline_applied_historical_metered_stage',stage,tests:tests.numPassedTests,strictTypecheck:true,live:false},null,2)+'\n');
