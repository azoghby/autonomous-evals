/** Real generic owner SQL + concrete admission + rich adapters; provider/target transport only are fakes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { IntakeInput } from '@ae/core/contracts';
import type { ServiceContext } from '@ae/core/contracts/services';
import { PostgresAgentTaskStore,PostgresBudgetLedger,type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { AgentSessionService,type AgentTaskRunner } from '@ae/core/agents/session-service';
import { harness,directory } from '@ae/core/agents/__tests__/fakes';
import { behavioralInstructions,behavioralRubric } from '@ae/core/evals/text/rubric-admission';
import { makeScenarios } from '@ae/core/evals/text/__tests__/fixtures';
import { createNaiveTextMethods,createNaiveTextMethodBuilder } from './naive-text-methods';
import { ROLE_DEFINITIONS,TASK_BUDGETS } from '@ae/core/agents/roles';
const jobId='123e4567-e89b-42d3-a456-426614174000';
const databases:PGlite[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const pg of databases.splice(0))await pg.close();});
async function fixture(rubric=false,fixtureJobId=jobId,shared?:{pg:PGlite;sql:AgentTransactionalSql;provider:ReturnType<typeof harness>;proxyFetch:typeof fetch},proxyOutcome:'passed'|'inconclusive'='passed'){
 const jobId=fixtureJobId;
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-jude-model');vi.stubEnv('NAIVE_API_KEY','fixture-proxy-key');
 vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 const pg=shared?.pg??new PGlite();if(!shared){databases.push(pg);
 for(const file of ['packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql'])await pg.exec(readFileSync(resolve(file),'utf8'));
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id text NOT NULL,environment text NOT NULL,package text NOT NULL,is_mock boolean NOT NULL,state text NOT NULL,intake jsonb NOT NULL,retest_of_job_id uuid,credentials_delete_after timestamptz);
 CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text NOT NULL);
 CREATE TABLE costs(id text PRIMARY KEY,job_id uuid NOT NULL,micro_usd bigint NOT NULL,receipt jsonb NOT NULL);`);}
 const intake:Extract<IntakeInput,{package:'text_eval'}>={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture-model',referenceText:'Canonical grounding text.',systemPrompt:rubric?'Use a polite tone.':'Follow explicit constraints.',apiKey:'fixture-target-key'}};
 // Match workflows/steps/evaluate.ts targetFor: referenceText belongs to design, not the dispatch target.
 const target={url:intake.endpoint.url,model:intake.endpoint.model,apiKey:intake.endpoint.apiKey,systemPrompt:intake.endpoint.systemPrompt??''};
 const {apiKey:_key,...endpoint}=intake.endpoint;
 await pg.query(`INSERT INTO jobs VALUES($1,'canonical-owner','test','text_eval',false,'planning',$2,null,null)`,[jobId,JSON.stringify({...intake,endpoint,_credentialSlots:['endpoint']})]);
 await pg.query(`INSERT INTO job_credentials VALUES($1,'encrypted-fixture')`,[jobId]);
 const sql:AgentTransactionalSql=shared?.sql??{query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const scenarios=makeScenarios().map(s=>{if(!rubric)return s;const source=behavioralInstructions(intake.endpoint.systemPrompt,s)[0]!;return {...s,rubricChecks:[{id:`${s.id}.r1`,kind:'rubric' as const,description:'Polite tone',rubric:behavioralRubric(source),behavioralInstructionId:source.id,assessesFactualCorrectness:false}]};});
 const provider=shared?.provider??harness(body=>({structuredOutput:body.metadata.ae_output==='text_design'?{scenarios}:body.metadata.ae_output==='text_review'?{verdicts:scenarios.map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))}:{reproduceScenarioIds:['S01'],verdicts:[{candidateId:'text:S01:S01.o1',verdict:'confirmed',rationale:'Reproduced exact literal constraint failure.',quote:'WRONG',defectNote:null}]}}),{store:new PostgresAgentTaskStore(sql),ledger:new PostgresBudgetLedger(sql),directory:Object.fromEntries(Object.entries(directory).map(([role,agent])=>[role,{...agent,agentVersion:1}])) as typeof directory});
 const proxyBodies=new Map<string,any>();let proxySequence=0;
 const proxyFetch=shared?.proxyFetch??vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input),text=JSON.stringify({outcome:proxyOutcome,explanation:'Fixture judged the exact response.',evidenceQuotes:['WRONG']});
  if(url.includes('/anthropic/v1/messages')){const body=JSON.parse(String(init?.body));const id=`req_${String(++proxySequence).padStart(26,'0')}`;proxyBodies.set(id,body);return Response.json({id,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}});}
  const id=url.split('/').at(-1)!,body=proxyBodies.get(id);if(!body)throw Error('unknown fixture proxy trace');
  return Response.json({id,object:'proxy_call_trace',dialect:'anthropic',actor:{type:'system',id:'fixture'},model:body.model,window:'immediate',resolved_model:body.model,provider:'fixture',generation_id:null,stop:'end_turn',usage:{input:1,output:2,cache_read:0,cache_write:0,reasoning:0},billed_micro_usd:5,vendor_cost_micro_usd:null,duration_ms:1,content_scope:'full',source:'proxy',session_id:null,seq:null,board_card_id:null,tool_call_ids:[],tool_schema_hash:null,request_sha256:'a'.repeat(64),response_sha256:'b'.repeat(64),request_bytes:1,response_bytes:1,request:{model:body.model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages},response:{text,tool_calls:[]},truncated:false,created_at:'2026-11-07T20:00:00.000Z',expires_at:null});
 });
 let loseCostAck=false,revokeAfterAgent=false,revokeAfterTarget=false;
 const post=vi.fn(async()=>{if(revokeAfterTarget){revokeAfterTarget=false;await pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);}return {choices:[{message:{role:'assistant',content:'WRONG'},finish_reason:'stop'}]};});
 const ctx:ServiceContext={jobId,environment:'test',budgetMicroUsd:1000000,recordProgress:async()=>{},recordCost:async cost=>{
  const key=String(cost.meta?.idempotencyKey);await sql.transaction(async tx=>{await tx.query('INSERT INTO costs VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[key,jobId,cost.microUsd,JSON.stringify(cost)]);const r=await tx.query<{equal:boolean}>('SELECT receipt=$2::jsonb AS equal FROM costs WHERE id=$1',[key,JSON.stringify(cost)]);if(!r.rows[0]?.equal)throw Error('cost_conflict');});
  if(loseCostAck){loseCostAck=false;throw Error('cost_ack_lost');}
 }};
 function runtime(context=ctx){
  return createNaiveTextMethods(context,{sql,runnerFactory:ledger=>{
   const service=new AgentSessionService({...provider.deps,store:new PostgresAgentTaskStore(sql),ledger,workerId:'reconstructed-worker'});
   const runner:AgentTaskRunner={run:async spec=>{const result=await service.run(spec);if(revokeAfterAgent){revokeAfterAgent=false;await pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);}return result;}};
   return runner;
  },clock:provider.clock,targetTransport:{post},proxyFetch,decryptCredentials:()=>({endpoint:'fixture-target-key'})});
 }

 return {jobId,pg,sql,intake,target,ctx,provider,post,proxyFetch,runtime,loseCostAck:()=>{loseCostAck=true;},revokeAfterAgent:()=>{revokeAfterAgent=true;},revokeAfterTarget:()=>{revokeAfterTarget=true;}};
}
describe('generic application text composition with durable SQL authority',()=>{
 it('rejects zero and unsafe budgets before SQL or provider construction, and unsupported methods fail closed',async()=>{
  const query=vi.fn(async()=>{throw Error('SQL must not be touched');}),transaction=vi.fn(async()=>{throw Error('SQL must not be touched');});
  const sql={query,transaction} as AgentTransactionalSql,base={jobId,environment:'test' as const,budgetMicroUsd:0,recordCost:async()=>{},recordProgress:async()=>{}};
  for(const budgetMicroUsd of [0,-1,Number.NaN,Infinity,Number.MAX_SAFE_INTEGER+1,0.5])await expect(createNaiveTextMethods({...base,budgetMicroUsd},{sql})).rejects.toThrow();
  const builder=createNaiveTextMethodBuilder({sql});for(const method of ['proposeAndVerifyFix','rerunFinding'] as const)await expect(builder(method,{...base,budgetMicroUsd:1000000})).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
 });
 it('requires configured judge policy before provider or target calls',async()=>{
  const f=await fixture();vi.stubEnv('NAIVE_JUDGE_MODEL','');await expect(f.runtime()).rejects.toThrow();expect(f.provider.naive.createCalls).toHaveLength(0);expect(f.post).not.toHaveBeenCalled();
 });
 it('pins provider task allocations below role maxima and default budgets for a larger initial allowance',async()=>{
  const f=await fixture(),large={...f.ctx,budgetMicroUsd:3000000},api=await f.runtime(large);const suite=await api.designSuite(large,f.intake);
  expect(f.provider.naive.createCalls).toHaveLength(2);
  for(const {body} of f.provider.naive.createCalls){const role=body.metadata.ae_role as keyof typeof ROLE_DEFINITIONS;const expected=body.metadata.ae_output==='text_design'?TASK_BUDGETS.suiteDesign:TASK_BUDGETS.suiteReview;expect(body.budget_micro_usd).toBeLessThanOrEqual(ROLE_DEFINITIONS[role].maxTaskMicroUsd);expect(body.budget_micro_usd).toBeLessThanOrEqual(expected);}
  const lower={...f.ctx,budgetMicroUsd:600000},fresh=await f.runtime(lower);expect(await fresh.designSuite(lower,f.intake)).toEqual(suite);expect(f.provider.naive.createCalls).toHaveLength(2);
 },60000);
 it('designs and independently admits then runs/investigates, reconstructs with reduced remaining budget without redispatch',async()=>{
  const f=await fixture(),api=await f.runtime();const suite=await api.designSuite(f.ctx,f.intake);const run=await api.runSuite(f.ctx,suite,f.target);const findings=await api.investigate(f.ctx,suite,[run]);
  expect(findings.find(x=>x.id==='text:S01:S01.o1')?.status).toBe('confirmed');expect(f.provider.naive.createCalls).toHaveLength(3);expect(f.post).toHaveBeenCalledTimes(13);
  const reduced={...f.ctx,budgetMicroUsd:900000},fresh=await f.runtime(reduced);
  expect(await fresh.designSuite(reduced,f.intake)).toEqual(suite);expect(await fresh.runSuite(reduced,suite,f.target)).toEqual(run);expect(await fresh.investigate(reduced,suite,[run])).toEqual(findings);
  expect(f.provider.naive.createCalls).toHaveLength(3);expect(f.post).toHaveBeenCalledTimes(13);expect((await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM costs')).rows[0].count).toBe(3);
  const rows=await f.pg.query('SELECT value FROM text_integration.checkpoints');expect(JSON.stringify(rows.rows)).not.toContain('fixture-target-key');
 },60000);
 it('uses the configured real Jude proxy adapter for rubric checks and retains keyed billed receipts across restart',async()=>{
  const f=await fixture(true),api=await f.runtime(),suite=await api.designSuite(f.ctx,f.intake),run=await api.runSuite(f.ctx,suite,f.target);
  expect(run.results.every(result=>result.assessment?.kind==='rubric'&&result.assessment.checks.some(check=>check.checkId.endsWith('.r1')&&check.status==='pass'))).toBe(true);
  expect(f.proxyFetch).toHaveBeenCalledTimes(24);
  const costs=(await f.pg.query<{receipt:{source:string;microUsd:number}}>('SELECT receipt FROM costs')).rows.map(row=>row.receipt);expect(costs.filter(c=>c.source==='naive_proxy')).toHaveLength(12);expect(costs.filter(c=>c.source==='naive_proxy').every(c=>c.microUsd===5)).toBe(true);
  const fresh=await f.runtime();expect(await fresh.runSuite(f.ctx,suite,f.target)).toEqual(run);expect(f.proxyFetch).toHaveBeenCalledTimes(24);expect(f.post).toHaveBeenCalledTimes(12);
 },60000);
 it('preserves inconclusive rubric checks in public and retained rich runs without publishing boolean pass',async()=>{
  const f=await fixture(true,jobId,undefined,'inconclusive'),api=await f.runtime(),suite=await api.designSuite(f.ctx,f.intake),run=await api.runSuite(f.ctx,suite,f.target);
  expect(run.results).toHaveLength(12);expect(run.results.every(r=>r.passed===undefined&&r.assessment?.kind==='inconclusive'&&r.assessment.checks.some(c=>c.checkId.endsWith('.r1')&&c.status==='inconclusive'))).toBe(true);
  const retained=(await f.pg.query<{value:{run:{executions:{checks:{checkId:string;status:string}[]}[]}}}>(`SELECT value FROM text_integration.checkpoints WHERE kind='naive_run_artifact' AND state='completed'`)).rows[0].value;
  expect(retained.run.executions).toHaveLength(12);expect(retained.run.executions.every(e=>e.checks.some(c=>c.checkId.endsWith('.r1')&&c.status==='inconclusive'))).toBe(true);
 },60000);
 it('uses the canonical job scope already established by qualification with a lower remaining allowance',async()=>{
  const f=await fixture();await f.pg.query('INSERT INTO agent_persistence.scopes VALUES($1,3000000)',[`job:${f.jobId}`]);
  const lower={...f.ctx,budgetMicroUsd:600000},api=await f.runtime(lower),suite=await api.designSuite(lower,f.intake);expect(suite.scenarios).toHaveLength(12);
  expect((await f.pg.query<{cap_micro_usd:string}>('SELECT cap_micro_usd::text FROM agent_persistence.scopes WHERE key=$1',[`job:${f.jobId}`])).rows[0].cap_micro_usd).toBe('3000000');
 },60000);
 it('shares the canonical judge-period scope across jobs with different generic allocations',async()=>{
  const first=await fixture(true),second=await fixture(true,'223e4567-e89b-42d3-a456-426614174000',first);
  const a={...first.ctx,budgetMicroUsd:1000000},b={...second.ctx,budgetMicroUsd:600000};
  for(const [f,ctx] of [[first,a],[second,b]] as const){const api=await f.runtime(ctx),suite=await api.designSuite(ctx,f.intake),run=await api.runSuite(ctx,suite,f.target);expect(run.results.every(r=>r.assessment?.kind==='rubric'&&r.assessment.checks.some(c=>c.checkId.endsWith('.r1')&&c.status==='pass'))).toBe(true);}
  const judgeScopes=(await first.pg.query<{cap_micro_usd:string}>(`SELECT cap_micro_usd::text FROM agent_persistence.scopes WHERE key LIKE 'agent:judge:%'`)).rows;expect(judgeScopes).toEqual([{cap_micro_usd:'3000000'}]);expect(first.proxyFetch).toHaveBeenCalledTimes(48);
  const genericScopes=(await first.pg.query<{key:string;cap_micro_usd:string}>(`SELECT key,cap_micro_usd::text FROM agent_persistence.scopes WHERE key LIKE 'generic-text:%' ORDER BY key`)).rows;expect(genericScopes).toEqual([{key:`generic-text:${first.jobId}`,cap_micro_usd:'1000000'},{key:`generic-text:${second.jobId}`,cap_micro_usd:'600000'}]);expect((await first.pg.query<{count:number}>('SELECT count(*)::int AS count FROM agent_persistence.reservations')).rows[0].count).toBe(28);
 },60000);
 it('recovers lost cost acknowledgement via reconstruction without another provider operation',async()=>{
  const f=await fixture();f.loseCostAck();const first=await f.runtime();await expect(first.designSuite(f.ctx,f.intake)).rejects.toThrow('cost_ack_lost');const calls=f.provider.naive.createCalls.length;
  const fresh=await f.runtime();const suite=await fresh.designSuite(f.ctx,f.intake);expect(suite.scenarios).toHaveLength(12);expect(f.provider.naive.createCalls).toHaveLength(calls);expect((await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM costs')).rows[0].count).toBe(2);
 },60000);
 it('refuses revoked canonical scope before target dispatch and retained publication',async()=>{
  const f=await fixture(),api=await f.runtime();const suite=await api.designSuite(f.ctx,f.intake);await f.pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);
  await expect(api.runSuite(f.ctx,suite,f.target)).rejects.toThrow();await expect(f.runtime()).rejects.toThrow();expect(f.post).not.toHaveBeenCalled();expect(f.provider.naive.createCalls).toHaveLength(2);
 },60000);
 it('retains measured provider cost before post-await revocation and drains it before revoked factory admission',async()=>{
  const f=await fixture(),api=await f.runtime();f.revokeAfterAgent();await expect(api.designSuite(f.ctx,f.intake)).rejects.toThrow();expect(f.provider.naive.createCalls).toHaveLength(1);
  const outbox=(await f.pg.query<{value:{jobId:string;customerId:string;environment:string;cost:{microUsd:number}}}>(`SELECT value FROM text_integration.checkpoints WHERE kind='naive_generic_cost' AND state='completed'`)).rows;
  expect(outbox).toHaveLength(1);expect(outbox[0].value).toMatchObject({jobId,customerId:'canonical-owner',environment:'test'});expect(outbox[0].value.cost.microUsd).toBeGreaterThan(0);
  await expect(f.runtime()).rejects.toThrow();expect((await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM costs')).rows[0].count).toBe(1);
  expect(f.provider.naive.createCalls).toHaveLength(1);expect(f.post).not.toHaveBeenCalled();
 },60000);
 it('rechecks authority after target await and prevents run publication when revocation occurs in flight',async()=>{
  const f=await fixture(),api=await f.runtime();const suite=await api.designSuite(f.ctx,f.intake);f.revokeAfterTarget();await expect(api.runSuite(f.ctx,suite,f.target)).rejects.toThrow();
  expect(f.post).toHaveBeenCalledTimes(1);expect((await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM text_integration.checkpoints WHERE kind='naive_run_artifact'`)).rows[0].count).toBe(0);
  const retained=(await f.pg.query<{state:string;value:{ok:boolean;text:string}}>(`SELECT state,value FROM text_integration.checkpoints WHERE kind='target'`)).rows;expect(retained.some(row=>row.state==='completed'&&row.value.ok===true&&row.value.text==='WRONG')).toBe(true);await expect(api.runSuite(f.ctx,suite,f.target)).rejects.toThrow();expect(f.post).toHaveBeenCalledTimes(1);
 },60000);
});
