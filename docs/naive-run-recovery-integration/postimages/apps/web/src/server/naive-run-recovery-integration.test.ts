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
import {naiveRunRecoveryStage} from './naive-run-recovery';
import {naiveDesignRecoveryStage} from './naive-design-recovery';
import {executeWorkflowStage,currentWorkflowStageScope} from './workflow-stage-runtime';
import {fenceWorkflowStageSessions} from './workflow-stage-children';
import {fenceWorkflowDesignCheckpoints} from './workflow-design-checkpoints';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
const state=vi.hoisted(()=>({pg:undefined as PGlite|undefined,stepId:'first',crashAfterTarget:false}));
vi.mock('workflow',()=>({getStepMetadata:()=>({stepId:state.stepId,attempt:0}),getWorkflowMetadata:()=>({workflowRunId:'design-fixture'}),FatalError:class extends Error{},RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:async(sql:string,params?:unknown[])=>{const result=await state.pg!.query(sql,params);if(sql==='COMMIT'&&state.crashAfterTarget){state.crashAfterTarget=false;throw Error('process lost after target committed');}return result;},release(){}};}}}));
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
 'docs/naive-budget-envelope-integration/sql/001-stage-model-envelopes.sql',
 'packages/core/src/judges/migrations/001-proxy-dispatch.sql',
 'docs/naive-run-recovery-integration/sql/001-run-recovery.sql',
 'docs/naive-run-recovery-integration/sql/002-run-checkpoint-ownership.sql',
];
beforeEach(async()=>{
 vi.stubEnv('DATABASE_URL','postgres://offline-design-fixture');vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY',Buffer.alloc(32,7).toString('base64'));
 vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-model');vi.stubEnv('NAIVE_API_KEY','offline-proxy-key');vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 pg=new PGlite();state.pg=pg;state.stepId='first';state.crashAfterTarget=false;
 const dir='packages/core/src/db/migrations';
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pg.exec(readFileSync(resolve(dir,file),'utf8'));
 for(const file of migrationFiles)await pg.exec(readFileSync(resolve(file),'utf8'));
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)',[customer,'offline@example.test']);
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb)`,[job,customer,JSON.stringify(intake)]);
 sql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
});
afterEach(async()=>{await pg.close();vi.unstubAllEnvs();});
async function fixture(){
 const scenarios=makeScenarios();scenarios[0]!.rubricChecks=[{id:'S01.r1',kind:'rubric',description:'Reference meaning',rubric:'Accurately reflects the supplied reference.',assessesFactualCorrectness:true,requiresReference:true}];const naive=new FakeNaive(body=>({pollsUntilDone:1,structuredOutput:body.metadata.ae_output==='text_design'?{scenarios}:{verdicts:scenarios.map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))}}));
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
 return {naive,stage,input,callback,generations,recordCost};
}

it.each(['recover','uncertain','cancel','changed-suite','changed-target','stale-owner'] as const)('reconstructs objects after target commit acknowledgement loss and fences %s through real SQL',async mode=>{
 const f=await fixture();
 let designed:any;
 for(let i=0;i<3;i++){state.stepId=`design-${i}`;try{const result=await executeWorkflowStage(f.input,f.callback);if(result.ok)designed=result.data;}catch(error){if(!(error instanceof TrackBPendingError))throw error;}}
 expect(designed).toBeTruthy();
 await pg.query("UPDATE jobs SET state='running' WHERE id=$1",[job]);
 vi.stubEnv('NAIVE_JUDGE_ATTEMPTS','1');
 const targetCalls=vi.fn(async()=>{if(mode==='uncertain')throw Error('connection lost after dispatch');return {choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}]};});
 const selected={generic:true as const,identity:{jobId:job,customerId:customer,environment:'test' as const},profile,sql};
 const target={url:intake.endpoint.url,model:intake.endpoint.model,systemPrompt:intake.endpoint.systemPrompt};
 const stage=await naiveRunRecoveryStage(job,designed,target,'endpoint','default',undefined,selected);
 if(mode==='changed-suite'){
  const changed=structuredClone(designed);changed.scenarios[0].title='Changed after admission';
  await expect(naiveRunRecoveryStage(job,changed,target,'endpoint','default',undefined,selected)).rejects.toThrow();expect(targetCalls).not.toHaveBeenCalled();return;
 }
 if(mode==='changed-target'){
  await pg.query("UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,model}','\"changed-model\"') WHERE id=$1",[job]);
  await expect(naiveRunRecoveryStage(job,designed,target,'endpoint','default',undefined,selected)).rejects.toThrow();expect(targetCalls).not.toHaveBeenCalled();return;
 }
 let priorScope:ReturnType<typeof currentWorkflowStageScope>;
 const input={jobId:job,ownerId:customer,environment:'test' as const,role:'judge',share:.4,stage};
 const proxyBodies=new Map<string,any>();let proxySequence=0;
 const proxyFetch=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input),text=JSON.stringify({outcome:'passed',explanation:'Fixture judged the exact response.',evidenceQuotes:['READY']});
  if(url.includes('/anthropic/v1/messages')){const body=JSON.parse(String(init?.body));const id=`req_${String(++proxySequence).padStart(26,'0')}`;proxyBodies.set(id,body);return Response.json({id,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}});}
  const id=url.split('/').at(-1)!,body=proxyBodies.get(id);if(!body)throw Error('unknown fixture proxy trace');
  return Response.json({id,object:'proxy_call_trace',dialect:'anthropic',actor:{type:'system',id:'fixture'},model:body.model,window:'immediate',resolved_model:body.model,provider:'fixture',generation_id:null,stop:'end_turn',usage:{input:1,output:2,cache_read:0,cache_write:0,reasoning:0},billed_micro_usd:5,vendor_cost_micro_usd:null,duration_ms:1,content_scope:'full',source:'proxy',session_id:null,seq:null,board_card_id:null,tool_call_ids:[],tool_schema_hash:null,request_sha256:'a'.repeat(64),response_sha256:'b'.repeat(64),request_bytes:1,response_bytes:1,request:{model:body.model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages},response:{text,tool_calls:[]},truncated:false,created_at:'2026-11-07T20:00:00.000Z',expires_at:null});
 });
 const reconstructed=async()=>{
  const renewedStage=await naiveRunRecoveryStage(job,designed,target,'endpoint','default',undefined,selected);
  return executeWorkflowStage({...input,stage:renewedStage},async amount=>{
   priorScope??=currentWorkflowStageScope();
   const ctx:ServiceContext={jobId:job,environment:'test',budgetMicroUsd:amount,recordCost:f.recordCost,recordProgress:async()=>{}};
   const methods=await createNaiveTextMethods(ctx,{sql,executionProfile:profile,runnerFactory:ledger=>new AgentSessionService({naive:fenceWorkflowStageSessions(f.naive),store:new PostgresAgentTaskStore(sql),ledger,directory,budgetPeriodId:'fixture',idempotencyNamespace:'design-fixture',workerId:'new-process',maxWaitMs:0}),proxyFetch,targetTransport:{post:targetCalls}});
   return methods.runSuite(ctx,designed,target);
  });
 };
 const complete=PostgresTextCheckpointStore.prototype.complete;
 let crashed=false;
 const spy=vi.spyOn(PostgresTextCheckpointStore.prototype,'complete').mockImplementation(async function(...args){
  await complete.apply(this,args);
  if(args[0].kind==='target'&&!crashed){crashed=true;state.crashAfterTarget=true;}
 });
 state.stepId='run-owner-one';await expect(reconstructed()).rejects.toThrow();spy.mockRestore();
 expect(targetCalls).toHaveBeenCalledTimes(1);
 if(mode==='uncertain'){
  expect((await pg.query("SELECT state FROM text_integration.checkpoints WHERE kind='target'")).rows).toEqual([{state:'ambiguous'}]);
  await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second' WHERE stage_key=$1",[stage.key]);
  state.stepId='uncertain-reconstruction';await expect(reconstructed()).rejects.toThrow();expect(targetCalls).toHaveBeenCalledTimes(1);expect(proxySequence).toBe(0);return;
 }
 expect(crashed).toBe(true);
 if(mode==='cancel'){
  await pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job]);state.stepId='cancel-reconstruction';
  await expect(reconstructed()).rejects.toThrow();expect(targetCalls).toHaveBeenCalledTimes(1);expect(proxySequence).toBe(0);return;
 }
 expect((await pg.query("SELECT state FROM text_integration.checkpoints WHERE kind='target'")).rows).toEqual([{state:'completed'}]);
 await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second' WHERE stage_key=$1",[stage.key]);
 state.stepId='run-owner-two';try{await reconstructed();}catch{}
 expect(targetCalls).toHaveBeenCalledTimes(designed.scenarios.length);
 expect((await pg.query("SELECT count(*)::int AS n FROM text_integration.checkpoints WHERE kind='run_result' AND state='completed'")).rows[0]).toEqual({n:1});
 expect((await pg.query("SELECT generation,state FROM workflow_stage.stages WHERE stage_key=$1",[stage.key])).rows).toMatchObject([{generation:2,state:'pending'}]);
 if(mode==='stale-owner')await expect(priorScope!.transaction(async()=>{throw Error('stale callback executed');})).rejects.toThrow(/revoked|closing/);
 expect(proxySequence).toBe(1);expect((await pg.query('SELECT state FROM naive_proxy_dispatch.attempts')).rows).toEqual([{state:'dispatched'}]);
 expect((await pg.query("SELECT released_at IS NULL AS held FROM budget_reservations WHERE agent='judge'")).rows).toEqual([{held:true}]);
 expect((await pg.query("SELECT count(*)::int AS n FROM costs WHERE source='naive_proxy'")).rows).toEqual([{n:1}]);
 state.stepId='run-owner-three';try{await reconstructed();}catch{}
 expect(targetCalls).toHaveBeenCalledTimes(designed.scenarios.length);
 expect((await pg.query("SELECT count(*)::int AS n FROM text_integration.checkpoints WHERE kind='run_result' AND state='completed'")).rows[0]).toEqual({n:1});
},60000);
