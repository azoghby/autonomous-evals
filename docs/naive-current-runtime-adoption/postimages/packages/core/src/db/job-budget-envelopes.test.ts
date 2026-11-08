import { SharedJobBudgetLedger } from './job-budget-ledger';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach,afterEach,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { admitModelReservationInTransaction,jobBudgetExposure,reserveJobBudget,releaseWorkflowJobBudget,type JobBudgetTx } from './job-budget-authority';
let pg:PGlite;
const job='11111111-1111-4111-8111-111111111111';
const owner={jobId:job,stageKey:'design',token:'token',generation:1};
const run=<T>(f:(tx:JobBudgetTx)=>Promise<T>)=>pg.transaction(t=>f({query:(s,p)=>t.query(s,p)}));
async function reserve(id:string,n:number,o:typeof owner|undefined=owner){return run(tx=>admitModelReservationInTransaction(tx,{jobId:job,reservationId:id,amountMicroUsd:n,requestDigest:id,stageOwner:o},async()=>{await tx.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,first_result) VALUES($1,$2,$3,'{"ok":true}') ON CONFLICT DO NOTHING`,[id,job,n]);return {ok:true};}));}
beforeEach(async()=>{pg=new PGlite();await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,budget_reserved_micro_usd bigint DEFAULT 0,customer_id text,environment text,state text);
CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text,source text DEFAULT 'naive');
CREATE SCHEMA agent_persistence;CREATE TABLE agent_persistence.reservations(id text PRIMARY KEY,job_id text,amount_micro_usd bigint,settled_micro_usd bigint,first_result jsonb,scopes jsonb DEFAULT '[]');
CREATE SCHEMA workflow_stage;CREATE TABLE workflow_stage.stages(job_id uuid,stage_key text,reservation_id uuid,amount_micro_usd bigint,owner_token text,generation integer,state text,lease_until timestamptz,customer_id text,environment text,PRIMARY KEY(job_id,stage_key));CREATE TABLE workflow_stage.cancellations(job_id uuid);
`);await pg.exec(readFileSync(resolve('docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql'),'utf8'));await pg.exec(readFileSync(resolve('docs/naive-budget-envelope-integration/sql/001-stage-model-envelopes.sql'),'utf8'));await pg.query(`INSERT INTO jobs(id,package,customer_id,environment,state) VALUES($1,'trace_audit','customer','test','running')`,[job]);const p=await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'parent',workflowAgent:'engineer',amountMicroUsd:100}));await pg.query(`INSERT INTO workflow_stage.stages VALUES($1,'design',$2,100,'token',1,'running',clock_timestamp()+interval '1 minute','customer','test')`,[job,p.reservationId]);});
afterEach(async()=>pg.close());
it('covers exact child overlap and enforces cumulative measured envelope',async()=>{expect(await reserve('a',70)).toMatchObject({ok:true});expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);expect(await reserve('b',31)).toMatchObject({ok:false,remainingMicroUsd:30,exhaustedScope:`stage:${job}:design`,capMicroUsd:100});await pg.query("UPDATE agent_persistence.reservations SET settled_micro_usd=20 WHERE id='a'");expect(await reserve('c',80)).toMatchObject({ok:true});expect(await reserve('b',31)).toMatchObject({ok:false,remainingMicroUsd:30,exhaustedScope:`stage:${job}:design`,capMicroUsd:100});expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);});
it('keeps unknown public costs additive; release leaves measured children standing alone',async()=>{await reserve('a',70);await pg.query(`INSERT INTO costs VALUES('22222222-2222-4222-8222-222222222222',$1,20,NULL,'naive')`,[job]);expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(120);await run(async tx=>{const p=(await tx.query<{reservation_id:string}>('SELECT reservation_id FROM workflow_stage.stages')).rows[0]!;await releaseWorkflowJobBudget(tx,job,p.reservation_id);});expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(90);});
it('replays only current owner, allowing recovery generation while retaining immutable parent',async()=>{await reserve('a',70);await pg.query("UPDATE workflow_stage.stages SET generation=2,owner_token='next'");await expect(reserve('a',70)).rejects.toThrow();expect(await reserve('a',70,{...owner,generation:2,token:'next'})).toMatchObject({ok:true});await expect(pg.query("UPDATE job_budget.stage_model_bindings SET stage_key='other'")).rejects.toThrow('job_budget_evidence_immutable');});
it('rejects stale, cancelled, expired and cross-job owners without creating children',async()=>{await expect(reserve('stale',1,{...owner,token:'bad'})).rejects.toThrow();await expect(reserve('cross',1,{...owner,jobId:'other'})).rejects.toThrow();await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()-interval '1 second'");await expect(reserve('expired',1)).rejects.toThrow();await pg.query("UPDATE workflow_stage.stages SET lease_until=clock_timestamp()+interval '1 minute'");await pg.query('INSERT INTO workflow_stage.cancellations VALUES($1)',[job]);await expect(reserve('cancelled',1)).rejects.toThrow();expect((await pg.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(0);});
it('never adopts historical unbound child or changes a bound parent',async()=>{await run(tx=>admitModelReservationInTransaction(tx,{jobId:job,reservationId:'old',amountMicroUsd:10,requestDigest:'old'},async()=>{await tx.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,first_result) VALUES('old',$1,10,'{"ok":true}')`,[job]);return {ok:true};}));await expect(reserve('old',10)).rejects.toThrow();await reserve('new',10);await pg.query("UPDATE workflow_stage.stages SET stage_key='other'").catch(()=>{});await expect(reserve('new',10,{...owner,stageKey:'other'})).rejects.toThrow();});

it('records measured overrun conservatively and blocks new children',async()=>{await reserve('a',70);await pg.query("UPDATE agent_persistence.reservations SET settled_micro_usd=130 WHERE id='a'");expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(130);expect(await reserve('b',1)).toMatchObject({ok:false,remainingMicroUsd:0});});

it('replays actual scoped model role-cap denial through Shared ledger without adopting legacy holds',async()=>{
 await pg.exec('CREATE TABLE agent_persistence.scopes(key text PRIMARY KEY,cap_micro_usd bigint)');
 const db:AgentTransactionalSql={query:(s,p)=>pg.query(s,p),transaction:f=>pg.transaction(t=>f({query:(s,p)=>t.query(s,p)}))};
 const request={reservationId:'role-denied',jobId:job,amountMicroUsd:10,scopes:[{key:`job:${job}`,capMicroUsd:1000},{key:'agent:commercial:test',capMicroUsd:0}]};
 const ledger=new SharedJobBudgetLedger(db,async()=>owner);
 const denied={ok:false,reservationId:'role-denied',exhaustedScope:'agent:commercial:test',capMicroUsd:0,availableMicroUsd:0};
 expect(await ledger.reserve(request)).toEqual(denied);
 expect(await new SharedJobBudgetLedger(db,async()=>owner).reserve(request)).toEqual(denied);
 expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);
 expect((await pg.query('SELECT * FROM job_budget.stage_model_bindings WHERE reservation_id=$1',['role-denied'])).rows).toHaveLength(1);
});

it('pins a scoped preflight denial to its parent and refuses unscoped reinterpretation',async()=>{
 await reserve('first',100);
 expect(await reserve('denied',1)).toMatchObject({ok:false,exhaustedScope:`stage:${job}:design`,capMicroUsd:100});
 expect((await pg.query("SELECT stage_key FROM job_budget.stage_model_bindings WHERE reservation_id='denied'")).rows).toEqual([{stage_key:'design'}]);
 expect((await pg.query("SELECT * FROM agent_persistence.reservations WHERE id='denied'")).rows).toHaveLength(0);
 await expect(run(tx=>admitModelReservationInTransaction(tx,{jobId:job,reservationId:'denied',amountMicroUsd:1,requestDigest:'denied'},async()=>({ok:true})))).rejects.toThrow('job_budget_conflict');
 expect(await reserve('denied',1)).toMatchObject({ok:false,exhaustedScope:`stage:${job}:design`,capMicroUsd:100});
});
