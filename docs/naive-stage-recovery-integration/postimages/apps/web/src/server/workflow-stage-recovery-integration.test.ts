/** Offline composition fixture: real stage SQL, runner, task store and ledgers; fake provider only. */
import { PGlite } from '@electric-sql/pglite';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AgentSessionService } from '@ae/core/agents/session-service';
import { PostgresAgentTaskStore,type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import { FakeNaive,directory,fixtureJob } from '@ae/core/agents/__tests__/fakes';
import { executeWorkflowStage,currentWorkflowStageScope } from './workflow-stage-runtime';
import { fenceWorkflowStageSessions,fenceWorkflowStageRunner } from './workflow-stage-children';
const state=vi.hoisted(()=>({pg:undefined as PGlite|undefined,stepId:'first',attempt:0}));
vi.mock('workflow',()=>({getStepMetadata:()=>({stepId:state.stepId,attempt:state.attempt}),getWorkflowMetadata:()=>({workflowRunId:'fixture-run'}),RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:(sql:string,params?:unknown[])=>state.pg!.query(sql,params),release(){}};}}}));
let pg:PGlite;let sql:AgentTransactionalSql;
const job='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222';
const taskKey=`${job}:quality_investigator:resume_fixture:1`;
const input={jobId:job,ownerId:customer,environment:'test' as const,role:'investigator',share:.1,stage:{key:'strict-single-fixture',input:{revision:1},recovery:'naive-single-child-v1' as const,expectedChildKey:taskKey,isPending:(value:unknown)=>(value as {status:string}).status==='pending'}};
const migrations=[
 'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',
 'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql',
 'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql',
 'docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql',
];
beforeEach(async()=>{
 process.env.DATABASE_URL='postgres://offline-fixture';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 pg=new PGlite();state.pg=pg;state.stepId='first';state.attempt=0;
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,customer_id uuid,environment text,state text NOT NULL DEFAULT 'running',budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text);`);
 for(const path of migrations)await pg.exec(readFileSync(resolve(path),'utf8'));
 await pg.query('INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,$2,$3,$4)',[job,'trace_audit',customer,'test']);
 sql={query:(text,args)=>pg.query(text,args),transaction:fn=>pg.transaction(tx=>fn({query:(text,args)=>tx.query(text,args)}))};
});
afterEach(async()=>{await pg.close();});
function fixture(){
 const naive=new FakeNaive(()=>({structuredOutput:{answer:'retained'},pollsUntilDone:1}));
 const store=new PostgresAgentTaskStore(sql);
 const runner=fenceWorkflowStageRunner(new AgentSessionService({naive:fenceWorkflowStageSessions(naive),store,ledger:new SharedJobBudgetLedger(sql),directory,budgetPeriodId:'fixture',idempotencyNamespace:'offline-test',workerId:'worker',maxWaitMs:0}));
 const spec={job:fixtureJob({jobId:job,customerId:customer}),role:'quality_investigator' as const,purpose:'resume_fixture',message:'Return a JSON answer.',output:{name:'fixture.v1',schema:z.object({answer:z.string()})},budgetMicroUsd:100_000};
 return {naive,store,run:()=>runner.run(spec)};
}
it('resumes pending stage in a later SDK step through the same durable task and provider session, then replays completion',async()=>{
 const f=fixture();const generations:number[]=[];
 const callback=vi.fn(async()=>{generations.push(currentWorkflowStageScope()!.owner.generation);return f.run();});
 const first=await executeWorkflowStage(input,callback);expect(first).toMatchObject({ok:true,data:{status:'pending'}});
 const retained=await f.store.get(taskKey);expect(retained).toMatchObject({state:'created',sessionId:'ses_fake_1'});
 expect((await pg.query('SELECT state,recovery_profile,expected_child_key FROM workflow_stage.stages')).rows[0]).toEqual({state:'pending',recovery_profile:'naive-single-child-v1',expected_child_key:taskKey});
 state.stepId='later-poll';const second=await executeWorkflowStage(input,callback);
 expect(second).toMatchObject({ok:true,data:{status:'completed',output:{answer:'retained'},session:{sessionId:'ses_fake_1'}}});
 expect(generations).toEqual([1,2]);expect(f.naive.createCalls).toHaveLength(1);
 expect((await pg.query('SELECT * FROM agent_persistence.tasks')).rows).toHaveLength(1);
 expect((await pg.query('SELECT * FROM budget_reservations')).rows).toHaveLength(1);
 expect((await pg.query('SELECT state FROM workflow_stage.stages')).rows[0]).toEqual({state:'completed'});
 state.stepId='acknowledgement-retry';expect(await executeWorkflowStage(input,callback)).toEqual(second);expect(callback).toHaveBeenCalledTimes(2);expect(f.naive.createCalls).toHaveLength(1);
});
it('recovers an interrupted strict stage with no child and authorizes exactly its bound first task',async()=>{
 const interrupted=new Error('interrupted before runner');await expect(executeWorkflowStage(input,async()=>{throw interrupted;})).rejects.toBe(interrupted);
 expect((await pg.query('SELECT * FROM workflow_stage.children')).rows).toHaveLength(0);
 await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second'");
 state.stepId='restart';const f=fixture();
 expect(await executeWorkflowStage(input,async()=>{expect(currentWorkflowStageScope()!.owner.generation).toBe(2);return f.run();})).toMatchObject({ok:true,data:{status:'pending'}});
 expect(f.naive.createCalls).toHaveLength(1);
 expect((await pg.query('SELECT operation_key FROM workflow_stage.children')).rows).toEqual([{operation_key:taskKey}]);
 expect((await pg.query('SELECT * FROM budget_reservations')).rows).toHaveLength(1);
});
it('retains the parent hold when an unknown-usage child is hidden behind a normal fallback result',async()=>{
 const f=fixture();f.naive.setScript(()=>({pollsUntilDone:0,consumedMicroUsd:-1,structuredOutput:{answer:'ignored'}}));
 const fallback=vi.fn(async()=>{expect(await f.run()).toMatchObject({status:'needs_operator',code:'invalid_session_usage'});return {answer:'application fallback'};});
 await expect(executeWorkflowStage(input,fallback)).rejects.toThrow('Workflow stage recovery_required');
 expect((await pg.query('SELECT state,result_ciphertext FROM workflow_stage.stages')).rows[0]).toEqual({state:'pending',result_ciphertext:null});
 expect((await pg.query('SELECT released_at FROM budget_reservations')).rows).toEqual([{released_at:null}]);
 expect(await f.store.get(taskKey)).toMatchObject({state:'needs_operator',consumedMicroUsd:null});
 state.stepId='reconcile-later';await expect(executeWorkflowStage(input,fallback)).rejects.toThrow('Workflow stage recovery_required');
 expect(fallback).toHaveBeenCalledOnce();expect(f.naive.createCalls).toHaveLength(1);
 expect((await pg.query('SELECT * FROM budget_reservations')).rows).toHaveLength(1);
});
it('allows application fallback after a measured terminal failure without a replacement provider session',async()=>{
 const f=fixture();f.naive.setScript(()=>({pollsUntilDone:0,status:'failed',stopReason:'error',stopCode:'fixture_failure',structuredOutput:null}));
 const fallback=vi.fn(async()=>{expect(await f.run()).toMatchObject({status:'failed',code:'fixture_failure'});return {answer:'measured failure fallback'};});
 expect(await executeWorkflowStage(input,fallback)).toEqual({ok:true,data:{answer:'measured failure fallback'}});
 expect(await f.store.get(taskKey)).toMatchObject({state:'failed',consumedMicroUsd:12_345});
 expect((await pg.query('SELECT state FROM workflow_stage.stages')).rows[0]).toEqual({state:'completed'});
 expect((await pg.query('SELECT released_at IS NOT NULL AS released FROM budget_reservations')).rows).toEqual([{released:true}]);
 state.stepId='replay-fallback';await executeWorkflowStage(input,fallback);expect(fallback).toHaveBeenCalledOnce();expect(f.naive.createCalls).toHaveLength(1);
});
