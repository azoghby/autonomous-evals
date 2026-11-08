import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  bridge: {loadRequest:vi.fn(),verifyPayment:vi.fn(),prepareQuote:vi.fn(),drainReceipts:vi.fn(),drainPendingReceipts:vi.fn()},
  application: {bootstrap:vi.fn(),publication:vi.fn(),advanceDueJobs:vi.fn()},
  config:undefined as any,
}));
vi.mock('@/server/current-stripe-payment', () => ({currentStripePaymentOptions:(options:unknown)=>options}));
vi.mock('@/server/current-payment', () => ({createCurrentPaymentBridge:()=>h.bridge}));
vi.mock('@/server/current-autonomy', () => ({createCurrentAutonomyApplication:(config:unknown)=>{h.config=config;return h.application;}}));
import {createCurrentPaymentStartup,createCurrentIsolateStartup,type CurrentOwnerAdapters} from '@/server/current-payment-startup';
const owner = () => {
  const sql = {} as any;
  return {config:{db:sql},bridge:{sql},dependencies:{viewer:vi.fn(async()=>({id:'tenant'}))},enqueue:vi.fn(),enqueueQuote:vi.fn()} as unknown as CurrentOwnerAdapters;
};
beforeEach(()=>{
  for(const spy of Object.values(h.bridge)) spy.mockReset();
  for(const spy of Object.values(h.application)) spy.mockReset();
  h.application.bootstrap.mockImplementation(async()=>Response.json({ok:true}));
  h.bridge.loadRequest.mockResolvedValue({tenantId:'tenant',job:{jobId:'job'}});
});
it('canonical request and receipt verification replace owner callbacks; quote offer uses actual checkout bridge before outbox',async()=>{
  const adapters=owner();createCurrentPaymentStartup(adapters);
  expect(h.config.loadRequest).toBe(h.bridge.loadRequest);
  expect(h.config.verifyPayment).toBe(h.bridge.verifyPayment);
  const request={job:{jobId:'job'}},quote={version:1};
  await h.config.enqueue(request,'quote-key',{kind:'quote',quote},{});
  expect(h.bridge.prepareQuote).toHaveBeenCalledWith(request,quote);
  expect(adapters.enqueueQuote).toHaveBeenCalledOnce();
});
it('unsupported or stale quote refuses before any communication is queued',async()=>{
  const adapters=owner();createCurrentPaymentStartup(adapters);
  h.bridge.prepareQuote.mockRejectedValue(new Error('current_payment_per_finding_unsupported'));
  await expect(h.config.enqueue({},'quote-key',{kind:'quote',quote:{}},{})).rejects.toThrow('per_finding');
  expect(adapters.enqueueQuote).not.toHaveBeenCalled();
  expect(adapters.enqueue).not.toHaveBeenCalled();
});
it('bootstrap drains earlier receipts only after fresh owner resolution',async()=>{
  const startup=createCurrentPaymentStartup(owner());
  expect((await startup.bootstrap(new Request('https://local.invalid'),'job')).status).toBe(200);
  expect(h.bridge.loadRequest).toHaveBeenCalledWith({tenantId:'tenant',subject:'tenant'},'job');
  expect(h.bridge.drainReceipts).toHaveBeenCalledWith('tenant','job');
});
it('denied bootstrap never drains and revoked owner cannot publish receipts',async()=>{
  let startup=createCurrentPaymentStartup(owner());
  h.application.bootstrap.mockImplementation(async()=>new Response(null,{status:404}));
  await startup.bootstrap(new Request('https://local.invalid'),'job');
  expect(h.bridge.drainReceipts).not.toHaveBeenCalled();
  h.application.bootstrap.mockImplementation(async()=>Response.json({ok:true}));
  const adapters=owner();vi.mocked(adapters.dependencies.viewer).mockResolvedValue(null);
  startup=createCurrentPaymentStartup(adapters);
  expect((await startup.bootstrap(new Request('https://local.invalid'),'job')).status).toBe(401);
  expect(h.bridge.drainReceipts).not.toHaveBeenCalled();
});
it('independent server and step isolates construct from same loader without shared install state',async()=>{
  const load=vi.fn(async()=>({status:'ready' as const,adapters:owner()}));
  const server=createCurrentIsolateStartup(load),step=createCurrentIsolateStartup(load);
  const first=await server();expect(await server()).toBe(first);
  expect(await step()).not.toBe(first);expect(load).toHaveBeenCalledTimes(2);
  h.application.advanceDueJobs.mockResolvedValue({outcomes:[]});
  expect(await (await step())!.advanceDueJobs()).toEqual({outcomes:[]});
  expect(h.bridge.drainPendingReceipts).toHaveBeenCalledOnce();
});
it('missing owner adapters fail closed and failed construction can retry',async()=>{
  expect(await createCurrentIsolateStartup(async()=>({status:'blocked',missing:['provider_receipts']}))()).toBeNull();
  const adapters=owner();adapters.bridge.sql={} as any;
  const load=vi.fn().mockResolvedValueOnce({status:'ready',adapters}).mockResolvedValueOnce({status:'ready',adapters:owner()});
  const get=createCurrentIsolateStartup(load);
  await expect(get()).rejects.toThrow('transaction_adapter_mismatch');expect(await get()).toBeTruthy();
});

it('refuses autonomous service construction without fresh exclusive canonical dispatch ownership',async()=>{
 const adapters=owner();adapters.exclusiveDispatch=vi.fn(async()=>false);
 createCurrentPaymentStartup(adapters);
 await expect(h.config.contextFor({job:{jobId:'job'}})).rejects.toThrow('exclusive_dispatch_required');
 await expect(h.config.evaluateWithServices({},'key','digest',{})).rejects.toThrow('exclusive_dispatch_required');
 expect(adapters.exclusiveDispatch).toHaveBeenCalledTimes(2);
});
