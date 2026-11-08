import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { JudgeAccounting } from '@/server/judge-accounting';
import { createTrustedJudgeResolver } from '@/server/rich-judge';
import { deliverRemediationCost } from '@/server/rich-remediation';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { PostgresBudgetLedger, type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { PRICE_TABLE } from '@ae/core/evals/pricing';
import { ROLE_DEFINITIONS } from '@ae/core/agents/roles';
import { makeScenarios, makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { verifyAdmittedFrozenSuite } from '@ae/core/evals/text/freeze';
import { evaluateObjectiveCheck, executeSuite } from '@ae/core/evals/text';

const stage=process.env.WORKFLOW_STAGE!;
const valid={outcome:'passed',explanation:'Response matches the supplied reference.',evidenceQuotes:['READY']};
const envelope=(verdict:unknown=valid)=>new Response(JSON.stringify({id:'offline-receipt',choices:[{finish_reason:'stop',message:{content:JSON.stringify(verdict)}}],usage:{prompt_tokens:9,completion_tokens:4}}));
const input={operationId:'fixture:judgment',rubric:'Assess the response using the reference.',response:'READY',reference:'READY is the required answer.',assessesFactualCorrectness:true};
async function fixture() {
 const db=new PGlite();
 // Serialize whole transactions on the single PGlite connection. Never interleave a query into another transaction.
 let tail:Promise<unknown>=Promise.resolve();
 const serial=<T>(fn:()=>Promise<T>)=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;};
 const sql:AgentTransactionalSql={query:(s,p)=>serial(()=>db.query(s,p)),transaction:fn=>serial(()=>db.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)})))};
 for(const path of ['agents/persistence-migrations/001-agent-persistence.sql','evals/integration/migrations/001-text-integration.sql','evals/remediation/accounting/001-remediation-accounting.sql']) await db.exec(readFileSync(join(stage,'packages/core/src',path),'utf8'));
 await db.exec('CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(job_id text,key text PRIMARY KEY,payload jsonb); CREATE TABLE workflow_integration.provider_costs(job_id text,key text PRIMARY KEY,source text,operation_id text,receipt_id text,micro_usd bigint);');
 const job={jobId:'judging-fixture',customerId:'fixture-tenant',package:'text_eval' as const,environment:'test' as const,isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const current={job,knownSecrets:['fixture-private-target-key'],targetVersion:'target-v1'};
 const policy={model:'fixture/fixed-model',configVersion:'fixed-v1',privateKeyRef:'fixture-private-ref',reservationMicroUsd:20,periodId:'judge_fixture',auth:'api_key' as const};
 const signal=new AbortController();
 const fetcher=vi.fn<typeof fetch>(async()=>envelope());
 const meter=vi.fn(async (_intent:unknown)=>{});
 const token=vi.fn(async (_ref:string,_auth:string)=>'fixture-gateway-key');
 const deps={sql,checkpoints:new PostgresTextCheckpointStore(sql),canonical:async()=>structuredClone(current),policy,runtime:{signal:signal.signal,beforeDispatch:meter,token,fetch:fetcher},deliverCost:deliverRemediationCost};
 return {db,sql,current,policy,signal,fetcher,meter,token,deps,judge:()=>createTrustedJudgeResolver(deps)};
}

