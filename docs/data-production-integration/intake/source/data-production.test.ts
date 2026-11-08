import { readFileSync } from 'node:fs';
import { describe,it,expect,vi,beforeAll,afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ human: null as null | {id:string;isOperator:boolean}, sql: undefined as any, runner: vi.fn(), design: vi.fn(async()=>({status:'blocked',reason:'suite_rejected_after_bounded_revision',costs:[]})) }));
vi.mock('@ae/core/evals/text/design',()=>({designTextSuite:fixture.design}));
vi.mock('server-only',()=>({}));
vi.mock('@neondatabase/serverless',()=>({Pool:class {}}));
vi.mock('@ae/core/integration/eval-services',()=>({buildAgentDeps:async()=>({runner:{run:fixture.runner}})}));
vi.mock('@ae/core/simulator/pool',()=>({pooledCalendarDatabase:()=>fixture.sql}));
vi.mock('./session',()=>({getCurrentCustomer:async()=>fixture.human}));
import { humanDataReview, advanceProductionData } from './data-production';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { dataReviewRequestDigest } from '@ae/core/evals/data/orchestration';
import { reviewDigest } from '@ae/core/evals/data/binding';
let db:PGlite;
const jobId='a1b2c3d4-e5f6-4abc-8def-aabbccddeeff', tenantId='b1c2d3e4-f5a6-4abc-8def-bbccddeeffaa';
const task = {taskId:'task_a',jobId,description:'Review candidate',requirements:[{id:'req',description:'A case',minimumCases:1}],factualAnswersRequired:false,targetId:'target'};
const candidates={sources:[],cases:[{id:'case_a',input:'Question',requirementIds:['req'],synthetic:true,generatorId:'producer',sourceIds:[]}]};
const digest=dataReviewRequestDigest(task,candidates);
beforeAll(async()=>{
 process.env.DATABASE_URL='unused';
 db=new PGlite(); await db.exec(readFileSync('packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql','utf8')); await db.exec(readFileSync('packages/core/src/evals/data/persistence-migrations/002-data-operations.sql','utf8'));
 await db.exec(`CREATE TABLE jobs(id text,customer_id text,package text,environment text,is_mock boolean,retest_of_job_id text); CREATE TABLE job_credentials(job_id text,ciphertext text);`);
 await db.query('INSERT INTO jobs VALUES($1,$2,$3,$4,false,null)',[jobId,tenantId,'text_eval','test']);
 fixture.sql={query:(q:string,p?:unknown[])=>db.query(q,p),transaction:(fn:any)=>db.transaction(tx=>fn({query:(q:string,p?:unknown[])=>tx.query(q,p)}))};
 const operations=createPostgresDataOperationLedger(fixture.sql,{tenantId,jobId,ownerId:'data_service_v1',authenticateOwner:async()=>({ownerId:'data_service_v1'})});
 const result={task,candidates};const key=`data-review-request:${digest}`;await operations.claim(key,reviewDigest(result));await operations.complete(key,reviewDigest(result),result);
});
afterAll(async()=>{await db.close();});
describe('actual authenticated intake composition with PGlite operation storage',()=>{
 it('denies missing/nonoperator sessions before SQL candidate reads',async()=>{
  const spy=vi.spyOn(fixture.sql,'query');
  for(const human of [null,{id:'customer',isOperator:false}]) {fixture.human=human;await expect(humanDataReview(jobId,digest)).rejects.toThrow();}
  expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 });
 it('reads exact durable candidate snapshot and blocks a different job',async()=>{
  fixture.human={id:'independent-human',isOperator:true};
  expect(await humanDataReview(jobId,digest)).toEqual({task,candidates});
  await expect(humanDataReview('c1d2e3f4-a5b6-4abc-8def-ccddeeffaabb',digest)).rejects.toThrow();
 });
 it('rejects producer approval and altered candidate payloads',async()=>{
  fixture.human={id:'producer',isOperator:true};
  await expect(humanDataReview(jobId,digest,{receiptId:'producer_receipt',decision:'approved',reviewed:structuredClone(candidates)})).rejects.toThrow();
  fixture.human={id:'independent-human',isOperator:true};
  const changed=structuredClone(candidates);changed.cases[0].input='swapped';
  await expect(humanDataReview(jobId,digest,{receiptId:'swapped_receipt',decision:'approved',reviewed:changed})).rejects.toThrow();
 });
 it('records and replays only an explicit human decision, with immutable receipt',async()=>{
  fixture.human={id:'independent-human',isOperator:true};
  const input={receiptId:'human_receipt',decision:'approved' as const,reviewed:structuredClone(candidates)};
  expect(await humanDataReview(jobId,digest,input)).toEqual({status:'recorded'});
  expect(await humanDataReview(jobId,digest,input)).toEqual({status:'recorded'});
  await expect(humanDataReview(jobId,digest,{...input,decision:'rejected'})).rejects.toThrow();
  expect(fixture.runner).not.toHaveBeenCalled();
 });
 it('keeps an incomplete design frozen operation fenced across a retry',async()=>{
  const input={task,initial:candidates,context:{versionLabel:'default',systemPrompt:null}};
  const first=await advanceProductionData(jobId,input);
  expect(first.status).toBe('reconciliation_required');
  expect(first.frozen).toBeUndefined();
  const second=await advanceProductionData(jobId,input);
  expect(second.status).toBe('reconciliation_required');
  expect(second.frozen).toBeUndefined();
  expect(fixture.design).toHaveBeenCalledTimes(1);
  expect(fixture.runner).not.toHaveBeenCalled();
 });
});
