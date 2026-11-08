/** Shared replay-verification fixture (not a test file). Real composed rich services, real core
 * Calendar engine, real PGlite SQL for application + simulator. Only the Neon Pool transport,
 * canonical job loader, branch connection lookup and target HTTP transport are scripted. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {vi} from 'vitest';
import {createRichWorkflowServices,workflowSql} from '@/server/rich-services';
import {createAutonomousPaidContext} from '@/server/autonomous-paid';
import {deliverRemediationCost} from '@/server/rich-remediation';
import {createAutonomousPolicy} from '@ae/core/agents/autonomy/policy';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import type {ServiceContext} from '@ae/core/contracts/services';
import {calendarOperationRunId} from '@ae/core/evals/calendar-integration/index';
import {calendarAcceptanceScenarios} from '@ae/core/simulator/acceptance-scenarios';
import type {ChatTarget} from '@ae/core/targets/chat';

export type Transport={loaded:unknown;pool:unknown;complete:ReturnType<typeof vi.fn<ChatTarget['complete']>>;pools:Array<{kind:string;closed:boolean}>;branchLookups:number;calendarDeps:unknown};
export const request={suiteId:'reviewed-calendar',operationId:'durable-baseline',versionLabel:'baseline'};
export const acceptance=calendarAcceptanceScenarios();

export async function buildFixture(transport:Transport,opts:{mode?:'reference'|'broken'|'lost';reviewed?:boolean;paidSql?:'exact'|'foreign';jobWorkflowRunId?:string;cap?:number}={}){
 const {mode='reference',reviewed:withReviewed=true,paidSql='exact',jobWorkflowRunId='authorized-workflow',cap=10000}=opts;
 const application=new PGlite(),simulator=new PGlite();
 const stage=process.env.WORKFLOW_STAGE!;
 const migration=(p:string)=>readFileSync(join(stage,'packages/core/src',p),'utf8');
 for(const p of ['agents/persistence-migrations/001-agent-persistence.sql','evals/integration/migrations/001-text-integration.sql','simulator/ledger-migrations/001_branch_ownership.sql','simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql'])await application.exec(migration(p));
 await simulator.exec(migration('simulator/migrations/001_calendar.sql'));
 await application.exec(readFileSync(join(stage,'apps/web/src/server/autonomous-paid.sql'),'utf8'));
 await application.exec(readFileSync(join(stage,'docs/current-autonomy-integration/dependencies/owner-migrations/app.inventory.sql'),'utf8'));
 await application.exec(`CREATE TABLE jobs(id text,customer_id text,environment text,package text);INSERT INTO jobs VALUES('calendar-job','tenant','test','workflow_eval');
 CREATE TABLE customers(id text,is_internal_fixture boolean);INSERT INTO customers VALUES('tenant',true);
 CREATE TABLE job_credentials(job_id text,ciphertext text);INSERT INTO job_credentials VALUES('calendar-job','retained-opaque-ciphertext');
 CREATE SCHEMA workflow_integration;CREATE TABLE workflow_integration.bindings(job_id text,target_revision text,reviewed_calendar jsonb,isolation text,remediation_operation_micro_usd bigint,baseline_suite_digest text,baseline_run_id text);
 CREATE TABLE workflow_integration.cost_keys(job_id text,key text PRIMARY KEY,payload jsonb);CREATE TABLE workflow_integration.provider_costs(job_id text,key text PRIMARY KEY,source text,operation_id text,receipt_id text,micro_usd bigint);
 INSERT INTO app_branch_ownership VALUES('calendar-job','local-project','br-parent','eval-job-11111111-1111-1111-1111-111111111111','br-owned','ready',1);`);
 const reviewed={jobId:'calendar-job',origin:'internal_fixture',frozenAt:'2026-11-07T20:00:00.000Z',review:{reviewerId:'trusted-local-fixture',approved:true},scenarios:acceptance.map(({id,prompt,actorId,seed,checks})=>structuredClone({id,prompt,actorId,seed,checks}))};
 await application.query("INSERT INTO workflow_integration.bindings VALUES('calendar-job','target-v1',$1::jsonb,NULL,NULL,NULL,NULL)",[withReviewed?JSON.stringify(reviewed):null]);
 let appLock:Promise<void>=Promise.resolve();
 const acquire=async()=>{const previous=appLock;let release!:()=>void;appLock=new Promise<void>(r=>{release=r;});await previous;return release;};
 const appQuery=async(s:string,p?:unknown[])=>{const release=await acquire();try{return await application.query(s,p);}finally{release();}};
 let lock:Promise<void>=Promise.resolve();
 transport.pool={query:(kind:string,s:string,p?:unknown[])=>kind==='application'?appQuery(s,p):simulator.query(s,p),async connect(kind:string){
  if(kind==='application'){let release:(()=>void)|undefined;return {async query(s:string,p?:unknown[]){if(s.includes('pg_advisory_unlock'))return {rows:[{unlocked:true}]};if(s.includes('pg_advisory_lock'))return {rows:[]};if(s==='BEGIN')release=await acquire();if(release){try{return await application.query(s,p);}finally{if(s==='COMMIT'||s==='ROLLBACK'){release();release=undefined;}}}return appQuery(s,p);},release(){release?.();release=undefined;}};}
  const before=lock;let unlock!:()=>void;lock=new Promise<void>(r=>{unlock=r;});await before;
  return {query:(s:string,p?:unknown[])=>simulator.query(s,p),release(){unlock();}};
 }};
 process.env.DATABASE_URL='offline-application';const exact=workflowSql();
 // A distinct port over the same database: same rows, different object identity.
 const foreign:AgentTransactionalSql={query:(s,p)=>exact.query(s,p),transaction:fn=>exact.transaction(fn)};
 const sql=paidSql==='exact'?exact:foreign;
 const job={jobId:'calendar-job',customerId:'tenant',package:'workflow_eval' as const,environment:'test' as const,isFixture:true,quoteVersion:1,linkedRetestOf:null};
 const loaded={job:{id:job.jobId,customerId:job.customerId,environment:job.environment,workflowRunId:jobWorkflowRunId,isMock:false,state:'running',neonBranchId:'br-owned',retestOfJobId:null},intake:{package:'workflow_eval',authorizedToTest:true,endpoint:{url:'https://controlled.invalid/chat',model:'controlled-fixture',systemPrompt:'Trusted calendar instructions.'}},credentials:{}};
 transport.loaded=loaded;
 const policy=createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'calendar_test',enabled:true,rootBudgetMicroUsd:cap*4,singleJobCapMicroUsd:cap,comparisonJobCapMicroUsd:cap,roleCapsMicroUsd:{commercial:cap,evaluation_engineer:cap,quality_investigator:cap,company_operator:cap},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
 const runner={run:vi.fn(async()=>{throw Error('No agent sessions needed for reviewed controlled calendar');})};
 const paid=createAutonomousPaidContext({sql,policy,job,runner,guard:async()=>{},jobCapMicroUsd:cap,targetReservationMicroUsd:10,judgeReservationMicroUsd:10,deliverCost:deliverRemediationCost,verifyReceipt:async()=>true});
 Object.assign(process.env,{DATABASE_URL:'offline-application',WORKFLOW_JUDGE_AUTH:'api_key',WORKFLOW_JUDGE_MODEL:'controlled/model',WORKFLOW_JUDGE_CONFIG_VERSION:'v1',WORKFLOW_JUDGE_RESERVATION_MICRO_USD:'10',NAIVE_BUDGET_PERIOD_ID:policy.periodId});
 transport.complete.mockImplementation(async messages=>{
  if(mode==='lost')throw Error('accepted target request; response lost');
  if(mode==='broken')return {role:'assistant',content:'No action was performed.'};
  const prompt=messages.find(m=>m.role==='user')!.content;
  const scenario=acceptance.find(s=>s.prompt===prompt)!;
  return messages.some(m=>m.role==='tool')?{role:'assistant',content:'Reference sequence complete.'}:{role:'assistant',content:null,tool_calls:structuredClone(scenario.referenceCalls)};
 });
 const ctx:ServiceContext={jobId:job.jobId,environment:'test',budgetMicroUsd:cap,recordCost:vi.fn(async()=>{}),recordProgress:vi.fn(async()=>{})};
 const restart=(workflowRunId='authorized-workflow')=>createRichWorkflowServices(ctx,{workflowRunId,autonomous:paid});
 const phase=async<T>(s:Awaited<ReturnType<typeof restart>>,action:()=>Promise<T>)=>s.inventory.phase({runId:calendarOperationRunId(job.jobId,request.operationId),suiteDigest:(await s.calendar.getSuite(ctx,request)).hash,scenarioIds:acceptance.map(s=>s.id),branchId:'br-owned'},action);
 const count=async(table:string,where='')=>(await application.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;
 const close=async()=>{await application.close();await simulator.close();};
 return {application,simulator,sql,exact,job,loaded,policy,paid,ctx,restart,phase,count,close};
}
