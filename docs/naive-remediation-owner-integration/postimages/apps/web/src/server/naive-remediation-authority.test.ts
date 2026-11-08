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
import { createNaiveRemediationAuthority } from './naive-remediation-authority';
import { createNaiveTextRuntime } from './naive-text-methods';
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
 for(const file of ['packages/core/src/db/migrations/0000_init.sql','packages/core/src/db/migrations/0005_remediations.sql','packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql','docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql'])await pg.exec(readFileSync(resolve(file),'utf8'));
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

async function preparedAuthority(){
 const f=await fixture(),methods=await f.runtime();
 const suite=await methods.designSuite(f.ctx,f.intake),run=await methods.runSuite(f.ctx,suite,f.target),findings=await methods.investigate(f.ctx,suite,[run]);
 const runtime=await createNaiveTextRuntime(f.ctx,{sql:f.sql,decryptCredentials:()=>({endpoint:'fixture-target-key'}),runnerFactory:()=>new AgentSessionService(f.provider.deps)});
 const authority=await createNaiveRemediationAuthority(f.ctx,{sql:f.sql,authority:runtime.authority});
 const snapshot=await authority.resolve(findings[0]!.id,findings[0]);
 const detailed={remediation:{findingId:snapshot.finding.id,kind:'other' as const,summary:'Proposal only',patch:'Bounded proposal',rationale:'Unsupported patch',verification:{status:'not_verified' as const,before:{passed:0,total:12},after:{passed:0,total:0},regressions:0,evidence:[]}},reason:'Unsupported',scope:'12 original scenarios',baselineRunId:snapshot.runId,freshRunId:null,suiteDigest:snapshot.scope.suiteDigest,patchDigest:'a'.repeat(64),executions:[],applied:[]};
 return {...f,authority,snapshot,detailed,findings,suite};
}
describe('current remediation authority SQL',()=>{
 it('resolves full retained baseline and immutable projection before public finding exists',async()=>{
  const f=await preparedAuthority();expect(f.snapshot.original.run.executions).toHaveLength(12);expect(f.snapshot.finding.label).toBe('confirmed');
  expect((await f.pg.query('SELECT * FROM findings')).rows).toHaveLength(0);
  await f.authority.retain(f.detailed);await f.authority.retain(f.detailed);
  expect((await f.pg.query('SELECT * FROM remediations')).rows).toHaveLength(1);
  expect((await f.pg.query("SELECT * FROM text_integration.checkpoints WHERE kind='naive_remediation_receipt'")).rows).toHaveLength(1);
  await expect(f.authority.retain({...f.detailed,reason:'conflicting replay'})).rejects.toThrow();
 },60000);
 it('rejects public finding substitution and cancellation before persistence',async()=>{
  const f=await preparedAuthority();await expect(f.authority.resolve(f.findings[0]!.id,{...f.findings[0]!,title:'substitution'})).rejects.toThrow();
  await f.pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[f.jobId]);await expect(f.authority.retain(f.detailed)).rejects.toThrow();
  expect((await f.pg.query('SELECT * FROM remediations')).rows).toHaveLength(0);
 },60000);
 it('rejects changed credentials before dispatch',async()=>{
  const f=await preparedAuthority();await f.pg.query('DELETE FROM job_credentials WHERE job_id=$1',[f.jobId]);await expect(f.authority.assertCurrent()).rejects.toThrow();
 },60000);
 it('rolls back detailed receipt when a conflicting public projection already exists',async()=>{
  const f=await preparedAuthority();
  const finding=(await f.pg.query<{id:string}>(`INSERT INTO findings(job_id,finding_key,data) VALUES($1,$2,$3::jsonb) RETURNING id`,[f.jobId,f.snapshot.finding.id,JSON.stringify(f.snapshot.publicFinding)])).rows[0]!;
  await f.pg.query(`INSERT INTO remediations(job_id,finding_row_id,data) VALUES($1,$2,$3::jsonb)`,[f.jobId,finding.id,JSON.stringify({...f.detailed.remediation,summary:'conflicting existing projection'})]);
  await expect(f.authority.retain(f.detailed)).rejects.toThrow();
  expect((await f.pg.query("SELECT * FROM text_integration.checkpoints WHERE kind='naive_remediation_receipt'")).rows).toHaveLength(0);
 },60000);
 it('rejects admission revocation on replay',async()=>{
  const f=await preparedAuthority();
  await f.pg.query(`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{status}','"rejected"'::jsonb) WHERE job_id=$1 AND kind='naive_admission'`,[f.jobId]);
  await expect(f.authority.assertCurrent()).rejects.toThrow();
  await expect(f.authority.retain(f.detailed)).rejects.toThrow();
  expect((await f.pg.query('SELECT * FROM remediations')).rows).toHaveLength(0);
 },60000);

});

