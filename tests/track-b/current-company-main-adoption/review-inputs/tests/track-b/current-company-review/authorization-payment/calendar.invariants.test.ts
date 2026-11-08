/** Calendar shared paid authority invariants. Fixture copied verbatim from tests/track-b/current-autonomy-calendar/calendar.test.ts
 * (real rich services, core Calendar engine, app + simulator SQL; only transport/branch connection scripted). */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,it,vi} from 'vitest';
import {createRichWorkflowServices,workflowSql} from '@/server/rich-services';
import {createAutonomousPaidContext} from '@/server/autonomous-paid';
import {deliverRemediationCost} from '@/server/rich-remediation';
import {PostgresBudgetLedger} from '@ae/core/agents/postgres-ports';
import {createAutonomousPolicy} from '@ae/core/agents/autonomy/policy';
import type {ServiceContext} from '@ae/core/contracts/services';
import {calendarOperationRunId} from '@ae/core/evals/calendar-integration/index';
import {calendarAcceptanceScenarios} from '@ae/core/simulator/acceptance-scenarios';
import type {ChatTarget} from '@ae/core/targets/chat';

const transport=vi.hoisted(()=>({loaded:null as unknown,pool:null as unknown,complete:vi.fn<ChatTarget['complete']>(),failCalendarComplete:false,pools:[] as Array<{kind:string;closed:boolean}>}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>transport.loaded}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),evalServices:{getJobBranchConnection:vi.fn(async()=> 'offline-simulator')}}));
vi.mock('@ae/core/targets/adapters',async original=>({...await original<typeof import('@ae/core/targets/adapters')>(),platformTarget:()=>({complete:transport.complete})}));
vi.mock('@neondatabase/serverless',()=>({Pool:class {
  readonly kind:string; closed=false;
  constructor(config:{connectionString:string}){this.kind=config.connectionString==='offline-simulator'?'simulator':'application';transport.pools.push(this);}
  query(s:string,p?:unknown[]){return (transport.pool as {query(kind:string,s:string,p?:unknown[]):Promise<unknown>}).query(this.kind,s,p);}
  connect(){return (transport.pool as {connect(kind:string):Promise<unknown>}).connect(this.kind);}
  async end(){this.closed=true;}
}}));
const request={suiteId:'reviewed-calendar',operationId:'durable-baseline',versionLabel:'baseline'};
const acceptance=calendarAcceptanceScenarios();
const engines:PGlite[]=[];
afterEach(async()=>{transport.complete.mockReset();transport.pools.length=0;await Promise.all(engines.splice(0).map(db=>db.close()));});
async function fixture(mode:'reference'|'broken'|'lost'='reference',cap=10000){
 const application=new PGlite(),simulator=new PGlite();engines.push(application,simulator);
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
 await application.query("INSERT INTO workflow_integration.bindings VALUES('calendar-job','target-v1',$1::jsonb,NULL,NULL,NULL,NULL)",[JSON.stringify(reviewed)]);
 let appLock:Promise<void>=Promise.resolve();
 const acquire=async()=>{const previous=appLock;let release!:()=>void;appLock=new Promise<void>(r=>{release=r;});await previous;return release;};
 const executeApp=async(s:string,p?:unknown[])=>{if(transport.failCalendarComplete&&s.includes("SET state = 'completed'")&&p?.includes('calendar_run')){transport.failCalendarComplete=false;throw Error('durable completion unavailable');}return application.query(s,p);};
 const appQuery=async(s:string,p?:unknown[])=>{const release=await acquire();try{return await executeApp(s,p);}finally{release();}};
 let lock:Promise<void>=Promise.resolve();
 transport.pool={query:(kind:string,s:string,p?:unknown[])=>kind==='application'?appQuery(s,p):simulator.query(s,p),async connect(kind:string){
  if(kind==='application'){let release:(()=>void)|undefined;return {async query(s:string,p?:unknown[]){if(s.includes('pg_advisory_unlock'))return {rows:[{unlocked:true}]};if(s.includes('pg_advisory_lock'))return {rows:[]};if(s==='BEGIN')release=await acquire();if(release){try{return await executeApp(s,p);}finally{if(s==='COMMIT'||s==='ROLLBACK'){release();release=undefined;}}}return appQuery(s,p);},release(){release?.();release=undefined;}};}
  const before=lock;let unlock!:()=>void;lock=new Promise<void>(r=>{unlock=r;});await before;
  return {query:(s:string,p?:unknown[])=>simulator.query(s,p),release(){unlock();}};
 }};
 process.env.DATABASE_URL='offline-application';const sql=workflowSql();
 const job={jobId:'calendar-job',customerId:'tenant',package:'workflow_eval' as const,environment:'test' as const,isFixture:true,quoteVersion:1,linkedRetestOf:null};
 const loaded={job:{id:job.jobId,customerId:job.customerId,environment:job.environment,workflowRunId:'authorized-workflow',isMock:false,state:'running',neonBranchId:'br-owned',retestOfJobId:null},intake:{package:'workflow_eval',authorizedToTest:true,endpoint:{url:'https://controlled.invalid/chat',model:'controlled-fixture',systemPrompt:'Trusted calendar instructions.'}},credentials:{}};
 transport.loaded=loaded;
 const policy=createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'calendar_test',enabled:true,rootBudgetMicroUsd:cap*4,singleJobCapMicroUsd:cap,comparisonJobCapMicroUsd:cap,roleCapsMicroUsd:{commercial:cap,evaluation_engineer:cap,quality_investigator:cap,company_operator:cap},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
 let allowed=true;
 const runner={run:vi.fn(async()=>{throw Error('No agent sessions needed for reviewed controlled calendar');})};
 const paid=createAutonomousPaidContext({sql,policy,job,runner,guard:async()=>{if(!allowed)throw Error('authority revoked');},jobCapMicroUsd:cap,targetReservationMicroUsd:10,judgeReservationMicroUsd:10,deliverCost:deliverRemediationCost,verifyReceipt:async()=>true});
 Object.assign(process.env,{DATABASE_URL:'offline-application',WORKFLOW_JUDGE_AUTH:'api_key',WORKFLOW_JUDGE_MODEL:'controlled/model',WORKFLOW_JUDGE_CONFIG_VERSION:'v1',WORKFLOW_JUDGE_RESERVATION_MICRO_USD:'10',NAIVE_BUDGET_PERIOD_ID:policy.periodId});
 workflowSql(); // Initialize app pool explicitly; production factory must also support first autonomous invocation.
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
 const mint=(port:typeof sql)=>createAutonomousPaidContext({sql:port,policy,job,runner,guard:async()=>{if(!allowed)throw Error('authority revoked');},jobCapMicroUsd:cap,targetReservationMicroUsd:10,judgeReservationMicroUsd:10,deliverCost:deliverRemediationCost,verifyReceipt:async()=>true});
 return {application,simulator,sql,job,loaded,policy,paid,ctx,restart,phase,mint,revoke:()=>{allowed=false;}};
}


