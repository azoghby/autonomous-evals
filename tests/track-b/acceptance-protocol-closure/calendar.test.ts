import type { ChatTarget } from '@ae/core/targets/chat';
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { createCalendarEvaluationServices } from '@ae/core/evals/calendar-integration';
import { calendarAcceptanceScenarios } from '@ae/core/simulator/acceptance-scenarios';
import { CalendarSimulator } from '@ae/core/simulator/calendar';
import { PostgresCalendarStore } from '@ae/core/simulator/postgres';
it('full12 actual SQL proof preserves independent job-bound suites and replays without target calls',async()=>{
 const stage=process.env.WORKFLOW_STAGE!; const db=new PGlite();
 const sql:any={query:(s:string,p?:unknown[])=>db.query(s,p),transaction:(f:any)=>db.transaction(tx=>f({query:(s:string,p?:unknown[])=>tx.query(s,p)}))};
 try{
 for(const p of ['simulator/migrations/001_calendar.sql','simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql','evals/integration/migrations/001-text-integration.sql'])await db.exec(readFileSync(join(stage,'packages/core/src',p),'utf8'));
 const scenarios=calendarAcceptanceScenarios();
 const calendarJob:any={jobId:'fixture-calendar',customerId:'tenant',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const calendarCtx:any={jobId:calendarJob.jobId,environment:'test',budgetMicroUsd:0,recordCost:async()=>{},recordProgress:async()=>{}};
 const reviewedSuite:any={jobId:calendarJob.jobId,origin:'internal_fixture',frozenAt:'2026-11-07T00:00:00Z',review:{reviewerId:'fixture',approved:true},scenarios:scenarios.map(({id,prompt,actorId,seed,checks})=>structuredClone({id,prompt,actorId,seed,checks}))};
 const pool:any={query:sql.query,connect:async()=>({query:(s:string,p:any)=>s.includes('pg_advisory_unlock')?Promise.resolve({rows:[{unlocked:true}]}):s.includes('pg_advisory_lock')?Promise.resolve({rows:[]}):sql.query(s,p),release:()=>{}})};
 let calendarCalls=0;
 const calendarReports:any={};
 for(const version of ['buggy','fixed']){
  calendarJob.jobId='fixture-calendar-'+version; calendarCtx.jobId=calendarJob.jobId; reviewedSuite.jobId=calendarJob.jobId;
  const checkpoints=new PostgresTextCheckpointStore(sql);
  const targetForScenario=(scenario:any):ChatTarget=>({complete:async(messages:any[])=>{
   calendarCalls++;
   const reference=scenarios.find(s=>s.id===scenario.id)!;
   if(messages.some(m=>m.role==='tool'))return {role:'assistant',content:'Fixture sequence complete.'};
   const calls=version==='buggy'&&['booking','cancel'].includes(scenario.id)?[{id:reference.referenceCalls[0].id,type:'function' as const,function:{name:'list_events',arguments:'{\"calendarId\":\"personal\"}'}}]:structuredClone(reference.referenceCalls);
   return {role:'assistant',content:null,tool_calls:calls};
  }});
  const api=createCalendarEvaluationServices({checkpoints,journalPool:pool,resolve:async()=>({job:calendarJob,targetVersion:version,branch:{jobId:calendarJob.jobId,branchId:'fixture-branch',targetVersion:version},reviewedSuite,systemPrompt:'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.',knownSecrets:[],dependencies:{db:sql,simulator:new CalendarSimulator(new PostgresCalendarStore(sql)),targetForScenario}})});
  const request={suiteId:'suite-'+version,operationId:'run-'+version,versionLabel:version};
  await api.freezeSuite(calendarCtx,request);await api.runSuite(calendarCtx,request);await api.investigate(calendarCtx,request);
  calendarReports[version]=await api.reportInput(calendarCtx,request);
  const before=calendarCalls;
  await api.runSuite(calendarCtx,request);await api.investigate(calendarCtx,request);
  expect(calendarCalls).toBe(before);
  expect(await api.reportInput(calendarCtx,request)).toEqual(calendarReports[version]);
 }

 expect(calendarCalls).toBe(52);
 expect(calendarReports.buggy.suite.hash).not.toBe(calendarReports.fixed.suite.hash);
 for(const version of ['buggy','fixed']){
  const report=calendarReports[version];expect(report.run.jobId).toBe('fixture-calendar-'+version);
  expect(report.run.suiteHash).toBe(report.suite.hash);expect(report.run.results).toHaveLength(12);
  for(const row of report.run.results){
   expect(row.scope.jobId).toBe(report.run.jobId);expect(row.scope.version).toBe(version);
   expect(row.scope.runId).toBeTruthy();expect(row.stateGrade).toBeDefined();
   expect(row.outcome).toBe(version==='buggy'&&['booking','cancel'].includes(row.scenarioId)?'product_failure':'passed');
  }
 }
 }finally{await db.close();}
},60000);
