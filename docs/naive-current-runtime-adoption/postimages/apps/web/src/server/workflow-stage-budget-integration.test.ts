/** Offline PGlite composition: real stage, runner, task store, budget and trial accounting.
 * Provider, Workflow metadata and Pool transport are fixtures; generic cost delivery is
 * recorded locally. Receipt substitution uses retained real SQL proof, not hosted billing. */
import { PGlite } from '@electric-sql/pglite';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AgentSessionService } from '@ae/core/agents/session-service';
import { PostgresAgentTaskStore,type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import { jobBudgetExposure,releaseWorkflowJobBudget,linkJobBudgetCost } from '@ae/core/db/job-budget-authority';
import { createWorkflowStageBudgetLedger } from './workflow-stage-budget';
import { FakeNaive,directory,fixtureJob } from '@ae/core/agents/__tests__/fakes';
import { createNaiveRemediationTrial } from './naive-remediation-trial';
import { lockJobBudget } from '@ae/core/db/job-budget-authority';
import { makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { evaluateObjectiveCheck,executeSuite } from '@ae/core/evals/text/index';
import type { RemediationTargetScope } from '@ae/core/targets/remediation';
import { makeScenarios } from '@ae/core/evals/text/__tests__/fixtures';
import { createNaiveTextMethods } from './naive-text-methods';
import { naiveDesignRecoveryStage } from './naive-design-recovery';
import type { ServiceContext } from '@ae/core/contracts/services';
import { executeWorkflowStage,currentWorkflowStageScope } from './workflow-stage-runtime';
import { fenceWorkflowStageSessions,fenceWorkflowStageRunner } from './workflow-stage-children';
const state=vi.hoisted(()=>({pg:undefined as PGlite|undefined,stepId:'first',attempt:0}));
vi.mock('workflow',()=>({getStepMetadata:()=>({stepId:state.stepId,attempt:state.attempt}),getWorkflowMetadata:()=>({workflowRunId:'fixture-run'}),FatalError:class extends Error{},RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:(sql:string,params?:unknown[])=>state.pg!.query(sql,params),release(){}};}}}));
let pg:PGlite;let sql:AgentTransactionalSql;
const job='a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6',customer='b1c2d3e4-f5a6-47b8-9c0d-e1f2a3b4c5d6';
const taskKey=`${job}:quality_investigator:resume_fixture:1`;
const input={jobId:job,ownerId:customer,environment:'test' as const,role:'investigator',share:.9,stage:{key:'strict-single-fixture',input:{revision:1},recovery:'naive-single-child-v1' as const,expectedChildKey:taskKey,isPending:(value:unknown)=>(value as {status:string}).status==='pending'}};
const migrations=[
 'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',
 'packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql',
 'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql',
 'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql',
 'docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql',
 'docs/naive-cancellation-integration/sql/001-job-cancellation.sql',
 'packages/core/src/evals/integration/migrations/001-text-integration.sql',
 'docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql',
 'docs/naive-design-recovery-integration/sql/002-design-checkpoint-ownership.sql',
 'docs/naive-budget-envelope-integration/sql/001-stage-model-envelopes.sql',
];
beforeEach(async()=>{
 process.env.DATABASE_URL='postgres://offline-fixture';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 pg=new PGlite();state.pg=pg;state.stepId='first';state.attempt=0;
 await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY,email text);CREATE TABLE jobs(id uuid PRIMARY KEY,package text,customer_id uuid,environment text,state text NOT NULL DEFAULT 'running',budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text,source text);`);
 for(const path of migrations)await pg.exec(readFileSync(resolve(path),'utf8'));
 await pg.query('INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,$2,$3,$4)',[job,'trace_audit',customer,'test']);
 sql={query:(text,args)=>pg.query(text,args),transaction:fn=>pg.transaction(tx=>fn({query:(text,args)=>tx.query(text,args)}))};
});
afterEach(async()=>{await pg.close();vi.unstubAllEnvs();});
function fixture(polls=1){
 const naive=new FakeNaive(()=>({structuredOutput:{answer:'retained'},pollsUntilDone:polls}));
 const store=new PostgresAgentTaskStore(sql);
 const runner=fenceWorkflowStageRunner(new AgentSessionService({naive:fenceWorkflowStageSessions(naive),store,ledger:createWorkflowStageBudgetLedger(sql),directory,budgetPeriodId:'fixture',idempotencyNamespace:'offline-test',workerId:'worker',maxWaitMs:0}));
 const spec={job:fixtureJob({jobId:job,customerId:customer}),role:'quality_investigator' as const,purpose:'resume_fixture',message:'Return a JSON answer.',output:{name:'fixture.v1',schema:z.object({answer:z.string()})},budgetMicroUsd:100_000,jobCapMicroUsd:3_000_000};
 return {naive,store,run:()=>runner.run(spec)};
}
const request=(id:string,amount:number)=>({reservationId:id,jobId:job,amountMicroUsd:amount,scopes:[{key:`job:${job}`,capMicroUsd:3_000_000},{key:'agent:commercial:fixture',capMicroUsd:3_000_000}]});
const exposure=()=>sql.transaction(tx=>jobBudgetExposure(tx,job));
async function releaseParent(){const id=await parentId();await sql.transaction(tx=>releaseWorkflowJobBudget(tx,job,id));}
async function parentId(){return String((await pg.query('SELECT reservation_id FROM workflow_stage.stages')).rows[0]!.reservation_id);}
it('admits a real session inside its near-cap stage allocation and recovers the same held child without double charging',async()=>{
 const f=fixture();
 const sibling=new SharedJobBudgetLedger(sql);
 expect(await sibling.reserve(request('unrelated-sibling',300_000))).toMatchObject({ok:true});
 expect(await executeWorkflowStage(input,async()=>f.run())).toMatchObject({ok:true,data:{status:'pending'}});
 expect(f.naive.createCalls).toHaveLength(1);
 expect(await exposure()).toMatchObject({committedMicroUsd:3_000_000,remainingMicroUsd:0});
 expect((await pg.query('SELECT * FROM job_budget.stage_model_bindings')).rows).toHaveLength(1);
 expect(await exposure()).toMatchObject({committedMicroUsd:3_000_000,remainingMicroUsd:0});
 expect(await sibling.reserve(request('unrelated-over-cap',1))).toMatchObject({ok:false});
 state.stepId='resume';expect(await executeWorkflowStage(input,async()=>f.run())).toMatchObject({ok:true,data:{status:'completed'}});
 expect(f.naive.createCalls).toHaveLength(1);
 expect(await exposure()).toMatchObject({committedMicroUsd:312_345});
 expect((await pg.query('SELECT released_at IS NOT NULL AS released FROM budget_reservations')).rows).toEqual([{released:true}]);
});
it('bounds the sum of child actuals and held allocations by the parent while sibling spending stays additive',async()=>{
 await executeWorkflowStage({...input,stage:{key:'aggregate-envelope',input:{},isPending:()=>true}},async()=>{
  const ledger=createWorkflowStageBudgetLedger(sql);
  expect(await ledger.reserve(request('first-child',2_500_000))).toMatchObject({ok:true});
  expect(await ledger.reserve(request('held-too-large',200_001))).toMatchObject({ok:false});
  await ledger.settle('first-child',100_000);
  expect(await ledger.reserve(request('second-child',2_600_000))).toMatchObject({ok:true});
  expect(await ledger.reserve(request('actual-plus-held-over-parent',1))).toMatchObject({ok:false});
  expect(await exposure()).toMatchObject({committedMicroUsd:2_700_000});
  return {status:'pending'};
 });
 expect(await new SharedJobBudgetLedger(sql).reserve(request('outside-stage',300_000))).toMatchObject({ok:true});
 expect(await exposure()).toMatchObject({committedMicroUsd:3_000_000});
 // Explicit administrative parent release cannot erase unknown child commitments.
 await releaseParent();
 expect(await exposure()).toMatchObject({committedMicroUsd:3_000_000});
});
it('keeps unknown child usage across parent release and cancellation, and rejects a captured stale owner allocation',async()=>{
 const f=fixture();let stale:ReturnType<typeof currentWorkflowStageScope>;
 await executeWorkflowStage(input,async()=>{stale=currentWorkflowStageScope();return f.run();});
 const oldLedger=createWorkflowStageBudgetLedger(sql,()=>stale);
 await expect(async()=>oldLedger.reserve(request('stale-owner-child',1))).rejects.toThrow();
 expect((await pg.query("SELECT * FROM agent_persistence.reservations WHERE id='stale-owner-child'")).rows).toHaveLength(0);
 await releaseParent();
 expect(await exposure()).toMatchObject({committedMicroUsd:100_000});
 await pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job]);
 await expect(async()=>oldLedger.reserve(request('cancelled-owner-child',1))).rejects.toThrow();
 expect(await exposure()).toMatchObject({committedMicroUsd:100_000});
 expect(f.naive.createCalls).toHaveLength(1);
});
it('substitutes an exact measured session receipt once and retains its cost after parent release',async()=>{
 const f=fixture(0);
 // Normalize the fake provider session identity into the production receipt grammar.
 const realCreate=f.naive.createSession.bind(f.naive);
 vi.spyOn(f.naive,'createSession').mockImplementation(async(body,key)=>{
  const snapshot=await realCreate(body,key);
  const id='ses_00000000000000000000000001';
  const stored=f.naive.sessions.get(snapshot.id)!;stored.id=id;f.naive.sessions.delete(snapshot.id);f.naive.sessions.set(id,stored);f.naive.byKey.get(key)!.id=id;
  return {...snapshot,id};
 });
 let reservation='';
 await executeWorkflowStage({...input,stage:{...input.stage,isPending:()=>true}},async()=>{
  expect(await f.run()).toMatchObject({status:'completed'});
  reservation=(await f.store.get(taskKey))!.reservationId;
  const receipt='naive:ses_00000000000000000000000001',cost='33333333-3333-4333-8333-333333333333';
  await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key,source) VALUES($1,$2,$3,$4,$5)',[cost,job,12_345,receipt,'naive']);
  // Without the exact retained task/session link the public cost remains additive.
  expect(await exposure()).toMatchObject({committedMicroUsd:2_712_345});
  await sql.transaction(tx=>linkJobBudgetCost(tx,{jobId:job,operationId:`model:${reservation}`,costId:cost,expectedReceiptKey:receipt}));
  expect(await exposure()).toMatchObject({committedMicroUsd:2_700_000});
  await sql.transaction(tx=>linkJobBudgetCost(tx,{jobId:job,operationId:`model:${reservation}`,costId:cost,expectedReceiptKey:receipt}));
  expect(await exposure()).toMatchObject({committedMicroUsd:2_700_000});
  return {status:'pending'};
 });
 await releaseParent();
 expect(await exposure()).toMatchObject({committedMicroUsd:12_345});
 expect((await pg.query('SELECT micro_usd FROM costs')).rows).toHaveLength(1);
});
it('attaches the actual remediation target authorization and retains unknown money after release and cancellation',async()=>{
 const suite=makeSuite({jobId:job});
 const run=await executeSuite(suite,'baseline',{target:{send:async()=>({ok:true,text:'WRONG',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
 const binding={targetId:'target',targetVersion:'v1',environment:'test' as const};
 const scope:RemediationTargetScope={job:{jobId:job,customerId:customer,environment:'test',package:'trace_audit',quoteVersion:null,linkedRetestOf:null,isFixture:true},
 finding:{id:'finding',source:'text_eval',category:'instruction_violation',title:'Missing marker',summary:'READY missing',label:'confirmed',severity:'medium',basis:'objective',evidence:[{kind:'check',checkId:'S01.o1',detail:'Missing marker'}],investigatorNote:null,reproduction:null},
 binding,original:{suite,run,binding,failingCheckIds:['S01.o1']},trialId:'trial',endpoint:{kind:'stateless_chat_completions',isolation:'request_messages_only',url:'https://example.com/chat/completions',model:'fixture-model'}};
 const id=`remediation:${job}:target:fixture:S01`,req=request(id,2_700_000);
 req.scopes.push({key:`generic-text:fixture:${job}`,capMicroUsd:2_700_000});
 const transport={post:vi.fn(async()=>{throw Error('No transport authorized');})};
 const trial=createNaiveRemediationTrial({sql,scope,operationMicroUsd:req.amountMicroUsd,reservationScopes:req.scopes,assertCurrent:async()=>[],assertCurrentInTransaction:async tx=>{await lockJobBudget(tx,job);},resolveJudge:async()=>null,transport});
 await executeWorkflowStage({...input,stage:{key:'target-commitment',input:{},isPending:()=>true}},async()=>{
  expect(await trial.authorize({kind:'target',operationId:id,inputDigest:'a'.repeat(64)})).toBe(true);
  return {status:'pending'};
 });
 expect((await pg.query('SELECT operation_id,allowed,settlement,usage FROM remediation_accounting.operations')).rows).toEqual([{operation_id:id,allowed:true,settlement:null,usage:null}]);
 expect((await pg.query('SELECT operation_id,pending,reason FROM remediation_accounting.reconciliation_outbox')).rows).toEqual([{operation_id:id,pending:true,reason:'reserved'}]);
 expect((await pg.query('SELECT reservation_id FROM job_budget.stage_model_bindings')).rows).toEqual([{reservation_id:id}]);
 await releaseParent();
 await pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job]);
 expect(await exposure()).toMatchObject({committedMicroUsd:2_700_000});
 expect((await pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations WHERE id=$1',[id])).rows).toEqual([{settled_micro_usd:null}]);
 expect((await pg.query('SELECT * FROM costs')).rows).toHaveLength(0);expect(transport.post).not.toHaveBeenCalled();
});
it('completes the actual generic design with a 600k retained total allocation and exact four-slot envelope',async()=>{
 // This case loads the complete application schema and real generic method composition.
 await pg.close();pg=new PGlite();state.pg=pg;
 for(const file of readdirSync('packages/core/src/db/migrations').filter(f=>f.endsWith('.sql')).sort())await pg.exec(readFileSync(resolve('packages/core/src/db/migrations',file),'utf8'));
 for(const path of migrations)await pg.exec(readFileSync(resolve(path),'utf8'));
 const intake={package:'text_eval' as const,authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture-model',systemPrompt:'Follow explicit constraints.',referenceText:'Canonical grounding text.'}};
 const profile={policyId:'generic-text-v1' as const,designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1'};
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)',[customer,'offline@example.test']);
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb)`,[job,customer,JSON.stringify(intake)]);
 vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-model');vi.stubEnv('NAIVE_API_KEY','offline-key');vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 const scenarios=makeScenarios();
 const naive=new FakeNaive(body=>({pollsUntilDone:0,structuredOutput:body.metadata.ae_output==='text_design'?{scenarios}:{verdicts:scenarios.map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))}}));
 const stage=await naiveDesignRecoveryStage(job,intake,{generic:true,identity:{jobId:job,customerId:customer,environment:'test'},profile,sql});
 const costs:unknown[]=[];
 const result=await executeWorkflowStage({jobId:job,ownerId:customer,environment:'test',role:'engineer',share:.2,stage},async amount=>{
  const ctx:ServiceContext={jobId:job,environment:'test',budgetMicroUsd:amount,recordCost:async cost=>{costs.push(cost);},recordProgress:async()=>{}};
  const methods=await createNaiveTextMethods(ctx,{sql,executionProfile:profile,runnerFactory:ledger=>new AgentSessionService({naive:fenceWorkflowStageSessions(naive),store:new PostgresAgentTaskStore(sql),ledger,directory:Object.fromEntries(Object.entries(directory).map(([r,a])=>[r,{...a,agentVersion:1}])),budgetPeriodId:'fixture',idempotencyNamespace:'small-envelope-design',workerId:'fixture',maxWaitMs:0})});
  return methods.designSuite(ctx,intake);
 });
 expect(result).toMatchObject({ok:true,data:{versionLabel:'generic-text-v1',scenarios:expect.any(Array)}});
 expect(naive.createCalls).toHaveLength(2);expect(costs).toHaveLength(2);
 expect((await pg.query('SELECT * FROM job_budget.stage_model_bindings')).rows).toHaveLength(2);
 expect((await pg.query('SELECT released_at IS NOT NULL AS released FROM budget_reservations')).rows).toEqual([{released:true}]);
 expect(await exposure()).toMatchObject({committedMicroUsd:24_690});
 vi.unstubAllEnvs();
});
