/** CHARACTERIZATION (passing; NOT acceptance). The app-level paid completeRound hook validates identity
 * self-consistency (run derived from operation, deterministic scope, suite, branch, phase, round) but does
 * not itself read a claimed calendar_run checkpoint or committed investigation journal intent; it relies on
 * the core engine being its only caller (the hook is not exposed through the services API). */
import {afterEach,expect,it,vi} from 'vitest';
import {calendarOperationRunId,type CalendarEvaluationServiceDeps} from '@ae/core/evals/calendar-integration/index';
import {calendarExecutionScope,freezeCalendarSuite} from '@ae/core/simulator/workflow/index';
import {calendarTools} from '@ae/core/simulator/calendar';
import {buildFixture,request,acceptance,type Transport} from './fixture';

const transport=vi.hoisted(()=>({loaded:null as unknown,pool:null as unknown,complete:vi.fn(),pools:[] as Array<{kind:string;closed:boolean}>,branchLookups:0,calendarDeps:null as unknown}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>transport.loaded}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),evalServices:{getJobBranchConnection:vi.fn(async()=>'offline-simulator')}}));
vi.mock('@ae/core/targets/adapters',async original=>({...await original<typeof import('@ae/core/targets/adapters')>(),platformTarget:()=>({complete:transport.complete})}));
vi.mock('@ae/core/evals/calendar-integration/index',async original=>{const m=await original<typeof import('@ae/core/evals/calendar-integration/index')>();return {...m,createCalendarEvaluationServices:(deps:CalendarEvaluationServiceDeps)=>{transport.calendarDeps=deps;return m.createCalendarEvaluationServices(deps);}};});
vi.mock('@neondatabase/serverless',()=>({Pool:class {
  readonly kind:string; closed=false;
  constructor(config:{connectionString:string}){this.kind=config.connectionString==='offline-simulator'?'simulator':'application';transport.pools.push(this);}
  query(s:string,p?:unknown[]){return (transport.pool as {query(kind:string,s:string,p?:unknown[]):Promise<unknown>}).query(this.kind,s,p);}
  connect(){return (transport.pool as {connect(kind:string):Promise<unknown>}).connect(this.kind);}
  async end(){this.closed=true;}
}}));
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{transport.complete.mockReset();await Promise.all(closers.splice(0).map(c=>c()));});

it('CHARACTERIZATION: a self-consistent identity for an operation that was never claimed (and an investigation with no journal intent) is dispatched by the hook itself',async()=>{
 const f=await buildFixture(transport as unknown as Transport);closers.push(f.close);const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const a=await (transport.calendarDeps as CalendarEvaluationServiceDeps).resolve(f.ctx);const suite=freezeCalendarSuite(a.reviewedSuite);const scenario=acceptance[0];
 const identity=(operationId:string,phase:'baseline'|'investigation')=>{const runId=calendarOperationRunId(f.job.jobId,operationId);return {jobId:f.job.jobId,operationId,runId,suiteId:request.suiteId,suiteHash:suite.hash,branchId:'br-owned',versionLabel:'baseline',phase,scenarioId:scenario.id,scope:calendarExecutionScope({jobId:f.job.jobId,operationId,runId,phase,scenarioId:scenario.id,versionLabel:'baseline'}),round:1};};
 const messages=[{role:'system' as const,content:'x'},{role:'user' as const,content:scenario.prompt}];
 await a.dependencies.completeRound!(identity('never-claimed-operation','baseline'),messages,calendarTools);
 await a.dependencies.completeRound!(identity('never-claimed-operation','investigation'),messages,calendarTools);
 expect(transport.complete).toHaveBeenCalledTimes(2);
 expect(await f.count('text_integration.checkpoints',"WHERE kind IN ('calendar_run','calendar_investigation')")).toBe(0);
 expect(await f.count('app_workflow_investigation_journals')).toBe(0);
 await s.dispose();
},30000);
