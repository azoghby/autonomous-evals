/** Real applied current rich service + durable core + app and simulator SQL. Only transport is scripted. */
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
 return {application,simulator,sql,job,loaded,policy,paid,ctx,restart,phase,revoke:()=>{allowed=false;}};
}

it('runs all 12 actual SQL scenarios through paid current app services and replays after reconstruction without target calls',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
 expect(run.results.map(r=>r.outcome)).toEqual(Array(12).fill('passed'));expect(run.runId).toBe(calendarOperationRunId(f.job.jobId,request.operationId));expect(transport.complete).toHaveBeenCalledTimes(24);
 const restarted=await f.restart();expect(await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).toEqual(run);
 const inv=await f.phase(restarted,()=>restarted.calendar.investigate(f.ctx,request));expect(inv.findings).toEqual([]);
 expect((await restarted.calendar.reportInput(f.ctx,request)).status).toBe('completed');expect(transport.complete).toHaveBeenCalledTimes(24);
 const reservations=(await f.sql.query<{scopes:Array<{key:string;capMicroUsd:number}>;settled_micro_usd:number|null}>('SELECT * FROM agent_persistence.reservations')).rows;
 expect(reservations).toHaveLength(24);for(const r of reservations){expect(r.settled_micro_usd).toBeNull();expect(r.scopes).toContainEqual({key:'job:calendar-job',capMicroUsd:10000});expect(r.scopes).toContainEqual({key:'agent:evaluation_engineer:calendar_test',capMicroUsd:10000});expect(r.scopes).toContainEqual({key:'autonomous-root:tenant:calendar_test',capMicroUsd:40000});}
 expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toEqual([]);
 await s.dispose();expect(transport.pools.filter(p=>p.kind==='simulator').every(p=>p.closed)).toBe(false);expect(transport.pools.filter(p=>p.kind==='application').every(p=>!p.closed)).toBe(true);await restarted.dispose();expect(transport.pools.filter(p=>p.kind==='simulator').every(p=>p.closed)).toBe(true);
 expect((await f.sql.query('SELECT * FROM app_branch_ownership')).rows).toHaveLength(1);expect((await f.sql.query('SELECT * FROM app_workflow_investigation_journals')).rows).toHaveLength(1);
},30000);

it('preserves product failures and investigation identity separately from baseline; unknown costs remain held',async()=>{
 const f=await fixture('broken');const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));expect(run.results.some(r=>r.outcome==='product_failure')).toBe(true);
 const inv=await f.phase(s,()=>s.calendar.investigate(f.ctx,request));expect(inv.reproductions).toHaveLength(3);expect(inv.findings.filter(r=>r.status==='confirmed')).toHaveLength(3);
 const calls=transport.complete.mock.calls.length;const restarted=await f.restart();expect(await f.phase(restarted,()=>restarted.calendar.investigate(f.ctx,request))).toEqual(inv);expect(transport.complete).toHaveBeenCalledTimes(calls);
 expect((await f.sql.query('SELECT * FROM autonomous_paid_app.operations')).rows).toHaveLength(15);expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(15);
 await s.dispose();await restarted.dispose();
},30000);

it('retains lost target replies as infrastructure with no reproduction or blind redispatch',async()=>{
 const f=await fixture('lost');const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));expect(run.results.map(r=>r.outcome)).toEqual(Array(12).fill('infrastructure_error'));
 const inv=await f.phase(s,()=>s.calendar.investigate(f.ctx,request));expect(inv.reproductions).toEqual([]);expect(inv.findings.every(r=>r.status==='inconclusive')).toBe(true);
 const restarted=await f.restart();expect(await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).toEqual(run);expect((await restarted.calendar.reportInput(f.ctx,request)).status).toBe('unresolved');expect(transport.complete).toHaveBeenCalledTimes(12);expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(12);
 await s.dispose();await restarted.dispose();
},30000);

