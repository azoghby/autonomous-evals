import { describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { discoverSourcingLockKeys,assertDerivedSourcingAuthorityCurrent } from './expert-sourcing-bridge';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
function executor(rows:unknown[][]){const statements:string[]=[];const tx:AgentSqlExecutor={query:async(q)=>{statements.push(q);return {rows:rows.shift()??[]} as any;}};return {tx,statements};}
describe('derived sourcing authority fail-closed boundaries',()=>{
 it('discovers policy before job mutex without mutating authority',async()=>{const f=executor([[{id:'consent'}],[{id:'policy'}]]);expect(await discoverSourcingLockKeys(f.tx,'job')).toEqual({policyId:'policy',keys:['expert-sourcing:policy:policy','expert-sourcing:job:job']});expect(f.statements.every(q=>q.startsWith('SELECT'))).toBe(true);});
 it.each([[],[{id:'one'},{id:'two'}]])('rejects missing or ambiguous policy/consent joins',async rows=>{const f=executor([[{id:'consent'}],rows]);await expect(discoverSourcingLockKeys(f.tx,'job')).rejects.toThrow('expert_sourcing_owner_policy');});
 it('never treats missing receipt/discriminator as legacy',async()=>{const f=executor([[{input:{},enabled:true,current:true}],[{}]]);await expect(assertDerivedSourcingAuthorityCurrent(f.tx,'job','task')).rejects.toThrow('expert_sourcing_input_binding');expect(f.statements.every(q=>q.startsWith('SELECT'))).toBe(true);});
 it('permits only an explicitly configured legacy scope without factual metadata',async()=>{const f=executor([[{input:{},enabled:true,current:true}],[{authority_kind:'legacy_configured'}]]);await expect(assertDerivedSourcingAuthorityCurrent(f.tx,'job','task')).resolves.toBeUndefined();});
 it('does not let factual plans opt into legacy behavior',async()=>{const f=executor([[{input:{factualGapEntry:{}},enabled:false,current:true}],[{authority_kind:'legacy_configured'}]]);await expect(assertDerivedSourcingAuthorityCurrent(f.tx,'job','task')).rejects.toThrow();});
});

import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach} from 'vitest';
import {reviewDigest} from '@ae/core/evals/data/binding';
import {factualGapInputDigest} from '@ae/core/evals/text/factual-gap';
import {deriveFactualGapPlan,type FactualGapPlanRequest} from './expert-data-plan';
import {installDerivedSourcingAuthority} from './expert-sourcing-bridge';
import {issueSourcingPolicy,issueSourcingConsent,revokeSourcingConsent} from './expert-sourcing-store';
const databases:PGlite[]=[];afterEach(async()=>{vi.unstubAllEnvs();for(const p of databases.splice(0))await p.close();});
async function sqlFixture(){
 vi.stubEnv('EVAL_SERVICES','real');const pg=new PGlite();databases.push(pg);
 const jobId='123e4567-e89b-42d3-a456-426614174000',tenant='223e4567-e89b-42d3-a456-426614174000',versionLabel='generic-text-factual-gap-v1';
 await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY);CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text,is_mock boolean,state text,intake jsonb,created_at timestamptz DEFAULT now(),credentials_delete_after timestamptz);CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text);CREATE TABLE expert_automation_policies(id text PRIMARY KEY,enabled boolean,job_cap_micro_usd bigint,daily_cap_micro_usd bigint);CREATE TABLE expert_automation_scopes(job_id uuid,task_id text,tenant_id uuid,policy_id text,topic text,request_hash text,enabled boolean,customer_sharing_consent boolean,PRIMARY KEY(job_id,task_id));CREATE SCHEMA text_integration;CREATE TABLE text_integration.checkpoints(job_id uuid,kind text,id text,state text,input_digest text,value jsonb);CREATE SCHEMA expert_workflow;CREATE TABLE expert_workflow.plans(job_id uuid,input jsonb,input_digest text,topic text,enabled boolean,response_deadline timestamptz);`);
 await pg.exec(readFileSync('docs/naive-sourcing-authority-integration/sql/001-expert-sourcing-authority.sql','utf8'));
 const tx:AgentSqlExecutor={query:(q,p)=>pg.query(q,p)},intake={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/agent',model:'model',systemPrompt:'Answer product questions.'}};
 await pg.query('INSERT INTO customers VALUES($1)',[tenant]);await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb)`,[jobId,tenant,JSON.stringify(intake)]);await pg.exec("INSERT INTO expert_automation_policies VALUES('caps',true,25000000,50000000)");
 const request:FactualGapPlanRequest={jobId,environment:'test',taskId:'facts',versionLabel,canonicalInputDigest:reviewDigest({...intake,endpoint:{...intake.endpoint,referenceText:null},notes:null}),proposal:{schemaVersion:'text_factual_gap.v1',authority:'model_proposed_coverage_requires_owner_validation',inputDigest:factualGapInputDigest({job:{jobId,customerId:tenant,environment:'test'},versionLabel,systemPrompt:intake.endpoint.systemPrompt,referenceText:null}),requirements:[{reason:'factual_check_missing_reference',scenarioId:'S01',userMessage:'What are the limits?',check:{id:'S01.r1',kind:'rubric',description:'Limits',rubric:'Matches facts.',requiresReference:true,assessesFactualCorrectness:true}}]}};
 const targetDigest=reviewDigest({url:intake.endpoint.url,model:intake.endpoint.model,systemPrompt:intake.endpoint.systemPrompt}),input=deriveFactualGapPlan(request,{customer_id:tenant,intake},targetDigest),identity={jobId,customerId:tenant,environment:'test'};
 const profile={policyId:versionLabel,designId:versionLabel,versionLabel,admissionPolicyId:'automated-text-design-factual-gap-v1',factualGapPolicy:'propose_missing_reference.v1',expertTaskId:'facts'};
 for(const [kind,id,value] of [['naive_execution_policy','selection-v1',{schemaVersion:'naive_text_execution_selection.v1',identity,profile}],['naive_factual_gap_proposal','proposal-v1',{schemaVersion:'naive_factual_gap_retention.v1',identity,profile,canonicalInputDigest:request.canonicalInputDigest,targetDigest,proposal:request.proposal}]] as const)await pg.query("INSERT INTO text_integration.checkpoints VALUES($1,$2,$3,'completed',$4,$5::jsonb)",[jobId,kind,id,reviewDigest(value),JSON.stringify(value)]);
 const policy=await issueSourcingPolicy(tx,{tenantId:tenant,environment:'test',topic:'Product',capsPolicyId:'caps',maxRequirements:36,maxContextChars:16000,grantLifetimeSeconds:3600,expiresAt:'2099-01-01T00:00:00Z'},async()=>({operatorId:'operator'}));
 const auth=async()=>({customerId:tenant}),validate=async()=>({tenantId:tenant,environment:'test' as const,canonicalInputDigest:request.canonicalInputDigest});
 const consent=await issueSourcingConsent(tx,{jobId,topic:'Product',canonicalInputDigest:request.canonicalInputDigest,accepted:true,expiresAt:'2099-01-01T00:00:00Z'},auth,validate);
 const args={request,input,targetDigest};return {pg,tx,args,policy,consent,auth,validate};
}
it('SQL derives exact scope once, rejects changed proposal and revoked consent without overwrite',async()=>{
 const f=await sqlFixture();const install=()=>f.pg.transaction(p=>installDerivedSourcingAuthority({query:(q,v)=>p.query(q,v)},f.args,{expectedPolicyId:f.policy.id}));
 expect(await install()).toEqual({topic:'Product'});expect(await install()).toEqual({topic:'Product'});
 await f.pg.query(`INSERT INTO expert_workflow.plans VALUES($1,$2::jsonb,$3,'Product',true,now()+interval '1 hour')`,[f.args.request.jobId,JSON.stringify(f.args.input),reviewDigest(f.args.input)]);
 await assertDerivedSourcingAuthorityCurrent(f.tx,f.args.request.jobId,f.args.request.taskId);
 const row=(await f.pg.query<any>('SELECT * FROM expert_sourcing.grants')).rows[0];expect(row.request_hash).toBe(reviewDigest({task:f.args.input.task,topic:'Product'}));expect(row.input_digest).toBe(reviewDigest(f.args.input));
 const changed=structuredClone(f.args);changed.request.proposal.requirements[0].check.rubric='Changed';await expect(f.pg.transaction(p=>installDerivedSourcingAuthority({query:(q,v)=>p.query(q,v)},changed,{expectedPolicyId:f.policy.id}))).rejects.toThrow();
 expect((await f.pg.query('SELECT * FROM expert_sourcing.grants')).rows).toHaveLength(1);
 await revokeSourcingConsent(f.tx,{jobId:f.args.request.jobId,consentId:f.consent.id,reason:'withdraw'},f.auth,f.validate);await expect(install()).rejects.toThrow('sharing_consent');await expect(assertDerivedSourcingAuthorityCurrent(f.tx,f.args.request.jobId,f.args.request.taskId)).rejects.toThrow('sharing_consent');
});
it('SQL caller rollback removes both exact scope and immutable receipt',async()=>{const f=await sqlFixture();await expect(f.pg.transaction(async p=>{await installDerivedSourcingAuthority({query:(q,v)=>p.query(q,v)},f.args,{expectedPolicyId:f.policy.id});throw Error('abort-plan');})).rejects.toThrow('abort-plan');expect((await f.pg.query('SELECT * FROM expert_sourcing.grants')).rows).toHaveLength(0);expect((await f.pg.query('SELECT * FROM expert_automation_scopes')).rows).toHaveLength(0);});
