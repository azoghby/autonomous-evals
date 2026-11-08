import { createHash } from 'node:crypto';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { COMPANY_ROLE_DEFINITIONS } from '@ae/core/agents/company-roles';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
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
import { createNaiveTextMethods,createNaiveTextRuntime } from './naive-text-methods';
import { composeNaiveRemediationMethods } from './naive-remediation-runtime';
vi.mock('./workflow-stage-children',()=>({fenceWorkflowStageRunner:(runner:unknown)=>runner,fenceWorkflowStageSessions:(sessions:unknown)=>sessions}));
// This runtime fixture intentionally excludes stage authority; real stage envelopes
// are verified by workflow-stage-budget-integration.test.ts.
vi.mock('./workflow-stage-budget',async()=>{const {SharedJobBudgetLedger}=await import('@ae/core/db/job-budget-ledger');return {createWorkflowStageBudgetLedger:(sql:import('@ae/core/agents/postgres-ports').AgentTransactionalSql)=>new SharedJobBudgetLedger(sql)};});
const remediationStage=vi.hoisted(()=>({active:false}));
// Design/run setup executes without a stage in this owner-runtime fixture. Only
// remediation calls receive its existing mocked owner; real run fencing has its
// own SQL composition coverage.
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>remediationStage.active?{owner:{jobId}}:undefined}));
// This fixture deliberately mocks stage ownership; real stage/checkpoint recovery is tested separately.
vi.mock('./workflow-design-checkpoints',()=>({fenceWorkflowDesignCheckpoints:(store:unknown)=>store}));
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:async()=>{}}));
import { ROLE_DEFINITIONS,TASK_BUDGETS } from '@ae/core/agents/roles';
const jobId='123e4567-e89b-42d3-a456-426614174000';
const databases:PGlite[]=[];
afterEach(async()=>{remediationStage.active=false;vi.unstubAllEnvs();for(const pg of databases.splice(0))await pg.close();});
async function fixture(rubric=false,fixtureJobId=jobId,shared?:{pg:PGlite;sql:AgentTransactionalSql;provider:ReturnType<typeof harness>;proxyFetch:typeof fetch},proxyOutcome:'passed'|'inconclusive'='passed',factual=false){
 const jobId=fixtureJobId;
 if(factual){vi.stubEnv('EVAL_NAIVE_FACTUAL_GAPS','1');vi.stubEnv('EVAL_SERVICES','real');}
 vi.stubEnv('NAIVE_JUDGE_MODEL','fixture-jude-model');vi.stubEnv('NAIVE_API_KEY','fixture-proxy-key');
 vi.stubEnv('NAIVE_JUDGE_RESERVATION_MICRO_USD','10000');vi.stubEnv('NAIVE_JUDGE_MAX_OUTPUT_TOKENS','500');
 const pg=shared?.pg??new PGlite();if(!shared){databases.push(pg);
 for(const file of ['packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql'])await pg.exec(readFileSync(resolve(file),'utf8'));
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id text NOT NULL,environment text NOT NULL,package text NOT NULL,is_mock boolean NOT NULL,state text NOT NULL,intake jsonb NOT NULL,retest_of_job_id uuid,credentials_delete_after timestamptz,budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE findings(id uuid DEFAULT gen_random_uuid(),job_id uuid,finding_key text,data jsonb,rerun_of_finding_id uuid,UNIQUE(job_id,finding_key));
 CREATE TABLE remediations(job_id uuid,finding_row_id uuid,data jsonb,UNIQUE(job_id,finding_row_id));
 CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text NOT NULL);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid NOT NULL,micro_usd bigint NOT NULL,receipt jsonb NOT NULL);`);
 await pg.exec(readFileSync(resolve('docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql'),'utf8'));}
 const intake:Extract<IntakeInput,{package:'text_eval'}>={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture-model',referenceText:'Canonical grounding text.',systemPrompt:rubric?'Use a polite tone.':'Follow explicit constraints.',apiKey:'fixture-target-key'}};
 // Match workflows/steps/evaluate.ts targetFor: referenceText belongs to design, not the dispatch target.
 const target={url:intake.endpoint.url,model:intake.endpoint.model,apiKey:intake.endpoint.apiKey,systemPrompt:intake.endpoint.systemPrompt??''};
 const {apiKey:_key,...endpoint}=intake.endpoint;
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake,retest_of_job_id,credentials_delete_after) VALUES($1,'123e4567-e89b-42d3-a456-426614174099','test','text_eval',false,'planning',$2,null,null)`,[jobId,JSON.stringify({...intake,endpoint,_credentialSlots:['endpoint']})]);
 await pg.query(`INSERT INTO job_credentials VALUES($1,'encrypted-fixture')`,[jobId]);
 const sql:AgentTransactionalSql=shared?.sql??{query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const executionProfile=factual?{policyId:'generic-text-factual-gap-v1' as const,designId:'generic-text-factual-gap-v1' as const,versionLabel:'generic-text-factual-gap-v1' as const,admissionPolicyId:'automated-text-design-factual-gap-v1' as const,factualGapPolicy:'propose_missing_reference.v1' as const,expertTaskId:'fact-task'}:undefined;
 if(executionProfile){const value={schemaVersion:'naive_text_execution_selection.v1',identity:{jobId,customerId:'123e4567-e89b-42d3-a456-426614174099',environment:'test'},profile:executionProfile};await pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_execution_policy','selection-v1',$2,'selection','completed',$3)`,[jobId,createHash('sha256').update(canonicalJson(value)).digest('hex'),JSON.stringify(value)]);}
 const scenarios=makeScenarios().map(s=>{if(!rubric)return s;const source=behavioralInstructions(intake.endpoint.systemPrompt,s)[0]!;return {...s,rubricChecks:[{id:`${s.id}.r1`,kind:'rubric' as const,description:'Polite tone',rubric:behavioralRubric(source),behavioralInstructionId:source.id,assessesFactualCorrectness:false}]};});
 const provider=shared?.provider??harness(body=>({structuredOutput:body.metadata.ae_output==='remediation_patch'?{kind:'prompt_patch',summary:'Replace prompt',patch:'Return the exact expected literal.',rationale:'Preserve fixed checks.'}:body.metadata.ae_output==='text_design'?{scenarios}:body.metadata.ae_output==='text_review'?{verdicts:scenarios.map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))}:{reproduceScenarioIds:['S01'],verdicts:[{candidateId:'text:S01:S01.o1',verdict:'confirmed',rationale:'Reproduced exact literal constraint failure.',quote:'WRONG',defectNote:null}]}}),{store:new PostgresAgentTaskStore(sql),ledger:new PostgresBudgetLedger(sql),directory:Object.fromEntries(Object.entries(directory).map(([role,agent])=>[role,{...agent,agentVersion:1}])) as typeof directory});
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
  const digest=createHash('sha256').update(String(cost.meta?.idempotencyKey)).digest('hex');const key=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;await sql.transaction(async tx=>{await tx.query('INSERT INTO costs VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[key,jobId,cost.microUsd,JSON.stringify(cost)]);const r=await tx.query<{equal:boolean}>('SELECT receipt=$2::jsonb AS equal FROM costs WHERE id=$1',[key,JSON.stringify(cost)]);if(!r.rows[0]?.equal)throw Error('cost_conflict');});
  if(loseCostAck){loseCostAck=false;throw Error('cost_ack_lost');}
 }};
 function runtime(context=ctx){
  return createNaiveTextRuntime(context,{sql,executionProfile,runnerFactory:ledger=>{
   const service=new AgentSessionService({...provider.deps,store:new PostgresAgentTaskStore(sql),ledger,workerId:'reconstructed-worker'});
   const runner:AgentTaskRunner={run:async spec=>{const result=await service.run(spec);if(revokeAfterAgent){revokeAfterAgent=false;await pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);}return result;}};
   return runner;
  },clock:provider.clock,targetTransport:{post},proxyFetch,decryptCredentials:()=>({endpoint:'fixture-target-key'})});
 }

 return {jobId,pg,sql,intake,target,ctx,provider,post,proxyFetch,runtime,loseCostAck:()=>{loseCostAck=true;},revokeAfterAgent:()=>{revokeAfterAgent=true;},revokeAfterTarget:()=>{revokeAfterTarget=true;}};
}

