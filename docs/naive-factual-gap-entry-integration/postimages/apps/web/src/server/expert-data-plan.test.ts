import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,expect,it,vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { factualGapInputDigest } from '@ae/core/evals/text/factual-gap';
import { deriveFactualGapPlan,installFactualGapExpertPlan,type FactualGapPlanRequest } from './expert-data-plan';
const jobId='123e4567-e89b-42d3-a456-426614174000',tenant='223e4567-e89b-42d3-a456-426614174000',expert='323e4567-e89b-42d3-a456-426614174000';
const dbs:PGlite[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const pg of dbs.splice(0))await pg.close();});
async function fixture(){
 vi.stubEnv('EVAL_SERVICES','real');
 const pg=new PGlite();dbs.push(pg);
 await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY);CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text,is_mock boolean,state text,intake jsonb,created_at timestamptz DEFAULT now(),credentials_delete_after timestamptz);
 CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text);CREATE TABLE experts(id uuid PRIMARY KEY,email text,status text,source text,consent_flags jsonb);
 CREATE TABLE expert_requests(id uuid PRIMARY KEY);CREATE TABLE expert_engagements(id uuid PRIMARY KEY);CREATE TABLE outreach_drafts(id uuid PRIMARY KEY);
 CREATE TABLE expert_responses(id uuid PRIMARY KEY);CREATE TABLE contact_suppressions(email text);`);
 for(const file of ['0024_expert_automation.sql','0025_expert_workflow.sql'])await pg.exec(readFileSync(resolve('packages/core/src/db/migrations',file),'utf8'));
 const intake={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/agent',model:'model',systemPrompt:'Answer product questions.'}};
 await pg.query('INSERT INTO customers VALUES($1)',[tenant]);
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb)`,[jobId,tenant,JSON.stringify(intake)]);
 const request:FactualGapPlanRequest={jobId,environment:'test',taskId:'factual-entry-v1',versionLabel:'v1',canonicalInputDigest:reviewDigest({...intake,endpoint:{...intake.endpoint,referenceText:null},notes:null}),proposal:{schemaVersion:'text_factual_gap.v1',authority:'model_proposed_coverage_requires_owner_validation',inputDigest:factualGapInputDigest({job:{jobId,customerId:tenant,environment:'test'},versionLabel:'v1',systemPrompt:intake.endpoint.systemPrompt,referenceText:null}),requirements:[{reason:'factual_check_missing_reference',scenarioId:'S01',userMessage:'What are the limits?',check:{id:'S01.r1',kind:'rubric',description:'Product limits',rubric:'Matches product facts.',requiresReference:true,assessesFactualCorrectness:true}}]}};
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const deps={sql,decryptCredentials:()=>({endpoint:'fixture-private-secret'})};
 const plan=deriveFactualGapPlan(request,{customer_id:tenant,intake},reviewDigest({url:intake.endpoint.url,model:intake.endpoint.model,systemPrompt:intake.endpoint.systemPrompt}));
 async function configure(){
  await pg.query(`INSERT INTO expert_automation_policies VALUES('pilot',true,25000000,50000000)`);
  await pg.query(`INSERT INTO expert_automation_scopes VALUES($1,$2,$3,$4,'pilot','Product support',true,true)`,[jobId,request.taskId,tenant,reviewDigest({task:plan.task,topic:'Product support'})]);
  await pg.query(`INSERT INTO experts VALUES($1,'expert@example.com','active','opt_in','{"contactForPaidWork":true}'::jsonb)`,[expert]);
  await pg.query(`INSERT INTO expert_automation_qualifications VALUES($1,'Product support',true,'["owner recorded evidence"]'::jsonb,'["evaluation"]'::jsonb,'consent-receipt',null)`,[expert]);
 }
 async function count(){return (await pg.query<{n:number}>('SELECT count(*)::int AS n FROM expert_workflow.plans')).rows[0].n;}
 return {pg,sql,deps,intake,request,plan,configure,count};
}
it('installs exact existing owner scope once; retains proposal and canonical target; replay has no sends or promises',async()=>{
 const f=await fixture();await f.configure();
 const first=await installFactualGapExpertPlan(f.request,f.deps);expect(first).toMatchObject({status:'installed',proposalDigest:reviewDigest(f.request.proposal)});
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toEqual({...first,status:'replayed'});
 const row=(await f.pg.query<{input:unknown;input_digest:string;enabled:boolean}>('SELECT input,input_digest,enabled FROM expert_workflow.plans')).rows[0];
 expect(row.input).toEqual(f.plan);expect(row.input_digest).toBe(reviewDigest(f.plan));expect(row.enabled).toBe(true);
 for(const table of ['expert_automation_operations','expert_automation_invitations','outreach_drafts','expert_requests','expert_workflow.contribution_reviews'])expect((await f.pg.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
});
it('missing scope, policy, sharing consent and qualifications remain prerequisites; no authority is invented',async()=>{
 const f=await fixture();expect(await installFactualGapExpertPlan(f.request,f.deps)).toEqual({status:'prerequisite_blocked',reason:'owner_scope'});await f.configure();
 for(const [update,reason,restore] of [
  ["UPDATE expert_automation_policies SET enabled=false",'owner_policy',"UPDATE expert_automation_policies SET enabled=true"],
  ["UPDATE expert_automation_scopes SET customer_sharing_consent=false",'sharing_consent',"UPDATE expert_automation_scopes SET customer_sharing_consent=true"],
  ["UPDATE expert_automation_qualifications SET qualified=false",'expert_qualification',"UPDATE expert_automation_qualifications SET qualified=true"],
  ["UPDATE expert_automation_qualifications SET consent_receipt=''",'expert_qualification',"UPDATE expert_automation_qualifications SET consent_receipt='consent-receipt'"],
 ] as const){await f.pg.exec(update);expect(await installFactualGapExpertPlan(f.request,f.deps)).toEqual({status:'prerequisite_blocked',reason});expect(await f.count()).toBe(0);await f.pg.exec(restore);}
});
it('foreign target, environment, tenant or altered proposal cannot reuse an authorized scope',async()=>{
 const f=await fixture();await f.configure();
 expect(await installFactualGapExpertPlan({...f.request,environment:'live'},f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'job_scope'});
 expect(await installFactualGapExpertPlan({...f.request,canonicalInputDigest:'0'.repeat(64)},f.deps)).toMatchObject({status:'rejected',reason:'input_binding'});
 const changed=structuredClone(f.request);changed.proposal.requirements[0].check.rubric='Changed facts.';
 expect(await installFactualGapExpertPlan(changed,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'owner_scope'});
 await f.pg.query(`UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,url}','"https://other.example.com/agent"'::jsonb) WHERE id=$1`,[jobId]);
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'rejected',reason:'input_binding'});expect(await f.count()).toBe(0);
});
it('rechecks canonical authority inside the write transaction and respects revocation on replay',async()=>{
 const f=await fixture();await f.configure();
 const racing={...f.deps,sql:{query:f.sql.query,transaction:async<T>(fn:Parameters<AgentTransactionalSql['transaction']>[0])=>{await f.pg.exec("UPDATE expert_automation_scopes SET enabled=false");return f.sql.transaction(fn) as Promise<T>;}}};
 expect(await installFactualGapExpertPlan(f.request,racing)).toMatchObject({status:'prerequisite_blocked',reason:'owner_scope'});expect(await f.count()).toBe(0);
 await f.pg.exec('UPDATE expert_automation_scopes SET enabled=true');await installFactualGapExpertPlan(f.request,f.deps);
 await f.pg.exec('UPDATE expert_workflow.plans SET enabled=false');expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'owner_scope'});
 expect((await f.pg.query<{enabled:boolean}>('SELECT enabled FROM expert_workflow.plans')).rows[0].enabled).toBe(false);
});
it('refuses a conflicting immutable plan and independently enforces real mode, secret and deadline gates',async()=>{
 const f=await fixture();await f.configure();
 await f.pg.query(`INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic) VALUES($1,$2,$3::jsonb,$4,'Other topic')`,[jobId,tenant,JSON.stringify(f.plan),reviewDigest(f.plan)]);
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'rejected',reason:'plan_conflict'});
 vi.stubEnv('EVAL_SERVICES','lite');expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'real_mode'});vi.stubEnv('EVAL_SERVICES','real');
 await f.pg.exec("UPDATE jobs SET created_at=now()-interval '8 days'");expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'deadline'});
});
it('secret-bearing proposal never enters plans even with a typed shape',async()=>{
 const f=await fixture();await f.pg.query('INSERT INTO job_credentials VALUES($1,$2)',[jobId,'encrypted']);
 const request=structuredClone(f.request);request.proposal.requirements[0].userMessage='fixture-private-secret';
 expect(await installFactualGapExpertPlan(request,f.deps)).toMatchObject({status:'rejected',reason:'unsafe_input'});expect(await f.count()).toBe(0);
});