it('Calendar refuses a paid capability minted over any SQL adapter other than the application workflowSql() port, before any target call',async()=>{
 const f=await fixture();
 const foreign={query:f.sql.query.bind(f.sql),transaction:f.sql.transaction.bind(f.sql)} as typeof f.sql; // same database, different port identity
 expect(f.paid.sql).toBe(workflowSql());
 await expect(createRichWorkflowServices(f.ctx,{workflowRunId:'authorized-workflow',autonomous:f.mint(foreign)})).rejects.toThrow('Canonical Workflow binding unavailable or changed');
 const control=await createRichWorkflowServices(f.ctx,{workflowRunId:'authorized-workflow',autonomous:f.mint(f.sql)});await control.dispose(); // identical port constructs
 expect(transport.complete).not.toHaveBeenCalled();expect((await f.sql.query('SELECT * FROM autonomous_paid_app.operations')).rows).toHaveLength(0);
},30000);

it('revocation during a Calendar run stops every further paid target call; only the in-flight intent is retained and its cost stays held',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const reference=transport.complete.getMockImplementation()!;
 transport.complete.mockImplementation(async(messages,tools)=>{f.revoke();return reference(messages,tools);});
 await f.phase(s,()=>s.calendar.runSuite(f.ctx,request)).catch(()=>undefined);
 expect(transport.complete).toHaveBeenCalledTimes(1);
 const ops=(await f.sql.query<{state:string}>('SELECT state FROM autonomous_paid_app.operations')).rows;
 expect(ops).toEqual([{state:'dispatched'}]);
 expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(1);
 const restarted=await f.restart().catch(()=>null);
 if(restarted){await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request)).catch(()=>undefined);await restarted.dispose();}
 expect(transport.complete).toHaveBeenCalledTimes(1);await s.dispose();
},30000);
