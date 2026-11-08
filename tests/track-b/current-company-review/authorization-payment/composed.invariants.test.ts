/** Positive invariants on the composed candidate: real startup/bridge/release/paid modules over actual SQL.
 * Only the Stripe SDK verifier, session viewer, target transport and company driver are scripted. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {runAutonomousTarget,type AutonomousPaidContext} from '@/server/autonomous-paid';
import {createCurrentPaymentStartup} from '@/server/current-payment-startup';
import {currentStripePaymentOptions} from '@/server/current-stripe-payment';
import type {CompanyPorts,CompanyRequest} from '@ae/core/agents/autonomy/company';
import {closeEngines,composed,paidEvent,refundEvent,recordPayment} from './fixture';

const h=vi.hoisted(()=>({construct:vi.fn(),run:vi.fn(),transport:vi.fn(async(n:number)=>({ok:n,usage:{cost:0.42},microUsd:420000})),mode:'test'}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:()=>({webhooks:{constructEvent:(...a:unknown[])=>h.construct(...a)}}),webhookSecret:()=>'fixture-only',getStripeMode:()=>h.mode}));
vi.mock('@ae/core/agents/autonomy/company',async original=>({...await original<typeof import('@ae/core/agents/autonomy/company')>(),
 advanceAutonomousCompany:(r:CompanyRequest,p:CompanyPorts)=>h.run(r,p)}));
afterEach(async()=>{h.construct.mockReset();h.run.mockReset();h.transport.mockClear();h.mode='test';await closeEngines();});
const progress={state:'pending',reason:'fixture',policyVersion:'v1',founderInterventions:0,costStatus:'unknown'};
const OTHER='00000000-0000-4000-8000-0000000000f9';
const count=async(f:Awaited<ReturnType<typeof composed>>,table:string)=>(await f.engine.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('owner/session revocation and pending publication',()=>{
 async function published(){
  const f=await composed(h);expect((await f.startup.bootstrap(f.http(),f.job)).status).toBe(200);
  const key=`autonomous-company:${f.tenant}:${f.job}:0:published-report`,record={tenantId:f.tenant,jobId:f.job,artifactId:'report_a',rendered:{markdown:'PRIVATE-REPORT'}};
  await f.operations.claim(key,'d'.repeat(64));await f.operations.complete(key,'d'.repeat(64),record);
  const res=await f.startup.publication(f.http(),f.job);expect(res.status).toBe(200);expect(await res.text()).toContain('PRIVATE-REPORT');
  return f;
 }
 const denied=async(res:Response,status:number)=>{expect(res.status).toBe(status);expect(await res.text()).not.toContain('PRIVATE-REPORT');};
 it('job ownership transfer: old owner 404, new owner 409; payload never serialized',async()=>{
  const f=await published();
  await f.engine.query("INSERT INTO customers(id,email) VALUES($1,'n@example.invalid')",[OTHER]);await f.engine.query('UPDATE jobs SET customer_id=$1',[OTHER]);
  await denied(await f.startup.publication(f.http(),f.job),404);
  f.state.viewer=OTHER;await denied(await f.startup.publication(f.http(),f.job),409);
 });
 it('current target/policy authorization revoked: 409 without payload',async()=>{const f=await published();f.state.authorized=false;await denied(await f.startup.publication(f.http(),f.job),409);});
 it('cancelled canonical job: 409 without payload',async()=>{const f=await published();await f.engine.query("UPDATE jobs SET state='cancelled'");await denied(await f.startup.publication(f.http(),f.job),409);});
 it('session revoked after the durable read but before serialization: 401 (publication reauthorization patch present)',async()=>{
  const f=await published();f.state.revokeViewerAtCall=f.state.viewerCalls+3;await denied(await f.startup.publication(f.http(),f.job),401);
 });
 it('scheduler report notification is refused after ownership transfer; owner outbox never called',async()=>{
  const f=await composed(h);await f.startup.bootstrap(f.http(),f.job);
  const seen:string[]=[];
  h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{
   await f.engine.query("INSERT INTO customers(id,email) VALUES($1,'n@example.invalid')",[OTHER]);await f.engine.query('UPDATE jobs SET customer_id=$1',[OTHER]);
   await p.enqueue('report',{kind:'report_ready',artifactId:'report_a'}).then(()=>seen.push('sent'),()=>seen.push('refused'));return progress;});
  await f.startup.advanceDueJobs();expect(seen).toEqual(['refused']);expect(f.enqueue).not.toHaveBeenCalled();
 });
});

describe('shared paid authority: revocation before each paid dispatch',()=>{
 it.each([
  ['ownership transfer',async(f:Awaited<ReturnType<typeof composed>>)=>{await f.engine.query("INSERT INTO customers(id,email) VALUES($1,'n@example.invalid')",[OTHER]);await f.engine.query('UPDATE jobs SET customer_id=$1',[OTHER]);}],
  ['current authorization revoked',async(f:Awaited<ReturnType<typeof composed>>)=>{f.state.authorized=false;}],
  ['job cancelled',async(f:Awaited<ReturnType<typeof composed>>)=>{await f.engine.query("UPDATE jobs SET state='cancelled'");}],
  ['release binding disabled',async(f:Awaited<ReturnType<typeof composed>>)=>{await f.engine.query('UPDATE company_autonomy_release.job_bindings SET enabled=false');}],
 ] as const)('%s mid-evaluation refuses the next paid target call and leaves its reservation unspent',async(_name,revoke)=>{
  const f=await composed(h);await f.paidAndBound();const quote=await f.quote();const out:string[]=[];
  f.evaluateWithServices.mockImplementation(async(...args:unknown[])=>{
   const request=args[0] as CompanyRequest,paid=(args[3] as {paid:AutonomousPaidContext}).paid;
   await runAutonomousTarget(paid,{operationId:'op-1',input:{n:1},job:request.job},()=>h.transport(1));
   await revoke(f);
   await runAutonomousTarget(paid,{operationId:'op-2',input:{n:2},job:request.job},()=>h.transport(2)).then(()=>out.push('allowed'),()=>out.push('refused'));
   return {status:'pending'} as never;
  });
  h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{out.push(await p.payment(quote));await p.evaluate('eval','b'.repeat(64)).catch(()=>{});return progress;});
  await f.startup.advanceDueJobs();
  expect(out).toEqual(['paid','refused']);expect(h.transport).toHaveBeenCalledTimes(1);
  expect((await f.engine.query('SELECT operation_id FROM autonomous_paid_app.operations')).rows).toEqual([{operation_id:'op-1'}]);
 },60000);
 it('startup refuses distinct release and payment SQL adapters; paid guard refuses a foreign SQL port',async()=>{
  const f=await composed(h);
  expect(()=>createCurrentPaymentStartup({...f.owner,bridge:{...f.owner.bridge,sql:{...f.sql}}})).toThrow('current_payment_transaction_adapter_mismatch');
  await f.paidAndBound();const quote=await f.quote();const out:string[]=[];
  f.evaluateWithServices.mockImplementation(async(...args:unknown[])=>{
   const request=args[0] as CompanyRequest,paid=(args[3] as {paid:AutonomousPaidContext}).paid;
   out.push(String(paid.sql===f.sql));
   await paid.guard(request.job,{...f.sql}).then(()=>out.push('foreign_allowed'),()=>out.push('foreign_refused'));
   await paid.guard({...request.job,jobId:'other'},f.sql).then(()=>out.push('job_allowed'),()=>out.push('job_refused'));
   return {status:'pending'} as never;
  });
  h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{out.push(await p.payment(quote));await p.evaluate('eval','b'.repeat(64)).catch(()=>{});return progress;});
  await f.startup.advanceDueJobs();expect(out).toEqual(['paid','true','foreign_refused','job_refused']);
 },60000);
});

describe('canonical payment binding over actual SQL',()=>{
 async function bound(){const f=await composed(h);await f.startup.bootstrap(f.http(),f.job);await f.startup.bridge.prepareQuote(await f.request(),await f.quote());
  await recordPayment(f.engine,{payment:'00000000-0000-4000-8000-0000000000c1',job:f.job,session:f.session,pi:'pi_1',event:'evt_paid'});return f;}
 it.each([
  ['amount',(e:ReturnType<typeof paidEvent>)=>{e.data.object.amount_total=499;}],
  ['currency',(e:ReturnType<typeof paidEvent>)=>{e.data.object.currency='eur';}],
  ['PaymentIntent',(e:ReturnType<typeof paidEvent>)=>{e.data.object.payment_intent='pi_other';}],
  ['quote version',(e:ReturnType<typeof paidEvent>)=>{e.data.object.metadata.quote_version='2';}],
  ['job metadata',(e:ReturnType<typeof paidEvent>)=>{e.data.object.metadata.job_id=OTHER;}],
  ['client reference',(e:ReturnType<typeof paidEvent>)=>{e.data.object.client_reference_id=OTHER;}],
  ['object livemode',(e:ReturnType<typeof paidEvent>)=>{e.data.object.livemode=true;}],
  ['metadata environment',(e:ReturnType<typeof paidEvent>)=>{e.data.object.metadata.environment='live';}],
  ['unpaid status',(e:ReturnType<typeof paidEvent>)=>{e.data.object.payment_status='unpaid';}],
 ] as const)('altered %s is refused and retains no event or outbox work',async(_n,alter)=>{
  const f=await bound();const e=paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'});alter(e);
  h.construct.mockReturnValueOnce(e);await expect(f.startup.bridge.ingestStripe('RAW','signed')).rejects.toThrow(/current_payment_/);
  expect(await count(f,'current_autonomy_payment.events')).toBe(0);expect(await count(f,'current_autonomy_payment.outbox')).toBe(0);
 });
 it('canonical payment row drift (amount/status/environment) is refused by SQL/bridge',async()=>{
  for(const drift of ['UPDATE payments SET amount_cents=499','UPDATE payments SET status=\'needs_refund\'','UPDATE quotes SET price_cents=499']){
   const f=await bound();await f.engine.exec(drift);h.construct.mockReturnValueOnce(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1',amount:drift.includes('499')&&drift.includes('payments')?499:500}));
   await expect(f.startup.bridge.ingestStripe('RAW','signed')).rejects.toThrow();expect(await count(f,'current_autonomy_payment.events')).toBe(0);await closeEngines();
  }
 });
 it('configured live/test mode mismatch is refused by the production verifier adapter',()=>{
  const o=currentStripePaymentOptions({sql:{} as never,now:()=>0,authorize:async()=>true});
  h.construct.mockReturnValueOnce({...paidEvent({id:'e',job:'j',session:'s',pi:'p'}),livemode:true});expect(()=>o.verifyStripe('RAW','signed')).toThrow('configured_environment_mismatch');
 });
 it('altered duplicate provider event identity is rejected and does not replace the retained event or receipt',async()=>{
  const f=await bound();expect(await f.ingest(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}))).toEqual({status:'queued'});
  expect(await f.ingest(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}))).toEqual({status:'duplicate'});
  await f.startup.bridge.drainReceipts(f.tenant,f.job);expect(await f.valid('evt_paid')).toBe(true);
  await expect(f.ingest({...paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}),type:'checkout.session.async_payment_succeeded'})).rejects.toThrow();
  await expect(f.ingest(refundEvent({id:'evt_paid',pi:'pi_1'}))).rejects.toThrow();
  expect(await count(f,'current_autonomy_payment.events')).toBe(1);expect(await f.valid('evt_paid')).toBe(true);
 });
 it.each([
  ['refund after current authorization revoked',async(f:Awaited<ReturnType<typeof composed>>)=>{f.state.authorized=false;},'charge.refunded'],
  ['refund after job cancelled',async(f:Awaited<ReturnType<typeof composed>>)=>{await f.engine.query("UPDATE jobs SET state='cancelled'");},'charge.refunded'],
  ['cancellation after viewer session gone',async(f:Awaited<ReturnType<typeof composed>>)=>{f.state.viewer=null;},'payment_intent.canceled'],
 ] as const)('%s is still persisted as permanent revocation; restoration cannot revive the receipt',async(_n,revoke,type)=>{
  const f=await bound();await f.ingest(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}));await f.startup.bridge.drainReceipts(f.tenant,f.job);expect(await f.valid('evt_paid')).toBe(true);
  await revoke(f);
  const ev=type==='payment_intent.canceled'?{id:'evt_cancel',type,livemode:false,data:{object:{id:'pi_1',object:'payment_intent',livemode:false}}}:refundEvent({id:'evt_cancel',pi:'pi_1'});
  expect(await f.ingest(ev)).toEqual({status:'queued'});
  f.state.authorized=true;f.state.viewer=f.tenant;await f.engine.query("UPDATE jobs SET state='awaiting_payment'");
  expect(await f.valid('evt_paid')).toBe(false);
  expect((await f.engine.query('SELECT settled FROM company_autonomy_release.payment_receipts')).rows).toEqual([{settled:false}]);
  expect((await f.engine.query('SELECT revoked FROM current_autonomy_payment.bindings')).rows).toEqual([{revoked:true}]);
 });
 it('late/out-of-order: refund before the paid webhook retry, then a distinct later completion, never yields paid',async()=>{
  const f=await bound();expect(await f.ingest(refundEvent({id:'evt_refund',pi:'pi_1'}))).toEqual({status:'queued'});
  expect(await f.ingest(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}))).toEqual({status:'queued'});
  expect(await f.ingest(paidEvent({id:'evt_async',job:f.job,session:f.session,pi:'pi_1'}))).toEqual({status:'queued'});
  await f.startup.bridge.drainReceipts(f.tenant,f.job);await f.permit();
  const quote=await f.quote();const out:string[]=[];h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{out.push(await p.payment(quote));return progress;});
  await f.startup.advanceDueJobs();expect(out).toEqual(['waiting']);expect(await count(f,'company_autonomy_release.payment_receipts')).toBe(0);
 });
 it('per-finding, subscription, unsupported-mode and USDC paths refuse explicitly rather than becoming prepaid authority',async()=>{
  const f=await bound();
  const strict=(e:unknown)=>{h.construct.mockReturnValueOnce(e);return f.startup.bridge.ingestStripe('RAW','signed');};
  const sub=paidEvent({id:'evt_sub',job:f.job,session:f.session,pi:'pi_1'});(sub.data.object as {mode:string}).mode='subscription';
  await expect(strict(sub)).rejects.toThrow('settled_fixed_payment_required');
  const pf=paidEvent({id:'evt_pf',job:f.job,session:f.session,pi:'pi_1'});(pf.data.object.metadata as {pricing_mode:string}).pricing_mode='per_finding';
  await expect(strict(pf)).rejects.toThrow('per_finding_contract_unsupported');
  await expect(f.startup.bridge.ingestX402()).rejects.toThrow('usdc_release_currency_contract_unsupported');
  await f.engine.exec("UPDATE quotes SET pricing_mode='per_finding',cap_cents=1500");
  await expect(f.startup.bridge.loadRequest({tenantId:f.tenant,subject:f.tenant},f.job)).rejects.toThrow('per_finding_contract_unsupported');
  await expect(f.engine.query('SELECT current_autonomy_payment.prepare_binding($1,$2,1,$3,$3,\'test\',500,$4)',[f.tenant,f.job,'a'.repeat(64),f.session])).rejects.toThrow(/canonical_quote_refused/);
  expect(await count(f,'current_autonomy_payment.events')).toBe(0);
 });
});

describe('held unknown costs',()=>{
 it('scripted target responses never settle; unverified receipts refuse; reservations stay held at the pinned job cap',async()=>{
  const f=await composed(h);await f.paidAndBound();const quote=await f.quote();const out:string[]=[];
  f.evaluateWithServices.mockImplementation(async(...args:unknown[])=>{
   const request=args[0] as CompanyRequest,paid=(args[3] as {paid:AutonomousPaidContext}).paid;
   await runAutonomousTarget(paid,{operationId:'op-1',input:{n:1},job:request.job},()=>h.transport(1));
   const op=(await f.engine.query<{input_digest:string}>('SELECT input_digest FROM autonomous_paid_app.operations')).rows[0];
   await paid.reconcile({operationId:'op-1',inputDigest:op.input_digest,receiptId:'scripted-response',microUsd:420000,evidence:{scripted:true}}).then(()=>out.push('settled'),()=>out.push('reconcile_refused'));
   await paid.runner.run({job:request.job,jobCapMicroUsd:3000001} as never).then(()=>out.push('cap_raised'),()=>out.push('cap_refused'));
   return {status:'pending'} as never;
  });
  h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{out.push(await p.payment(quote));await p.evaluate('eval','b'.repeat(64)).catch(()=>{});return progress;});
  await f.startup.advanceDueJobs();
  expect(out).toEqual(['paid','reconcile_refused','cap_refused']);
  const r=(await f.engine.query<{settled_micro_usd:unknown;scopes:Array<{key:string;capMicroUsd:number}>}>('SELECT settled_micro_usd,scopes FROM agent_persistence.reservations')).rows;
  expect(r).toHaveLength(1);expect(r[0].settled_micro_usd).toBeNull();expect(r[0].scopes).toContainEqual({key:`job:${f.job}`,capMicroUsd:3000000});
  expect((await f.engine.query('SELECT state,receipt FROM autonomous_paid_app.operations')).rows).toEqual([{state:'dispatched',receipt:null}]);
  expect(f.owner.config.naive.createSession).not.toHaveBeenCalled();
 },60000);
});
