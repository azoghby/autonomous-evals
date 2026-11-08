import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { remediationDigest, type Patch } from '@ae/core/evals/remediation/index';
import { evaluateObjectiveCheck, executeSuite } from '@ae/core/evals/text/index';
import { makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { jobBudgetExposure, lockJobBudget } from '@ae/core/db/job-budget-authority';
import type { RemediationTargetScope } from '@ae/core/targets/remediation';
import { createNaiveRemediationTrial, type NaiveRemediationTrialDeps } from './naive-remediation-trial';

const jobId='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text);`);
 await pg.exec(readFileSync(resolve('packages/core/src/agents/persistence-migrations/001-agent-persistence.sql'),'utf8'));
 await pg.exec(readFileSync(resolve('packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql'),'utf8'));
 await pg.exec(readFileSync(resolve('docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql'),'utf8'));
 await pg.query('INSERT INTO jobs(id,package) VALUES($1,$2)',[jobId,'text_eval']);
 const sql:AgentTransactionalSql={query:(s,p)=>pg.query(s,p),transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 const suite=makeSuite({jobId});
 const run=await executeSuite(suite,'baseline',{target:{send:async()=>({ok:true,text:'WRONG',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
 const binding={targetId:'target',targetVersion:'v1',environment:'test' as const};
 const scope:RemediationTargetScope={job:{jobId,customerId:'customer',environment:'test',package:'text_eval',quoteVersion:null,linkedRetestOf:null,isFixture:true},
  finding:{id:'finding',source:'text_eval',category:'instruction_violation',title:'Missing marker',summary:'READY missing',label:'confirmed',severity:'medium',basis:'objective',evidence:[{kind:'check',checkId:'S01.o1',detail:'Missing marker'}],investigatorNote:null,reproduction:null},
  binding,original:{suite,run,binding,failingCheckIds:['S01.o1']},trialId:'trial',endpoint:{kind:'stateless_chat_completions',isolation:'request_messages_only',url:'https://example.com/chat/completions',model:'test-model'}};
 const patch:Patch={kind:'prompt_patch',patch:'Always say READY.',summary:'Add marker',rationale:'Preserve criteria'};
 const root=remediationDigest({finding:scope.finding,binding,original:scope.original,trialId:scope.trialId});
 const input={request:{runId:`rem-${root.slice(0,48)}`,scenarioId:'S01',systemPrompt:patch.patch,userMessage:suite.scenarios[0]!.userMessage},patch,patchDigest:remediationDigest(patch),baselineRunId:run.runId,suiteDigest:suite.digest};
 const operation={kind:'target' as const,operationId:`remediation:${jobId}:target:${root}:S01`,inputDigest:remediationDigest({root,input})};
 let revoked=false;
 const post=vi.fn(async(_url:string,_body:unknown)=>({choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}]}));
 const current=async()=>{if(revoked)throw Error('revoked');return [];};
 const deps:NaiveRemediationTrialDeps={sql,scope,operationMicroUsd:40,reservationScopes:[{key:`job:${jobId}`,capMicroUsd:1000},{key:`generic-text:${jobId}`,capMicroUsd:1000},{key:'agent:quality_investigator:2026-11',capMicroUsd:1000}],assertCurrent:current,
  assertCurrentInTransaction:async tx=>{await lockJobBudget(tx,jobId);await current();},resolveJudge:async()=>null,transport:{post}};
 return {pg,sql,deps,input,operation,post,revoke:()=>{revoked=true;}};
}
describe('Naive remediation shared-budget stateless trial',()=>{
 it('receipts match actual immutable messages; unknown target money remains held and fresh instances cannot redispatch',async()=>{
  const f=await fixture();try{
   const ports=createNaiveRemediationTrial(f.deps);expect(await ports.authorize(f.operation)).toBe(true);
   const result=await ports.trial!.send(f.input);
   const payload=f.post.mock.calls[0]![1] as {messages:{content:string}[]};
   expect(result.value.receipt.actualSystemPrompt).toBe(payload.messages[0]!.content);
   expect(Object.isFrozen(payload)).toBe(true);expect(result.costs).toEqual([]);
   expect((await f.pg.query('SELECT settlement,usage FROM remediation_accounting.operations')).rows).toEqual([{settlement:null,usage:null}]);
   expect((await f.pg.query('SELECT pending,reason FROM remediation_accounting.reconciliation_outbox')).rows).toEqual([{pending:true,reason:'usage_unknown'}]);
   expect(await f.sql.transaction(tx=>jobBudgetExposure(tx,jobId))).toMatchObject({committedMicroUsd:40});
   const restarted=createNaiveRemediationTrial(f.deps);expect(await restarted.authorize(f.operation)).toBe(true);
   await expect(restarted.trial!.send(f.input)).rejects.toThrow();expect(f.post).toHaveBeenCalledTimes(1);
   expect((await f.pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows).toEqual([{settled_micro_usd:null}]);
  }finally{await f.pg.close();}
 });
 it('revocation after reservation blocks the secured transport and preserves the hold',async()=>{
  const f=await fixture();try{const ports=createNaiveRemediationTrial(f.deps);await ports.authorize(f.operation);f.revoke();
   await expect(ports.trial!.send(f.input)).rejects.toThrow();expect(f.post).not.toHaveBeenCalled();
   expect(await f.sql.transaction(tx=>jobBudgetExposure(tx,jobId))).toMatchObject({committedMicroUsd:40});
  }finally{await f.pg.close();}
 });
 it('a lost target acknowledgement keeps durable ambiguity and refuses replay',async()=>{
  const f=await fixture();try{
   f.post.mockRejectedValueOnce(Error('lost response'));
   const ports=createNaiveRemediationTrial(f.deps);await ports.authorize(f.operation);
   await expect(ports.trial!.send(f.input)).rejects.toThrow();
   const restarted=createNaiveRemediationTrial(f.deps);await restarted.authorize(f.operation);
   await expect(restarted.trial!.send(f.input)).rejects.toThrow();expect(f.post).toHaveBeenCalledTimes(1);
   expect((await f.pg.query('SELECT ambiguous,settlement FROM remediation_accounting.operations')).rows).toEqual([{ambiguous:true,settlement:null}]);
   expect(await f.sql.transaction(tx=>jobBudgetExposure(tx,jobId))).toMatchObject({committedMicroUsd:40});
  }finally{await f.pg.close();}
 });
 it('unsupported patches and changed reservation policy fail before dispatch',async()=>{
  const f=await fixture();try{const ports=createNaiveRemediationTrial(f.deps);await ports.authorize(f.operation);
   await expect(ports.trial!.send({...f.input,patch:{...f.input.patch,kind:'tool_schema'}})).rejects.toThrow();
   await expect(createNaiveRemediationTrial({...f.deps,operationMicroUsd:41}).authorize(f.operation)).rejects.toThrow();
   expect(f.post).not.toHaveBeenCalled();
  }finally{await f.pg.close();}
 });
 it('reuses the accounted proxy judge without fabricating session costs',async()=>{
  const f=await fixture();try{const judge=vi.fn(async()=>({outcome:'passed' as const,explanation:'Retained proxy result',evidenceQuotes:[]}));
   const ports=createNaiveRemediationTrial({...f.deps,resolveJudge:async()=>judge});
   expect(await ports.authorize({...f.operation,kind:'judge'})).toBe(true);
   const input={} as Parameters<NonNullable<typeof ports.judge>>[0];
   expect(await ports.judge!(input)).toEqual({value:{outcome:'passed',explanation:'Retained proxy result',evidenceQuotes:[]},costs:[]});
   expect(judge).toHaveBeenCalledTimes(1);expect((await f.pg.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(0);
  }finally{await f.pg.close();}
 });
});
