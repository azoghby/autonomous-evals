import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({
  construct:vi.fn(),record:vi.fn(),resume:vi.fn(),ingest:vi.fn(),mode:'test',app:undefined as any,
}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:()=>({webhooks:{constructEvent:h.construct}}),webhookSecret:()=> 'fixture-only-secret',getStripeMode:()=>h.mode}));
vi.mock('@ae/core/payments/checkout',()=>({recordPaymentFromSession:h.record,isManualCaptureAuthorized:vi.fn()}));
vi.mock('@/server/current-autonomy-runtime',()=>({currentAutonomy:async()=>h.app}));
vi.mock('@/workflows/resume',()=>({resumeJobForPayment:h.resume}));
import {POST} from '@/app/api/stripe/webhook/route';
import {currentStripePaymentOptions} from '@/server/current-stripe-payment';
const event=()=>({id:'evt_test',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test',mode:'payment',payment_status:'paid',metadata:{job_id:'job',pricing_mode:'fixed'}}}});
const request=()=>new Request('https://local.invalid/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':'signed'},body:'RAW'});
beforeEach(()=>{
  h.mode='test';h.app={bridge:{ingestStripeIfBound:h.ingest}};
  h.construct.mockReset().mockReturnValue(event());h.record.mockReset().mockResolvedValue({payment:{workflowResumedAt:null},inserted:true});
  h.resume.mockReset().mockResolvedValue(undefined);h.ingest.mockReset().mockResolvedValue({status:'ignored_unbound'});
});
it('signed unbound legacy fixed checkout still records and resumes the existing workflow',async()=>{
  expect((await POST(request())).status).toBe(200);
  expect(h.construct).toHaveBeenCalledWith('RAW','signed','fixture-only-secret');
  expect(h.record).toHaveBeenCalledOnce();expect(h.ingest).toHaveBeenCalledWith('RAW','signed');expect(h.resume).toHaveBeenCalledOnce();
});
it('fixed bound receipt persistence failure is retryable before the legacy resume',async()=>{
  h.ingest.mockRejectedValue(new Error('receipt_conflict'));
  expect((await POST(request())).status).toBe(500);expect(h.record).toHaveBeenCalledOnce();expect(h.resume).not.toHaveBeenCalled();
});
it('refund evidence is ingested before acknowledgement; wrong-mode refunds never ingest',async()=>{
  h.construct.mockReturnValue({...event(),type:'charge.refunded'});
  expect((await POST(request())).status).toBe(200);expect(h.ingest).toHaveBeenCalledOnce();expect(h.record).not.toHaveBeenCalled();
  h.ingest.mockClear();h.construct.mockReturnValue({...event(),type:'charge.refunded',livemode:true});
  expect((await POST(request())).status).toBe(200);expect(h.ingest).not.toHaveBeenCalled();
});
it('missing signature and invalid cryptographic verification precede payment work',async()=>{
  expect((await POST(new Request('https://local.invalid',{method:'POST',body:'RAW'}))).status).toBe(400);
  h.construct.mockImplementation(()=>{throw Error('signature mismatch');});
  expect((await POST(request())).status).toBe(400);expect(h.record).not.toHaveBeenCalled();expect(h.ingest).not.toHaveBeenCalled();
});
it('production adapter uses actual current SDK verifier and configured-mode gate without network',()=>{
  const options=currentStripePaymentOptions({sql:{} as any,now:()=>0,authorize:async()=>true});
  expect(options.verifyStripe('RAW','signed')).toEqual(event());
  h.construct.mockReturnValue({...event(),livemode:true});
  expect(()=>options.verifyStripe('RAW','signed')).toThrow('configured_environment_mismatch');
});
