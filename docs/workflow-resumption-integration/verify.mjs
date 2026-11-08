import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageResumption } from './stage.mjs';
const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../..');
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE ?? '/tmp/workflow-bootstrap.JpxCTM');
const deps=join(installed,'node_modules');
const assembled=stageResumption(), {stage}=assembled;
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});
for(const name of readdirSync(deps)) if(name!=='@ae') symlinkSync(join(deps,name),join(stage,'node_modules',name));
symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'),'dir');
for(const sub of ['apps/web','packages/core']) symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'),'dir');
writeFileSync(join(stage,'package.json'),'{"private":true,"type":"module"}');
for(const [from,to] of [['docs/workflow-data-bridge/verification','bridge-verification'],['docs/workflow-remediation-integration/app/tests','remediation-verification'],['tests/track-b/complete-workflow-integration','complete-verification'],['tests/track-b/workflow-resumption-integration','resumption-verification']]) {
 mkdirSync(join(stage,to),{recursive:true});
 for(const name of readdirSync(join(root,from)).filter(n=>n.endsWith('.test.ts'))) copyFileSync(join(root,from,name),join(stage,to,name));
}
// Update only the predecessor's expected pending labels for the now-distinct public outcomes.
const driver=join(stage,'bridge-verification/rich-driver.test.ts');
writeFileSync(driver,readFileSync(driver,'utf8').replace("['waiting_for_data','pending']","['waiting_for_data','agent_pending']").replace("['waiting_for_review','pending']","['waiting_for_review','review_pending']").replace("['cost_delivery_pending','pending']","['cost_delivery_pending','cost_delivery_pending']"));
copyFileSync(join(root,'docs/workflow-integration/verification/costs.test.ts'),join(stage,'bridge-verification/global-costs.test.ts'));
for(const [source,target] of [['data-production.test.ts','apps/web/src/server/data-production.test.ts'],['route.test.ts','apps/web/src/app/api/jobs/[jobId]/data-review/route.test.ts']]) copyFileSync(join(root,'docs/data-production-integration/intake/source',source),join(stage,target));
// Extend the predecessor fixture with the production columns/migration required by atomic wake admission.
const intakeTest=join(stage,'apps/web/src/server/data-production.test.ts');
writeFileSync(intakeTest,readFileSync(intakeTest,'utf8').replace(" fixture.sql={query:"," await db.exec(`ALTER TABLE jobs ADD COLUMN state text DEFAULT 'planning', ADD COLUMN workflow_run_id text DEFAULT 'workflow-current'; CREATE SCHEMA workflow_integration;`);\n await db.exec(readFileSync('apps/web/migrations/004-workflow-resumption.sql','utf8'));\n fixture.sql={query:"));
writeFileSync(join(stage,'complete-verification/empty.ts'),'export {};\n');
const aliases=[['@rich-step','apps/web/src/workflows/steps/rich-evaluation.ts'],['@step-evaluate','apps/web/src/workflows/steps/evaluate.ts'],['@step-common','apps/web/src/workflows/steps/common.ts'],['server-only','complete-verification/empty.ts'],['@workflow-data','apps/web/src/server/workflow-data.ts'],['@costs','apps/web/src/server/workflow-costs.ts'],['@/','apps/web/src/']].map(([find,path])=>({find,replacement:join(stage,path)}));
writeFileSync(join(stage,'vitest.complete.config.mjs'),`export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['resumption-verification/*.test.ts','bridge-verification/*.test.ts','remediation-verification/*.test.ts','complete-verification/*.test.ts','apps/web/src/server/data-production.test.ts','apps/web/src/app/api/jobs/**/data-review/route.test.ts','packages/core/src/evals/integration/approved-suite.test.ts','packages/core/src/evals/remediation/**/*.test.ts','packages/core/src/targets/remediation.test.ts'],maxWorkers:1}};`);
// Actual combined app entrypoints, data admission, routes and accounting, transitively.
writeFileSync(join(stage,'complete-ambient.d.ts'),"declare module 'server-only';\n");
writeFileSync(join(stage,'tsconfig.complete.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,jsx:'react-jsx',resolveJsonModule:true,types:['node'],paths:{'@ae/core/*':[join(stage,'packages/core/src/*')],'@/*':[join(stage,'apps/web/src/*')]}},files:['complete-ambient.d.ts','packages/core/src/evals/integration/approved-suite.ts','packages/core/src/evals/remediation/accounting/index.ts','apps/web/src/server/data-production.ts','apps/web/src/server/workflow-resumption.ts','apps/web/src/workflows/job.ts','apps/web/src/workflows/steps/review-wake.ts','apps/web/src/app/api/cron/review-resumption/route.ts','apps/web/src/server/workflow-data.ts','apps/web/src/server/rich-remediation.ts','apps/web/src/server/rich-services.ts','apps/web/src/workflows/steps/rich-evaluation.ts','apps/web/src/app/api/operator/jobs/[jobId]/workflow-binding/route.ts','apps/web/src/app/api/jobs/[jobId]/data-review/route.ts']},null,2));
execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p','tsconfig.complete.json'],{cwd:stage,stdio:'inherit'});
console.log('Actual combined-source strict TypeScript passed. Stage: '+stage);
if(process.argv.includes('--typecheck-only')) process.exit(0);
const localTests=join(root,'tests/track-b/node_modules');
const testDeps=resolve(process.env.WORKFLOW_NODE_MODULES ?? (existsSync(join(localTests,'vitest/vitest.mjs')) ? localTests : deps));
if(!existsSync(join(testDeps,'vitest/vitest.mjs'))) throw new Error('Existing offline Vitest required');
execFileSync(process.execPath,[join(testDeps,'vitest/vitest.mjs'),'run','--config','vitest.complete.config.mjs','--reporter=default','--reporter=json','--outputFile.json=complete-results.json'],{cwd:stage,stdio:'inherit',env:{...process.env,WORKFLOW_STAGE:stage,BRIDGE_STAGE:stage,BRIDGE_ROOT:root}});
const report=JSON.parse(readFileSync(join(stage,'complete-results.json'),'utf8'));
const cases=report.testResults.flatMap(f=>f.assertionResults);
if(!cases.length || cases.some(c=>c.status!=='passed')) throw new Error('Required test failed/skipped');
const summary={...assembled,strictCombinedSourceTypecheck:'passed',tests:cases.length,files:report.testResults.map(f=>({file:relative(realpathSync(stage),f.name),tests:f.assertionResults.length,status:f.status})),skipped:0};
writeFileSync(join(here,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
