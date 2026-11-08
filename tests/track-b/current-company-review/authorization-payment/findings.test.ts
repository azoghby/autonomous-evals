/** Repro tests for suspected defects. Each FAILS on the composed candidate because of the defect. */
import {afterEach,expect,it,vi} from 'vitest';
import {runAutonomousTarget,type AutonomousPaidContext} from '@/server/autonomous-paid';
import type {CompanyPorts,CompanyRequest} from '@ae/core/agents/autonomy/company';
import {closeEngines,composed,paidEvent,refundEvent,seedJob,recordPayment} from './fixture';

const h=vi.hoisted(()=>({construct:vi.fn(),run:vi.fn(),transport:vi.fn(async(n:number)=>({ok:n}))}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:()=>({webhooks:{constructEvent:(...a:unknown[])=>h.construct(...a)}}),webhookSecret:()=>'fixture-only',getStripeMode:()=>'test'}));
vi.mock('@ae/core/agents/autonomy/company',async original=>({...await original<typeof import('@ae/core/agents/autonomy/company')>(),
 advanceAutonomousCompany:(r:CompanyRequest,p:CompanyPorts)=>h.run(r,p)}));
afterEach(async()=>{h.construct.mockReset();h.run.mockReset();h.transport.mockClear();await closeEngines();});
const progress={state:'pending',reason:'fixture',policyVersion:'v1',founderInterventions:0,costStatus:'unknown'};

it('AP-1: refunded jobs\' permanently undeliverable outbox rows must not starve the bounded scheduler drain of later paid receipts',async()=>{
 const f=await composed(h,{tenant:'ffffffff-ffff-4fff-8fff-ffffffffffff',job:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'});
 // 25 earlier jobs (the default drain limit) were paid, bootstrapped, published, then refunded via signed events.
 for(let i=0;i<25;i++){
  const pad=String(i).padStart(12,'0'),t=`00000000-0000-4000-8000-${pad}`,j=`10000000-0000-4000-8000-${pad}`,pi=`pi_b${i}`;
  const session=await seedJob(f.engine,{tenant:t,job:j,session:`cs_b${i}`});
  const request=(await f.startup.bridge.loadRequest({tenantId:t,subject:t},j))!;
  await f.engine.query(`INSERT INTO company_autonomy_release.job_bindings(tenant_id,job_id,owner_id,policy_version,request,enabled,next_tick_at) VALUES($1,$2,$1,'v1',$3::jsonb,true,1000000000000000)`,[t,j,JSON.stringify(request)]);
  const {buildQuote}=await import('@ae/core/agents/commercial');
  await f.startup.bridge.prepareQuote(request,buildQuote(request.job,'text_eval',1,'Text evaluation'));
  await recordPayment(f.engine,{payment:`20000000-0000-4000-8000-${pad}`,job:j,session,pi,event:`evt_bp${i}`});
  expect(await f.ingest(paidEvent({id:`evt_bp${i}`,job:j,session,pi}))).toEqual({status:'queued'});
  await f.startup.bridge.drainReceipts(t,j);
  expect(await f.ingest(refundEvent({id:`evt_br${i}`,pi}))).toEqual({status:'queued'});
 }
 // Later customer: bootstrapped first, then paid; only the scheduler drain can publish this receipt.
 await f.paidAndBound();
 const quote=await f.quote();const seen:string[]=[];
 h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{seen.push(await p.payment(quote));return progress;});
 const dueMain=()=>f.engine.query('UPDATE company_autonomy_release.job_bindings SET next_tick_at=0 WHERE job_id=$1',[f.job]);
 await f.startup.advanceDueJobs();await dueMain();await f.startup.advanceDueJobs();
 const stuck=(await f.engine.query<{n:number}>(`SELECT count(*)::int AS n FROM current_autonomy_payment.outbox o JOIN current_autonomy_payment.events e USING(provider,environment,event_id) WHERE NOT o.delivered AND e.status='refunded'`)).rows[0].n;
 expect(stuck).toBe(25); // root cause: revocation rows are never acknowledged
 // Control: the same receipt is valid; a job-targeted drain (the bootstrap path) publishes it.
 await f.startup.bridge.drainReceipts(f.tenant,f.job);await dueMain();await f.startup.advanceDueJobs();
 expect(seen).toEqual(['paid','paid','paid']);
},120000);

it('AP-2: a signed refund recorded during an in-flight evaluation must fence the remaining paid target dispatches',async()=>{
 const f=await composed(h);await f.paidAndBound();const quote=await f.quote();
 const observed:unknown[]=[];
 f.evaluateWithServices.mockImplementation(async(...args:unknown[])=>{
  const request=args[0] as CompanyRequest,paid=(args[3] as {paid:AutonomousPaidContext}).paid;
  await runAutonomousTarget(paid,{operationId:'autonomous-text:review:1',input:{n:1},job:request.job},()=>h.transport(1));
  observed.push(await f.ingest(refundEvent({id:'evt_refund',pi:'pi_1'})));
  observed.push(await f.valid('evt_paid'));
  observed.push((await f.engine.query('SELECT settled FROM company_autonomy_release.payment_receipts')).rows);
  try{await runAutonomousTarget(paid,{operationId:'autonomous-text:review:2',input:{n:2},job:request.job},()=>h.transport(2));observed.push('second_dispatch_allowed');}
  catch(e){observed.push('second_dispatch_refused:'+(e as Error).message);}
  return {status:'pending'} as never;
 });
 h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{observed.push(await p.payment(quote));await p.evaluate('eval','b'.repeat(64)).catch(()=>{});return progress;});
 await f.startup.advanceDueJobs();
 expect(observed.slice(0,4)).toEqual(['paid',{status:'queued'},false,[{settled:false}]]);
 expect(observed[4]).toMatch(/^second_dispatch_refused/);
 expect(h.transport).toHaveBeenCalledTimes(1);
},60000);
