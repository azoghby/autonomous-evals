import { PGlite } from '@electric-sql/pglite';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Finding,JOB_STATES,type Remediation } from '@ae/core/contracts/index';
import { claimWorkflowStage,markWorkflowStagePending,registerWorkflowStageChild,recoverWorkflowStage,type WorkflowStageClaim } from '@ae/core/db/workflow-stage-authority';
import type { WorkflowStageScope } from './workflow-stage-runtime';
import { setJobState,recordProgress,saveFindings,saveRemediation,recordCost } from './job-store';
const state=vi.hoisted(()=>({scope:undefined as WorkflowStageScope|undefined,settle:vi.fn()}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>state.scope,workflowStageDigest:JSON.stringify}));
vi.mock('./cost-settlement',()=>({recordSettledCost:state.settle}));
vi.mock('@ae/core/db/client',()=>({db:()=>{throw Error('unexpected_unfenced_database');},schema:{}}));
vi.mock('@ae/core/adapters/index',()=>({createServiceAdapters:()=>({})}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifactText:vi.fn()}));
vi.mock('@ae/core/storage/crypto',()=>({decryptJson:vi.fn()}));
let pg:PGlite;
const job='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const claim:WorkflowStageClaim={jobId:job,ownerId:customer,environment:'test',stageKey:'report',inputDigest:'digest',role:'operator',amountMicroUsd:100,invocation:{workflowRunId:'run',stepId:'step',attempt:0},leaseMs:300000};
const tx:WorkflowStageScope['transaction']=fn=>pg.transaction(t=>fn({query:(s,p)=>t.query(s,p)}));
const finding=Finding.parse({id:'f1',title:'Unsupported claim',status:'confirmed',severity:'high',category:'unsupported_claim',description:'Evidence contradicts the answer',evidence:[{kind:'trace_excerpt',excerpt:'answer'}]});
const remediation:Remediation={findingId:'f1',kind:'prompt_patch',summary:'Require citations',rationale:'Support factual answers',patch:'Add citations',verification:{status:'verified',before:{passed:0,total:1},after:{passed:1,total:1},regressions:0,evidence:[]}};
async function findingId(){return (await pg.query<{id:string}>('SELECT id FROM findings WHERE job_id=$1 AND rerun_of_finding_id IS NULL',[job])).rows[0]!.id;}
beforeEach(async()=>{
 state.settle.mockReset();pg=new PGlite();
 await pg.exec(`CREATE TYPE job_state AS ENUM (${JOB_STATES.map(s=>`'${s}'`).join(',')});CREATE TYPE environment AS ENUM ('test','live');
 CREATE TABLE jobs(id uuid PRIMARY KEY,package text NOT NULL,customer_id uuid NOT NULL,environment environment NOT NULL,state job_state NOT NULL DEFAULT 'draft',intake jsonb NOT NULL DEFAULT '{}',budget_reserved_micro_usd bigint NOT NULL DEFAULT 0,error text,delivered_at timestamptz,neon_branch_id text,report_blob_path text,suite_blob_path text,workflow_run_id text,credentials_delete_after timestamptz,branch_delete_after timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid REFERENCES jobs(id),agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid REFERENCES jobs(id),micro_usd bigint,receipt_key text);
 CREATE TABLE progress_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES jobs(id),milestone text NOT NULL,message text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE findings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES jobs(id),finding_key text NOT NULL,data jsonb NOT NULL,rerun_of_finding_id uuid,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE remediations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES jobs(id),finding_row_id uuid NOT NULL UNIQUE REFERENCES findings(id),data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE SCHEMA agent_persistence;CREATE TABLE agent_persistence.reservations(id text PRIMARY KEY,job_id text,amount_micro_usd bigint,settled_micro_usd bigint,first_result jsonb,scopes jsonb DEFAULT '[]');`);
 await pg.exec(readFileSync(process.env.JOB_BUDGET_SQL??'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql','utf8'));
 await pg.exec(readFileSync(process.env.WORKFLOW_STAGE_SQL??'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql','utf8'));
 await pg.exec(readFileSync('docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql','utf8'));
 await pg.exec(readFileSync('docs/naive-stage-recovery-integration/sql/002-stage-progress.sql','utf8'));
 await pg.query('INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,$2,$3,$4),($5,$2,$3,$4)',[job,'trace_audit',customer,'test',other]);
 const decision=await tx(t=>claimWorkflowStage(t,claim));if(decision.kind!=='owned')throw Error('owner');state.scope={owner:decision.owner,transaction:tx};
});
afterEach(async()=>{state.scope=undefined;await pg.close();});
it('executes scoped state SQL with actual enum and every supported extra column',async()=>{
 const date=new Date('2026-11-08T12:00:00Z');
 await setJobState(job,'delivered',{error:null,deliveredAt:date,neonBranchId:'branch',reportBlobPath:'private/report',suiteBlobPath:'private/suite',workflowRunId:'workflow',credentialsDeleteAfter:date,branchDeleteAfter:date,budgetReservedMicroUsd:100});
 const row=(await pg.query('SELECT * FROM jobs WHERE id=$1',[job])).rows[0];expect(row).toMatchObject({state:'delivered',error:null,neon_branch_id:'branch',report_blob_path:'private/report',suite_blob_path:'private/suite',workflow_run_id:'workflow',budget_reserved_micro_usd:100});expect(new Date(row.delivered_at as string).toISOString()).toBe(date.toISOString());
 await expect(setJobState(job,'running',{error:undefined})).rejects.toThrow('workflow_stage_conflict');expect((await pg.query('SELECT state FROM jobs WHERE id=$1',[job])).rows[0]).toMatchObject({state:'delivered'});
});
it('executes scoped progress, original/rerun finding inserts and remediation upsert against real columns',async()=>{
 await recordProgress(job,'m'.repeat(110),'p'.repeat(1100));expect((await pg.query('SELECT milestone,message FROM progress_events')).rows[0]).toEqual({milestone:'m'.repeat(100),message:'p'.repeat(1000)});
 await saveFindings(job,[finding]);await saveFindings(job,[{...finding,title:'Do not replace original'}]);const id=await findingId();
 await saveFindings(job,[{...finding,title:'Rerun result'}],id);expect((await pg.query('SELECT * FROM findings')).rows).toHaveLength(2);
 expect((await pg.query<{data:unknown}>('SELECT data FROM findings WHERE id=$1',[id])).rows[0]!.data).toEqual(finding);
 await saveRemediation(job,id,remediation);await saveRemediation(job,id,{...remediation,summary:'Updated verification'});
 const rows=(await pg.query('SELECT * FROM remediations')).rows;expect(rows).toHaveLength(1);expect(rows[0]!.data).toEqual({...remediation,summary:'Updated verification'});
 await expect(saveRemediation(job,other,remediation)).rejects.toThrow('finding_job_mismatch');
});
it('denies all scoped publication SQL from an expired lease without writing rows',async()=>{
 await saveFindings(job,[finding]);const id=await findingId();await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second'");
 for(const write of [()=>setJobState(job,'delivered'),()=>recordProgress(job,'late','late'),()=>saveFindings(job,[{...finding,id:'f2'}]),()=>saveRemediation(job,id,remediation)])await expect(write()).rejects.toThrow('workflow_stage_conflict');
 expect((await pg.query('SELECT state FROM jobs WHERE id=$1',[job])).rows[0]).toMatchObject({state:'draft'});expect((await pg.query('SELECT * FROM findings')).rows).toHaveLength(1);expect((await pg.query('SELECT * FROM progress_events')).rows).toHaveLength(0);expect((await pg.query('SELECT * FROM remediations')).rows).toHaveLength(0);
});
it('denies old generation writes after concrete takeover while current generation can publish',async()=>{
 await saveFindings(job,[finding]);const id=await findingId(),old=state.scope!;
 await tx(t=>registerWorkflowStageChild(t,old.owner,{kind:'retained-test',operationKey:'task',requestDigest:'body'}));await tx(t=>markWorkflowStagePending(t,old.owner));
 const next=await tx(t=>recoverWorkflowStage(t,claim,{read:async()=>({state:'resumable',evidenceKey:'retained-test:task'})}));if(next.kind!=='owned')throw Error('owner');
 for(const write of [()=>setJobState(job,'delivered'),()=>recordProgress(job,'late','late'),()=>saveFindings(job,[{...finding,id:'f2'}]),()=>saveRemediation(job,id,remediation)])await expect(write()).rejects.toThrow('workflow_stage_conflict');
 state.scope={owner:next.owner,transaction:tx};await recordProgress(job,'recovered','current');expect((await pg.query('SELECT message FROM progress_events')).rows).toEqual([{message:'current'}]);
 await expect(setJobState(other,'running')).rejects.toThrow('workflow_stage_job_mismatch');
});
it('measured cost settlement remains available after owner expiry and bypasses publication fencing',async()=>{
 await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second'");
 const cost={jobId:job,source:'ai_gateway' as const,requestId:'measured-request',microUsd:7,meta:{measured:true}};
 await recordCost(cost,{ownerId:customer,environment:'test'});expect(state.settle).toHaveBeenCalledExactlyOnceWith({kind:'job',id:job,ownerId:customer,environment:'test'},cost);
 expect((await pg.query('SELECT * FROM progress_events')).rows).toHaveLength(0);
});