it('refuses changed canonical and cross-scope identities before another paid call',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
 for(const [field,value] of [['workflowRunId','forged'],['customerId','foreign'],['environment','live'],['neonBranchId','br-other']] as const){const old=f.loaded.job[field];(f.loaded.job as Record<string,unknown>)[field]=value;await expect(s.calendar.runSuite(f.ctx,request)).rejects.toThrow();(f.loaded.job as Record<string,unknown>)[field]=old;}
 await expect(s.calendar.runSuite({...f.ctx,jobId:'foreign-job'},request)).rejects.toThrow();
 f.loaded.job.workflowRunId='changed-authorized-workflow';const changed=await f.restart('changed-authorized-workflow');await expect(changed.calendar.runSuite(f.ctx,request)).rejects.toThrow();await changed.dispose();f.loaded.job.workflowRunId='authorized-workflow';
 await f.sql.query("UPDATE workflow_integration.bindings SET target_revision='target-v2'");await expect(s.calendar.runSuite(f.ctx,request)).rejects.toThrow();await f.sql.query("UPDATE workflow_integration.bindings SET target_revision='target-v1'");
 await f.sql.query("UPDATE app_branch_ownership SET state='delete_requested'");await expect(s.calendar.runSuite(f.ctx,request)).rejects.toThrow();expect(transport.complete).toHaveBeenCalledTimes(24);await s.dispose();
},30000);

it('holds whole-phase ambiguity when durable completion is unavailable and never resumes individual targets',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 transport.failCalendarComplete=true;await expect(f.phase(s,()=>s.calendar.runSuite(f.ctx,request))).rejects.toThrow();
 expect((await f.sql.query<{state:string}>("SELECT state FROM text_integration.checkpoints WHERE kind='calendar_run'")).rows[0].state).toBe('ambiguous');
 const restarted=await f.restart();await expect(f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).rejects.toThrow();expect(transport.complete).toHaveBeenCalledTimes(24);await s.dispose();await restarted.dispose();
},30000);

it('snapshots mutable constructor authority and context so mutation cannot remove paid accounting',async()=>{
 const f=await fixture();const mutableCtx={...f.ctx};const authority:{workflowRunId:string;autonomous?:typeof f.paid}={workflowRunId:'authorized-workflow',autonomous:f.paid};
 const s=await createRichWorkflowServices(mutableCtx,authority);delete authority.autonomous;authority.workflowRunId='forged';mutableCtx.jobId='foreign';mutableCtx.environment='live';mutableCtx.budgetMicroUsd=0;
 await s.calendar.freezeSuite(f.ctx,request);const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));expect(run.results.map(r=>r.outcome)).toEqual(Array(12).fill('passed'));expect((await f.sql.query('SELECT * FROM autonomous_paid_app.operations')).rows).toHaveLength(24);await s.dispose();
},30000);

it('keeps unknown target charges held until verified receipt reconciliation and rejects changed accounting facts',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
 const op=(await f.sql.query<{operation_id:string;input_digest:string}>('SELECT operation_id,input_digest FROM autonomous_paid_app.operations ORDER BY operation_id LIMIT 1')).rows[0];
 const receipt={operationId:op.operation_id,inputDigest:op.input_digest,receiptId:'controlled-provider-receipt',microUsd:null as number|null,evidence:{providerId:'retained-controlled-evidence'}};
 await f.paid.reconcile(receipt);expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(24);
 await f.paid.reconcile({...receipt,microUsd:3});await f.paid.reconcile({...receipt,microUsd:3});expect((await f.sql.query('SELECT * FROM workflow_integration.provider_costs')).rows).toHaveLength(1);expect((await f.sql.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(1);
 await expect(f.paid.reconcile({...receipt,microUsd:4})).rejects.toThrow();await expect(f.paid.reconcile({...receipt,microUsd:3,receiptId:'changed'})).rejects.toThrow();expect(transport.complete).toHaveBeenCalledTimes(24);await s.dispose();
},30000);

it('root role and job cap denial prevents target dispatch and a completed phase cannot retry denied calls',async()=>{
 const f=await fixture('reference',20);expect((await new PostgresBudgetLedger(f.sql).reserve({reservationId:'existing-paid-hold',jobId:f.job.jobId,amountMicroUsd:20,scopes:[{key:'job:calendar-job',capMicroUsd:20},{key:'agent:evaluation_engineer:calendar_test',capMicroUsd:20},{key:'autonomous-root:tenant:calendar_test',capMicroUsd:80}]})).ok).toBe(true);const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
 expect(run.results.map(r=>r.outcome)).toEqual(Array(12).fill('infrastructure_error'));expect(transport.complete).not.toHaveBeenCalled();expect((await f.sql.query<{state:string}>('SELECT state FROM autonomous_paid_app.operations')).rows.every(r=>r.state==='denied')).toBe(true);
 const restarted=await f.restart();expect(await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).toEqual(run);expect(transport.complete).not.toHaveBeenCalled();await s.dispose();await restarted.dispose();
},30000);
