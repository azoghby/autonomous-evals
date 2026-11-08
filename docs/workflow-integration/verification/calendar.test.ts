import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {it,expect,vi} from 'vitest';
import {createCalendarEvaluationServices, calendarOperationRunId} from '@ae/core/evals/calendar-integration/index';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {calendarAcceptanceScenarios} from '@ae/core/simulator/acceptance-scenarios';
import {CalendarSimulator} from '@ae/core/simulator/calendar';
import {PostgresCalendarStore} from '@ae/core/simulator/postgres';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
it('actual patched factory retains operation ID and replays full twelve-case SQL run after reconstruction',async()=>{
 const pg=new PGlite();
 try{
  for(const p of ['simulator/migrations/001_calendar.sql','simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql','evals/integration/migrations/001-text-integration.sql'])await pg.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,'packages/core/src',p),'utf8'));
  const db:AgentTransactionalSql={query:async<T>(q:string,p:unknown[]=[])=>({rows:(await pg.query(q,p)).rows as T[]}),transaction:async action=>pg.transaction(async tx=>action({query:async<T>(q:string,p:unknown[]=[])=>({rows:(await tx.query(q,p)).rows as T[]})}))};
  const pool={query:db.query,connect:async()=>({query:async<T>(q:string,p:unknown[]=[])=>q.includes('pg_advisory_unlock')?{rows:[{unlocked:true}] as T[]}:q.includes('pg_advisory_lock')?{rows:[] as T[]}:db.query<T>(q,p),release:()=>{}})};
  const cases=calendarAcceptanceScenarios();
  const job={jobId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',package:'workflow_eval' as const,environment:'test' as const,isFixture:true,linkedRetestOf:null,quoteVersion:null};
  const ctx={jobId:job.jobId,environment:'test' as const,budgetMicroUsd:0,recordCost:vi.fn(async()=>{}),recordProgress:vi.fn(async()=>{})};
  let calls=0;
  const resolve=async()=>({job,targetVersion:'v1',branch:{jobId:job.jobId,branchId:'branch-1',targetVersion:'v1'},systemPrompt:'Calendar assistant.',knownSecrets:[],reviewedSuite:{jobId:job.jobId,origin:'internal_fixture' as const,frozenAt:'2026-11-07T20:00:00Z',review:{reviewerId:'fixture',approved:true},scenarios:cases.map(({id,prompt,actorId,seed,checks})=>structuredClone({id,prompt,actorId,seed,checks}))},dependencies:{db,simulator:new CalendarSimulator(new PostgresCalendarStore(db)),targetForScenario:(s:{id:string})=>({complete:async(messages:{role:string}[])=>{calls++;return messages.some(m=>m.role==='tool')?{role:'assistant' as const,content:'Reference complete.'}:{role:'assistant' as const,content:null,tool_calls:structuredClone(cases.find(c=>c.id===s.id)!.referenceCalls)};}})}});
  const make=()=>createCalendarEvaluationServices({checkpoints:new PostgresTextCheckpointStore(db),journalPool:pool,resolve});
  const request={suiteId:'frozen12',operationId:'operation-stable',versionLabel:'baseline'};
  const api=make();await api.freezeSuite(ctx,{suiteId:request.suiteId});
  const run=await api.runSuite(ctx,request);
  expect(run.runId).toBe(calendarOperationRunId(job.jobId,request.operationId));
  expect(run.runId).not.toBe(calendarOperationRunId('another-job',request.operationId));
  expect(run.results).toHaveLength(12);expect(run.results.map(r=>r.outcome)).toEqual(Array(12).fill('passed'));
  const before=calls;expect(await make().runSuite(ctx,request)).toEqual(run);expect(calls).toBe(before);
 }finally{await pg.close();}
},30000);