it.each(['cancelled','failed','delivered','paused_budget','payment_review'])('committed %s state revokes callback publication while retaining measured accounting',async status=>{
 await saveFindings(job,[finding]);const id=await findingId();
 await pg.query('UPDATE jobs SET state=$2 WHERE id=$1',[job,status]);
 for(const write of [()=>setJobState(job,'running'),()=>recordProgress(job,'late','late'),()=>saveFindings(job,[{...finding,id:'f2'}]),()=>saveRemediation(job,id,remediation)])await expect(write()).rejects.toThrow('workflow_stage_conflict');
 expect((await pg.query('SELECT state FROM jobs WHERE id=$1',[job])).rows[0]).toMatchObject({state:status});
 expect((await pg.query('SELECT * FROM findings')).rows).toHaveLength(1);
 expect((await pg.query('SELECT * FROM progress_events')).rows).toHaveLength(0);
 expect((await pg.query('SELECT * FROM remediations')).rows).toHaveLength(0);
 await recordCost({jobId:job,source:'ai_gateway',requestId:'late-measured',microUsd:7,meta:{measured:true}});
 expect(state.settle).toHaveBeenCalledOnce();
});

it('deduplicates identical progress across recovered generations while retaining changed messages',async()=>{
 await recordProgress(job,'audit','Working');await recordProgress(job,'audit','Working');
 await tx(t=>registerWorkflowStageChild(t,state.scope!.owner,{kind:'retained-test',operationKey:'task',requestDigest:'body'}));await tx(t=>markWorkflowStagePending(t,state.scope!.owner));
 const next=await tx(t=>recoverWorkflowStage(t,claim,{read:async()=>({state:'resumable',evidenceKey:'task'})}));if(next.kind!=='owned')throw Error('owner');state.scope={owner:next.owner,transaction:tx};
 await recordProgress(job,'audit','Working');await recordProgress(job,'audit','Finished');
 expect((await pg.query('SELECT message FROM progress_events ORDER BY created_at')).rows).toEqual([{message:'Working'},{message:'Finished'}]);
});