describe('applied trusted app Gateway judge with serialized SQL',()=>{
 it('reserves both scopes before actual adapter dispatch, binds meter, and replays across restart without cost fabrication',async()=>{
  const f=await fixture();try{
   f.fetcher.mockImplementation(async (_url,init)=>{
    const held=(await f.sql.query<{settled_micro_usd:unknown}>('SELECT * FROM agent_persistence.reservations WHERE first_result->>\'ok\'=\'true\'')).rows;
    expect(held).toHaveLength(1);expect(held[0]!.settled_micro_usd).toBeNull();expect(f.meter).toHaveBeenCalledOnce();
    expect(init!.signal).toBeDefined();expect(JSON.parse(String(init!.body)).model).toBe(f.policy.model);
    return envelope();
   });
   const result=await f.judge()(input);expect(result).toEqual(valid);
   expect(await f.judge()(input)).toEqual(result);expect(f.fetcher).toHaveBeenCalledOnce();
   expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toEqual([]);
   expect((await f.sql.query('SELECT * FROM remediation_accounting.reconciliation_outbox WHERE pending=true')).rows).toHaveLength(1);
  }finally{await f.db.close();}
 },30000);
 it('settles only authenticated measured money through the shared keyed protocol and replays a lost acknowledgement once',async()=>{
  const f=await fixture();try{
   await f.judge()(input);
   const op=(await f.sql.query<{operation_id:string;input_digest:string}>('SELECT operation_id,input_digest FROM remediation_accounting.operations')).rows[0]!;
   const accounting=new JudgeAccounting({sql:f.sql,jobId:f.current.job.jobId,reservation:operation=>({reservationId:operation.operationId,jobId:f.current.job.jobId,amountMicroUsd:f.policy.reservationMicroUsd,scopes:[{key:`job:${f.current.job.jobId}`,capMicroUsd:PRICE_TABLE.text_eval.jobBudgetMicroUsd},{key:`agent:evaluation_engineer:${f.policy.periodId}`,capMicroUsd:ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd}]}),deliverCost:deliverRemediationCost});
   const receipt={operationId:op.operation_id,inputDigest:op.input_digest,receiptId:'authenticated-provider-receipt',usage:{promptTokens:9,completionTokens:4,totalTokens:13},microUsd:null as number|null};
   await accounting.reconcile(receipt);
   expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(1);
   // The transaction commits but its acknowledgement is lost at the owner boundary.
   await expect((async()=>{await accounting.reconcile({...receipt,microUsd:7});throw new Error('owner acknowledgement lost');})()).rejects.toThrow('acknowledgement lost');
   await accounting.reconcile({...receipt,microUsd:7});
   expect((await f.sql.query<{micro_usd:string}>('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(1);
   expect((await f.sql.query('SELECT * FROM remediation_accounting.reconciliation_outbox WHERE pending=true')).rows).toHaveLength(0);
   await expect(accounting.reconcile({...receipt,microUsd:8})).rejects.toThrow();
   expect(f.fetcher).toHaveBeenCalledOnce();
  }finally{await f.db.close();}
 },30000);
 it('denies exhausted global budget before any outbound call',async()=>{
  const f=await fixture();try{
   await new PostgresBudgetLedger(f.sql).reserve({reservationId:'prior-global-hold',jobId:'another-job',amountMicroUsd:ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd,scopes:[{key:'job:another-job',capMicroUsd:ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd},{key:`agent:evaluation_engineer:${f.policy.periodId}`,capMicroUsd:ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd}]});
   await expect(f.judge()(input)).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();expect(f.meter).not.toHaveBeenCalled();
  }finally{await f.db.close();}
 },30000);
 it('fences concurrent claims and refuses same identity with changed input',async()=>{
  const f=await fixture();try{
   const attempts=await Promise.allSettled([f.judge()(input),f.judge()(input)]);
   expect(attempts.some(x=>x.status==='fulfilled')).toBe(true);expect(f.fetcher).toHaveBeenCalledOnce();
   await expect(f.judge()({...input,response:'DIFFERENT'})).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledOnce();
  }finally{await f.db.close();}
 },30000);
 it('rechecks current secret guards after token resolution and before dispatch',async()=>{
  const f=await fixture();try{
   f.token.mockImplementation(async()=>{f.current.knownSecrets.push('READY');return 'fixture-gateway-key';});
   await expect(f.judge()(input)).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();
  }finally{await f.db.close();}
 },30000);
 it('holds ambiguous transport results and never repeats them on restart',async()=>{
  const f=await fixture();try{
   f.fetcher.mockRejectedValue(new Error('reply lost'));
   await expect(f.judge()(input)).rejects.toThrow();await expect(f.judge()(input)).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledOnce();
   expect((await f.sql.query('SELECT * FROM remediation_accounting.reconciliation_outbox WHERE pending=true')).rows).toHaveLength(1);
   expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(1);
  }finally{await f.db.close();}
 },30000);
 it('rejects fabricated citations while retaining measured usage and unknown monetary hold',async()=>{
  const f=await fixture();try{
   f.fetcher.mockImplementation(async()=>envelope({...valid,outcome:'rubric_concern',evidenceQuotes:['invented quote']}));
   await expect(f.judge()(input)).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledOnce();
   expect((await f.sql.query('SELECT usage FROM remediation_accounting.operations')).rows[0]!.usage).toEqual({promptTokens:9,completionTokens:4,totalTokens:13});
   expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(0);
  }finally{await f.db.close();}
 },30000);
 it('refuses a rejected parent meter and secret-bearing prompt/reference before network',async()=>{
  const f=await fixture();try{
   await expect(f.judge()({...input,operationId:'secret-prompt',rubric:f.current.knownSecrets[0]!})).rejects.toThrow();
   await expect(f.judge()({...input,operationId:'secret-reference',reference:f.current.knownSecrets[0]!})).rejects.toThrow();
   expect(f.token).not.toHaveBeenCalled();
   f.meter.mockRejectedValue(new Error('acceptance cap exhausted'));
   await expect(f.judge()(input)).rejects.toThrow();
   expect(f.fetcher).not.toHaveBeenCalled();
   await expect(f.judge()(input)).rejects.toThrow();expect(f.meter).toHaveBeenCalledOnce();
  }finally{await f.db.close();}
 },30000);
 it('aborts before dispatch and leaves factual checks without reference unassessed',async()=>{
  const f=await fixture();try{
   f.signal.abort();await expect(f.judge()(input)).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();
   const suite=makeSuite({jobId:f.current.job.jobId,scenarios:makeScenarios().map(s=>({...s,rubricChecks:[{id:`${s.id}.r1`,kind:'rubric' as const,description:'Source assessment',rubric:'Assess using reference',assessesFactualCorrectness:true,requiresReference:true as const}]}))});
   const run=await executeSuite(suite,'missing-reference',{target:{send:async()=>({ok:true,text:'READY',latencyMs:1})},judge:f.judge(),evaluateObjective:evaluateObjectiveCheck});
   expect(run.executions).toHaveLength(12);expect(run.executions.flatMap(s=>s.checks.filter(c=>c.kind==='rubric')).every(c=>c.status==='not_assessed')).toBe(true);expect(f.fetcher).not.toHaveBeenCalled();
  }finally{await f.db.close();}
 },30000);
 it('retains all twelve original scenarios/objectives while actual judges assess valid reference rubrics',async()=>{
  const f=await fixture();try{
   const original=makeScenarios();
   const suite=makeSuite({jobId:f.current.job.jobId,referenceText:input.reference,scenarios:original.map(s=>({...s,rubricChecks:[{id:`${s.id}.r1`,kind:'rubric' as const,description:'Reference answer',rubric:input.rubric,assessesFactualCorrectness:true,requiresReference:true as const}]}))});
   expect(suite.scenarios.map(({rubricChecks,...rest})=>rest)).toEqual(original.map(({rubricChecks,...rest})=>rest));
   const run=await executeSuite(suite,'full-retained-base12',{target:{send:async()=>({ok:true,text:'READY',latencyMs:1})},judge:f.judge(),evaluateObjective:evaluateObjectiveCheck});
   expect(run.executions).toHaveLength(12);expect(f.fetcher).toHaveBeenCalledTimes(12);
   expect(run.executions.flatMap(s=>s.checks).every(c=>c.status==='pass')).toBe(true);
   expect((await f.sql.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(12);
  }finally{await f.db.close();}
 },30000);
 it('executes the immutable accepted live-designed base12 with every original rubric and objective retained',async()=>{
  const f=await fixture();try{
   const artifact=JSON.parse(readFileSync(join(stage,'packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json'),'utf8'));
   const suite=verifyAdmittedFrozenSuite(artifact.outcome.suite);const before=JSON.stringify(suite);
   expect(suite.digest).toBe('0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9');
   f.fetcher.mockImplementation(async()=>envelope({outcome:'inconclusive',explanation:'Offline provider fixture cannot establish answer quality.',evidenceQuotes:[]}));
   const run=await executeSuite(suite,'original-base12',{target:{send:async()=>({ok:true,text:'The basic plan permits three projects.',latencyMs:1})},judge:f.judge(),evaluateObjective:evaluateObjectiveCheck});
   expect(JSON.stringify(suite)).toBe(before);expect(run.executions).toHaveLength(12);
   expect(f.fetcher.mock.calls.length).toBeGreaterThan(0);
   expect(run.executions.flatMap(s=>s.checks).filter(c=>c.kind==='rubric').every(c=>c.status!=='pass')).toBe(true);
  }finally{await f.db.close();}
 },30000);

});