it('requires qualification evidence, allowed evaluation use and absence of suppression; cold status grants no send',async()=>{
 const f=await fixture();await f.configure();
 for(const [update,restore] of [
  ["UPDATE expert_automation_qualifications SET evidence='[]'::jsonb","UPDATE expert_automation_qualifications SET evidence='[\"owner evidence\"]'::jsonb"],
  ["UPDATE expert_automation_qualifications SET allowed_uses='[]'::jsonb","UPDATE expert_automation_qualifications SET allowed_uses='[\"evaluation\"]'::jsonb"],
  ["INSERT INTO contact_suppressions VALUES('expert@example.com')","DELETE FROM contact_suppressions"],
 ] as const){await f.pg.exec(update);expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'expert_qualification'});expect(await f.count()).toBe(0);await f.pg.exec(restore);}
 await f.pg.exec("UPDATE experts SET source='cold',consent_flags='{}'::jsonb");
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'installed',contactGate:'cold_approval_required'});
 expect((await f.pg.query<{n:number}>('SELECT count(*)::int AS n FROM expert_automation_invitations')).rows[0].n).toBe(0);
});
it('refuses canonical customer changes before write and does not alter immutable plan input',async()=>{
 const f=await fixture();await f.configure();
 const other='423e4567-e89b-42d3-a456-426614174000';await f.pg.query('INSERT INTO customers VALUES($1)',[other]);
 const racing={...f.deps,sql:{query:f.sql.query,transaction:async<T>(fn:Parameters<AgentTransactionalSql['transaction']>[0])=>{await f.pg.query('UPDATE jobs SET customer_id=$1',[other]);return f.sql.transaction(fn) as Promise<T>;}}};
 expect(await installFactualGapExpertPlan(f.request,racing)).toMatchObject({status:'rejected',reason:'input_binding'});expect(await f.count()).toBe(0);
 await f.pg.query('UPDATE jobs SET customer_id=$1',[tenant]);await installFactualGapExpertPlan(f.request,f.deps);
 await expect(f.pg.exec("UPDATE expert_workflow.plans SET topic='rewritten'")).rejects.toThrow('immutable expert task authority');
});

