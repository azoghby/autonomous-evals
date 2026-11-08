/** Applied rich-services factory, real SQL budget/fence, fake canonical loader and HTTP only. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {it,expect,vi} from 'vitest';
import {createAutonomousPaidContext} from '@/server/autonomous-paid';
import {createAutonomousPolicy} from '@ae/core/agents/autonomy/policy';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
const state=vi.hoisted(()=>({bootstrap:vi.fn(async()=>{throw Error('legacy construction forbidden');}),send:vi.fn(async()=>({ok:true as const,text:'READY',latencyMs:1})),package:'text_eval' as 'text_eval'|'workflow_eval'}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>({job:{id:'fixture',customerId:'tenant',workflowRunId:'workflow',environment:'test',isMock:false,state:'running',retestOfJobId:null,neonBranchId:'fixture-branch'},credentials:{},intake:{package:state.package,authorizedToTest:true,endpoint:{url:'https://fixture.invalid/chat/completions',model:'fixture',systemPrompt:'fixture'}}}),recordCost:vi.fn()}));
vi.mock('@ae/core/integration/eval-services',()=>({buildAgentDeps:state.bootstrap,evalServices:{}}));
vi.mock('@ae/core/targets/text',()=>({createTextTarget:()=>({send:state.send})}));
import {createRichWorkflowServices} from '@/server/rich-services';
async function fixture(){
 const engine=new PGlite();const sql:AgentTransactionalSql={query:(s,p)=>engine.query(s,p),transaction:fn=>engine.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 await engine.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql'),'utf8'));
 await engine.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,'apps/web/src/server/autonomous-paid.sql'),'utf8'));
 await engine.exec(`CREATE SCHEMA workflow_integration;CREATE TABLE workflow_integration.bindings(job_id text,target_revision text,reviewed_calendar jsonb,isolation text,remediation_operation_micro_usd bigint,baseline_suite_digest text,baseline_run_id text);
 INSERT INTO workflow_integration.bindings VALUES('fixture','v1',NULL,'request_messages_only',1,NULL,NULL);
 CREATE TABLE customers(id text,is_internal_fixture boolean);INSERT INTO customers VALUES('tenant',true);
 CREATE TABLE job_credentials(job_id text,ciphertext text);INSERT INTO job_credentials VALUES('fixture','retained-encrypted');`);
 const policy=createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'baseline_fixture',enabled:true,rootBudgetMicroUsd:400,singleJobCapMicroUsd:100,comparisonJobCapMicroUsd:100,roleCapsMicroUsd:{commercial:100,evaluation_engineer:100,quality_investigator:100,company_operator:100},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
 const job={jobId:'fixture',customerId:'tenant',package:state.package,environment:'test' as const,isFixture:true,quoteVersion:1,linkedRetestOf:null};
 const run=vi.fn(async()=>{throw Error('not asked to call Naive in baseline target fixture');});
 let allowed=true;
 const paid=createAutonomousPaidContext({sql,policy,job,runner:{run},guard:async()=>{if(!allowed)throw Error('revoked');},jobCapMicroUsd:100,targetReservationMicroUsd:20,judgeReservationMicroUsd:1,deliverCost:async()=>{throw Error('unknown target money stays held');}});
 const ctx={jobId:'fixture',environment:'test' as const,budgetMicroUsd:100,recordCost:async()=>{},recordProgress:async()=>{}};
 for(const [k,v] of Object.entries({WORKFLOW_JUDGE_AUTH:'api_key',WORKFLOW_JUDGE_MODEL:'fixture/model',WORKFLOW_JUDGE_CONFIG_VERSION:'v1',WORKFLOW_JUDGE_RESERVATION_MICRO_USD:'1',NAIVE_BUDGET_PERIOD_ID:'baseline_fixture'}))vi.stubEnv(k,v);
 const api=await createRichWorkflowServices(ctx,{workflowRunId:'workflow',autonomous:paid,judgeRuntime:{signal:new AbortController().signal,beforeDispatch:async()=>{throw Error('no judge requested');},token:async()=>{throw Error('no credentials');}}});
 return {engine,sql,api,ctx,run,revoke:()=>{allowed=false;}};
}
it('actual baseline/pack Text send meters shared SQL and never constructs legacy runner',async()=>{
 state.package='text_eval';state.bootstrap.mockClear();state.send.mockClear();const f=await fixture();try{
  expect(state.bootstrap).not.toHaveBeenCalled();expect(f.api.job.quoteVersion).toBe(1);
  const target=await f.api.resolvePackTarget();const input={runId:'honest-run',scenarioId:'scenario-1',systemPrompt:null,userMessage:'READY'};
  await target.target.send(input);expect(state.send).toHaveBeenCalledOnce();
  const rows=(await f.sql.query<{scopes:Array<{key:string}>;settled_micro_usd:number|null}>('SELECT * FROM agent_persistence.reservations')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].scopes.some(s=>s.key==='autonomous-root:tenant:baseline_fixture')).toBe(true);expect(rows[0].settled_micro_usd).toBeNull();
  await expect(target.target.send(input)).rejects.toThrow();expect(state.send).toHaveBeenCalledOnce();
  f.revoke();await expect(target.target.send({...input,scenarioId:'scenario-2'})).rejects.toThrow();expect(state.send).toHaveBeenCalledOnce();
 }finally{await f.api.dispose();await f.engine.close();vi.unstubAllEnvs();}
},30000);
it('actual Calendar autonomous factory refuses unsupported lifecycle identity before branch/target access',async()=>{
 state.package='workflow_eval';state.bootstrap.mockClear();state.send.mockClear();const f=await fixture();try{
  await expect(f.api.calendar.freezeSuite(f.ctx,{suiteId:'retained-calendar'})).rejects.toThrow();
  expect(state.bootstrap).not.toHaveBeenCalled();expect(state.send).not.toHaveBeenCalled();
  expect((await f.sql.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(0);
 }finally{await f.api.dispose();await f.engine.close();vi.unstubAllEnvs();}
},30000);
