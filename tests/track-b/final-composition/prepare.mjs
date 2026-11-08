import {copyFileSync,cpSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
/** Copy test fixtures only; all application/core imports resolve into the final staged source. */
export function prepareFinalTests(stage,root,migrations={}) {
 const dir=join(stage,'final-verification');mkdirSync(dir,{recursive:true});
 const copyTests=(from,to)=>{mkdirSync(join(stage,to),{recursive:true});for(const n of readdirSync(join(root,from)).filter(n=>n.endsWith('.test.ts')))copyFileSync(join(root,from,n),join(stage,to,n));};
 copyTests('docs/workflow-data-bridge/verification','final-verification/bridge');
 copyTests('docs/workflow-remediation-integration/app/tests','final-verification/remediation');
 copyTests('tests/track-b/complete-workflow-integration','final-verification/complete');
 copyTests('tests/track-b/final-composition','final-verification/combined');
 copyFileSync(join(root,'docs/workflow-integration/verification/costs.test.ts'),join(dir,'bridge/global-costs.test.ts'));
 for(const [from,to] of [['data-production.test.ts','apps/web/src/server/data-production.test.ts'],['route.test.ts','apps/web/src/app/api/jobs/[jobId]/data-review/route.test.ts']])copyFileSync(join(root,'docs/data-production-integration/intake/source',from),join(stage,to));
 for(const path of ['workflow-data.test.ts']) {const p=join(dir,'bridge',path);let text=readFileSync(p,'utf8');for(const [oldName,newName]of Object.entries(migrations))text=text.replaceAll(oldName,newName);writeFileSync(p,text);}
 copyTests('docs/workflow-pack-integration/execution','final-verification/execution');
 // Adapt only fixture interfaces added by the combined driver; historical assertions remain intact.
 {const p=join(dir,'execution/rich-step.test.ts');let source=readFileSync(p,'utf8');
 source=source.replace('workflowPackSelection:async()=>','authorizeWorkflowPack:async()=>({}),workflowPackSelection:async()=>');
 source=source.replace('text:{designSuite:',"advanceData:vi.fn(async()=>{if(state.tasks.length){await state.api.inventory.acquisition(state.tasks.map(t=>t.task_id));return {status:'needs_operator'};}return null;}),text:{designSuite:");
 writeFileSync(p,source);}
 {const p=join(dir,'execution/adapter.test.ts');let source=readFileSync(p,'utf8').replaceAll("'../packages/","'../../packages/").replaceAll("'../apps/","'../../apps/");
 source=source.replace('003-workflow-packs.sql','005-workflow-packs.sql');
 source=source.replace('return {job:{customerId:tenant},','return {text:{getSuite:async()=>suite},resolvePackBaseSuite:async(digest?:string)=>{if(digest&&digest!==suite.digest)throw Error("scope");return suite;},job:{customerId:tenant},');
 const start=source.indexOf(' const store=new PostgresTextCheckpointStore(state.db);const key=');
 const end=source.indexOf('\n});',start);if(start<0||end<0)throw Error('Historical adapter fixture changed; review no-checkpoint setup');
 source=source.slice(0,start)+" // Approved admission intentionally requires no fabricated suite/design checkpoint.\n"+source.slice(end);
 source=source.replace("rejects.toThrow('context_mismatch')","rejects.toThrow('pack_base_or_target_changed')");
 writeFileSync(p,source);}

 cpSync(join(root,'tests/track-b/pack-integration'),join(stage,'tests/track-b/pack-integration'),{recursive:true});
 for(const name of ['fixture.ts','projection.test.ts','route.test.ts','storage.test.ts'])copyFileSync(join(root,'docs/workflow-pack-integration/projection',name),join(stage,name));
 writeFileSync(join(dir,'empty.ts'),'export {};\n');
 const aliases=[['@rich-step','apps/web/src/workflows/steps/rich-evaluation.ts'],['@step-evaluate','apps/web/src/workflows/steps/evaluate.ts'],['@step-common','apps/web/src/workflows/steps/common.ts'],['server-only','final-verification/empty.ts'],['@workflow-data','apps/web/src/server/workflow-data.ts'],['@costs','apps/web/src/server/workflow-costs.ts'],['@/','apps/web/src/']].map(([find,path])=>({find,replacement:join(stage,path)}));
 const main='vitest.final.config.mjs';writeFileSync(join(stage,main),`export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['final-verification/**/*.test.ts','tests/track-b/pack-integration/*.test.ts','projection.test.ts','route.test.ts','storage.test.ts','apps/web/src/server/data-production.test.ts','apps/web/src/app/api/jobs/**/data-review/route.test.ts','packages/core/src/evals/integration/approved-suite.test.ts','packages/core/src/evals/remediation/**/*.test.ts','packages/core/src/targets/remediation.test.ts'],exclude:['final-verification/chat/**'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}};`);
 const security=join(dir,'chat');cpSync(join(root,'tests/track-b/chat-workflow-release/restored/chat-release/security'),security,{recursive:true});
 const chatAliases=[['@route',join(stage,'apps/web/src/app/api/jobs/[jobId]/chat/route.ts')],['@/server/progress-chat',join(stage,'apps/web/src/server/progress-chat.ts')],['./session',join(security,'fixture-session.ts')],['@neondatabase/serverless',join(security,'fixture-pool.ts')],['server-only',join(dir,'empty.ts')]].map(([find,replacement])=>({find,replacement}));
 const chat='vitest.final-chat.config.mjs';writeFileSync(join(stage,chat),`export default {resolve:{alias:[...${JSON.stringify(chatAliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['final-verification/chat/*.test.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}};`);
 return {configs:[main,chat],env:{WORKFLOW_STAGE:stage,BRIDGE_STAGE:stage,BRIDGE_ROOT:root,PROJECTION_ROOT:root,SECURITY_STAGE:stage,SECURITY_REPO:root}};
}
