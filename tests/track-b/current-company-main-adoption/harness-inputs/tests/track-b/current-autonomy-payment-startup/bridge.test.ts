import { PRICE_CENTS } from '../../../packages/core/src/contracts';
import { describe, it, expect, vi } from 'vitest';
import { createCurrentPaymentBridge } from '../../../docs/current-autonomy-payment-startup/bridge/source/apps/web/src/server/current-payment';
import { buildQuote } from '../../../packages/core/src/agents/commercial';
import type { AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';

function fixture() {
  const job={id:'job',customer_id:'tenant',package:'text_eval',environment:'test',state:'quoted',is_mock:false,
    workflow_run_id:'run',retest_of_job_id:null,intake:{package:'text_eval',authorizedToTest:true,notes:'Check response quality',endpoint:{url:'https://target.example/v1',systemPrompt:'Be helpful'}},
    scope_summary:'Text evaluation',deliverables:buildQuote({jobId:'job',customerId:'tenant',package:'text_eval',environment:'test',quoteVersion:1,linkedRetestOf:null,isFixture:false},'text_eval',1,'Text evaluation').deliverables,version:1,price_cents:PRICE_CENTS.text_eval,pricing_mode:'fixed',stripe_checkout_session_id:'cs_1'};
  const payment={id:'pay',job_id:'job',quote_version:1,environment:'test',amount_cents:PRICE_CENTS.text_eval,currency:'usd',status:'paid',kind:'one_time',stripe_checkout_session_id:'cs_1',stripe_payment_intent_id:'pi_1'};
  const event={id:'evt_1',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_1',mode:'payment',payment_status:'paid',livemode:false,client_reference_id:'job',amount_total:PRICE_CENTS.text_eval,currency:'usd',payment_intent:'pi_1',metadata:{job_id:'job',quote_version:'1',environment:'test',pricing_mode:'fixed'}}}};
  let allowed=true;
  const query=vi.fn(async (q:string,_p?:unknown[])=>{
    if(q.includes('FROM public.jobs'))return {rows:[job]};
    if(q.includes('FROM public.messages'))return {rows:[]};
    if(q.includes('FROM public.payments'))return {rows:[payment]};
    if(q.includes('FROM current_autonomy_payment.bindings'))return {rows:[{tenant_id:'tenant',quote_digest:'a'.repeat(64)}]};
    if(q.includes('prepare_binding'))return {rows:[{result:'prepared'}]};
    if(q.includes('ingest_event'))return {rows:[{result:'queued'}]};
    if(q.includes('receipt_valid'))return {rows:[{valid:true}]};
    return {rows:[]};
  });
  const sql={query,transaction:async (f:(tx:unknown)=>unknown)=>f({query})} as unknown as AgentTransactionalSql;
  const verifier=vi.fn(()=>event as never);
  const bridge=createCurrentPaymentBridge({sql,now:()=>0,authorize:async()=>allowed,verifyStripe:verifier});
  return {bridge,job,payment,event,query,verifier,revoke:()=>{allowed=false;}};
}
describe('current canonical payment bridge',()=>{
  it('uses canonical request and actual owner checkout without accepting or charging',async()=>{
    const f=fixture();
    expect(await f.bridge.loadRequest({tenantId:'other',subject:'other'},'job')).toBeNull();
    const request=(await f.bridge.loadRequest({tenantId:'tenant',subject:'tenant'},'job'))!;
    expect(request.intake.endpointHost).toBe('target.example');
    expect(request.intake.notes).toContain('response quality');
    const quote=buildQuote(request.job,'text_eval',1,'Text evaluation');
    expect(await f.bridge.prepareQuote(request,quote)).toMatchObject({path:'/api/jobs/job/accept-quote',body:{quoteVersion:1},requiresOwnerAcceptance:true});
    expect(f.query.mock.calls.some(([q])=>q.includes('UPDATE public.'))).toBe(false);
    f.revoke();
    await expect(f.bridge.prepareQuote(request,quote)).rejects.toThrow('authorization_or_request_changed');
  });
  it('refuses current per-finding hold instead of calling it fixed/prepaid',async()=>{
    const f=fixture();f.job.pricing_mode='per_finding';
    await expect(f.bridge.loadRequest({tenantId:'tenant',subject:'tenant'},'job')).rejects.toThrow('per_finding_contract_unsupported');
    await expect(f.bridge.ingestX402()).rejects.toThrow('usdc_release_currency_contract_unsupported');
  });
  it('signature gate precedes reads, then exact event/payment quantities bind',async()=>{
    const f=fixture();f.verifier.mockImplementationOnce(()=>{throw Error('bad signature');});
    await expect(f.bridge.ingestStripe('{}','bad')).rejects.toThrow('bad signature');
    expect(f.query).not.toHaveBeenCalled();
    f.event.data.object.amount_total=PRICE_CENTS.text_eval+1;
    await expect(f.bridge.ingestStripe('{}','signed')).rejects.toThrow('event_payment_mismatch');
    expect(f.query.mock.calls.some(([q])=>q.includes('ingest_event'))).toBe(false);
    f.event.data.object.amount_total=PRICE_CENTS.text_eval;
    expect(await f.bridge.ingestStripe('{}','signed')).toEqual({status:'queued'});
    const ingest=f.query.mock.calls.find(([q])=>q.includes('ingest_event'))!;
    expect(ingest[1]?.slice(0,6)).toEqual(['tenant','job',1,'stripe','test','evt_1']);
  });
  it.each(['environment','currency','quote','customer'] as const)('rejects %s mismatch',async kind=>{
    const f=fixture();
    if(kind==='environment')f.event.livemode=true;
    if(kind==='currency')f.event.data.object.currency='usdc';
    if(kind==='quote')f.event.data.object.metadata.quote_version='2';
    if(kind==='customer')f.event.data.object.metadata.job_id='other';
    await expect(f.bridge.ingestStripe('{}','signed')).rejects.toThrow();
    expect(f.query.mock.calls.some(([q])=>q.includes('ingest_event'))).toBe(false);
  });
});
