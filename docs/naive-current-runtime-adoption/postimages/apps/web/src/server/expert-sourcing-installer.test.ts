import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import type {AgentSqlExecutor,AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {reviewDigest} from '@ae/core/evals/data/binding';
import {factualGapInputDigest} from '@ae/core/evals/text/factual-gap';
import {deriveFactualGapPlan,installFactualGapExpertPlan,type FactualGapPlanRequest} from './expert-data-plan';
import {issueSourcingPolicy,issueSourcingConsent} from './expert-sourcing-store';
import {assertFactualGapPlanCurrent} from './expert-data-plan-binding';
import {discoverSourcingLockKeys} from './expert-sourcing-bridge';
import type {withSourcingLocks} from './expert-sourcing-locks';
const databases:PGlite[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const p of databases.splice(0))await p.close();});
async function sqlFixture(){
 vi.stubEnv('EVAL_SERVICES','real');const pg=new PGlite();databases.push(pg);
 const jobId='123e4567-e89b-42d3-a456-426614174000',tenant='223e4567-e89b-42d3-a456-426614174000',versionLabel='generic-text-factual-gap-v1';
 await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY);CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text,is_mock boolean,state text,intake jsonb,created_at timestamptz DEFAULT now(),credentials_delete_after timestamptz);CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text);CREATE TABLE expert_automation_policies(id text PRIMARY KEY,enabled boolean,job_cap_micro_usd bigint,daily_cap_micro_usd bigint);CREATE TABLE expert_automation_scopes(job_id uuid,task_id text,tenant_id uuid,policy_id text,topic text,request_hash text,enabled boolean,customer_sharing_consent boolean,PRIMARY KEY(job_id,task_id));CREATE SCHEMA text_integration;CREATE TABLE text_integration.checkpoints(job_id uuid,kind text,id text,state text,input_digest text,value jsonb);CREATE SCHEMA expert_workflow;CREATE TABLE expert_workflow.plans(job_id uuid PRIMARY KEY,tenant_id uuid,input jsonb,input_digest text,topic text,enabled boolean,response_deadline timestamptz);CREATE TABLE experts(id text,email text,status text,source text,consent_flags jsonb);CREATE TABLE expert_automation_qualifications(expert_id text,topic text,qualified boolean,evidence jsonb,consent_receipt text,allowed_uses jsonb);CREATE TABLE contact_suppressions(email text);`);
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

async function installerFixture(){
 const f=await sqlFixture(),events:string[]=[];
 const sql:AgentTransactionalSql={query:f.tx.query,transaction:fn=>{events.push('transaction');return f.pg.transaction(p=>fn({query:(q,v)=>p.query(q,v)}));}};
 const withLocks:typeof withSourcingLocks=async(keys,work)=>{events.push(...keys);try{return await work(async()=>{events.push('held');});}finally{events.push('release');}};
 const deps={sql,withLocks};
 const qualify=()=>f.pg.exec(`INSERT INTO experts VALUES('expert','expert@example.com','active','opt_in','{"contactForPaidWork":true}');INSERT INTO expert_automation_qualifications VALUES('expert','Product',true,'["evidence"]','receipt','["evaluation"]');`);
 const counts=async()=>{const rows=await f.pg.query<{n:number}>(`SELECT (SELECT count(*) FROM expert_automation_scopes)+(SELECT count(*) FROM expert_sourcing.grants)+(SELECT count(*) FROM expert_workflow.plans) AS n`);return Number(rows.rows[0].n);};
 return {...f,deps,events,qualify,counts};
}
it('holds policy then job mutex before row transaction and atomically installs and replays',async()=>{
 const f=await installerFixture();await f.qualify();
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toMatchObject({status:'installed',contactGate:'opted_in'});
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toMatchObject({status:'replayed'});
 expect(await f.counts()).toBe(3);
 expect(f.events.slice(0,4)).toEqual([`expert-sourcing:policy:${f.policy.id}`,`expert-sourcing:job:${f.args.request.jobId}`,'held','transaction']);
 expect(f.events.at(-1)).toBe('release');
});
it('rolls back new scope and grant when qualification blocks, then retries cleanly',async()=>{
 const f=await installerFixture();
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toEqual({status:'prerequisite_blocked',reason:'expert_qualification'});
 expect(await f.counts()).toBe(0);await f.qualify();
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toMatchObject({status:'installed'});
});
it('rolls back authority on a later conflicting immutable plan',async()=>{
 const f=await installerFixture();await f.qualify();
 await f.pg.query(`INSERT INTO expert_workflow.plans VALUES($1,$2,'{}','bad','Product',true,now()+interval '1 hour')`,[f.args.request.jobId,f.args.input.factualGapEntry.tenantId]);
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toEqual({status:'rejected',reason:'plan_conflict'});
 expect(await f.counts()).toBe(1);
});
it('rejects a discovered policy mismatch under mutex without writes',async()=>{
 const f=await installerFixture();await f.qualify();
 const discoverLocks:typeof discoverSourcingLockKeys=async(sql,jobId)=>({...await discoverSourcingLockKeys(sql,jobId),policyId:'changed'});
 expect(await installFactualGapExpertPlan(f.args.request,{...f.deps,discoverLocks})).toEqual({status:'prerequisite_blocked',reason:'owner_policy'});
 expect(await f.counts()).toBe(0);
});
it('preserves revoked consent prerequisite status',async()=>{
 const f=await installerFixture();await f.qualify();
 await f.pg.exec("UPDATE expert_sourcing.consents SET revoked_at=now(),revoked_by=tenant_id::text,revocation_reason='revoked'");
 expect(await installFactualGapExpertPlan(f.args.request,f.deps)).toEqual({status:'prerequisite_blocked',reason:'sharing_consent'});
 expect(await f.counts()).toBe(0);
});

it('runtime binding rechecks live derived receipt and rejects absent factual metadata without legacy discriminator',async()=>{
 const f=await installerFixture();await f.qualify();
 await installFactualGapExpertPlan(f.args.request,f.deps);
 await expect(assertFactualGapPlanCurrent(f.tx,f.args.request.jobId)).resolves.toBeUndefined();
 await f.pg.exec("UPDATE expert_sourcing.consents SET revoked_at=now(),revoked_by=tenant_id::text,revocation_reason='revoked'");
 await expect(assertFactualGapPlanCurrent(f.tx,f.args.request.jobId)).rejects.toThrow('expert_sourcing_sharing_consent');
 await f.pg.exec("UPDATE expert_workflow.plans SET input=input-'factualGapEntry'");
 await expect(assertFactualGapPlanCurrent(f.tx,f.args.request.jobId)).rejects.toThrow();
});
