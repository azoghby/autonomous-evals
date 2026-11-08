/** INVARIANTS (acceptance-grade, passing): real composed createRichWorkflowServices + real core Calendar
 * engine + real PGlite SQL. Scripted only: Neon Pool transport, job loader, branch lookup, target HTTP.
 * Restores the removed real-factory assertion "Calendar with paid authority but without the exact durable
 * identity does no branch/target/reservation work", and exercises the paid completeRound identity gate. */
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {calendarOperationRunId,type CalendarEvaluationServiceDeps} from '@ae/core/evals/calendar-integration/index';
import {calendarExecutionScope,freezeCalendarSuite,rerunCalendarFinding,investigateCalendarRun,MemoryWorkflowInvestigationJournal,type CalendarDispatchIdentity} from '@ae/core/simulator/workflow/index';
import {calendarTools} from '@ae/core/simulator/calendar';
import type {ChatTarget} from '@ae/core/targets/chat';
import {buildFixture,request,acceptance,type Transport} from './fixture';

const transport=vi.hoisted(()=>({loaded:null as unknown,pool:null as unknown,complete:vi.fn(),pools:[] as Array<{kind:string;closed:boolean}>,branchLookups:0,calendarDeps:null as unknown}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>transport.loaded}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),evalServices:{getJobBranchConnection:vi.fn(async()=>{transport.branchLookups++;return 'offline-simulator';})}}));
vi.mock('@ae/core/targets/adapters',async original=>({...await original<typeof import('@ae/core/targets/adapters')>(),platformTarget:()=>({complete:transport.complete})}));
// Capture-only wrapper: the real core factory runs unchanged; we keep its trusted resolver for direct probing.
vi.mock('@ae/core/evals/calendar-integration/index',async original=>{const m=await original<typeof import('@ae/core/evals/calendar-integration/index')>();return {...m,createCalendarEvaluationServices:(deps:CalendarEvaluationServiceDeps)=>{transport.calendarDeps=deps;return m.createCalendarEvaluationServices(deps);}};});
vi.mock('@neondatabase/serverless',()=>({Pool:class {
  readonly kind:string; closed=false;
  constructor(config:{connectionString:string}){this.kind=config.connectionString==='offline-simulator'?'simulator':'application';transport.pools.push(this);}
  query(s:string,p?:unknown[]){return (transport.pool as {query(kind:string,s:string,p?:unknown[]):Promise<unknown>}).query(this.kind,s,p);}
  connect(){return (transport.pool as {connect(kind:string):Promise<unknown>}).connect(this.kind);}
  async end(){this.closed=true;}
}}));
const T=transport as unknown as Transport;
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{transport.complete.mockReset();transport.pools.length=0;transport.branchLookups=0;transport.calendarDeps=null;await Promise.all(closers.splice(0).map(c=>c()));});
async function fixture(opts?:Parameters<typeof buildFixture>[1]){const f=await buildFixture(T,opts);closers.push(f.close);return f;}
async function noPaidWork(f:Awaited<ReturnType<typeof fixture>>){
 expect(transport.complete).not.toHaveBeenCalled();
 expect(await f.count('agent_persistence.reservations')).toBe(0);
 expect(await f.count('autonomous_paid_app.operations')).toBe(0);
}
const sims=()=>transport.pools.filter(p=>p.kind==='simulator').length;

it('paid Calendar with a SQL port other than the exact workflowSql() refuses construction before branch, simulator, target or reservation',async()=>{
 const f=await fixture({paidSql:'foreign'});
 await expect(f.restart()).rejects.toThrow('Canonical Workflow binding unavailable or changed');
 await noPaidWork(f);expect(transport.branchLookups).toBe(0);expect(sims()).toBe(0);
},30000);

it('paid Calendar whose retained binding has no reviewed suite (removed baseline fixture shape) refuses freezeSuite before branch/target/reservation',async()=>{
 const f=await fixture({reviewed:false});const s=await f.restart();
 await expect(s.calendar.freezeSuite(f.ctx,{suiteId:'retained-calendar'})).rejects.toThrow();
 await expect(s.calendar.runSuite(f.ctx,request)).rejects.toThrow();
 await noPaidWork(f);expect(transport.branchLookups).toBe(0);expect(sims()).toBe(0);
 expect(await f.count('text_integration.checkpoints')).toBe(0);await s.dispose();
},30000);

it('a scheduler run id or empty id never substitutes for the job\'s durable Workflow run identity',async()=>{
 const f=await fixture();
 for(const id of ['scheduler-run','',randomUUID()])await expect(f.restart(id)).rejects.toThrow();
 await noPaidWork(f);expect(transport.branchLookups).toBe(0);
 const g=await fixture({jobWorkflowRunId:null as unknown as string});await expect(g.restart('')).rejects.toThrow();await noPaidWork(g);
},30000);

