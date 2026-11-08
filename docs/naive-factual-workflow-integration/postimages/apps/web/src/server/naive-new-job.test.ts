import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,expect,it } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { insertNewFactualJob,readNewJobFactualGapEnabled } from './naive-new-job';
const job={jobId:'123e4567-e89b-42d3-a456-426614174000',customerId:'223e4567-e89b-42d3-a456-426614174000',environment:'test' as const,idempotencyKey:'key',intake:{package:'text_eval'},traceBlobPath:'private/trace',ciphertext:'encrypted'};
const env={EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:'designSuite,runSuite,investigate',EVAL_NAIVE_FACTUAL_GAPS:'1'};
const dbs:PGlite[]=[];
afterEach(async()=>{for(const pg of dbs.splice(0))await pg.close();});
async function fixture(){
 const pg=new PGlite();dbs.push(pg);
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,package text,state text,environment text,intake jsonb,trace_blob_path text,is_mock boolean,idempotency_key text,retest_of_job_id uuid,UNIQUE(customer_id,idempotency_key));CREATE TABLE job_credentials(job_id uuid PRIMARY KEY REFERENCES jobs(id),ciphertext text)`);
 await pg.exec(readFileSync('packages/core/src/evals/integration/migrations/001-text-integration.sql','utf8'));
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 return {pg,sql};
}
it('allows only explicit trusted complete real text configuration',()=>{
 expect(readNewJobFactualGapEnabled({package:'text_eval',isMock:false},env)).toBe(true);
 for(const flag of ['true','','2'])expect(()=>readNewJobFactualGapEnabled({package:'text_eval',isMock:false},{...env,EVAL_NAIVE_FACTUAL_GAPS:flag})).toThrow();
 for(const changes of [{EVAL_SERVICES:'lite'},{EVAL_NAIVE_METHODS:'designSuite'},{EVAL_NAIVE_METHODS:'designSuite,runSuite,investigate,unknown'}])expect(()=>readNewJobFactualGapEnabled({package:'text_eval',isMock:false},{...env,...changes})).toThrow();
 expect(()=>readNewJobFactualGapEnabled({package:'text_eval',isMock:true},env)).toThrow();
 expect(readNewJobFactualGapEnabled({package:'trace_audit',isMock:false},env)).toBe(false);
 expect(readNewJobFactualGapEnabled({package:'text_eval',isMock:false},{})).toBe(false);
});
it('commits credentials and deterministic enrollment together and duplicates never replace them',async()=>{
 const f=await fixture();expect(await insertNewFactualJob(f.sql,job)).toBe(job.jobId);
 expect(await insertNewFactualJob(f.sql,{...job,jobId:'323e4567-e89b-42d3-a456-426614174000',ciphertext:'replacement'})).toBe(job.jobId);
 expect((await f.pg.query('SELECT * FROM jobs')).rows).toHaveLength(1);
 expect((await f.pg.query('SELECT ciphertext FROM job_credentials')).rows).toEqual([{ciphertext:'encrypted'}]);
 expect((await f.pg.query<{value:any}>('SELECT value FROM text_integration.checkpoints')).rows[0].value.profile.expertTaskId).toBe(`factual-gap:${job.jobId}`);
});
it('a raced legacy row is returned without enrollment or credential changes',async()=>{
 const f=await fixture();await f.pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,idempotency_key) VALUES($1,$2,'test','text_eval',false,$3)`,[job.jobId,job.customerId,job.idempotencyKey]);
 expect(await insertNewFactualJob(f.sql,{...job,jobId:'323e4567-e89b-42d3-a456-426614174000'})).toBe(job.jobId);
 expect((await f.pg.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
 expect((await f.pg.query('SELECT * FROM job_credentials')).rows).toHaveLength(0);
});
it('a crash after enrollment rolls back jobs, credentials, and markers',async()=>{
 const f=await fixture();const crash:AgentTransactionalSql={...f.sql,transaction:fn=>f.sql.transaction(async tx=>{await fn(tx);throw new Error('crash before commit');})};
 await expect(insertNewFactualJob(crash,job)).rejects.toThrow('crash');
 for(const table of ['jobs','job_credentials','text_integration.checkpoints'])expect((await f.pg.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 expect(await insertNewFactualJob(f.sql,job)).toBe(job.jobId);
});
it('credential failure prevents enrollment and job visibility',async()=>{
 const f=await fixture();await f.pg.exec(`ALTER TABLE job_credentials ADD CHECK(ciphertext <> 'encrypted')`);
 await expect(insertNewFactualJob(f.sql,job)).rejects.toThrow();
 expect((await f.pg.query('SELECT * FROM jobs')).rows).toHaveLength(0);
 expect((await f.pg.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
});
it('selection persistence failure rolls back the already inserted credentials and job',async()=>{
 const f=await fixture();await f.pg.exec(`ALTER TABLE text_integration.checkpoints ADD CHECK(kind <> 'naive_execution_policy')`);
 await expect(insertNewFactualJob(f.sql,job)).rejects.toThrow();
 expect((await f.pg.query('SELECT * FROM jobs')).rows).toHaveLength(0);
 expect((await f.pg.query('SELECT * FROM job_credentials')).rows).toHaveLength(0);
});
