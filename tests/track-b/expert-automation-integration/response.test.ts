import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSqlExpertResponseService } from '../../../apps/web/src/server/automated-expert-responses';
import type { AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';
import { taskKeyFor, type AgentTaskRunner } from '../../../packages/core/src/agents/session-service';
import type { DataTaskSpec } from '../../../packages/core/src/evals/data/types';
import type { ExpertLoopScope } from '../../../packages/core/src/evals/data/adapters/automated-expert';

const tenant='123e4567-e89b-42d3-a456-426614174000',job='123e4567-e89b-42d3-a456-426614174001';
const expert='123e4567-e89b-42d3-a456-426614174002',request='123e4567-e89b-42d3-a456-426614174003';
const engagement='123e4567-e89b-42d3-a456-426614174004',response='123e4567-e89b-42d3-a456-426614174005',draft='123e4567-e89b-42d3-a456-426614174006';
const scope:ExpertLoopScope={operationId:'expert-response-operation',taskId:'task-one',jobId:job,requestHash:'a'.repeat(64)};
const task:DataTaskSpec={jobId:job,taskId:scope.taskId,targetId:'target-one',description:'Arithmetic cases',requirements:[{id:'addition',description:'Addition',minimumCases:1}],factualAnswersRequired:true};
const extraction={cases:[{input:{questionIndex:0,start:0,end:5,quote:'1 + 1'},answer:{questionIndex:0,start:8,end:9,quote:'2'},requirementIds:['addition']}]};
const source={url:'https://evidence.example/response',retrievedAt:'2026-11-07T00:00:00Z',license:{name:'Explicit grant',url:'https://evidence.example/terms',permission:'allowed',allowedUses:['evaluation']}};
let pg:PGlite,calls=0,costs=0,secrets:string[]=[],during:()=>Promise<void>=async()=>{};
const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
const runner:AgentTaskRunner={async run(spec){calls++;await during();return {status:'completed',taskKey:taskKeyFor(spec.job.jobId,spec.role,spec.purpose,1),output:extraction as never,
 session:{sessionId:'fixture-session',agentId:'fixture-agent',agentVersion:1,consumedMicroUsd:7,tokenUsage:{}},
 cost:{jobId:job,source:'naive_session',role:spec.role,purpose:spec.purpose,externalId:'fixture-session',microUsd:7,measured:true,recordedAt:'2026-11-07T00:00:00Z'}};}};
function service(){return createSqlExpertResponseService(sql,{scope,tenantId:tenant,topic:'Arithmetic',runner,
 job:{jobId:job,customerId:tenant,package:'text_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null},sessionCapMicroUsd:1000,jobCapMicroUsd:5000,
 onMeasuredCost:async()=>{costs++;},knownSecrets:()=>secrets});}
beforeAll(async()=>{pg=new PGlite();const root=new URL('../../../packages/core/src/',import.meta.url),dir=new URL('db/migrations/',root);const journal=JSON.parse(readFileSync(new URL('meta/_journal.json',dir),'utf8')) as {entries:{tag:string}[]};for(const e of journal.entries)await pg.exec(readFileSync(new URL(e.tag+'.sql',dir),'utf8'));if(!journal.entries.some(e=>e.tag==='0024_expert_automation'))await pg.exec(readFileSync(new URL('0024_expert_automation.sql',dir),'utf8'));});
afterAll(async()=>{await pg.close();});
beforeEach(async()=>{
 calls=0;costs=0;secrets=[];during=async()=>{};
 await pg.exec('TRUNCATE experts,outreach_drafts,contact_suppressions,customers CASCADE');
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2)',[tenant,'private@example.test']);
 await pg.query("INSERT INTO jobs(id,customer_id,package,intake) VALUES($1,$2,'text_eval','{}')",[job,tenant]);
 await pg.query("INSERT INTO experts(id,email,name,title,source,consent_flags) VALUES($1,'private-expert@example.test','Private Name','Teacher','opt_in','{\"contactForPaidWork\":true}')",[expert]);
 await pg.exec("INSERT INTO expert_automation_policies VALUES('pilot',true,25000000,50000000) ON CONFLICT(id) DO UPDATE SET enabled=true");
 await pg.query("INSERT INTO expert_automation_scopes(job_id,task_id,tenant_id,request_hash,policy_id,topic,enabled) VALUES($1,$2,$3,$4,'pilot','Arithmetic',true)",[job,scope.taskId,tenant,scope.requestHash]);
 await pg.query("INSERT INTO expert_requests(id,job_id,domain,questions,purpose,max_budget_cents) VALUES($1,$2,'Arithmetic','[\"Provide a case and answer\"]','Independent cases',2500)",[request,job]);
 await pg.query('INSERT INTO expert_automation_operations(operation_id,job_id,task_id,tenant_id,request_hash,request_id) VALUES($1,$2,$3,$4,$5,$6)',[scope.operationId,job,scope.taskId,tenant,scope.requestHash,request]);
 await pg.query("INSERT INTO outreach_drafts(id,to_email,subject,body,status,kind) VALUES($1,'private-expert@example.test','Case request','Contribute cases','sent','expert_invite')",[draft]);
 await pg.query("INSERT INTO expert_engagements(id,request_id,expert_id,token_hash,expires_at,honorarium_cents,outreach_draft_id,status) VALUES($1,$2,$3,'private-token',now()+interval '7 days',2500,$4,'answered')",[engagement,request,expert,draft]);
 await pg.query("INSERT INTO expert_automation_invitations(operation_id,expert_id,engagement_id,draft_id,invitation_digest,amount_micro_usd,promised,send_state) VALUES($1,$2,$3,$4,$5,25000000,true,'sent')",[scope.operationId,expert,engagement,draft,'b'.repeat(64)]);
 await pg.query("INSERT INTO expert_responses(id,engagement_id,answers,provenance) VALUES($1,$2,$3::jsonb,'expert_sourced')",[response,engagement,JSON.stringify([{questionIndex:0,answer:'1 + 1 = 2'}])]);
 await pg.query("INSERT INTO expert_automation_qualifications(expert_id,topic,qualified,evidence,allowed_uses,consent_receipt,contribution_source) VALUES($1,'Arithmetic',true,'[\"https://evidence.example/qualification\"]','[\"evaluation\"]','https://evidence.example/consent',$2::jsonb)",[expert,JSON.stringify(source)]);
});
describe('actual SQL questionnaire response ingestion',()=>{
 it('maps actual stored answers to exact unapproved candidates without exporting private identity',async()=>{
  const result=await service().extract(task,engagement);expect(result.status).toBe('candidate');expect(calls).toBe(1);expect(costs).toBe(1);
  if(result.status!=='candidate')throw Error(result.reason);
  expect(result.contribution.cases[0]).toMatchObject({input:'1 + 1',expectedAnswer:'2',synthetic:false});
  expect(result.contribution.cases[0]?.verification).toBeUndefined();expect(result.contribution.sources[0]?.review.status).toBe('pending');
  expect(JSON.stringify(result)).not.toContain('private');expect(result.contribution.contributorId).toBe(expert);
  expect((await pg.query('SELECT * FROM expert_automation_response_bindings')).rows).toHaveLength(1);
  expect(await service().extract(task,engagement)).toEqual(result);
 });
 it.each(['source','consent','qualification'])('leaves missing %s evidence pending before model spend',async kind=>{
  if(kind==='source')await pg.exec('UPDATE expert_automation_qualifications SET contribution_source=NULL');
  if(kind==='consent')await pg.exec("UPDATE expert_automation_qualifications SET allowed_uses='[]',consent_receipt=''");
  if(kind==='qualification')await pg.exec('UPDATE expert_automation_qualifications SET qualified=false');
  expect((await service().extract(task,engagement)).status).toBe('pending');expect(calls).toBe(0);
 });
 it('refuses changed persisted response identity across reader instances',async()=>{
  expect((await service().read(engagement)).status).toBe('received');
  await pg.exec(`UPDATE expert_responses SET answers='[{"questionIndex":0,"answer":"changed response"}]'`);
  expect(await service().read(engagement)).toEqual({status:'pending',reason:'response_identity_changed'});
  expect((await service().extract(task,engagement)).status).toBe('pending');expect(calls).toBe(0);
 });
 it.each(['consent','qualification','scope','secret','source'] )('rechecks %s after awaited model completion before publication',async kind=>{
  during=async()=>{
   if(kind==='consent')await pg.exec("UPDATE expert_automation_qualifications SET allowed_uses='[]'");
   if(kind==='qualification')await pg.exec('UPDATE expert_automation_qualifications SET qualified=false');
   if(kind==='scope')await pg.exec('UPDATE expert_automation_scopes SET enabled=false');
   if(kind==='secret')secrets=['1 + 1'];
   if(kind==='source')await pg.exec('UPDATE expert_automation_qualifications SET contribution_source=NULL');
  };
  const result=await service().extract(task,engagement);expect(result.status).toBe('pending');expect(calls).toBe(1);expect(costs).toBe(1);
  expect(JSON.stringify(result)).not.toContain('1 + 1');
 });
 it('rejects a different operation engagement and ambiguous multiple response rows',async()=>{
  expect((await service().read('123e4567-e89b-42d3-a456-426614174099')).status).toBe('pending');
  await pg.query("INSERT INTO expert_responses(engagement_id,answers) VALUES($1,'[{\"questionIndex\":0,\"answer\":\"extra\"}]')",[engagement]);
  expect(await service().read(engagement)).toEqual({status:'pending',reason:'response_missing_or_ambiguous'});expect(calls).toBe(0);
 });
});