describe('composed generic remediation owner runtime',()=>{
 it('executes all twelve unchanged checks with applied prompt, retains detailed receipts and replays without dispatch',async()=>{
  const f=await fixture();const runtime=await f.runtime();
  const suite=await runtime.methods.designSuite(f.ctx,f.intake);
  const run=await runtime.methods.runSuite(f.ctx,suite,f.target);
  const findings=await runtime.methods.investigate(f.ctx,suite,[run]);
  const finding=findings.find(f=>f.status==='confirmed')!;
  await f.pg.exec(readFileSync(resolve('packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql'),'utf8'));
  const binding=(await runtime.authority.current()).binding;
  const policy={schemaVersion:'naive_remediation_trial_policy.v1',jobId,customerId:binding.job.customerId,environment:'test',targetVersion:binding.targetVersion,kind:'stateless_chat_completions',isolation:'request_messages_only',operationMicroUsd:1000,issuedByOperator:'123e4567-e89b-42d3-a456-426614174088'};
  await f.sql.query("INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_remediation_trial_policy',$2,$3,'policy','completed',$4::jsonb)",[jobId,binding.targetVersion,createHash('sha256').update(canonicalJson(policy)).digest('hex'),JSON.stringify(policy)]);
  const post=vi.fn(async(_url:unknown,request:any)=>{
   expect(request.messages[0].content).toBe('Return the exact expected literal.');
   return {choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  });
  remediationStage.active=true;
  const methods=composeNaiveRemediationMethods(f.ctx,runtime,{post});
  f.loseCostAck();
  await expect(methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake})).rejects.toThrow('cost_ack_lost');
  const proposalCalls=f.provider.naive.createCalls.length;
  const result=await methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake});
  expect(f.provider.naive.createCalls).toHaveLength(proposalCalls);
  expect(result.verification.status).toBe('verified');
  expect(result.verification.before).toEqual({passed:0,total:12});
  expect(result.verification.after).toEqual({passed:12,total:12});
  expect(post).toHaveBeenCalledTimes(12);
  const calls=f.provider.naive.createCalls.length;
  expect(await methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake})).toEqual(result);
  expect(post).toHaveBeenCalledTimes(12);expect(f.provider.naive.createCalls).toHaveLength(calls);
  const receipt=(await f.sql.query<{value:any}>("SELECT value FROM text_integration.checkpoints WHERE kind='naive_remediation_receipt'")).rows[0].value;
  expect(receipt.detailed.applied).toHaveLength(12);expect(receipt.detailed.executions).toHaveLength(12);
  expect((await f.sql.query("SELECT * FROM remediation_accounting.operations WHERE settlement IS NULL")).rows).toHaveLength(12);
 });
 it('uses canonical investigation, retained proposal-only result and replay without redispatch',async()=>{
  const f=await fixture();const runtime=await f.runtime();
  const suite=await runtime.methods.designSuite(f.ctx,f.intake);
  const run=await runtime.methods.runSuite(f.ctx,suite,f.target);
  const findings=await runtime.methods.investigate(f.ctx,suite,[run]);
  const finding=findings.find(f=>f.status==='confirmed')!;
  remediationStage.active=true;
  const methods=composeNaiveRemediationMethods(f.ctx,runtime);
  const result=await methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake});
  expect(result.verification.status).toBe('not_verified');
  expect(result.verification.after.total).toBe(0);
  expect(f.post).toHaveBeenCalledTimes(13);
  const calls=f.provider.naive.createCalls.length;
  expect(await methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake})).toEqual(result);
  expect(f.provider.naive.createCalls).toHaveLength(calls);
  expect((await f.pg.query("SELECT * FROM text_integration.checkpoints WHERE kind='naive_remediation_receipt'")).rows).toHaveLength(1);
  expect((await f.pg.query('SELECT * FROM remediations')).rows).toHaveLength(1);
  await expect(methods.proposeAndVerifyFix(f.ctx,{finding:{...finding,title:'Untrusted replacement'},suite,intake:f.intake})).rejects.toThrow();
  await f.pg.query("UPDATE jobs SET state='cancelled'");
  await expect(methods.proposeAndVerifyFix(f.ctx,{finding,suite,intake:f.intake})).rejects.toThrow();
  expect(f.provider.naive.createCalls).toHaveLength(calls);
 });
});
