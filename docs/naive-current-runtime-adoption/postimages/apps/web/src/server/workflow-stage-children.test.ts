import { PGlite } from '@electric-sql/pglite';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AgentTaskRecord,NaiveSessionsPort } from '@ae/core/evals/types';
import { claimWorkflowStage,markWorkflowStagePending,recoverWorkflowStage,type WorkflowStageClaim } from '@ae/core/db/workflow-stage-authority';
import type { WorkflowStageScope } from './workflow-stage-runtime';
import { fenceWorkflowStageSessions,fenceWorkflowStageRunner,publishWorkflowStage,workflowStageRecoveryReader } from './workflow-stage-children';
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>undefined,workflowStageDigest:(v:unknown)=>{function stable(x:unknown):string{if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable((x as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(x);}return createHash('sha256').update(stable(v)).digest('hex');}}));
let pg:PGlite,scope:WorkflowStageScope;
const job='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222';
const claim:WorkflowStageClaim={jobId:job,ownerId:customer,environment:'test',stageKey:'audit',inputDigest:'digest',role:'investigator',amountMicroUsd:100,invocation:{workflowRunId:'run',stepId:'step',attempt:0},leaseMs:300000};
let record:AgentTaskRecord;
const tx:WorkflowStageScope['transaction']=fn=>pg.transaction(t=>fn({query:(s,p)=>t.query(s,p)}));
async function save(){await pg.query('INSERT INTO agent_persistence.tasks(task_key,record) VALUES($1,$2::jsonb) ON CONFLICT(task_key) DO UPDATE SET record=excluded.record',[record.taskKey,JSON.stringify(record)]);}
const provider=()=>({createSession:vi.fn(async()=>({id:'session'})),getSession:vi.fn(async()=>({id:'session'})),listAgentSessions:vi.fn(async()=>({data:[],nextCursor:null}))}) as unknown as NaiveSessionsPort;
beforeEach(async()=>{
 pg=new PGlite();await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,customer_id uuid,environment text,state text NOT NULL DEFAULT 'running',budget_reserved_micro_usd bigint DEFAULT 0);CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text);CREATE SCHEMA agent_persistence;CREATE TABLE agent_persistence.tasks(task_key text PRIMARY KEY,record jsonb);CREATE TABLE agent_persistence.reservations(id text PRIMARY KEY,job_id text,amount_micro_usd bigint,settled_micro_usd bigint,first_result jsonb,scopes jsonb DEFAULT '[]');`);
 await pg.exec(readFileSync(process.env.JOB_BUDGET_SQL??'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql','utf8'));
 await pg.exec(readFileSync(process.env.WORKFLOW_STAGE_SQL??'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql','utf8'));
 await pg.exec(readFileSync('docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql','utf8'));
 await pg.exec("CREATE TABLE IF NOT EXISTS customers(id uuid PRIMARY KEY,email text)");
 await pg.exec(readFileSync('docs/naive-cancellation-integration/sql/001-job-cancellation.sql','utf8'));
 await pg.exec(readFileSync('docs/naive-stage-recovery-integration/sql/002-stage-progress.sql','utf8'));
 await pg.exec(readFileSync('docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql','utf8'));
 await pg.query('INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,$2,$3,$4)',[job,'trace_audit',customer,'test']);
 const owned=await tx(t=>claimWorkflowStage(t,claim));if(owned.kind!=='owned')throw Error('owner');scope={owner:owned.owner,transaction:tx};
 record={taskKey:`${job}:quality_investigator:audit:1`,jobId:job,idempotencyKey:'immutable-key',revision:0,state:'creating',requestBody:{agent_id:'agent',message:'hello',budget_micro_usd:100,structured_output_required:true,output_schema:{type:'object'},metadata:{ae_job_id:job,ae_task_key:`${job}:quality_investigator:audit:1`}},sessionId:null,result:null,consumedMicroUsd:null} as AgentTaskRecord;await save();
});
afterEach(async()=>{await pg.close();});
it('commits exact retained intent before provider call and permits same-key protocol replay',async()=>{
 const port=provider();vi.mocked(port.createSession).mockImplementation(async()=>{expect((await pg.query('SELECT * FROM workflow_stage.children')).rows[0]).toMatchObject({operation_key:record.taskKey,dispatch_generation:1});return {id:'session'} as never;});
 const wrapped=fenceWorkflowStageSessions(port,()=>scope);await wrapped.createSession(record.requestBody,record.idempotencyKey);record.state='ambiguous';await save();await wrapped.createSession(record.requestBody,record.idempotencyKey);expect(port.createSession).toHaveBeenCalledTimes(2);expect((await pg.query('SELECT * FROM workflow_stage.children')).rows).toHaveLength(1);
});
it('rejects changed bodies keys missing records and cross-job bodies without provider calls',async()=>{
 const port=provider(),wrapped=fenceWorkflowStageSessions(port,()=>scope);
 for(const [body,key] of [[{...record.requestBody,message:'changed'},record.idempotencyKey],[record.requestBody,'new-key'],[{...record.requestBody,metadata:{ae_task_key:'missing',ae_job_id:job}},record.idempotencyKey]])await expect(wrapped.createSession(body as typeof record.requestBody,key as string)).rejects.toThrow('reconciliation_required');expect(port.createSession).not.toHaveBeenCalled();
});
it('recovers accepted-create lost response using real retained task evidence and fences stale/new children',async()=>{
 const port=provider(),old=scope,wrapped=fenceWorkflowStageSessions(port,()=>scope);await wrapped.createSession(record.requestBody,record.idempotencyKey);record.state='ambiguous';await save();await tx(t=>markWorkflowStagePending(t,old.owner));
 const next=await tx(t=>recoverWorkflowStage(t,{...claim,invocation:{...claim.invocation,stepId:'poll'}},workflowStageRecoveryReader));if(next.kind!=='owned')throw Error('owner');scope={owner:next.owner,transaction:tx};
 await expect(fenceWorkflowStageSessions(port,()=>old).createSession(record.requestBody,record.idempotencyKey)).rejects.toThrow();await wrapped.createSession(record.requestBody,record.idempotencyKey);
 record={...record,taskKey:'fresh',idempotencyKey:'fresh-key',requestBody:{...record.requestBody,metadata:{ae_job_id:job,ae_task_key:'fresh'}}};await save();await expect(wrapped.createSession(record.requestBody,record.idempotencyKey)).rejects.toThrow();expect(port.createSession).toHaveBeenCalledTimes(2);
});
it('publication rollback uses the same transaction and stale owners cannot publish',async()=>{
 await expect(publishWorkflowStage(async t=>{await t.query('UPDATE jobs SET package=$2 WHERE id=$1',[job,'text_eval']);throw Error('crash');},scope)).rejects.toThrow('crash');expect((await pg.query('SELECT package FROM jobs')).rows[0]).toMatchObject({package:'trace_audit'});
 await tx(t=>markWorkflowStagePending(t,scope.owner));await expect(publishWorkflowStage(async()=>true,scope)).rejects.toThrow();await expect(publishWorkflowStage(async()=>true)).rejects.toThrow('scope_required');
});
it('reads remain available after ownership loss; unsupported or altered recovery evidence stays unknown',async()=>{
 const port=provider(),wrapped=fenceWorkflowStageSessions(port,()=>scope);await tx(t=>markWorkflowStagePending(t,scope.owner));await wrapped.getSession('session');await wrapped.listAgentSessions('agent',{limit:1});expect(port.getSession).toHaveBeenCalled();
 for(const kind of ['gateway','naive_session'])expect(await tx(t=>workflowStageRecoveryReader.read(t,{jobId:job,stageKey:'audit',kind,operationKey:record.taskKey,requestDigest:'wrong',dispatchIntent:true}))).toMatchObject({state:'unknown'});
});

it('registers completed task replay without create and recovers terminal retained result across polling',async()=>{
 record={...record,state:'completed',sessionId:'session',consumedMicroUsd:9,result:{ok:true}};await save();
 const run=vi.fn(async()=>({status:'completed',taskKey:record.taskKey,output:{ok:true}}));
 const runner=fenceWorkflowStageRunner({run} as never,()=>scope);
 await runner.run({job:{jobId:job},role:'quality_investigator',purpose:'audit'} as never);
 expect(run).toHaveBeenCalledTimes(1);expect((await pg.query('SELECT * FROM workflow_stage.children')).rows).toHaveLength(1);
 await tx(t=>markWorkflowStagePending(t,scope.owner));
 expect(await tx(t=>recoverWorkflowStage(t,{...claim,invocation:{...claim.invocation,stepId:'next-poll'}},workflowStageRecoveryReader))).toMatchObject({kind:'owned',recovery:'resume',owner:{generation:2}});
});

it('strict recovery permits only the declared first child after an interruption before dispatch',async()=>{
 const strict={...claim,stageKey:'strict',recoveryProfile:'naive-single-child-v1' as const,expectedChildKey:record.taskKey};
 const first=await tx(t=>claimWorkflowStage(t,strict));if(first.kind!=='owned')throw Error('owner');
 await tx(t=>markWorkflowStagePending(t,first.owner));
 const next=await tx(t=>recoverWorkflowStage(t,strict,workflowStageRecoveryReader));if(next.kind!=='owned')throw Error('owner');
 scope={owner:next.owner,transaction:tx};
 const port=provider();await fenceWorkflowStageSessions(port,()=>scope).createSession(record.requestBody,record.idempotencyKey);
 expect(port.createSession).toHaveBeenCalledOnce();
 const run=vi.fn();await expect(fenceWorkflowStageRunner({run} as never,()=>scope).run({job:{jobId:job},role:'commercial',purpose:'different'} as never)).rejects.toThrow('reconciliation_required');expect(run).not.toHaveBeenCalled();
});
it('local renewal failure revokes dispatch even after intent committed',async()=>{
 const port=provider();scope={...scope,assertActive:()=>{throw Error('lease_revoked');}};
 await expect(fenceWorkflowStageSessions(port,()=>scope).createSession(record.requestBody,record.idempotencyKey)).rejects.toThrow('lease_revoked');expect(port.createSession).not.toHaveBeenCalled();
});
it.each(['schema_failed','budget_paused','failed','needs_operator'] as const)('replays measured terminal %s evidence but keeps unknown usage held',async state=>{
 record={...record,state,sessionId:'session',consumedMicroUsd:9,error:{code:'terminal',message:'retained'},leaseOwner:null,leaseExpiresAt:null};await save();
 await fenceWorkflowStageRunner({run:vi.fn(async()=>({status:state}))} as never,()=>scope).run({job:{jobId:job},role:'quality_investigator',purpose:'audit'} as never);
 await tx(t=>markWorkflowStagePending(t,scope.owner));
 expect(await tx(t=>recoverWorkflowStage(t,claim,workflowStageRecoveryReader))).toMatchObject({kind:'owned'});
});
it('unmeasured operator escalation retains the stage for reconciliation',async()=>{
 record={...record,state:'needs_operator',sessionId:null,consumedMicroUsd:null,error:{code:'ambiguous_create_unresolved',message:'unknown'},leaseOwner:null,leaseExpiresAt:null};await save();
 await fenceWorkflowStageRunner({run:vi.fn(async()=>({status:'needs_operator'}))} as never,()=>scope).run({job:{jobId:job},role:'quality_investigator',purpose:'audit'} as never);
 await tx(t=>markWorkflowStagePending(t,scope.owner));expect(await tx(t=>recoverWorkflowStage(t,claim,workflowStageRecoveryReader))).toMatchObject({kind:'recovery_required'});
});
it('no-session rejection requires exact settled-zero reservation evidence',async()=>{
 record={...record,state:'failed',reservationId:record.taskKey,sessionId:null,consumedMicroUsd:null,error:{code:'rejected',message:'no session'},leaseOwner:null,leaseExpiresAt:null};await save();
 await fenceWorkflowStageRunner({run:vi.fn(async()=>({status:'failed'}))} as never,()=>scope).run({job:{jobId:job},role:'quality_investigator',purpose:'audit'} as never);
 await tx(t=>markWorkflowStagePending(t,scope.owner));expect(await tx(t=>recoverWorkflowStage(t,claim,workflowStageRecoveryReader))).toMatchObject({kind:'recovery_required'});
 await pg.query('INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,settled_micro_usd) VALUES($1,$2,100,0)',[record.reservationId,job]);
 expect(await tx(t=>recoverWorkflowStage(t,claim,workflowStageRecoveryReader))).toMatchObject({kind:'owned'});
});

it('design runner bounds fresh recovered work before invoking the core runner',async()=>{
 const plan={profile:'naive-design-v1' as const,scope:'a'.repeat(24),outerDesignId:'design:canonical',inputDigest:'b'.repeat(64)};
 const design={...claim,stageKey:'design',recoveryProfile:'naive-design-v1' as const,expectedChildPlan:plan};
 const first=await tx(t=>claimWorkflowStage(t,design));if(first.kind!=='owned')throw Error('owner');
 await tx(t=>markWorkflowStagePending(t,first.owner));const recovered=await tx(t=>recoverWorkflowStage(t,design,workflowStageRecoveryReader));if(recovered.kind!=='owned')throw Error('owner');scope={owner:recovered.owner,transaction:tx};
 const run=vi.fn(async()=>({status:'blocked'}));const fenced=fenceWorkflowStageRunner({run} as never,()=>scope);
 const spec={job:{jobId:job},role:'evaluation_engineer',purpose:`text_design_${plan.scope}_0`,attempt:1};
 for(const changed of [{...spec,role:'commercial'},{...spec,attempt:2},{...spec,purpose:`text_design_${plan.scope}_2`},{...spec,purpose:`text_design_${'c'.repeat(24)}_0`}])await expect(fenced.run(changed as never)).rejects.toThrow('reconciliation_required');
 expect(run).not.toHaveBeenCalled();await fenced.run(spec as never);expect(run).toHaveBeenCalledOnce();
});
it('design session guard fixes one reviewer request body and suffix per revision',async()=>{
 const plan={profile:'naive-design-v1' as const,scope:'a'.repeat(24),outerDesignId:'design:canonical',inputDigest:'b'.repeat(64)};
 const design={...claim,stageKey:'design',recoveryProfile:'naive-design-v1' as const,expectedChildPlan:plan};const first=await tx(t=>claimWorkflowStage(t,design));if(first.kind!=='owned')throw Error('owner');scope={owner:first.owner,transaction:tx};
 const key=`${job}:quality_investigator:text_review_${plan.scope}_0_${'b'.repeat(12)}:1`;
 record={...record,taskKey:key,requestBody:{...record.requestBody,metadata:{ae_job_id:job,ae_task_key:key}}};await save();const port=provider();const fenced=fenceWorkflowStageSessions(port,()=>scope);await fenced.createSession(record.requestBody,record.idempotencyKey);await fenced.createSession(record.requestBody,record.idempotencyKey);
 record={...record,requestBody:{...record.requestBody,message:'substitution'}};await save();await expect(fenced.createSession(record.requestBody,record.idempotencyKey)).rejects.toThrow('reconciliation_required');
 const alternate=key.replace('b'.repeat(12),'c'.repeat(12));record={...record,taskKey:alternate,requestBody:{...record.requestBody,metadata:{ae_job_id:job,ae_task_key:alternate}}};await save();await expect(fenced.createSession(record.requestBody,record.idempotencyKey)).rejects.toThrow('reconciliation_required');expect(port.createSession).toHaveBeenCalledTimes(2);
});
