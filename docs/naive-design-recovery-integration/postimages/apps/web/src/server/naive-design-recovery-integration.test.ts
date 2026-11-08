/** Offline composition: real stage/task/checkpoint/admission SQL and adapters; fake provider/Workflow/Pool only. */
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {AgentSessionService} from '@ae/core/agents/session-service';
import {PostgresAgentTaskStore,type AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {FakeNaive,directory} from '@ae/core/agents/__tests__/fakes';
import {makeScenarios} from '@ae/core/evals/text/__tests__/fixtures';
import type {ServiceContext} from '@ae/core/contracts/services';
import {TrackBPendingError} from '@ae/core/evals/service-adapter';
import {createNaiveTextMethods} from './naive-text-methods';
import {naiveDesignRecoveryStage} from './naive-design-recovery';
import {executeWorkflowStage,currentWorkflowStageScope} from './workflow-stage-runtime';
import {fenceWorkflowStageSessions} from './workflow-stage-children';
import {fenceWorkflowDesignCheckpoints} from './workflow-design-checkpoints';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
const state=vi.hoisted(()=>({pg:undefined as PGlite|undefined,stepId:'first'}));
vi.mock('workflow',()=>({getStepMetadata:()=>({stepId:state.stepId,attempt:0}),getWorkflowMetadata:()=>({workflowRunId:'design-fixture'}),FatalError:class extends Error{},RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:(sql:string,params?:unknown[])=>state.pg!.query(sql,params),release(){}};}}}));
let pg:PGlite,sql:AgentTransactionalSql;
const job='a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6',customer='b1c2d3e4-f5a6-47b8-9c0d-e1f2a3b4c5d6';
const intake={package:'text_eval' as const,authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture-model',systemPrompt:'Follow explicit constraints.',referenceText:'Canonical grounding text.'}};
const profile={policyId:'generic-text-v1' as const,designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1'};
const migrationFiles=[
 'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',
 'packages/core/src/evals/integration/migrations/001-text-integration.sql',
 'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql',
 'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql',
 'docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql',
 'docs/naive-cancellation-integration/sql/001-job-cancellation.sql',
 'docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql',
 'docs/naive-design-recovery-integration/sql/002-design-checkpoint-ownership.sql',
];
beforeEach(async()=>{
 vi.stubEnv('DATABASE_URL','postgres://offline-design-fixture');vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY',Buffer.alloc(32,7).toString('base64'));
 vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-model');vi.stubEnv('NAIVE_API_KEY','offline-proxy-key');vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 pg=new PGlite();state.pg=pg;state.stepId='first';
 const dir='packages/core/src/db/migrations';
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pg.exec(readFileSync(resolve(dir,file),'utf8'));
 for(const file of migrationFiles)await pg.exec(readFileSync(resolve(file),'utf8'));
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)',[customer,'offline@example.test']);
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb)`,[job,customer,JSON.stringify(intake)]);
 sql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
});
afterEach(async()=>{await pg.close();vi.unstubAllEnvs();});
async function fixture(){
 const scenarios=makeScenarios();const naive=new FakeNaive(body=>({pollsUntilDone:1,structuredOutput:body.metadata.ae_output==='text_design'?{scenarios}:{verdicts:scenarios.map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))}}));
 const stage=await naiveDesignRecoveryStage(job,intake,{generic:true,identity:{jobId:job,customerId:customer,environment:'test'},profile,sql});
 const input={jobId:job,ownerId:customer,environment:'test' as const,role:'engineer',share:.4,stage};
 const recordCost:ServiceContext['recordCost']=async cost=>{await pg.query(`INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta,receipt_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,[job,cost.source,cost.agent??null,cost.sessionId??null,cost.microUsd,JSON.stringify(cost.meta??{}),String(cost.meta?.idempotencyKey)]);};
 const generations:number[]=[];
 const callback=vi.fn(async(amount:number)=>{
 generations.push(currentWorkflowStageScope()!.owner.generation);
 const ctx:ServiceContext={jobId:job,environment:'test',budgetMicroUsd:amount,recordCost,recordProgress:async()=>{}};
 const api=await createNaiveTextMethods(ctx,{sql,executionProfile:profile,runnerFactory:ledger=>new AgentSessionService({naive:fenceWorkflowStageSessions(naive),store:new PostgresAgentTaskStore(sql),ledger,directory:Object.fromEntries(Object.entries(directory).map(([r,a])=>[r,{...a,agentVersion:1}])),budgetPeriodId:'fixture',idempotencyNamespace:'design-fixture',workerId:'reconstructed',maxWaitMs:0})});
 return api.designSuite(ctx,intake);
 });
 return {naive,stage,input,callback,generations};
}
it('continues pending engineer then reviewer through three owned generations, admits and replays exactly two sessions',async()=>{
 const f=await fixture();
 await expect(executeWorkflowStage(f.input,f.callback)).rejects.toBeInstanceOf(TrackBPendingError);
 expect(f.naive.createCalls).toHaveLength(1);
 state.stepId='reviewer';await expect(executeWorkflowStage(f.input,f.callback)).rejects.toBeInstanceOf(TrackBPendingError);
 expect(f.naive.createCalls).toHaveLength(2);
 state.stepId='complete';const completed=await executeWorkflowStage(f.input,f.callback);expect(completed).toMatchObject({ok:true,data:{versionLabel:'generic-text-v1',scenarios:expect.any(Array)}});
 expect(f.generations).toEqual([1,2,3]);expect(f.naive.createCalls).toHaveLength(2);
 expect((await pg.query(`SELECT state FROM workflow_stage.stages`)).rows).toEqual([{state:'completed'}]);
 expect((await pg.query(`SELECT value->>'status' AS status FROM text_integration.checkpoints WHERE kind='naive_admission'`)).rows).toEqual([{status:'approved'}]);
 state.stepId='completion-ack-retry';expect(await executeWorkflowStage(f.input,f.callback)).toEqual(completed);expect(f.callback).toHaveBeenCalledTimes(3);expect(f.naive.createCalls).toHaveLength(2);
 expect((await pg.query('SELECT count(*)::int AS n FROM agent_persistence.tasks')).rows[0]).toEqual({n:2});
 expect((await pg.query('SELECT count(*)::int AS n FROM workflow_stage.children')).rows[0]).toEqual({n:2});
 expect((await pg.query('SELECT released_at IS NOT NULL AS released FROM budget_reservations')).rows).toEqual([{released:true}]);
 expect((await pg.query('SELECT count(*)::int AS n FROM costs')).rows[0]).toEqual({n:2});
},60000);
it('recovers an interrupted outer design claim only after stage lease expiry, then completes without replacement sessions',async()=>{
 const f=await fixture(),plan=f.stage.expectedChildPlan!;
 const interrupted=new Error('crash after outer design claim');
 await expect(executeWorkflowStage(f.input,async()=>{const store=fenceWorkflowDesignCheckpoints(new PostgresTextCheckpointStore(sql));expect(await store.claim({jobId:job,kind:'design',id:plan.outerDesignId,inputDigest:plan.inputDigest})).toMatchObject({state:'claimed'});throw interrupted;})).rejects.toBe(interrupted);
 expect((await pg.query('SELECT kind,generation FROM workflow_stage.design_checkpoints')).rows).toEqual([{kind:'design',generation:1}]);
 state.stepId='too-early';await expect(executeWorkflowStage(f.input,f.callback)).rejects.toThrow();expect(f.callback).not.toHaveBeenCalled();
 await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second'");
 state.stepId='recovered';await expect(executeWorkflowStage(f.input,f.callback)).rejects.toBeInstanceOf(TrackBPendingError);
 state.stepId='reviewer';await expect(executeWorkflowStage(f.input,f.callback)).rejects.toBeInstanceOf(TrackBPendingError);
 state.stepId='completed';expect(await executeWorkflowStage(f.input,f.callback)).toMatchObject({ok:true,data:{versionLabel:'generic-text-v1'}});
 expect(f.generations).toEqual([2,3,4]);expect(f.naive.createCalls).toHaveLength(2);
 expect((await pg.query("SELECT state FROM text_integration.checkpoints WHERE kind='design'")).rows).toEqual([{state:'completed'}]);
 state.stepId='recovered-ack-retry';await executeWorkflowStage(f.input,f.callback);expect(f.callback).toHaveBeenCalledTimes(3);expect(f.naive.createCalls).toHaveLength(2);
},60000);
