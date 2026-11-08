import { createHash } from 'node:crypto';
import { canonicalJson } from '@ae/core/evals/text/freeze';
/** Real generic owner SQL + concrete admission + rich adapters; provider/target transport only are fakes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { IntakeInput } from '@ae/core/contracts/index';
import type { ServiceContext } from '@ae/core/contracts/services';
import { PostgresAgentTaskStore,PostgresBudgetLedger,type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { AgentSessionService,type AgentTaskRunner } from '@ae/core/agents/session-service';
import { harness,directory } from '@ae/core/agents/__tests__/fakes';
import { behavioralInstructions,behavioralRubric } from '@ae/core/evals/text/rubric-admission';
import { makeScenarios } from '@ae/core/evals/text/__tests__/fixtures';
import { createNaiveTextMethods } from './naive-text-methods';
import { createNaiveTextPublication,readNaiveTextDeliveryReceipt,claimNaiveTextDeliveryNotification,completeNaiveTextDeliveryNotification } from './naive-text-publication';
import type { Report } from '@ae/core/contracts/index';

const jobId='123e4567-e89b-42d3-a456-426614174000',customerId='323e4567-e89b-42d3-a456-426614174000';
const databases:PGlite[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const pg of databases.splice(0))await pg.close();});
async function fixture(rubric=false,fixtureJobId=jobId,shared?:{pg:PGlite;sql:AgentTransactionalSql;provider:ReturnType<typeof harness>;proxyFetch:typeof fetch},proxyOutcome:'passed'|'inconclusive'='passed',factual=false){
 const jobId=fixtureJobId;
 if(factual){vi.stubEnv('EVAL_NAIVE_FACTUAL_GAPS','1');vi.stubEnv('EVAL_SERVICES','real');}
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-jude-model');vi.stubEnv('NAIVE_API_KEY','fixture-proxy-key');
 vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 const pg=shared?.pg??new PGlite();if(!shared){databases.push(pg);
 for(const file of ['packages/core/src/db/migrations/0000_init.sql','packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql'])await pg.exec(readFileSync(resolve(file),'utf8'));
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)',[customerId,'publication-fixture@example.test']);}
 const intake:Extract<IntakeInput,{package:'text_eval'}>={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture-model',referenceText:'Canonical grounding text.',systemPrompt:rubric?'Use a polite tone.':'Follow explicit constraints.',apiKey:'fixture-target-key'}};
 // Match workflows/steps/evaluate.ts targetFor: referenceText belongs to design, not the dispatch target.
 const target={url:intake.endpoint.url,model:intake.endpoint.model,apiKey:intake.endpoint.apiKey,systemPrompt:intake.endpoint.systemPrompt??''};
 const {apiKey:_key,...endpoint}=intake.endpoint;
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3)`,[jobId,customerId,JSON.stringify({...intake,endpoint,_credentialSlots:['endpoint']})]);
 await pg.query(`INSERT INTO job_credentials(job_id,ciphertext) VALUES($1,'encrypted-fixture')`,[jobId]);
 const sql:AgentTransactionalSql=shared?.sql??{query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const executionProfile=factual?{policyId:'generic-text-factual-gap-v1' as const,designId:'generic-text-factual-gap-v1' as const,versionLabel:'generic-text-factual-gap-v1' as const,admissionPolicyId:'automated-text-design-factual-gap-v1' as const,factualGapPolicy:'propose_missing_reference.v1' as const,expertTaskId:'fact-task'}:undefined;
 if(executionProfile){const value={schemaVersion:'naive_text_execution_selection.v1',identity:{jobId,customerId:customerId,environment:'test'},profile:executionProfile};await pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_execution_policy','selection-v1',$2,'selection','completed',$3)`,[jobId,createHash('sha256').update(canonicalJson(value)).digest('hex'),JSON.stringify(value)]);}
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
  const key=String(cost.meta?.idempotencyKey);await sql.transaction(async tx=>{const old=(await tx.query<{micro_usd:string;meta:unknown}>(`SELECT micro_usd::text,meta FROM costs WHERE job_id=$1 AND meta->>'idempotencyKey'=$2`,[jobId,key])).rows[0];if(old){if(Number(old.micro_usd)!==cost.microUsd)throw Error('cost_conflict');}else await tx.query(`INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[jobId,cost.source,cost.agent??null,cost.sessionId??null,cost.microUsd,JSON.stringify(cost.meta)]);});
  if(loseCostAck){loseCostAck=false;throw Error('cost_ack_lost');}
 }};
 function runtime(context=ctx){
  return createNaiveTextMethods(context,{sql,executionProfile,runnerFactory:ledger=>{
   const service=new AgentSessionService({...provider.deps,store:new PostgresAgentTaskStore(sql),ledger,workerId:'reconstructed-worker'});
   const runner:AgentTaskRunner={run:async spec=>{const result=await service.run(spec);if(revokeAfterAgent){revokeAfterAgent=false;await pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);}return result;}};
   return runner;
  },clock:provider.clock,targetTransport:{post},proxyFetch,decryptCredentials:()=>({endpoint:'fixture-target-key'})});
 }

 return {jobId,pg,sql,intake,target,ctx,provider,post,proxyFetch,runtime,loseCostAck:()=>{loseCostAck=true;},revokeAfterAgent:()=>{revokeAfterAgent=true;},revokeAfterTarget:()=>{revokeAfterTarget=true;}};
}

const paths={reportBlobPath:'private/report.json',suiteBlobPath:'private/suite.json',reportHtmlBlobPath:'private/report.html',evidenceBlobPath:'private/evidence.json'};
async function prepared(rubric=false,outcome:'passed'|'inconclusive'='passed',factual=false){
 const f=await fixture(rubric,jobId,undefined,outcome,factual),api=await f.runtime();
 const suite=await api.designSuite(f.ctx,f.intake),run=await api.runSuite(f.ctx,suite,f.target),findings=await api.investigate(f.ctx,suite,[run]);
 const context={...f.ctx,budgetMicroUsd:0};
 const deps={sql:f.sql,decryptCredentials:()=>({endpoint:'fixture-target-key'})};
 const publication=await createNaiveTextPublication(context,suite,findings,deps),reportContext=await publication.reportContext();
 const report:Report={jobId,summary:reportContext.summary,markdown:reportContext.summary,html:`<p>${reportContext.summary}</p>`,findings};
 return {...f,suite,run,findings,context,deps,publication,reportContext,report};
}
describe('generic text report canonical SQL publication',()=>{
 it('reads canonical retained evidence at zero remaining budget without provider work',async()=>{
  const f=await prepared();expect(f.reportContext.assessed).toBe(12);expect(f.reportContext.summary).toContain('Remediation');
  const calls=f.provider.naive.createCalls.length,sends=f.post.mock.calls.length;
  const fresh=await createNaiveTextPublication(f.context,f.suite,f.findings,f.deps);expect(await fresh.reportContext()).toEqual(f.reportContext);await fresh.assertCurrent(f.report);
  expect(f.provider.naive.createCalls).toHaveLength(calls);expect(f.post).toHaveBeenCalledTimes(sends);
 },60000);
 it('atomically publishes exact findings and immutable paths; fresh replay has stable delivery timestamp',async()=>{
  const f=await prepared(),first=await f.publication.atomicPublish(f.report,paths);
  const row=(await f.pg.query<{state:string;report_blob_path:string;delivered_at:Date;credentials_delete_after:Date;branch_delete_after:Date}>('SELECT state,report_blob_path,delivered_at,credentials_delete_after,branch_delete_after FROM jobs WHERE id=$1',[jobId])).rows[0];
  expect(row.state).toBe('delivered');expect(row.report_blob_path).toBe(paths.reportBlobPath);expect(new Date(row.delivered_at).toISOString()).toBe(first.deliveredAtIso);expect(new Date(row.credentials_delete_after).getTime()-new Date(row.delivered_at).getTime()).toBe(24*3600000);expect(new Date(row.branch_delete_after).getTime()-new Date(row.delivered_at).getTime()).toBe(48*3600000);
  expect((await f.pg.query<{data:unknown}>('SELECT data FROM findings WHERE job_id=$1',[jobId])).rows.map(r=>r.data)).toEqual(f.findings);
  const fresh=await createNaiveTextPublication(f.context,f.suite,f.findings,f.deps);expect(await fresh.atomicPublish(f.report,paths)).toEqual(first);
  await expect(fresh.atomicPublish({...f.report,summary:'substitution'},paths)).rejects.toThrow();await expect(fresh.atomicPublish(f.report,{...paths,evidenceBlobPath:'other/evidence'})).rejects.toThrow();
 },60000);
 it('rejects substituted public suite/findings/report before any delivered state',async()=>{
  const f=await prepared();await expect(createNaiveTextPublication(f.context,{...f.suite,versionLabel:'substitution'},f.findings,f.deps)).rejects.toThrow();
  await expect(createNaiveTextPublication(f.context,f.suite,f.findings.map(x=>({...x,title:'substitution'})),f.deps)).rejects.toThrow();
  await expect(f.publication.atomicPublish({...f.report,findings:[]},paths)).rejects.toThrow();expect((await f.pg.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[jobId])).rows[0].state).toBe('planning');
 },60000);
 it('checks current canonical state, credentials and independent review before report publication',async()=>{
  const f=await prepared();await f.pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);await expect(f.publication.assertCurrent()).rejects.toThrow();await expect(f.publication.atomicPublish(f.report,paths)).rejects.toThrow();
  await f.pg.query(`UPDATE jobs SET state='planning' WHERE id=$1`,[jobId]);await f.pg.query('DELETE FROM job_credentials WHERE job_id=$1',[jobId]);await expect(f.publication.reportContext()).rejects.toThrow();
 },60000);
 it('rolls back findings, job delivery and publication receipt if a SQL write fails',async()=>{
  const f=await prepared();let writes=0;
  const failing:AgentTransactionalSql={query:f.sql.query,transaction:fn=>f.sql.transaction(tx=>fn({query:async<T>(q:string,p?:unknown[])=>{const result=await tx.query<T>(q,p);if(/(?:INSERT INTO findings|UPDATE jobs)/i.test(q)&&++writes===2)throw Error('injected publication failure');return result;}}))};
  const publication=await createNaiveTextPublication(f.context,f.suite,f.findings,{...f.deps,sql:failing});await expect(publication.atomicPublish(f.report,paths)).rejects.toThrow('injected publication failure');
  expect((await f.pg.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[jobId])).rows[0].state).toBe('planning');expect((await f.pg.query<{n:number}>('SELECT count(*)::int AS n FROM findings WHERE job_id=$1',[jobId])).rows[0].n).toBe(0);
  expect(await f.publication.atomicPublish(f.report,paths)).toHaveProperty('deliveredAtIso');
 },60000);
 it('preserves all-inconclusive coverage instead of claiming assessed scenarios',async()=>{
  const f=await prepared(true,'inconclusive');expect(f.reportContext.assessed).toBe(0);expect(f.run.results.every(r=>r.assessment?.kind==='inconclusive')).toBe(true);expect(f.reportContext.summary).toContain('0');await f.publication.assertCurrent();await expect(f.publication.atomicPublish(f.report,paths)).rejects.toThrow('no assessed');expect((await f.pg.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[jobId])).rows[0].state).toBe('planning');
 },60000);
 it('acknowledges an immutable committed receipt after credential cleanup and rejects receipt corruption',async()=>{
  const f=await prepared(),receipt=await f.publication.atomicPublish(f.report,paths);await f.pg.query('DELETE FROM job_credentials WHERE job_id=$1',[jobId]);
  await f.pg.query(`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{state}','"failed"'),revision=revision+1 WHERE record->>'role'='quality_investigator'`);
  await expect(f.publication.atomicPublish(f.report,paths)).rejects.toThrow();
  expect(await readNaiveTextDeliveryReceipt(f.context,f.deps)).toEqual(receipt);
  await f.pg.query(`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{input,report,summary}','"corruption"') WHERE job_id=$1 AND kind='naive_text_publication'`,[jobId]);
  await expect(readNaiveTextDeliveryReceipt(f.context,f.deps)).rejects.toThrow();
 },60000);
 it('refuses extra preexisting baseline findings and secret-bearing report artifacts',async()=>{
  const f=await prepared();await expect(f.publication.atomicPublish({...f.report,summary:'fixture-target-key'},paths)).rejects.toThrow();
  await f.pg.query(`INSERT INTO findings(job_id,finding_key,data) VALUES($1,'substituted',$2::jsonb)`,[jobId,JSON.stringify({...f.findings[0],id:'substituted'})]);
  await expect(f.publication.atomicPublish(f.report,paths)).rejects.toThrow();expect((await f.pg.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[jobId])).rows[0].state).toBe('planning');
 },60000);
 it('rechecks current independent reviewer evidence before publishing an already rendered report',async()=>{
  const f=await prepared();await f.pg.query(`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{state}','"failed"'),revision=revision+1 WHERE record->>'role'='quality_investigator'`);
  await expect(f.publication.assertCurrent(f.report)).rejects.toThrow();await expect(f.publication.atomicPublish(f.report,paths)).rejects.toThrow();
 },60000);

 it('fences a single notification intent across restart and rejects foreign or changed authority',async()=>{
  const f=await prepared();await expect(claimNaiveTextDeliveryNotification(f.context,f.deps)).rejects.toThrow();await f.publication.atomicPublish(f.report,paths);
  const claim=await claimNaiveTextDeliveryNotification(f.context,f.deps);expect(claim.status).toBe('claimed');if(claim.status!=='claimed')throw Error('missing claimed token');
  expect(await claimNaiveTextDeliveryNotification(f.context,f.deps)).toEqual({status:'pending'});await expect(completeNaiveTextDeliveryNotification(f.context,'foreign-token',f.deps)).rejects.toThrow();
  await completeNaiveTextDeliveryNotification(f.context,claim.token,f.deps);await completeNaiveTextDeliveryNotification(f.context,claim.token,f.deps);expect(await claimNaiveTextDeliveryNotification(f.context,f.deps)).toEqual({status:'completed'});
  await f.pg.query(`UPDATE text_integration.checkpoints SET input_digest=$2 WHERE job_id=$1 AND kind='naive_text_notification'`,[jobId,'f'.repeat(64)]);
  await expect(claimNaiveTextDeliveryNotification(f.context,f.deps)).rejects.toThrow();await expect(completeNaiveTextDeliveryNotification(f.context,claim.token,f.deps)).rejects.toThrow();
 },60000);

});

it('publishes factual selection with exact policy replay and recovers receipts/notification after flags roll back',async()=>{
 const f=await prepared(false,'passed',true);
 expect(f.suite.versionLabel).toBe('generic-text-factual-gap-v1');
 const saved=await f.publication.atomicPublish(f.report,paths),calls=f.provider.naive.createCalls.length;
 vi.stubEnv('EVAL_SERVICES','lite');vi.stubEnv('EVAL_NAIVE_FACTUAL_GAPS','0');
 expect(await readNaiveTextDeliveryReceipt(f.context,f.deps)).toEqual(saved);
 const claim=await claimNaiveTextDeliveryNotification(f.context,f.deps);expect(claim.status).toBe('claimed');
 if(claim.status==='claimed')await completeNaiveTextDeliveryNotification(f.context,claim.token,f.deps);
 expect(await claimNaiveTextDeliveryNotification(f.context,f.deps)).toEqual({status:'completed'});
 const rows=(await f.pg.query<{id:string}>(`SELECT id FROM text_integration.checkpoints WHERE kind IN ('naive_method_binding','naive_generic_budget','naive_text_publication','naive_text_notification')`)).rows;
 expect(rows.every(r=>r.id==='generic-text-factual-gap-v1')).toBe(true);
 expect(f.provider.naive.createCalls.length).toBe(calls);
},60000);
