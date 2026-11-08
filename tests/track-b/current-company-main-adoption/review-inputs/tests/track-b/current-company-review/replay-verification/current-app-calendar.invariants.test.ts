/** INVARIANTS (acceptance-grade, passing): non-mocked counterpart of the patched current-app Calendar
 * success test. The actual createCurrentAutonomyApplication.evaluate uses the REAL createRichWorkflowServices
 * (deps.rich not injected) over real PGlite SQL; only the release server constructor is captured (as the
 * parent test does) so its evaluate callback can be invoked, and evaluateWithServices is a minimal
 * retained-driver adapter that calls the real Calendar services. Transport boundaries as in fixture.ts. */
import {afterEach,expect,it,vi} from 'vitest';
import type {ReleaseConfig} from '@/server/autonomy-release';
import {createCurrentAutonomyApplication,type CurrentAutonomyConfig} from '@/server/current-autonomy';
import type {CompanyRequest} from '@ae/core/agents/autonomy/company';
import {buildFixture,request,type Transport} from './fixture';

const transport=vi.hoisted(()=>({loaded:null as unknown,pool:null as unknown,complete:vi.fn(),pools:[] as Array<{kind:string;closed:boolean}>,branchLookups:0,calendarDeps:null as unknown,release:null as unknown}));
vi.mock('@/server/autonomy-release',()=>({createAutonomyReleaseServer:(config:unknown)=>{transport.release=config;return {bootstrap:vi.fn(),publication:vi.fn(),scheduledTick:vi.fn()};}}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>transport.loaded}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),evalServices:{getJobBranchConnection:vi.fn(async()=>{transport.branchLookups++;return 'offline-simulator';})}}));
vi.mock('@ae/core/targets/adapters',async original=>({...await original<typeof import('@ae/core/targets/adapters')>(),platformTarget:()=>({complete:transport.complete})}));
vi.mock('@neondatabase/serverless',()=>({Pool:class {
  readonly kind:string; closed=false;
  constructor(config:{connectionString:string}){this.kind=config.connectionString==='offline-simulator'?'simulator':'application';transport.pools.push(this);}
  query(s:string,p?:unknown[]){return (transport.pool as {query(kind:string,s:string,p?:unknown[]):Promise<unknown>}).query(this.kind,s,p);}
  connect(){return (transport.pool as {connect(kind:string):Promise<unknown>}).connect(this.kind);}
  async end(){this.closed=true;}
}}));
const T=transport as unknown as Transport;
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{transport.complete.mockReset();transport.pools.length=0;transport.branchLookups=0;await Promise.all(closers.splice(0).map(c=>c()));});

async function setup(){
 const f=await buildFixture(T);closers.push(f.close);
 const job={id:'calendar-job',customerId:'tenant',workflowRunId:'authorized-workflow' as string|null,environment:'test',isMock:false};
 const companyRequest:CompanyRequest={tenantId:'tenant',round:0,job:structuredClone(f.job),intake:{requestedPackage:'workflow_eval',notes:'fixture',systemPromptExcerpt:null,trace:null,endpointHost:'controlled.invalid',clarifications:[]}} as unknown as CompanyRequest;
 const services:Array<{workflowJob:unknown}>=[];
 const config={db:f.exact,contextFor:vi.fn(async()=>f.ctx),
  // Minimal retained driver: drives the real Calendar services; returns only the report status.
  evaluateWithServices:vi.fn(async(_r:CompanyRequest,_k:string,_d:string,s:Awaited<ReturnType<typeof f.restart>>)=>{
   services.push({workflowJob:s.job});
   await s.calendar.freezeSuite(f.ctx,request);
   await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
   await f.phase(s,()=>s.calendar.investigate(f.ctx,request));
   const report=await s.calendar.reportInput(f.ctx,request);await s.dispose();
   return {status:report.status};
  })} as unknown as CurrentAutonomyConfig;
 createCurrentAutonomyApplication(config,{viewer:async()=>null,cron:()=>null,job:async()=>job});
 const evaluate=()=>(transport.release as ReleaseConfig).evaluate(companyRequest,'calendar','digest',{} as Parameters<ReleaseConfig['evaluate']>[3],f.paid);
 return {f,job,evaluate,config};
}

it('current-app Calendar evaluate reaches real rich services with the job\'s existing durable Workflow identity, meters SQL, and replays without target calls',async()=>{
 const {f,evaluate}=await setup();
 expect(await evaluate()).toEqual({status:'completed'});
 expect(transport.complete).toHaveBeenCalledTimes(24);
 expect(await f.count('agent_persistence.reservations','WHERE settled_micro_usd IS NULL')).toBe(24);
 expect(await f.count('autonomous_paid_app.operations',"WHERE state='dispatched'")).toBe(24);
 // Second evaluation (e.g. scheduler re-tick after lost acknowledgement) replays retained SQL; no target call.
 expect(await evaluate()).toEqual({status:'completed'});expect(transport.complete).toHaveBeenCalledTimes(24);
 expect(await f.count('autonomous_paid_app.operations')).toBe(24);
},40000);

it('evaluate uses the canonical job workflowRunId: a rebound (new) run id refuses after retained phases instead of minting fresh paid work',async()=>{
 const {f,job,evaluate}=await setup();
 expect(await evaluate()).toEqual({status:'completed'});
 // A new Workflow run for the same job (canonical row updated) conflicts with retained execution identity.
 job.workflowRunId='replacement-run';(f.loaded.job as {workflowRunId:string}).workflowRunId='replacement-run';
 await expect(evaluate()).rejects.toThrow();expect(transport.complete).toHaveBeenCalledTimes(24);
 // Canonical job row and current-app job lookup disagreeing (stale vs fresh run id) refuses before services.
 job.workflowRunId='authorized-workflow';
 await expect(evaluate()).rejects.toThrow();expect(transport.complete).toHaveBeenCalledTimes(24);
 expect(await f.count('autonomous_paid_app.operations')).toBe(24);
},40000);

it('missing durable job Workflow binding refuses before context, services, branch or reservation (real factory, no deps.rich)',async()=>{
 const {f,job,evaluate,config}=await setup();job.workflowRunId=null;
 await expect(evaluate()).rejects.toThrow('current_autonomy_authority_refused');
 expect(config.contextFor).not.toHaveBeenCalled();expect(config.evaluateWithServices).not.toHaveBeenCalled();
 expect(transport.branchLookups).toBe(0);expect(transport.complete).not.toHaveBeenCalled();
 expect(await f.count('agent_persistence.reservations')).toBe(0);
},40000);
