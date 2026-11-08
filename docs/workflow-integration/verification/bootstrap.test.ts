import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {createRichWorkflowServices} from '@rich-services';
it('actual canonical resolver queries A storage shape and rechecks workflow authority and target rotation',async()=>{
 const pg=new PGlite();
 const global=globalThis as any;
 const before=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://offline.invalid/test';global.__workflowPg=pg;
 try{
  await pg.exec(`CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.bindings(job_id text,target_revision text,reviewed_calendar jsonb,isolation text); CREATE TABLE customers(id text,is_internal_fixture boolean); CREATE TABLE job_credentials(job_id text,ciphertext text); INSERT INTO workflow_integration.bindings VALUES('job-1','v1',NULL,NULL); INSERT INTO customers VALUES('tenant-1',false); INSERT INTO job_credentials VALUES('job-1','ciphertext-original');`);
  global.__workflowLoaded={job:{id:'job-1',customerId:'tenant-1',workflowRunId:'workflow-1',environment:'test',state:'planning',isMock:false,package:'text_eval',retestOfJobId:null},credentials:{endpoint:'opaque-key-one'},intake:{package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/v1',model:'model',apiKey:'opaque-key-one',systemPrompt:'Assistant.'}}};
  const ctx={jobId:'job-1',environment:'test' as const,budgetMicroUsd:100,recordProgress:async()=>{},recordCost:async()=>{}};
  await expect(createRichWorkflowServices(ctx,{workflowRunId:'wrong-run'})).rejects.toThrow('Canonical Workflow binding');
  const first=await createRichWorkflowServices(ctx,{workflowRunId:'workflow-1'});
  expect(first.job.customerId).toBe('tenant-1');expect(first.job.isFixture).toBe(false);
  await pg.query("UPDATE job_credentials SET ciphertext='ciphertext-rotated'");
  const rotated=await createRichWorkflowServices(ctx,{workflowRunId:'workflow-1'});expect(rotated.targetVersion).not.toBe(first.targetVersion);
  global.__workflowLoaded.job.workflowRunId='replacement';
  await expect(first.text.getSuite(ctx,{suiteDigest:'a'.repeat(64)})).rejects.toThrow('Canonical Workflow binding');
  global.__workflowLoaded.job.workflowRunId='workflow-1';global.__workflowLoaded.job.environment='live';
  await expect(createRichWorkflowServices(ctx,{workflowRunId:'workflow-1'})).rejects.toThrow('Canonical Workflow binding');
 }finally{await pg.close();if(before===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=before;delete global.__workflowLoaded;delete global.__workflowPg;}
},30000);
