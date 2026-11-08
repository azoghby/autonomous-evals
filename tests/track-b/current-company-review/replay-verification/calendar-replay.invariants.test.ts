/** INVARIANTS (acceptance-grade, passing): no ambiguous redispatch over real composed services + real SQL.
 * A worker "lost" mid-phase is modelled by a target transport that never answers (the isolate stops
 * making progress); reconstruction is a fresh createRichWorkflowServices over the same retained SQL.
 * This is not an OS process kill and not hosted Workflow replay. */
import {afterEach,expect,it,vi} from 'vitest';
import {buildFixture,request,type Transport} from './fixture';

const transport=vi.hoisted(()=>({loaded:null as unknown,pool:null as unknown,complete:vi.fn(),pools:[] as Array<{kind:string;closed:boolean}>,branchLookups:0,calendarDeps:null as unknown}));
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
async function fixture(opts?:Parameters<typeof buildFixture>[1]){const f=await buildFixture(T,opts);closers.push(f.close);return f;}
/** After `answered` further replies (counted from installation), the target never answers again (worker lost while a paid call is in flight). */
function loseWorkerAfter(answered:number){
 const real=transport.complete.getMockImplementation()!;let n=0;
 transport.complete.mockImplementation(async(...args)=>{if(++n>answered)return new Promise(()=>{});return real(...args);});
}
const state=async(f:Awaited<ReturnType<typeof fixture>>,kind:string)=>(await f.application.query<{state:string}>('SELECT state FROM text_integration.checkpoints WHERE kind=$1',[kind])).rows.map(r=>r.state);

it('baseline phase lost mid-execution holds the whole phase after reconstruction; no target is re-called',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 loseWorkerAfter(5);void f.phase(s,()=>s.calendar.runSuite(f.ctx,request)).catch(()=>{});
 await vi.waitFor(()=>expect(transport.complete).toHaveBeenCalledTimes(6),{timeout:20000});
 expect(await state(f,'calendar_run')).toEqual(['pending']);
 const restarted=await f.restart();
 await expect(f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).rejects.toThrow(/pending/i);
 await expect(f.phase(restarted,()=>restarted.calendar.investigate(f.ctx,request))).rejects.toThrow();
 await expect(restarted.calendar.reportInput(f.ctx,request)).rejects.toThrow();
 await expect(f.phase(s,()=>s.calendar.runSuite(f.ctx,request))).rejects.toThrow(/pending/i); // same isolate too
 expect(transport.complete).toHaveBeenCalledTimes(6);
 // In-flight paid call stays an unsettled 'dispatched' hold; no release, no new intent.
 const ops=(await f.application.query<{state:string}>('SELECT state FROM autonomous_paid_app.operations')).rows;
 expect(ops).toHaveLength(6);expect(ops.every(o=>o.state==='dispatched')).toBe(true);
 expect(await f.count('agent_persistence.reservations','WHERE settled_micro_usd IS NULL')).toBe(6);
 expect(await state(f,'calendar_run')).toEqual(['pending']);
 await restarted.dispose();
},40000);

it('investigation lost after its journal intent holds the whole investigation after reconstruction; no reproduction is re-sent',async()=>{
 const f=await fixture({mode:'broken'});const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));const baseline=transport.complete.mock.calls.length;
 loseWorkerAfter(0);void f.phase(s,()=>s.calendar.investigate(f.ctx,request)).catch(()=>{});
 await vi.waitFor(()=>expect(transport.complete).toHaveBeenCalledTimes(baseline+1),{timeout:20000});
 const journal=(await f.application.query<{record:{attempts:Array<{scenarioId:string;result?:unknown}>}}>('SELECT * FROM app_workflow_investigation_journals')).rows;
 expect(journal).toHaveLength(1);
 const restarted=await f.restart();
 await expect(f.phase(restarted,()=>restarted.calendar.investigate(f.ctx,request))).rejects.toThrow(/pending/i);
 await expect(restarted.calendar.reportInput(f.ctx,request)).rejects.toThrow();
 // Completed baseline still replays from retained SQL without target calls.
 expect((await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).results).toHaveLength(12);
 expect(transport.complete).toHaveBeenCalledTimes(baseline+1);
 expect(await state(f,'calendar_investigation')).toEqual(['pending']);
 await restarted.dispose();
},40000);

it('a single lost reply inside a phase is retained as infrastructure; the completed phase replays over retained SQL without target calls',async()=>{
 const f=await fixture();const s=await f.restart();await s.calendar.freezeSuite(f.ctx,request);
 const real=transport.complete.getMockImplementation()!;let n=0;
 transport.complete.mockImplementation(async(...args)=>{if(++n===3)throw Error('accepted; reply lost');return real(...args);});
 const run=await f.phase(s,()=>s.calendar.runSuite(f.ctx,request));
 expect(run.results.filter(r=>r.outcome==='infrastructure_error')).toHaveLength(1);expect(run.results.filter(r=>r.outcome==='passed')).toHaveLength(11);
 const calls=transport.complete.mock.calls.length;expect(calls).toBe(23);
 const restarted=await f.restart();expect(await f.phase(restarted,()=>restarted.calendar.runSuite(f.ctx,request))).toEqual(run);
 const inv=await f.phase(restarted,()=>restarted.calendar.investigate(f.ctx,request));expect(inv.reproductions).toEqual([]); // infrastructure is never reproduced
 expect((await restarted.calendar.reportInput(f.ctx,request)).status).toBe('unresolved');
 expect(transport.complete).toHaveBeenCalledTimes(calls);
 expect(await f.count('agent_persistence.reservations','WHERE settled_micro_usd IS NULL')).toBe(23);
 await s.dispose();await restarted.dispose();
},40000);
