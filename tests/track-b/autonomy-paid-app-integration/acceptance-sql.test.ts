/** Offline acceptance of applied app sources, real SQL transactions, scripted provider only. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {it,expect,vi} from 'vitest';
import {z} from 'zod';
import {createAutonomousPaidContext,runAutonomousTarget} from '@/server/autonomous-paid';
import {createTrustedJudgeResolver,workflowJudgeRuntime} from '@/server/rich-judge';
import {JudgeAccounting} from '@/server/judge-accounting';
import {deliverRemediationCost} from '@/server/rich-remediation';
import {createAutonomousBudgetLedger} from '@ae/core/agents/autonomy/budget';
import {autonomyDigest,createAutonomousPolicy} from '@ae/core/agents/autonomy/policy';
import {AgentSessionService} from '@ae/core/agents/session-service';
import {PostgresBudgetLedger,PostgresAgentTaskStore,type AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {FakeNaive,directory} from '@ae/core/agents/__tests__/fakes';

const stage=process.env.WORKFLOW_STAGE!;
const judgment={operationId:'run-1:scenario-1:rubric-1',rubric:'Use supplied reference.',response:'READY',reference:'READY is required.',assessesFactualCorrectness:true};
const envelope=()=>new Response(JSON.stringify({id:'scripted-offline-provider',choices:[{finish_reason:'stop',message:{content:JSON.stringify({outcome:'passed',explanation:'Matches reference.',evidenceQuotes:['READY']})}}],usage:{prompt_tokens:9,completion_tokens:4}}));
async function fixture(){
 const engine=new PGlite();let tail:Promise<unknown>=Promise.resolve();
 const serial=<T>(f:()=>Promise<T>)=>{const p=tail.then(f);tail=p.catch(()=>{});return p;};
 const sql:AgentTransactionalSql={query:(s,p)=>serial(()=>engine.query(s,p)),transaction:fn=>serial(()=>engine.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)})))};
 for(const p of ['agents/persistence-migrations/001-agent-persistence.sql','evals/integration/migrations/001-text-integration.sql','evals/remediation/accounting/001-remediation-accounting.sql'])await engine.exec(readFileSync(join(stage,'packages/core/src',p),'utf8'));
 await engine.exec(readFileSync(join(stage,'apps/web/src/server/autonomous-paid.sql'),'utf8'));
 await engine.exec('CREATE SCHEMA workflow_integration;CREATE TABLE workflow_integration.cost_keys(job_id text,key text PRIMARY KEY,payload jsonb);CREATE TABLE workflow_integration.provider_costs(job_id text,key text PRIMARY KEY,source text,operation_id text,receipt_id text,micro_usd bigint);');
 const policy=createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'paid_test',enabled:true,rootBudgetMicroUsd:400,singleJobCapMicroUsd:200,comparisonJobCapMicroUsd:200,roleCapsMicroUsd:{commercial:100,evaluation_engineer:100,quality_investigator:100,company_operator:100},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
 const job={jobId:'paid-job',customerId:'tenant',package:'text_eval' as const,environment:'test' as const,isFixture:true,quoteVersion:null,linkedRetestOf:null};
 let allowed=true;
 const guard=vi.fn(async()=>{if(!allowed)throw Error('authority revoked');});
 const naive=new FakeNaive(()=>({consumedMicroUsd:15,structuredOutput:{answer:'ok'}}));
 const runner=new AgentSessionService({naive,store:new PostgresAgentTaskStore(sql),ledger:createAutonomousBudgetLedger(new PostgresBudgetLedger(sql),policy),directory,budgetPeriodId:policy.periodId,workerId:'offline-worker',idempotencyNamespace:'paid-test',maxWaitMs:0});
 const verifyReceipt=vi.fn(async()=>true);
 const makeContext=()=>createAutonomousPaidContext({sql,policy,job,runner,guard,jobCapMicroUsd:200,targetReservationMicroUsd:40,judgeReservationMicroUsd:40,deliverCost:deliverRemediationCost,verifyReceipt});
 const context=makeContext();
 const fetcher=vi.fn<typeof fetch>(async()=>envelope());
 const meter=vi.fn(async()=>{});
 const deps={sql,checkpoints:new PostgresTextCheckpointStore(sql),canonical:async()=>({job,knownSecrets:[] as string[],targetVersion:'v1'}),policy:{model:'fixture/model',configVersion:'v1',privateKeyRef:'fixture-ref',reservationMicroUsd:40,periodId:policy.periodId,auth:'api_key' as const},runtime:{signal:new AbortController().signal,token:async()=> 'scripted-offline-key',beforeDispatch:meter,fetch:fetcher},deliverCost:deliverRemediationCost,autonomous:context};
 const target=vi.fn(async()=>({ok:true as const,text:'READY',latencyMs:1}));
 const targetInput={operationId:'baseline:run-1:scenario-1',input:{runId:'run-1',scenarioId:'scenario-1'},job};
 const spec=(purpose:string)=>({job,role:'evaluation_engineer' as const,purpose,message:'Return JSON',output:{name:'offline.v1',schema:z.object({answer:z.string()})},budgetMicroUsd:20,jobCapMicroUsd:200});
 return {engine,sql,policy,job,guard,verifyReceipt,naive,runner,context,makeContext,deps,fetcher,meter,target,targetInput,spec,revoke:()=>{allowed=false;}};
}
it('actual Naive session, baseline target and Gateway judge share identical SQL root/role/job caps',async()=>{
 const f=await fixture();try{
  expect((await f.runner.run(f.spec('design'))).status).toBe('completed');
  await runAutonomousTarget(f.context,f.targetInput,f.target);
  await createTrustedJudgeResolver(f.deps)(judgment);
  const rows=(await f.sql.query<{scopes:Array<{key:string;capMicroUsd:number}>;amount_micro_usd:number;settled_micro_usd:number|null}>('SELECT * FROM agent_persistence.reservations')).rows;
  expect(rows).toHaveLength(3);
  for(const r of rows){expect(r.scopes).toContainEqual({key:'job:paid-job',capMicroUsd:200});expect(r.scopes).toContainEqual({key:'agent:evaluation_engineer:paid_test',capMicroUsd:100});expect(r.scopes).toContainEqual({key:'autonomous-root:tenant:paid_test',capMicroUsd:400});}
  expect(rows.filter(r=>r.settled_micro_usd===null)).toHaveLength(2);
  expect((await f.runner.run(f.spec('after-unknown-holds'))).status).toBe('budget_exhausted');
  expect(f.naive.createCalls).toHaveLength(1);expect(f.fetcher).toHaveBeenCalledOnce();expect(f.target).toHaveBeenCalledOnce();
  expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(0);
 }finally{await f.engine.close();}
},30000);
it('lost target reply retains money and permanent fence after reconstructing the context',async()=>{
 const f=await fixture();try{
  f.target.mockRejectedValue(Error('reply lost'));
  await expect(runAutonomousTarget(f.context,f.targetInput,f.target)).rejects.toThrow();
  await expect(runAutonomousTarget(f.makeContext(),f.targetInput,f.target)).rejects.toThrow();
  expect(f.target).toHaveBeenCalledOnce();
  const rows=(await f.sql.query<{settled_micro_usd:number|null}>('SELECT * FROM agent_persistence.reservations')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].settled_micro_usd).toBeNull();
 }finally{await f.engine.close();}
},30000);
it('permanent target identity refuses changed input and never emits the target again',async()=>{
 const f=await fixture();try{
  await runAutonomousTarget(f.context,f.targetInput,f.target);
  await expect(runAutonomousTarget(f.makeContext(),{...f.targetInput,input:{runId:'run-1',scenarioId:'changed'}},f.target)).rejects.toThrow();
  expect(f.target).toHaveBeenCalledOnce();
 }finally{await f.engine.close();}
},30000);
it('paid context binds tenant/job/SQL and revocation blocks target and judge before dispatch',async()=>{
 const f=await fixture();try{
  await expect(f.context.guard({...f.job,customerId:'attacker'},f.sql)).rejects.toThrow();
  await expect(f.context.guard(f.job,{...f.sql})).rejects.toThrow();
  f.revoke();
  await expect(runAutonomousTarget(f.context,f.targetInput,f.target)).rejects.toThrow();
  await expect(createTrustedJudgeResolver(f.deps)(judgment)).rejects.toThrow();
  expect(f.target).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();
 }finally{await f.engine.close();}
},30000);
it('Gateway unknown receipt holds, keyed authoritative settlement replays once and conflicts reject',async()=>{
 const f=await fixture();try{
  await createTrustedJudgeResolver(f.deps)(judgment);
  const op=(await f.sql.query<{operation_id:string;input_digest:string}>('SELECT operation_id,input_digest FROM remediation_accounting.operations')).rows[0];
  const accounting=new JudgeAccounting({sql:f.sql,jobId:f.job.jobId,reservation:()=>{throw Error('reconciliation never reserves');},deliverCost:deliverRemediationCost});
  const receipt={operationId:op.operation_id,inputDigest:op.input_digest,receiptId:'retained-scripted-receipt',usage:{promptTokens:9,completionTokens:4,totalTokens:13},microUsd:null as number|null};
  await accounting.reconcile(receipt);
  expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(1);
  await accounting.reconcile({...receipt,microUsd:7});await accounting.reconcile({...receipt,microUsd:7});
  expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(1);
  await expect(accounting.reconcile({...receipt,microUsd:8})).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledOnce();
 }finally{await f.engine.close();}
},30000);
it('explicit legacy judge mode retains existing two-scope accounting and permanent ambiguity fence',async()=>{
 const f=await fixture();try{
  const {autonomous:_,...legacy}=f.deps;f.fetcher.mockRejectedValue(Error('legacy reply lost'));
  await expect(createTrustedJudgeResolver(legacy)(judgment)).rejects.toThrow();
  await expect(createTrustedJudgeResolver(legacy)(judgment)).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledOnce();
  const rows=(await f.sql.query<{scopes:Array<{key:string}>}>('SELECT scopes FROM agent_persistence.reservations')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].scopes).toHaveLength(2);expect(rows[0].scopes.some(s=>s.key.startsWith('autonomous-root:'))).toBe(false);
 }finally{await f.engine.close();}
},30000);
it('monitoring Gateway phase retains explicit limits and acceptance meter cannot be bypassed',async()=>{
 const old=process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS;
 try{process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS=JSON.stringify({monitoring:1});const rt=workflowJudgeRuntime('monitoring');await rt.beforeDispatch({kind:'gateway',operationId:'first'});await expect(rt.beforeDispatch({kind:'gateway',operationId:'second'})).rejects.toThrow();}
 finally{if(old===undefined)delete process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS;else process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS=old;}
});

it('target reconciliation verifies retained receipt and atomically delivers exactly one keyed cost',async()=>{
 const f=await fixture();try{
  await runAutonomousTarget(f.context,f.targetInput,f.target);
  const receipt={operationId:f.targetInput.operationId,inputDigest:autonomyDigest({job:f.job,input:f.targetInput.input,policy:f.context.policy}),receiptId:'retained-provider-evidence',microUsd:null as number|null,evidence:{providerId:'offline-provider-receipt'}};
  f.verifyReceipt.mockResolvedValue(false);await expect(f.context.reconcile(receipt)).rejects.toThrow();
  f.verifyReceipt.mockResolvedValue(true);await f.context.reconcile(receipt);
  expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(1);
  await f.context.reconcile({...receipt,microUsd:7});await f.makeContext().reconcile({...receipt,microUsd:7});
  const costs=(await f.sql.query<{key:string}>('SELECT * FROM workflow_integration.provider_costs')).rows;
  expect(costs).toHaveLength(1);expect(costs[0].key).toBe('autonomous-target:'+f.targetInput.operationId);
  await expect(f.context.reconcile({...receipt,microUsd:8})).rejects.toThrow();
  expect(f.target).toHaveBeenCalledOnce();
 }finally{await f.engine.close();}
},30000);
it('monitoring target and judge share an additional immutable per-tick ceiling',async()=>{
 const f=await fixture();try{
  const monitor={key:'monitor:subscription:tick',capMicroUsd:60};
  await runAutonomousTarget(f.context,{...f.targetInput,monitor},f.target);
  await expect(createTrustedJudgeResolver({...f.deps,monitor})(judgment)).rejects.toThrow();
  expect(f.target).toHaveBeenCalledOnce();expect(f.fetcher).not.toHaveBeenCalled();
  const rows=(await f.sql.query<{scopes:Array<{key:string;capMicroUsd:number}>}>('SELECT scopes FROM agent_persistence.reservations')).rows;
  expect(rows).toHaveLength(2);for(const row of rows)expect(row.scopes).toContainEqual(monitor);
 }finally{await f.engine.close();}
},30000);
it('enabled context cannot be cloned or raise a pinned Naive job cap, and lower-level runner is guarded',async()=>{
 const f=await fixture();try{
  await expect(runAutonomousTarget({...f.context},f.targetInput,f.target)).rejects.toThrow();
  expect(()=>f.context.runnerForMonitor({key:'monitor:subscription:tick',capMicroUsd:60})).toThrow();
  await expect(f.context.runner.run({...f.spec('cap-change'),jobCapMicroUsd:201})).rejects.toThrow();
  const foreign={...f.spec('tenant-change'),job:{...f.job,customerId:'attacker'}};
  await expect(f.context.runner.run(foreign)).rejects.toThrow();
  f.revoke();await expect(f.context.runner.run(f.spec('revoked'))).rejects.toThrow();
  expect(f.naive.createCalls).toHaveLength(0);expect(f.target).not.toHaveBeenCalled();
 }finally{await f.engine.close();}
},30000);
it('target budget denial is permanently retained even when other SQL holds later settle',async()=>{
 const f=await fixture();try{
  const ledger=createAutonomousBudgetLedger(new PostgresBudgetLedger(f.sql),f.policy);
  expect((await ledger.reserve({reservationId:'existing-session-hold',jobId:f.job.jobId,amountMicroUsd:100,scopes:[{key:`job:${f.job.jobId}`,capMicroUsd:200},{key:'agent:evaluation_engineer:paid_test',capMicroUsd:100}]})).ok).toBe(true);
  await expect(runAutonomousTarget(f.context,f.targetInput,f.target)).rejects.toThrow();
  await ledger.settle('existing-session-hold',0);
  await expect(runAutonomousTarget(f.makeContext(),f.targetInput,f.target)).rejects.toThrow();
  expect(f.target).not.toHaveBeenCalled();
  expect((await f.sql.query<{state:string}>('SELECT state FROM autonomous_paid_app.operations')).rows).toEqual([{state:'denied'}]);
 }finally{await f.engine.close();}
},30000);