it('real paid completeRound refuses scheduler/scenario-only/UUID/cross-scope identities with no reservation or target call; a valid engine identity dispatches exactly once and is never blindly re-called',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const deps=transport.calendarDeps as CalendarEvaluationServiceDeps;const a=await deps.resolve(f.ctx);
 const completeRound=a.dependencies.completeRound!;expect(completeRound).toBeTypeOf('function');
 const suite=freezeCalendarSuite(a.reviewedSuite);const scenario=acceptance[0];
 const runId=calendarOperationRunId(f.job.jobId,request.operationId);
 const make=(over:Partial<CalendarDispatchIdentity>={},phase:'baseline'|'investigation'='baseline',versionLabel='baseline'):CalendarDispatchIdentity=>({jobId:f.job.jobId,operationId:request.operationId,runId,suiteId:request.suiteId,suiteHash:suite.hash,branchId:'br-owned',versionLabel,phase,scenarioId:scenario.id,scope:calendarExecutionScope({jobId:f.job.jobId,operationId:request.operationId,runId,phase,scenarioId:scenario.id,versionLabel}),round:1,...over});
 const messages=[{role:'system' as const,content:'Trusted calendar instructions.'},{role:'user' as const,content:scenario.prompt}];
 const call=(id:CalendarDispatchIdentity)=>completeRound(id,structuredClone(messages),structuredClone(calendarTools));
 const forged:Array<[string,CalendarDispatchIdentity]>=[
  ['generated UUID run',make({runId:randomUUID()})],['scheduler run id',make({runId:'scheduler-run'})],
  ['generated UUID scope (legacy engine scope)',make({scope:{jobId:f.job.jobId,runId:randomUUID(),version:'baseline'}})],
  ['scenario-only scope',make({scope:{jobId:f.job.jobId,runId:scenario.id,version:'baseline'}})],
  ['operation rebound without run',make({operationId:'other-operation'})],['foreign job',make({jobId:'foreign-job'})],
  ['foreign scope job',make({scope:{...make().scope,jobId:'foreign-job'}})],['foreign branch',make({branchId:'br-other'})],
  ['wrong suite hash',make({suiteHash:'f'.repeat(64)})],['unknown phase',make({phase:'rerun' as 'baseline'})],
  ['round 0',make({round:0})],['round 7',make({round:7})],['fractional round',make({round:1.5})],
  ['scenario outside reviewed suite',make({scenarioId:'not-reviewed'})],['version/scope mismatch',make({versionLabel:'v2'})],
 ];
 for(const [label,id] of forged)await expect(call(id),label).rejects.toThrow();
 await noPaidWork(f);
 // Positive control: proves the refusals above are not vacuous.
 await call(make());expect(transport.complete).toHaveBeenCalledTimes(1);
 expect(await f.count('autonomous_paid_app.operations')).toBe(1);expect(await f.count('agent_persistence.reservations','WHERE settled_micro_usd IS NULL')).toBe(1);
 // Same lifecycle identity again (lost reply / retry): refused, never re-sent.
 await expect(call(make())).rejects.toThrow('autonomous_paid_authority_or_reconciliation_required');
 // Version-scope collision: same run/phase/scenario/round under another versionLabel collides on the lifecycle ID and is refused, not re-sent.
 await expect(call(make({},'baseline','v2'))).rejects.toThrow('autonomous_paid_authority_or_reconciliation_required');
 expect(transport.complete).toHaveBeenCalledTimes(1);expect(await f.count('autonomous_paid_app.operations')).toBe(1);
 // Investigation of the same scenario/round is a distinct deterministic scope and dispatch.
 const inv=make({},'investigation');expect(inv.scope.runId).not.toBe(make().scope.runId);
 await call(inv);expect(transport.complete).toHaveBeenCalledTimes(2);expect(await f.count('autonomous_paid_app.operations')).toBe(2);
 // Legacy scenario-only factory is never a paid fallback.
 await expect((await a.dependencies.targetForScenario(scenario) as ChatTarget).complete(structuredClone(messages),calendarTools)).rejects.toThrow();
 expect(transport.complete).toHaveBeenCalledTimes(2);await s.dispose();
},30000);

it('paid standalone rerun and investigation without durable operation identity refuse before simulator/target work',async()=>{
 const f=await fixture({mode:'broken'});const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));const calls=transport.complete.mock.calls.length;const ops=await f.count('autonomous_paid_app.operations');
 expect(run.results.some(r=>r.outcome==='product_failure')).toBe(true);
 const a=await (transport.calendarDeps as CalendarEvaluationServiceDeps).resolve(f.ctx);const suite=freezeCalendarSuite(a.reviewedSuite);
 await expect(rerunCalendarFinding({suite,run,scenarioId:run.results[0].scenarioId,dependencies:a.dependencies})).rejects.toThrow('calendar_durable_dispatch_identity_required');
 const journal=new MemoryWorkflowInvestigationJournal();
 await expect(investigateCalendarRun({suite,run,dependencies:a.dependencies,journal})).rejects.toThrow('calendar_durable_dispatch_identity_required');
 expect(transport.complete).toHaveBeenCalledTimes(calls);expect(await f.count('autonomous_paid_app.operations')).toBe(ops);
 // The durable service path still works afterwards (fence untouched by the refused direct calls).
 const inv=await f.phase(s,()=>s.calendar.investigate(f.ctx,request));expect(inv.reproductions).toHaveLength(3);await s.dispose();
},30000);