it('refuses expired, missing required and inline plaintext credentials before installing any plan',async()=>{
 const f=await fixture();await f.configure();
 await f.pg.exec("UPDATE jobs SET credentials_delete_after=now()-interval '1 second'");
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'credentials'});
 await f.pg.exec("UPDATE jobs SET credentials_delete_after=null,intake=jsonb_set(intake,'{_credentialSlots}','[\"endpoint\"]'::jsonb)");
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'prerequisite_blocked',reason:'credentials'});
 await f.pg.exec("UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,apiKey}','\"plaintext-key\"'::jsonb)");
 expect(await installFactualGapExpertPlan(f.request,f.deps)).toMatchObject({status:'rejected',reason:'unsafe_input'});expect(await f.count()).toBe(0);
});
it('binds the secured target version without retaining keys and refuses credential rotation',async()=>{
 const f=await fixture();await f.configure();
 await f.pg.exec("UPDATE jobs SET intake=jsonb_set(intake,'{_credentialSlots}','[\"endpoint\"]'::jsonb)");
 await f.pg.query('INSERT INTO job_credentials VALUES($1,$2)',[jobId,'encrypted-v1']);
 const target={url:f.intake.endpoint.url,model:f.intake.endpoint.model,systemPrompt:f.intake.endpoint.systemPrompt,apiKey:'first-private-key'};
 const bound=deriveFactualGapPlan(f.request,{customer_id:tenant,intake:f.intake},reviewDigest(target));
 await f.pg.query('UPDATE expert_automation_scopes SET request_hash=$1',[reviewDigest({task:bound.task,topic:'Product support'})]);
 const deps={...f.deps,decryptCredentials:(cipher:string)=>({endpoint:cipher==='encrypted-v1'?'first-private-key':'rotated-private-key'})};
 expect(await installFactualGapExpertPlan(f.request,deps)).toMatchObject({status:'installed'});
 const input=(await f.pg.query<{input:unknown}>('SELECT input FROM expert_workflow.plans')).rows[0].input;
 expect(input).toEqual(bound);expect(JSON.stringify(input)).not.toContain('first-private-key');
 await f.pg.query('UPDATE job_credentials SET ciphertext=$1',['encrypted-v2']);
 expect(await installFactualGapExpertPlan(f.request,deps)).toMatchObject({status:'prerequisite_blocked',reason:'owner_scope'});
});
it('rechecks credentials after initial resolution and current schema rejects unsupported lower honorarium caps',async()=>{
 const f=await fixture();await f.configure();
 await f.pg.exec("UPDATE jobs SET intake=jsonb_set(intake,'{_credentialSlots}','[\"endpoint\"]'::jsonb)");
 await f.pg.query('INSERT INTO job_credentials VALUES($1,$2)',[jobId,'encrypted-v1']);
 const deps={...f.deps,decryptCredentials:(cipher:string)=>({endpoint:cipher==='encrypted-v1'?'first-private-key':'rotated-private-key'})};
 const racing={...deps,sql:{query:f.sql.query,transaction:async<T>(fn:Parameters<AgentTransactionalSql['transaction']>[0])=>{await f.pg.query('UPDATE job_credentials SET ciphertext=$1',['encrypted-v2']);return f.sql.transaction(fn) as Promise<T>;}}};
 expect(await installFactualGapExpertPlan(f.request,racing)).toMatchObject({status:'rejected',reason:'input_binding'});expect(await f.count()).toBe(0);
 await expect(f.pg.exec('UPDATE expert_automation_policies SET job_cap_micro_usd=1000000')).rejects.toThrow();
});