const publicationPaths={reportBlobPath:'private/report.json',suiteBlobPath:'private/suite.json',reportHtmlBlobPath:'private/report.html',evidenceBlobPath:'private/evidence.json'};
async function publicationFor(f:Awaited<ReturnType<typeof preparedAuthority>>){return createNaiveTextPublication(f.ctx,f.suite,f.findings,{sql:f.sql,decryptCredentials:()=>({endpoint:'fixture-target-key'})});}
describe('retained remediation report SQL integration',()=>{
 it('includes exact retained remediation and scoped summary in publication context',async()=>{
  const f=await preparedAuthority();await f.authority.retain(f.detailed);
  const publication=await publicationFor(f),context=await publication.reportContext();
  expect(context.remediations).toEqual([f.detailed.remediation]);expect(context.summary).toContain(`${f.snapshot.finding.id}: not_verified`);expect(context.summary).toContain('no deployed configuration was changed');
  const report={jobId:f.jobId,summary:context.summary,markdown:context.summary,html:'<p>Scoped report</p>',findings:f.findings};
  await publication.atomicPublish(report,publicationPaths);
  expect((await f.pg.query('SELECT * FROM remediations')).rows).toHaveLength(1);
 },60000);
 it('rejects corrupted receipt digest and a wrong baseline even with a recomputed receipt digest',async()=>{
  const f=await preparedAuthority();await f.authority.retain(f.detailed);
  const row=(await f.pg.query<{value:any}>(`SELECT value FROM text_integration.checkpoints WHERE kind='naive_remediation_receipt'`)).rows[0]!;
  const write=async(value:unknown)=>f.pg.query(`UPDATE text_integration.checkpoints SET value=$1::jsonb WHERE kind='naive_remediation_receipt'`,[JSON.stringify(value)]);
  await write({...row.value,receiptDigest:'0'.repeat(64)});await expect(publicationFor(f)).rejects.toThrow();
  const detailed={...row.value.detailed,baselineRunId:'substituted-baseline'},input=row.value.input;
  await write({...row.value,detailed,receiptDigest:createHash('sha256').update(canonicalJson({input,detailed})).digest('hex')});await expect(publicationFor(f)).rejects.toThrow();
 },60000);
 it('rejects public remediation projection drift',async()=>{
  const f=await preparedAuthority();await f.authority.retain(f.detailed);
  await f.pg.query(`UPDATE remediations SET data=jsonb_set(data,'{summary}','"substitution"'::jsonb) WHERE job_id=$1`,[f.jobId]);
  await expect(publicationFor(f)).rejects.toThrow();
 },60000);
 it('rejects remediation added after report context was captured',async()=>{
  const f=await preparedAuthority(),publication=await publicationFor(f),context=await publication.reportContext();
  expect(context.remediations).toEqual([]);await f.authority.retain(f.detailed);
  await expect(publication.atomicPublish({jobId:f.jobId,summary:context.summary,markdown:context.summary,html:'<p>Old context</p>',findings:f.findings},publicationPaths)).rejects.toThrow();
  expect((await f.pg.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[f.jobId])).rows[0]!.state).toBe('planning');
 },60000);
});
