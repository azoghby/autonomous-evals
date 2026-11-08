import { PGlite } from '@electric-sql/pglite';
import { beforeEach,afterEach,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JOB_BUDGET_MICRO_USD } from '../contracts/index';
import { admitModelReservationInTransaction,completeJobBudget,jobBudgetExposure,linkRunningJobBudgetCost,linkJobBudgetCost,markJobBudgetDispatched,refundUndispatchedJobBudget,reserveJobBudget,reserveWorkflowJobBudget,releaseWorkflowJobBudget,type JobBudgetTx } from './job-budget-authority';
let pg:PGlite;
const job='11111111-1111-4111-8111-111111111111', cost='22222222-2222-4222-8222-222222222222';
const cap=JOB_BUDGET_MICRO_USD.trace_audit;
const run=<T>(fn:(tx:JobBudgetTx)=>Promise<T>)=>pg.transaction(t=>fn({query:(s,p)=>t.query(s,p)}));
beforeEach(async()=>{pg=new PGlite();await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,budget_reserved_micro_usd bigint DEFAULT 0);
CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text,source text DEFAULT 'naive');
CREATE SCHEMA agent_persistence;CREATE TABLE agent_persistence.reservations(id text PRIMARY KEY,job_id text,amount_micro_usd bigint,settled_micro_usd bigint,first_result jsonb,scopes jsonb DEFAULT '[]');
`);await pg.exec(readFileSync(resolve(process.env.JOB_BUDGET_SQL??'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql'),'utf8'));await pg.query('INSERT INTO jobs(id,package) VALUES($1,$2)',[job,'trace_audit']);});
afterEach(async()=>{await pg.close();});
it('uses canonical cap and combines ordinary holds, all costs, and model holds',async()=>{await pg.query('INSERT INTO budget_reservations VALUES($1,$2,$3,$4,NULL)',[cost,job,'engineer',100]);await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,$3,NULL)',[cost,job,200]);await pg.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,settled_micro_usd,first_result) VALUES('model',$1,300,NULL,'{"ok":true}')`,[job]);expect(await run(tx=>jobBudgetExposure(tx,job))).toEqual({capMicroUsd:cap,committedMicroUsd:600,remainingMicroUsd:cap-600});expect(await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'large',amountMicroUsd:cap-599}))).toMatchObject({ok:false});});
it('retains replay identity and refuses postdispatch refund',async()=>{const input={jobId:job,operationId:'op',amountMicroUsd:100};expect(await run(tx=>reserveJobBudget(tx,input))).toMatchObject({ok:true,replayed:false});expect(await run(tx=>reserveJobBudget(tx,input))).toMatchObject({ok:true,replayed:true});await expect(run(tx=>reserveJobBudget(tx,{...input,amountMicroUsd:101}))).rejects.toThrow();await run(tx=>markJobBudgetDispatched(tx,job,'op'));await expect(run(tx=>refundUndispatchedJobBudget(tx,job,'op'))).rejects.toThrow();expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);});
it('refunds only undispatched and retains the operation',async()=>{await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'op',amountMicroUsd:100}));await run(tx=>refundUndispatchedJobBudget(tx,job,'op'));expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(0);await expect(run(tx=>markJobBudgetDispatched(tx,job,'op'))).rejects.toThrow();});
it('covers running measured costs exactly once and releases residual only at known completion',async()=>{await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'op',amountMicroUsd:100}));await run(tx=>markJobBudgetDispatched(tx,job,'op'));await run(async tx=>{await tx.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,40,NULL)',[cost,job]);await linkRunningJobBudgetCost(tx,{jobId:job,operationId:'op',costId:cost});});expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);await run(tx=>completeJobBudget(tx,job,'op'));expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(40);});
it('rolls reservation and model write back together on admission conflict',async()=>{await expect(run(async tx=>{await admitModelReservationInTransaction(tx,{jobId:job,reservationId:'r',amountMicroUsd:100,requestDigest:'digest'},async()=>{await tx.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,settled_micro_usd,first_result) VALUES('r',$1,101,NULL,'{"ok":true}')`,[job]);return {ok:true};});})).rejects.toThrow();expect((await pg.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(0);});
it('reuses open workflow stage then creates fresh hold after success',async()=>{const a=await run(tx=>reserveWorkflowJobBudget(tx,{jobId:job,agent:'judge',amountMicroUsd:100}));expect(await run(tx=>reserveWorkflowJobBudget(tx,{jobId:job,agent:'judge',amountMicroUsd:100}))).toMatchObject({reservationId:a.reservationId,replayed:true});await run(tx=>releaseWorkflowJobBudget(tx,job,a.reservationId));const b=await run(tx=>reserveWorkflowJobBudget(tx,{jobId:job,agent:'judge',amountMicroUsd:100}));expect(b.reservationId).not.toBe(a.reservationId);expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(100);});
it('rolls back cost insertion when a retained link conflicts',async()=>{await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'op',amountMicroUsd:100}));await expect(run(async tx=>{await tx.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,40,NULL)',[cost,job]);await linkRunningJobBudgetCost(tx,{jobId:job,operationId:'op',costId:cost});})).rejects.toThrow();expect((await pg.query('SELECT * FROM costs')).rows).toHaveLength(0);});
it('excludes separately capped expert promises while keeping ordinary model commitments',async()=>{await pg.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,first_result,scopes) VALUES('expert',$1,999999999,'{"ok":true}','[{"key":"expert-job:x"}]')`,[job]);expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(0);});
it('refuses stage reuse once recorded usage overruns the canonical cap',async()=>{await run(tx=>reserveWorkflowJobBudget(tx,{jobId:job,agent:'judge',amountMicroUsd:100}));await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,$3,NULL)',[cost,job,cap]);expect(await run(tx=>reserveWorkflowJobBudget(tx,{jobId:job,agent:'judge',amountMicroUsd:100}))).toMatchObject({ok:false});});
it('retains canonical denials across capacity changes and rejects changed scope digest',async()=>{await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'full',amountMicroUsd:cap}));const input={jobId:job,reservationId:'denied',amountMicroUsd:10,requestDigest:'scopes-one'};let callbacks=0;const reserve=async()=>{callbacks++;return {ok:true};};expect(await run(tx=>admitModelReservationInTransaction(tx,input,reserve))).toEqual({ok:false,remainingMicroUsd:0});await run(tx=>refundUndispatchedJobBudget(tx,job,'full'));expect(await run(tx=>admitModelReservationInTransaction(tx,input,reserve))).toEqual({ok:false,remainingMicroUsd:0});await expect(run(tx=>admitModelReservationInTransaction(tx,{...input,requestDigest:'scopes-two'},reserve))).rejects.toThrow();expect(callbacks).toBe(0);});

it('deduplicates model settlement only with exact retained session binding and receipt',async()=>{
 await pg.exec('CREATE TABLE agent_persistence.tasks(task_key text,record jsonb)');
 await pg.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,settled_micro_usd,first_result) VALUES('r',$1,100,40,'{"ok":true}')`,[job]);
 await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'model:r',amountMicroUsd:100,agentReservationId:'r'}));
 await run(tx=>markJobBudgetDispatched(tx,job,'model:r'));
 const receipt='naive:ses_00000000000000000000000000';
 await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,40,$3)',[cost,job,receipt]);
 const input={jobId:job,operationId:'model:r',costId:cost,expectedReceiptKey:receipt};
 await expect(run(tx=>linkJobBudgetCost(tx,input))).rejects.toThrow();
 expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(80);
 await pg.query('INSERT INTO agent_persistence.tasks VALUES($1,$2)', ['task',JSON.stringify({reservationId:'r',jobId:job,sessionId:receipt.slice(6)})]);
 await run(tx=>linkJobBudgetCost(tx,input));
 expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(40);
 await expect(run(tx=>linkJobBudgetCost(tx,{...input,expectedReceiptKey:'naive:other'}))).rejects.toThrow();
});
it('database rejects rewriting or deleting retained operation and admission evidence',async()=>{await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'op',amountMicroUsd:cap}));await run(tx=>admitModelReservationInTransaction(tx,{jobId:job,reservationId:'denied',amountMicroUsd:1,requestDigest:'digest'},async()=>({ok:true})));await expect(pg.query("DELETE FROM job_budget.operations WHERE operation_id='op'")).rejects.toThrow('job_budget_evidence_immutable');await expect(pg.query("UPDATE job_budget.operations SET amount_micro_usd=1 WHERE operation_id='op'")).rejects.toThrow('job_budget_evidence_immutable');await expect(pg.query("UPDATE job_budget.model_admissions SET admitted=true WHERE reservation_id='denied'")).rejects.toThrow('job_budget_evidence_immutable');await expect(pg.query('DELETE FROM job_budget.model_admissions')).rejects.toThrow('job_budget_evidence_immutable');});

it('rejects negative persisted cost offsets instead of using them as spending credit',async()=>{await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key) VALUES($1,$2,-1,NULL)',[cost,job]);await expect(run(tx=>jobBudgetExposure(tx,job))).rejects.toThrow('job_budget_conflict');});

it('refuses a session receipt key attached to a different provider source',async()=>{
 await pg.exec('CREATE TABLE agent_persistence.tasks(task_key text,record jsonb)');
 await pg.query(`INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,settled_micro_usd,first_result) VALUES('r',$1,100,40,'{"ok":true}')`,[job]);
 await run(tx=>reserveJobBudget(tx,{jobId:job,operationId:'model:r',amountMicroUsd:100,agentReservationId:'r'}));
 await run(tx=>markJobBudgetDispatched(tx,job,'model:r'));
 const receipt='naive:ses_00000000000000000000000000';
 await pg.query('INSERT INTO costs(id,job_id,micro_usd,receipt_key,source) VALUES($1,$2,40,$3,$4)',[cost,job,receipt,'ai_gateway']);
 await pg.query('INSERT INTO agent_persistence.tasks VALUES($1,$2)', ['task',JSON.stringify({reservationId:'r',jobId:job,sessionId:receipt.slice(6)})]);
 await expect(run(tx=>linkJobBudgetCost(tx,{jobId:job,operationId:'model:r',costId:cost,expectedReceiptKey:receipt}))).rejects.toThrow('job_budget_conflict');
 expect((await run(tx=>jobBudgetExposure(tx,job))).committedMicroUsd).toBe(80);
});
