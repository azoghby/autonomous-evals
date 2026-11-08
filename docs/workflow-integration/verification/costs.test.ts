import {PGlite} from '@electric-sql/pglite';
import {it,expect} from 'vitest';
import {upsertWorkflowCost} from '@costs';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
it('atomically deduplicates exact measured costs across fresh calls and rejects drift',async()=>{
 const pg=new PGlite();
 try {
  await pg.exec(`CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(job_id text,key text,payload jsonb,PRIMARY KEY(key)); CREATE TABLE costs(job_id text,source text,agent text,session_id text,micro_usd bigint,meta jsonb);`);
  const sql:AgentTransactionalSql={query:async<T>(q:string,p:unknown[]=[])=>({rows:(await pg.query(q,p)).rows as T[]}),transaction:async action=>pg.transaction(async tx=>action({query:async<T>(q:string,p:unknown[]=[])=>({rows:(await tx.query(q,p)).rows as T[]})}))};
  const entry={jobId:'11111111-1111-4111-8111-111111111111',source:'naive',sessionId:'session-1',agent:'engineer',microUsd:37,meta:{idempotencyKey:'naive:session-1'}};
  await upsertWorkflowCost(sql,entry);await upsertWorkflowCost(sql,structuredClone(entry));
  expect((await pg.query('SELECT * FROM costs')).rows).toHaveLength(1);
  await expect(upsertWorkflowCost(sql,{...entry,microUsd:38})).rejects.toThrow('measured_cost_identity_conflict');
  expect((await pg.query('SELECT sum(micro_usd)::text AS total FROM costs')).rows).toEqual([{total:'37'}]);
  await expect(upsertWorkflowCost(sql,{...entry,jobId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow('measured_cost_identity_conflict');
  await expect(upsertWorkflowCost(sql,{...entry,meta:{idempotencyKey:'different'}})).rejects.toThrow('measured_cost_identity_required');
 }finally{await pg.close();}
});
it('rolls back the dedup key when the canonical ledger insert fails',async()=>{
 const pg=new PGlite();
 try{
  await pg.exec(`CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(job_id text,key text,payload jsonb,PRIMARY KEY(key));`);
  const sql:AgentTransactionalSql={query:async<T>(q:string,p:unknown[]=[])=>({rows:(await pg.query(q,p)).rows as T[]}),transaction:async action=>pg.transaction(async tx=>action({query:async<T>(q:string,p:unknown[]=[])=>({rows:(await tx.query(q,p)).rows as T[]})}))};
  await expect(upsertWorkflowCost(sql,{jobId:'11111111-1111-4111-8111-111111111111',source:'naive',sessionId:'session-1',agent:'engineer',microUsd:37,meta:{idempotencyKey:'naive:session-1'}})).rejects.toThrow();
  expect((await pg.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(0);
 }finally{await pg.close();}
});
