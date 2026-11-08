/** INVARIANTS (passing): real createCurrentIsolateStartup / createCurrentPaymentStartup logic. Bridge and
 * release application are scripted boundaries (as in the parent startup.test.ts); assertions concern
 * only the real cache and per-call re-resolution logic. */
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({
 bridge:{loadRequest:vi.fn(),verifyPayment:vi.fn(),prepareQuote:vi.fn(),drainReceipts:vi.fn(),drainPendingReceipts:vi.fn(),ingestStripeIfBound:vi.fn()},
 application:{bootstrap:vi.fn(),publication:vi.fn(),advanceDueJobs:vi.fn(),tick:vi.fn()},
}));
vi.mock('@/server/current-stripe-payment',()=>({currentStripePaymentOptions:(o:unknown)=>o}));
vi.mock('@/server/current-payment',()=>({createCurrentPaymentBridge:()=>h.bridge}));
vi.mock('@/server/current-autonomy',()=>({createCurrentAutonomyApplication:()=>h.application}));
import {createCurrentIsolateStartup,type CurrentOwnerAdapters} from '@/server/current-payment-startup';
const owner=(viewer:()=>Promise<{id:string}|null>)=>{const sql={};return {config:{db:sql},bridge:{sql},dependencies:{viewer:vi.fn(viewer)},enqueue:vi.fn(),enqueueQuote:vi.fn(),exclusiveDispatch:vi.fn(async()=>true)} as unknown as CurrentOwnerAdapters;};
beforeEach(()=>{for(const s of [...Object.values(h.bridge),...Object.values(h.application)])s.mockReset();h.application.bootstrap.mockImplementation(async()=>Response.json({ok:true}));h.bridge.loadRequest.mockImplementation(async(p:{tenantId:string},jobId:string)=>({tenantId:p.tenantId,job:{jobId}}));});

it('cached isolate startup carries no principal: consecutive bootstraps re-resolve the session and drain under each caller\'s own tenant',async()=>{
 let current:{id:string}|null={id:'tenant_a'};const load=vi.fn(async()=>({status:'ready' as const,adapters:owner(async()=>current)}));
 const get=createCurrentIsolateStartup(load);
 await (await get())!.bootstrap(new Request('https://local.invalid'),'job_a');
 current={id:'tenant_b'};await (await get())!.bootstrap(new Request('https://local.invalid'),'job_b');
 current=null;expect((await (await get())!.bootstrap(new Request('https://local.invalid'),'job_c')).status).toBe(401);
 expect(load).toHaveBeenCalledOnce();
 expect(h.bridge.drainReceipts.mock.calls).toEqual([['tenant_a','job_a'],['tenant_b','job_b']]);
 expect(h.bridge.loadRequest.mock.calls.map(c=>c[0])).toEqual([{tenantId:'tenant_a',subject:'tenant_a'},{tenantId:'tenant_b',subject:'tenant_b'}]);
});
it('a rejected owner load or construction is not cached; concurrent callers share one load and all observe the failure',async()=>{
 const load=vi.fn().mockRejectedValueOnce(new Error('owner_loader_transient')).mockResolvedValue({status:'ready',adapters:owner(async()=>({id:'t'}))});
 const get=createCurrentIsolateStartup(load);
 const [a,b]=await Promise.allSettled([get(),get()]);expect(a.status).toBe('rejected');expect(b.status).toBe('rejected');expect(load).toHaveBeenCalledOnce();
 expect(await get()).toBeTruthy();expect(load).toHaveBeenCalledTimes(2);
});
it('scheduler entry drains retained receipts before every tick, including receipts that arrived after bootstrap',async()=>{
 const get=createCurrentIsolateStartup(async()=>({status:'ready',adapters:owner(async()=>({id:'t'}))}));
 const order:string[]=[];h.bridge.drainPendingReceipts.mockImplementation(async()=>{order.push('drain');});h.application.advanceDueJobs.mockImplementation(async()=>{order.push('tick');return {outcomes:[]};});
 await (await get())!.advanceDueJobs();await (await get())!.advanceDueJobs();
 expect(order).toEqual(['drain','tick','drain','tick']);
 h.bridge.drainPendingReceipts.mockRejectedValueOnce(new Error('receipt_conflict'));
 await expect((await get())!.advanceDueJobs()).rejects.toThrow('receipt_conflict');expect(order).toEqual(['drain','tick','drain','tick']);
});
