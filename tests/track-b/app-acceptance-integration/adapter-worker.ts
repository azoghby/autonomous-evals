/** Explicit offline fixture; not live app acceptance and never accepted evidence. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRichRemediation, deliverRemediationCost } from '@/server/rich-remediation';
import { persistRichArtifact, readRichArtifact } from '@/server/rich-artifacts';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import { createTrackBServices } from '@ae/core/evals/service-adapter';
import { makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { HttpsJsonTransport } from '@ae/core/targets/transport';
import { createCalendarEvaluationServices } from '@ae/core/evals/calendar-integration';
import { calendarAcceptanceScenarios } from '@ae/core/simulator/acceptance-scenarios';
import { CalendarSimulator } from '@ae/core/simulator/calendar';
import { PostgresCalendarStore } from '@ae/core/simulator/postgres';
import { canonicalJson } from '@ae/core/evals/text';
const [directory,phase,stage]=process.argv.slice(2);
const db=new PGlite(directory);
const sql:any={query:(s:string,p?:unknown[])=>db.query(s,p),transaction:(f:any)=>db.transaction(tx=>f({query:(s:string,p?:unknown[])=>tx.query(s,p)}))};
let dispatches=0, proposals=0;
try {
 if(phase==='baseline'){
  for(const p of ['simulator/migrations/001_calendar.sql','simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql','agents/persistence-migrations/001-agent-persistence.sql','evals/integration/migrations/001-text-integration.sql','evals/remediation/accounting/001-remediation-accounting.sql'])await db.exec(readFileSync(join(stage,'packages/core/src',p),'utf8'));
  await db.exec(`CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(job_id text,key text PRIMARY KEY,payload jsonb); CREATE TABLE workflow_integration.provider_costs(job_id text,key text PRIMARY KEY,source text,operation_id text,receipt_id text,micro_usd bigint); CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,environment text); INSERT INTO jobs VALUES('fixture','tenant','test'); CREATE TABLE workflow_integration.rich_artifacts(job_id text PRIMARY KEY,tenant_id text,environment text,suite_digest text,body jsonb);`);
 }
 // Actual Calendar factory + simulator + SQL graders. Only target messages and
 // advisory locks are fixture adapters; native PostgreSQL concurrency is unproven.
 const scenarios=calendarAcceptanceScenarios();
 const calendarJob:any={jobId:'fixture-calendar',customerId:'tenant',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const calendarCtx:any={jobId:calendarJob.jobId,environment:'test',budgetMicroUsd:0,recordCost:async()=>{},recordProgress:async()=>{}};
 const reviewedSuite:any={jobId:calendarJob.jobId,origin:'internal_fixture',frozenAt:'2026-11-07T00:00:00Z',review:{reviewerId:'fixture',approved:true},scenarios:scenarios.map(({id,prompt,actorId,seed,checks})=>structuredClone({id,prompt,actorId,seed,checks}))};
 const pool:any={query:sql.query,connect:async()=>({query:(s:string,p:any)=>s.includes('pg_advisory_unlock')?Promise.resolve({rows:[{unlocked:true}]}):s.includes('pg_advisory_lock')?Promise.resolve({rows:[]}):sql.query(s,p),release:()=>{}})};
 let calendarCalls=0;
 const calendarReports:any={};
 for(const version of ['buggy','fixed']){
  const checkpoints=new PostgresTextCheckpointStore(sql);
  const targetForScenario=(scenario:any)=>({complete:async(messages:any[])=>{
   calendarCalls++;if(phase==='restart')throw Error('calendar_replay_dispatched');
   const reference=scenarios.find(s=>s.id===scenario.id)!;
   if(messages.some(m=>m.role==='tool'))return {role:'assistant',content:'Fixture sequence complete.'};
   const calls=version==='buggy'&&['booking','cancel'].includes(scenario.id)?[{id:reference.referenceCalls[0].id,type:'function',function:{name:'list_events',arguments:'{\"calendarId\":\"personal\"}'}}]:structuredClone(reference.referenceCalls);
   return {role:'assistant',content:null,tool_calls:calls};
  }});
  const api=createCalendarEvaluationServices({checkpoints,journalPool:pool,resolve:async()=>({job:calendarJob,targetVersion:version,branch:{jobId:calendarJob.jobId,branchId:'fixture-branch',targetVersion:version},reviewedSuite,systemPrompt:'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.',knownSecrets:[],dependencies:{db:sql,simulator:new CalendarSimulator(new PostgresCalendarStore(sql)),targetForScenario}})});
  const request={suiteId:'suite-'+version,operationId:'run-'+version,versionLabel:version};
  await api.freezeSuite(calendarCtx,request);await api.runSuite(calendarCtx,request);await api.investigate(calendarCtx,request);
  calendarReports[version]=await api.reportInput(calendarCtx,request);
 }
 if(calendarReports.buggy.suite.hash!==calendarReports.fixed.suite.hash)throw Error('calendar_suite_drift');
 if(phase==='baseline'){
  await db.query('INSERT INTO jobs VALUES($1,$2,$3)',[calendarJob.jobId,'tenant','test']);
  await persistRichArtifact(sql,{jobId:calendarJob.jobId,tenantId:'tenant',environment:'test'},calendarReports.buggy.suite.hash,calendarReports,[]);
 }
 const retainedCalendar=await readRichArtifact(sql,calendarJob.jobId,'tenant',[]);
 const calendarDigest=createHash('sha256').update(canonicalJson(retainedCalendar)).digest('hex');
 const calendarBuggyFailures=calendarReports.buggy.run.results.filter((r:any)=>r.outcome==='product_failure').length;
 const calendarFixedPassed=calendarReports.fixed.run.results.filter((r:any)=>r.outcome==='passed').length;
 const job:any={jobId:'fixture',customerId:'tenant',package:'text_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const suite=makeSuite({jobId:'fixture'});
 const ctx:any={jobId:'fixture',environment:'test',budgetMicroUsd:100000,recordCost:async()=>{},recordProgress:async()=>{}};
 const checkpoints=new PostgresTextCheckpointStore(sql);
 const patch={kind:'prompt_patch',summary:'Retain marker',patch:'Always include READY.',rationale:'Satisfy explicit constraint.'};
 const runner:any={run:async(spec:any)=>{
  proposals++;
  if(phase==='restart')throw Error('fixture_replay_dispatched_agent');
  return {status:'completed',output:spec.output.name==='text_investigation'?{reproduceScenarioIds:['S01'],verdicts:[{candidateId:'text:S01:S01.o1',verdict:'confirmed',rationale:'Repeated failure',quote:'WRONG',defectNote:null}]}:patch};
 }};
 const text=createTextEvaluationServices({runner,checkpoints,resolveApprovedSuite:async()=>suite,resolve:async()=>({job,targetVersion:'v1',knownSecrets:[],judge:null,target:{send:async(r:any)=>{dispatches++;if(phase==='restart')throw Error('fixture_replay_dispatched_target');return {ok:true,text:r.scenarioId==='S01'?'WRONG':'READY',latencyMs:1};}}})});
 const request={suiteDigest:suite.digest,runId:'baseline'};
 await text.runSuite(ctx,request);await text.investigate(ctx,request);
 const saved=await text.reportInput(ctx,request);
 const canonical:any={job,knownSecrets:[],targetVersion:'v1',intake:{endpoint:{url:'https://fixture.example/v1/chat/completions',model:'offline-fixture'}},binding:{isolation:'request_messages_only',remediation_operation_micro_usd:1,baseline_suite_digest:suite.digest,baseline_run_id:'baseline'}};
 HttpsJsonTransport.prototype.post=async function(_url:any,payload:any){dispatches++;if(phase==='restart')throw Error('fixture_replay_dispatched_trial');if(payload.messages[0].content!==patch.patch)throw Error('actual_payload_mismatch');return {choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};} as any;
 process.env.NAIVE_BUDGET_PERIOD_ID='offline_fixture';
 const remediation=await createRichRemediation({sql,runner,checkpoints,canonical:async()=>canonical,text}).proposeAndVerifyFixDetailed(ctx,{findingId:'text:S01:S01.o1'});
 const report=await createTrackBServices({runner,resolveJob:async()=>job,resolveKnownSecrets:async()=>[],operatorSummary:false,clock:{now:()=>new Date('2026-11-07T00:00:00Z')}}).renderReport(ctx,{intake:{} as any,findings:[],richFindings:saved.richFindings,limitations:['offline_fixture_only','Provider monetary cost unknown.']});
 const body={format:'offline_fixture_only',baseline:saved,remediation,report};
 if(phase==='baseline')await persistRichArtifact(sql,{jobId:'fixture',tenantId:'tenant',environment:'test'},suite.digest,body,[]);
 const retained=await readRichArtifact(sql,'fixture','tenant',[]);
 const foreign=await readRichArtifact(sql,'fixture','other',[]);
 const entry:any={jobId:'fixture',operationId:'fixture-metered',kind:'target',microUsd:7,idempotencyKey:'fixture-measured-cost',receiptId:'fixture-measured-receipt'};
 await sql.transaction((tx:any)=>deliverRemediationCost(tx,entry));await sql.transaction((tx:any)=>deliverRemediationCost(tx,entry));
 const operations=(await db.query('SELECT * FROM remediation_accounting.operations')).rows;
 const costs=(await db.query('SELECT * FROM workflow_integration.provider_costs')).rows;
 process.stdout.write(JSON.stringify({source:'offline_fixture',remoteAttestation:false,calendarCalls,calendarDigest,calendarBuggyFailures,calendarFixedPassed,pid:process.pid,dispatches,proposals,reportDigest:createHash('sha256').update(canonicalJson(retained)).digest('hex'),foreign,operations:operations.length,unknown:operations.filter((o:any)=>o.settlement===null).length,costRows:costs.length,applied:remediation.applied.length,verification:remediation.remediation.verification}));
}finally{await db.close();}
