import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { createAuthenticatedDataReviewLedger } from '@ae/core/evals/data/review-ledger';
import { dataReviewRequestDigest } from '@ae/core/evals/data/orchestration';
import { enqueueReviewResume, reviewWakeReady, dispatchReviewResumes, captureReviewIntents, finishReviewIntents } from '@/server/workflow-resumption';

const scope={jobId:'a1b2c3d4-e5f6-4abc-8def-aabbccddeeff',tenantId:'b1c2d3e4-f5a6-4abc-8def-bbccddeeffaa',environment:'test' as const,workflowRunId:'workflow-original'};
const task={taskId:'review-task',jobId:scope.jobId,description:'Resume reviewed fixture',targetId:'target',factualAnswersRequired:false,requirements:[]};
const batch={sources:[],cases:[]};
const digest=dataReviewRequestDigest(task,batch);
let pg:PGlite,sql:AgentTransactionalSql;
const review=async()=>{
 const operations=createPostgresDataOperationLedger(sql,{tenantId:scope.tenantId,jobId:scope.jobId,ownerId:'data_service',authenticateOwner:async()=>({ownerId:'data_service'})});
 await createAuthenticatedDataReviewLedger({operations,authenticateHuman:async()=>({principalId:'independent_human'})}).submit({receiptId:'receipt',task,candidates:batch,reviewed:batch,decision:'approved'});
};
const boundary=()=>({liveness:vi.fn(async(_job:string,_run:string):Promise<'alive'|'dead'|'unknown'>=>'alive'),reenqueue:vi.fn(async(_job:string,_run:string)=>{})});
beforeEach(async()=>{
 pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,workflow_run_id text,package text,is_mock boolean,state text);CREATE SCHEMA workflow_integration;`);
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4,$5,false,$6)',[scope.jobId,scope.tenantId,scope.environment,scope.workflowRunId,'text_eval','running']);
 for(const file of ['packages/core/src/evals/data/persistence-migrations/002-data-operations.sql','apps/web/migrations/004-workflow-resumption.sql']) await pg.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,file),'utf8'));
 sql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
});
afterEach(async()=>{await pg.close();});

it('durable review + intent survive process death before dispatch and replay wakes the SAME original run',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);
 // The first process ends here. A new dispatcher loads committed SQL, never reconstructs a suite/run/branch.
 const api=boundary();await dispatchReviewResumes(sql,api);
 expect(api.liveness).toHaveBeenCalledWith(scope.jobId,scope.workflowRunId);
 expect(api.reenqueue).toHaveBeenCalledWith(scope.jobId,scope.workflowRunId);
 expect(await reviewWakeReady(sql,scope)).toBe(true);
 expect((await pg.query<{workflow_run_id:string}>('SELECT workflow_run_id FROM jobs')).rows[0].workflow_run_id).toBe(scope.workflowRunId);
});

it('duplicate reviews and keyed wakeups do not duplicate intent, provider operation, or measured cost',async()=>{
 const ledger=createPostgresDataOperationLedger(sql,{tenantId:scope.tenantId,jobId:scope.jobId,ownerId:'data_service',authenticateOwner:async()=>({ownerId:'data_service'})});
 const operation='generation';const operationDigest='a'.repeat(64);
 await ledger.claim(operation,operationDigest);await ledger.complete(operation,operationDigest,{providerReceipt:'existing'});
 await ledger.claim('generation:cost','b'.repeat(64));await ledger.complete('generation:cost','b'.repeat(64),{microUsd:100,measured:true});
 await review();await enqueueReviewResume(sql,scope,digest);
 await review();await enqueueReviewResume(sql,scope,digest);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(1);
 const api=boundary();await dispatchReviewResumes(sql,api);await dispatchReviewResumes(sql,api);
 expect(await reviewWakeReady(sql,scope)).toBe(true);
 expect(await ledger.claim(operation,operationDigest)).toMatchObject({claimed:false,record:{state:'complete',result:{providerReceipt:'existing'}}});
 expect((await ledger.get('generation:cost'))?.result).toEqual({microUsd:100,measured:true});
});

it('unknown liveness never starts, restarts or re-enqueues a possibly active worker',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);const api=boundary();api.liveness.mockResolvedValue('unknown');
 await dispatchReviewResumes(sql,api);expect(api.reenqueue).not.toHaveBeenCalled();
 expect((await pg.query<{status:string}>('SELECT status FROM workflow_integration.review_resume_intents')).rows[0].status).toBe('pending');
});

it('dead original worker requires operator observation, with no new worker and no claim clearing',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);const api=boundary();api.liveness.mockResolvedValue('dead');
 await dispatchReviewResumes(sql,api);expect(api.reenqueue).not.toHaveBeenCalled();
 expect((await pg.query<{status:string}>('SELECT status FROM workflow_integration.review_resume_intents')).rows[0].status).toBe('needs_operator');
});

it.each(['delivered','cancelled','failed','paused_budget','on_hold'])('stops dispatch after authoritative job state becomes %s',async state=>{
 await review();await enqueueReviewResume(sql,scope,digest);await pg.query('UPDATE jobs SET state=$1',[state]);
 const api=boundary();await dispatchReviewResumes(sql,api);expect(api.reenqueue).not.toHaveBeenCalled();
 expect(await reviewWakeReady(sql,scope)).toBe(false);
});

it.each(['customer_id','workflow_run_id','environment'])('revoked or changed %s scope cannot wake evaluation',async field=>{
 await review();await enqueueReviewResume(sql,scope,digest);
 const value=field==='customer_id'?'c1d2e3f4-a5b6-4abc-8def-ccddeeffaabb':field==='environment'?'live':'workflow-other';
 await pg.query(`UPDATE jobs SET ${field}=$1`,[value]);const api=boundary();await dispatchReviewResumes(sql,api);
 expect(api.reenqueue).not.toHaveBeenCalled();expect(await reviewWakeReady(sql,scope)).toBe(false);
});

it('intent without canonical authenticated review never authorizes evaluation',async()=>{
 await expect(enqueueReviewResume(sql,scope,digest)).rejects.toThrow();
 expect(await reviewWakeReady(sql,scope)).toBe(false);expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(0);
});

it('lost reenqueue acknowledgment leaves durable retryable intent without claiming provider success',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);const api=boundary();api.reenqueue.mockRejectedValue(new Error('scripted external Workflow API lost ack'));
 try{await dispatchReviewResumes(sql,api);}catch{/* safe retry or propagated failure both preserve intent */}
 const recovered=boundary();await dispatchReviewResumes(sql,recovered);
 expect(recovered.reenqueue).toHaveBeenCalledWith(scope.jobId,scope.workflowRunId);
 expect((await pg.query<{status:string}>('SELECT status FROM workflow_integration.review_resume_intents')).rows[0].status).toBe('pending');
});

it('acknowledges only intents captured before advance; a concurrent new review remains a wakeup',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);
 const captured=await captureReviewIntents(sql,scope);expect(captured).toEqual([digest]);
 const secondTask={...task,taskId:'second-review'};
 const operations=createPostgresDataOperationLedger(sql,{tenantId:scope.tenantId,jobId:scope.jobId,ownerId:'data_service',authenticateOwner:async()=>({ownerId:'data_service'})});
 await createAuthenticatedDataReviewLedger({operations,authenticateHuman:async()=>({principalId:'independent_human'})}).submit({receiptId:'second-receipt',task:secondTask,candidates:batch,reviewed:batch,decision:'approved'});
 const secondDigest=dataReviewRequestDigest(secondTask,batch);await enqueueReviewResume(sql,scope,secondDigest);
 await finishReviewIntents(sql,scope,captured);
 expect(await captureReviewIntents(sql,scope)).toEqual([secondDigest]);expect(await reviewWakeReady(sql,scope)).toBe(true);
 await finishReviewIntents(sql,scope,[secondDigest]);expect(await reviewWakeReady(sql,scope)).toBe(false);
});
it('bounds each dispatcher tick and rejects unbounded limits',async()=>{
 await review();await enqueueReviewResume(sql,scope,digest);const api=boundary();
 expect((await dispatchReviewResumes(sql,api,1)).examined).toBe(1);
 for(const limit of [0,101,Infinity,1.5])await expect(dispatchReviewResumes(sql,api,limit)).rejects.toThrow();
});
