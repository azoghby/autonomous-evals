import {execFileSync} from 'node:child_process';
import {cpSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageComparison} from '../../../docs/workflow-comparison-integration/stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../..');
const upstream=join(root,'tests/track-b/workflow-comparison-integration');
const deps=resolve(process.env.WORKFLOW_NODE_MODULES??'/tmp/autonomous-evals-checks.m10du4/node_modules');
const {stage}=stageComparison();
if(!process.argv.includes('--before-fix')) {
 const patch=join(root,'docs/comparison-cost-delivery-fix/fix.patch');
 execFileSync('git',['apply','--check',patch],{cwd:stage});
 execFileSync('git',['apply',patch],{cwd:stage});
}
cpSync(upstream,join(stage,'comparison-tests'),{recursive:true});
const tests=join(stage,'comparison-tests/app.test.ts');
writeFileSync(tests,readFileSync(tests,'utf8')+'\n'+readFileSync(join(here,'regressions.ts'),'utf8'));
execFileSync(process.execPath,[join(upstream,'typecheck.mjs'),stage],{stdio:'inherit'});
writeFileSync(join(stage,'package.json'),'{"private":true,"type":"module"}');
writeFileSync(join(stage,'comparison-tests/empty.ts'),'export {};');
const aliases=[{find:'server-only',replacement:join(stage,'comparison-tests/empty.ts')},{find:'@/',replacement:join(stage,'apps/web/src/')}];
writeFileSync(join(stage,'vitest.comparison.config.mjs'),`export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['comparison-tests/**/*.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:30000}};`);
execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.comparison.config.mjs','--reporter=default','--reporter=json','--outputFile.json=results.json'],{cwd:stage,stdio:'inherit'});
const r=JSON.parse(readFileSync(join(stage,'results.json'),'utf8'));
if(r.numPassedTests!==17||r.numFailedTests||r.numPendingTests||r.numTodoTests)throw new Error('Required assertions missing or skipped');
console.log(JSON.stringify({stage,passed:r.numPassedTests,offline:true}));
