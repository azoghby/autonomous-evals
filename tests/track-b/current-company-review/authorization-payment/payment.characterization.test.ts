/** characterization: documents CURRENT composed behavior. Passing here is NOT acceptance. */
import {afterEach,expect,it,vi} from 'vitest';
import type {CompanyPorts,CompanyRequest} from '@ae/core/agents/autonomy/company';
import {closeEngines,composed,paidEvent,refundEvent,recordPayment} from './fixture';

const h=vi.hoisted(()=>({construct:vi.fn(),run:vi.fn()}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:()=>({webhooks:{constructEvent:(...a:unknown[])=>h.construct(...a)}}),webhookSecret:()=>'fixture-only',getStripeMode:()=>'test'}));
vi.mock('@ae/core/agents/autonomy/company',async original=>({...await original<typeof import('@ae/core/agents/autonomy/company')>(),
 advanceAutonomousCompany:(r:CompanyRequest,p:CompanyPorts)=>h.run(r,p)}));
afterEach(async()=>{h.construct.mockReset();h.run.mockReset();await closeEngines();});
const progress={state:'pending',reason:'fixture',policyVersion:'v1',founderInterventions:0,costStatus:'unknown'};
const OTHER='00000000-0000-4000-8000-0000000000f9';
async function published(){
 const f=await composed(h);await f.startup.bootstrap(f.http(),f.job);await f.startup.bridge.prepareQuote(await f.request(),await f.quote());
 await recordPayment(f.engine,{payment:'00000000-0000-4000-8000-0000000000c1',job:f.job,session:f.session,pi:'pi_1',event:'evt_paid'});
 await f.ingest(paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}));await f.startup.bridge.drainReceipts(f.tenant,f.job);
 expect(await f.valid('evt_paid')).toBe(true);return f;
}

it('characterization: a signed refund arriving while canonical job ownership differs is refused by ingest_event (canonical_job_refused) and is not retained; restoring ownership revives the receipt',async()=>{
 const f=await published();
 await f.engine.query("INSERT INTO customers(id,email) VALUES($1,'n@example.invalid')",[OTHER]);await f.engine.query('UPDATE jobs SET customer_id=$1',[OTHER]);
 await expect(f.ingest(refundEvent({id:'evt_refund',pi:'pi_1'}))).rejects.toThrow(/canonical_job_refused/);
 expect((await f.engine.query('SELECT revoked FROM current_autonomy_payment.bindings')).rows).toEqual([{revoked:false}]);
 expect(await f.valid('evt_paid')).toBe(false); // fails closed while ownership differs
 await f.engine.query('UPDATE jobs SET customer_id=$1',[f.tenant]);
 expect(await f.valid('evt_paid')).toBe(true); // if the provider stops retrying before restoration, the refund is lost
});

it('characterization: after refund the company payment port reports waiting (not invalid); re-offering the same quote refuses',async()=>{
 const f=await published();await f.ingest(refundEvent({id:'evt_refund',pi:'pi_1'}));await f.permit();
 const quote=await f.quote();const out:string[]=[];
 h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{out.push(await p.payment(quote));
  await p.enqueue('quote',{kind:'quote',quote}).then(()=>out.push('offered'),(e:Error)=>out.push(e.message));return progress;});
 await f.startup.advanceDueJobs();
 expect(out[0]).toBe('waiting');expect(out[1]).toMatch(/binding_replay_conflict/);expect(f.enqueueQuote).not.toHaveBeenCalled();
});

it('characterization: charge.dispute.created (chargeback) is ignored by the bridge and the receipt remains valid',async()=>{
 const f=await published();
 expect(await f.ingest({id:'evt_dispute',type:'charge.dispute.created',livemode:false,data:{object:{id:'dp_1',object:'dispute',livemode:false,payment_intent:'pi_1',charge:'ch_1',amount:500}}})).toEqual({status:'ignored'});
 expect(await f.valid('evt_paid')).toBe(true);
});

it('characterization: a redelivered event with the same id whose only change is pending_webhooks is rejected as an identity conflict',async()=>{
 const f=await published();
 const again={...paidEvent({id:'evt_paid',job:f.job,session:f.session,pi:'pi_1'}),pending_webhooks:0};
 await expect(f.ingest(again)).rejects.toThrow(/provider_event_replay_conflict/);
});

it('characterization: a completed autonomous publication is refused (409) once the canonical job state is delivered',async()=>{
 const f=await composed(h);await f.startup.bootstrap(f.http(),f.job);
 const key=`autonomous-company:${f.tenant}:${f.job}:0:published-report`;
 await f.operations.claim(key,'d'.repeat(64));await f.operations.complete(key,'d'.repeat(64),{tenantId:f.tenant,jobId:f.job,artifactId:'r',rendered:{markdown:'REPORT'}});
 expect((await f.startup.publication(f.http(),f.job)).status).toBe(200);
 await f.engine.query("UPDATE jobs SET state='delivered'");
 expect((await f.startup.publication(f.http(),f.job)).status).toBe(409);
});
