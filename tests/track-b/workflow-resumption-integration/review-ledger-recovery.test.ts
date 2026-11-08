import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { DataOperationLedger } from '@ae/core/evals/data/operation-ledger';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { createAuthenticatedDataReviewLedger } from '@ae/core/evals/data/review-ledger';
import { dataReviewRequestDigest } from '@ae/core/evals/data/orchestration';

const task = { taskId:'review-task', jobId:'job', description:'Review recovery fixture', targetId:'target', factualAnswersRequired:false, requirements:[] };
const batch = { sources:[], cases:[] };
const request = { task, data:batch, digest:dataReviewRequestDigest(task,batch) };
const submission = { receiptId:'receipt', task, candidates:batch, reviewed:batch, decision:'approved' as const };
let pg:PGlite, sql:AgentTransactionalSql, authorized:boolean;
const ledger = () => createPostgresDataOperationLedger(sql,{tenantId:'tenant',jobId:'job',ownerId:'data_service',authenticateOwner:async()=>({ownerId:'data_service'})});
const reviews = (operations:DataOperationLedger=ledger()) => createAuthenticatedDataReviewLedger({operations,authenticateHuman:async()=>authorized ? {principalId:'independent_human'} : null});
beforeEach(async()=>{
 authorized=true; pg=new PGlite();
 await pg.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,'packages/core/src/evals/data/persistence-migrations/002-data-operations.sql'),'utf8'));
 sql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
});
afterEach(async()=>{await pg.close();});

it('recovers exact authenticated review from a crash after receipt commit before canonical review, without provider activity',async()=>{
 const durable=ledger();
 const crash:DataOperationLedger={...durable,claim:async(key,digest)=>{
  if(key.startsWith('authenticated-data-review:')) throw new Error('process stopped after receipt');
  return durable.claim(key,digest);
 }};
 await expect(reviews(crash).submit(submission)).rejects.toThrow('process stopped');
 expect((await durable.get('data-review-receipt:receipt'))?.state).toBe('complete');
 expect(await reviews().readReview(request)).toEqual({status:'pending'});
 await reviews().submit(submission);
 expect(await reviews().readReview(request)).toMatchObject({status:'decided',review:{receiptId:'receipt',requestDigest:request.digest,authority:'authenticated_human'}});
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(2);
});

it('lost canonical completion acknowledgment survives a new service, duplicate webhook and exact receipt replay',async()=>{
 const durable=ledger();
 const lostAck:DataOperationLedger={...durable,complete:async(key,digest,result,receipt)=>{
  await durable.complete(key,digest,result,receipt);
  if(key.startsWith('authenticated-data-review:')) throw new Error('ack lost');
 }};
 await expect(reviews(lostAck).submit(submission)).rejects.toThrow('ack lost');
 expect(await reviews().readReview(request)).toMatchObject({status:'decided'});
 await reviews().submit(submission);
 await reviews().submit(submission);
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(2);
 await expect(reviews().submit({...submission,decision:'rejected'})).rejects.toThrow('immutable');
});

it('revoked review authority prevents replay mutations and never fabricates canonical completion',async()=>{
 const durable=ledger();
 const crash:DataOperationLedger={...durable,claim:async(key,digest)=>{
  if(key.startsWith('authenticated-data-review:')) throw new Error('stopped');
  return durable.claim(key,digest);
 }};
 await expect(reviews(crash).submit(submission)).rejects.toThrow('stopped');
 authorized=false;
 await expect(reviews().submit(submission)).rejects.toThrow('authorization');
 expect(await reviews().readReview(request)).toEqual({status:'pending'});
 expect((await durable.get('data-review-receipt:receipt'))?.state).toBe('complete');
});

it('pending provider operation stays pending through review recovery and no takeover or deletion is possible',async()=>{
 const durable=ledger();const digest='a'.repeat(64);
 await durable.claim('generation',digest);
 await reviews().submit(submission);
 await reviews().submit(submission);
 expect(await ledger().claim('generation',digest)).toMatchObject({claimed:false,record:{state:'pending'}});
 expect(await ledger().get('generation')).toEqual({key:'generation',digest,state:'pending'});
 await expect(pg.query("DELETE FROM evaluation_data_persistence.operations WHERE operation_key='generation'")).rejects.toThrow('immutable');
});
