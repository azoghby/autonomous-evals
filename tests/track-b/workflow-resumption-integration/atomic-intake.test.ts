import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
const fixture=vi.hoisted(()=>({human:null as null|{id:string;isOperator:boolean},sql:undefined as any,runner:vi.fn(),cost:vi.fn()}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{}}));
vi.mock('@ae/core/integration/eval-services',()=>({buildAgentDeps:async()=>({runner:{run:fixture.runner}})}));
vi.mock('@ae/core/simulator/pool',()=>({pooledCalendarDatabase:()=>fixture.sql}));
vi.mock('@/server/session',()=>({getCurrentCustomer:async()=>fixture.human}));
vi.mock('@/server/job-store',()=>({recordCost:fixture.cost}));
import {humanDataReview} from '@/server/data-production';
import {createPostgresDataOperationLedger} from '@ae/core/evals/data/postgres-operations';
import {dataReviewRequestDigest} from '@ae/core/evals/data/orchestration';
import {reviewDigest} from '@ae/core/evals/data/binding';
const jobId='a1b2c3d4-e5f6-4abc-8def-aabbccddeeff',tenantId='b1c2d3e4-f5a6-4abc-8def-bbccddeeffaa';
const task={taskId:'task',jobId,description:'Atomic review fixture',requirements:[],factualAnswersRequired:false,targetId:'target'};
const candidates={sources:[],cases:[]};const digest=dataReviewRequestDigest(task,candidates);
const submission={receiptId:'human_receipt',decision:'approved' as const,reviewed:candidates};
let pg:PGlite,sql:AgentTransactionalSql;
beforeEach(async()=>{
 vi.clearAllMocks();fixture.human={id:'independent-human',isOperator:true};process.env.DATABASE_URL='unused';pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,package text,environment text,is_mock boolean,retest_of_job_id text,workflow_run_id text,state text); CREATE TABLE job_credentials(job_id text,ciphertext text); CREATE SCHEMA workflow_integration;`);
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4,false,null,$5,$6)',[jobId,tenantId,'text_eval','test','workflow-original','running']);
 for(const path of ['packages/core/src/evals/data/persistence-migrations/002-data-operations.sql','apps/web/migrations/004-workflow-resumption.sql'])await pg.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,path),'utf8'));
 sql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};fixture.sql=sql;
 const operations=createPostgresDataOperationLedger(sql,{tenantId,jobId,ownerId:'data_service_v1',authenticateOwner:async()=>({ownerId:'data_service_v1'})});const result={task,candidates};const key=`data-review-request:${digest}`;
 await operations.claim(key,reviewDigest(result));await operations.complete(key,reviewDigest(result),result);
});
afterEach(async()=>{await pg.close();});
it('authenticated review commits receipt, canonical review and wakeup together; duplicate POST remains one intent',async()=>{
 expect(await humanDataReview(jobId,digest,submission)).toEqual({status:'recorded'});
 expect(await humanDataReview(jobId,digest,submission)).toEqual({status:'recorded'});
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(3);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(1);
 expect(fixture.runner).not.toHaveBeenCalled();expect(fixture.cost).not.toHaveBeenCalled();
});
it('a crash at wake-intent insert rolls back receipt and review, then identical POST fully recovers',async()=>{
 fixture.sql={query:sql.query,transaction:fn=>sql.transaction(tx=>fn({query:(q,p)=>{
  if(q.includes('INSERT INTO workflow_integration.review_resume_intents'))throw new Error('scripted process failure before intent');
  return tx.query(q,p);
 }}))};
 await expect(humanDataReview(jobId,digest,submission)).rejects.toThrow('scripted process failure');
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(1);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(0);
 fixture.sql=sql;await humanDataReview(jobId,digest,submission);
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(3);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(1);
});
it('revocation before authenticated submit creates no receipt, review or wake authority',async()=>{
 fixture.human={id:'independent-human',isOperator:false};await expect(humanDataReview(jobId,digest,submission)).rejects.toThrow();
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(1);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(0);
});
it('job scope revoked after review writes rolls back the entire transaction',async()=>{
 await pg.query("UPDATE jobs SET state='cancelled'");await expect(humanDataReview(jobId,digest,submission)).rejects.toThrow();
 expect((await pg.query('SELECT * FROM evaluation_data_persistence.operations')).rows).toHaveLength(1);
 expect((await pg.query('SELECT * FROM workflow_integration.review_resume_intents')).rows).toHaveLength(0);
});
