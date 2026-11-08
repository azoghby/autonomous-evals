import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRichRemediation, deliverRemediationCost, type RemediationCanonical } from '@/server/rich-remediation';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { makeScenarios, makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { evaluateObjectiveCheck, executeSuite } from '@ae/core/evals/text';
import { HttpsJsonTransport } from '@ae/core/targets/transport';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import type { Finding } from '@ae/core/evals/types';

const stage = process.env.WORKFLOW_STAGE!;
const patch = { kind: 'prompt_patch', summary: 'Keep marker', patch: 'Always include READY.', rationale: 'Retain frozen criteria.' };
afterEach(() => vi.restoreAllMocks());
async function fixture(proposed: unknown = patch) {
 const db=new PGlite();
 const sql: AgentTransactionalSql={query:(s,p)=>db.query(s,p),transaction:fn=>db.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 for(const path of ['agents/persistence-migrations/001-agent-persistence.sql','evals/integration/migrations/001-text-integration.sql','evals/remediation/accounting/001-remediation-accounting.sql']) await db.exec(readFileSync(join(stage,'packages/core/src',path),'utf8'));
 await db.exec(`CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(job_id text,key text PRIMARY KEY,payload jsonb);
 CREATE TABLE workflow_integration.provider_costs(job_id text,key text PRIMARY KEY,source text,operation_id text,receipt_id text,micro_usd bigint);`);
 const job={jobId:'app-remediation-job',customerId:'tenant',package:'text_eval' as const,environment:'test' as const,isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const suite=makeSuite({jobId:job.jobId,scenarios:makeScenarios().map(s=>({...s,userMessage:`You answer questions about ${s.id}.\n${s.userMessage}`}))});
 const run=await executeSuite(suite,'baseline',{target:{send:async r=>({ok:true,text:r.scenarioId==='S01'?'WRONG':'READY',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
 const finding: Finding={id:'confirmed-1',source:'text_eval',category:'instruction_violation',title:'Marker missing',label:'confirmed',severity:'medium',basis:'objective',summary:'Missing READY',evidence:[{kind:'check',checkId:'S01.o1',detail:'Missing'}],investigatorNote:null,reproduction:null};
 const canonical: RemediationCanonical={job,knownSecrets:['fixture-key'],targetVersion:'canonical-v1',intake:{endpoint:{url:'https://example.com/v1/chat/completions',model:'canonical',apiKey:'fixture-key'}},binding:{isolation:'request_messages_only',remediation_operation_micro_usd:1,baseline_suite_digest:suite.digest,baseline_run_id:run.runId}};
 const checkpoints=new PostgresTextCheckpointStore(sql);
 const identity={jobId:job.jobId,kind:'run_identity',id:run.runId,inputDigest:'a'.repeat(64)};
 const claim=await checkpoints.claim(identity);if(claim.state!=='claimed')throw new Error('fixture');
 await checkpoints.complete(identity,claim.token,{targetVersion:canonical.targetVersion});
 const reportInput=vi.fn(async()=>({suite,run,richFindings:[finding],limitations:[],investigation:{}}));
 const runner={run:vi.fn(async()=>({status:'completed',output:proposed}))} as unknown as AgentTaskRunner;
 const ctx:ServiceContext={jobId:job.jobId,environment:'test',budgetMicroUsd:1000,recordCost:async()=>{},recordProgress:async()=>{}};
 const post=vi.spyOn(HttpsJsonTransport.prototype,'post').mockImplementation(async()=>({choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));
 process.env.NAIVE_BUDGET_PERIOD_ID='app-fixture';
 const api=()=>createRichRemediation({sql,runner,checkpoints,canonical:async()=>structuredClone(canonical),text:{reportInput} as unknown as ReturnType<typeof createTextEvaluationServices>});
 return {db,sql,canonical,suite,run,finding,runner,ctx,post,api,reportInput};
}

describe('app saved-baseline remediation composition',()=>{
 it('retains all twelve actual serialized payload receipts, durable unknown usage, and replay without dispatch',async()=>{
  const f=await fixture();try{
   const baseline=JSON.stringify({suite:f.suite,run:f.run});
   const result=await f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:f.finding.id});
   expect(result.remediation.verification).toMatchObject({status:'verified',before:{passed:11,total:12},after:{passed:12,total:12},regressions:0});
   expect(result.applied).toHaveLength(12);expect(result.executions).toHaveLength(12);
   expect(f.post).toHaveBeenCalledTimes(12);
   for(const [i,call] of f.post.mock.calls.entries()){
    expect(call[1]).toEqual({model:'canonical',messages:[{role:'system',content:patch.patch},{role:'user',content:f.suite.scenarios[i]!.userMessage}],max_completion_tokens:512,store:false});
    expect(result.applied[i]).toMatchObject({actualSystemPrompt:patch.patch,baselineRunId:'baseline',suiteDigest:f.suite.digest,isolated:true});
   }
   const ops=(await f.db.query<{usage:unknown;settlement:unknown}>('SELECT usage,settlement FROM remediation_accounting.operations')).rows;
   expect(ops).toHaveLength(12);expect(ops.every(o=>o.settlement===null)).toBe(true);
   expect(ops[0]!.usage).toEqual({promptTokens:10,completionTokens:2,totalTokens:12});
   expect((await f.db.query('SELECT * FROM remediation_accounting.reconciliation_outbox WHERE pending=true')).rows).toHaveLength(12);
   expect((await f.db.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(0);
   expect(await f.api().proposeAndVerifyFixDetailed({...f.ctx,budgetMicroUsd:0},{findingId:f.finding.id})).toEqual(result);
   expect(f.post).toHaveBeenCalledTimes(12);expect(JSON.stringify({suite:f.suite,run:f.run})).toBe(baseline);
   writeFileSync(join(stage,'remediation-evidence.json'),JSON.stringify({mode:'offline_fixture_only',remoteAttestation:false,
    baseline:{suite:f.suite,run:f.run,finding:f.finding},trial:result,
    operations:(await f.db.query('SELECT * FROM remediation_accounting.operations ORDER BY operation_id')).rows,
    reconciliation:(await f.db.query('SELECT * FROM remediation_accounting.reconciliation_outbox ORDER BY operation_id')).rows,
    limitations:['Transport spy: no live provider call or remote attestation.','Monetary usage unknown; reservations held.','Frozen12 only; appended pack not run.']},null,2));
  }finally{await f.db.close();}
 },30000);
 it('keeps unsupported isolation unverified with no target dispatch or usage fabrication',async()=>{
  const f=await fixture();try{
   f.canonical.binding.isolation=null;
   const result=await f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:f.finding.id});
   expect(result.remediation.verification.status).toBe('not_verified');expect(result.applied).toEqual([]);expect(f.post).not.toHaveBeenCalled();
   expect((await f.db.query('SELECT * FROM remediation_accounting.operations')).rows).toEqual([]);
  }finally{await f.db.close();}
 },30000);
 it('keeps tool-schema proposals unverified and refuses Trace-only canonical jobs',async()=>{
  const f=await fixture({...patch,kind:'tool_schema'});try{
   const result=await f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:f.finding.id});
   expect(result.remediation.verification.status).toBe('not_verified');expect(result.applied).toEqual([]);
   expect(f.post).not.toHaveBeenCalled();
   f.canonical.job.package='trace_audit';
   await expect(f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:f.finding.id})).rejects.toThrow();
   expect(f.post).not.toHaveBeenCalled();
  }finally{await f.db.close();}
 },30000);
 it('refuses request finding substitution and target revision drift before proposal/dispatch',async()=>{
  const f=await fixture();try{
   await expect(f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:'request-prose'})).rejects.toThrow();
   f.canonical.targetVersion='changed';
   await expect(f.api().proposeAndVerifyFixDetailed(f.ctx,{findingId:f.finding.id})).rejects.toThrow();
   expect(f.runner.run).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  }finally{await f.db.close();}
 },30000);
 it('uses global cost keys and rejects cross-job/changed monetary facts atomically',async()=>{
  const f=await fixture();try{
   const entry={jobId:f.ctx.jobId,operationId:'op',kind:'target' as const,microUsd:7,idempotencyKey:'provider:op',receiptId:'real-receipt'};
   await f.sql.transaction(tx=>deliverRemediationCost(tx,entry));await f.sql.transaction(tx=>deliverRemediationCost(tx,entry));
   expect((await f.db.query('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(1);
   await expect(f.sql.transaction(tx=>deliverRemediationCost(tx,{...entry,microUsd:8}))).rejects.toThrow();
   await expect(f.sql.transaction(tx=>deliverRemediationCost(tx,{...entry,jobId:'other'}))).rejects.toThrow();
  }finally{await f.db.close();}
 },30000);
});
