import {afterEach,expect,it,vi} from 'vitest';
import {runAutonomousTarget,type AutonomousPaidContext} from '@/server/autonomous-paid';
import {createCurrentPaymentStartup} from '@/server/current-payment-startup';
import {autonomyDigest} from '@ae/core/agents/autonomy/policy';
import type {CompanyPorts,CompanyRequest} from '@ae/core/agents/autonomy/company';
import {closeEngines,composed,refundEvent} from '/private/tmp/current-company-main-adoption-payment-fixed-20261107/tests/track-b/current-company-review/authorization-payment/fixture';
const h=vi.hoisted(()=>({construct:vi.fn(),run:vi.fn()}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:()=>({webhooks:{constructEvent:(...a:unknown[])=>h.construct(...a)}}),webhookSecret:()=>'fixture-only',getStripeMode:()=>'test'}));
vi.mock('@ae/core/agents/autonomy/company',async original=>({...await original<typeof import('@ae/core/agents/autonomy/company')>(),advanceAutonomousCompany:(r:CompanyRequest,p:CompanyPorts)=>h.run(r,p)}));
afterEach(async()=>{h.construct.mockReset();h.run.mockReset();await closeEngines();});
it('refund fences new dispatch but an authenticated receipt can still settle prior spend; revoked owner cannot reconcile',async()=>{
 const f=await composed(h);await f.paidAndBound();
 const verified=vi.fn(async()=>true),transport=vi.fn(async()=>({ok:true}));
 const startup=createCurrentPaymentStartup({...f.owner,config:{...f.owner.config,verifyPaidReceipt:verified}});
 let reconciled=false;
 f.evaluateWithServices.mockImplementation(async(...args:unknown[])=>{try{
  const request=args[0] as CompanyRequest,paid=(args[3] as {paid:AutonomousPaidContext}).paid;
  const operationId='autonomous-text:refund-reconcile',input={case:1};
  await runAutonomousTarget(paid,{operationId,input,job:request.job},transport);
  await f.ingest(refundEvent({id:'evt_refund_reconcile',pi:'pi_1'}));
  await expect(runAutonomousTarget(paid,{operationId:'autonomous-text:after-refund',input,job:request.job},transport)).rejects.toThrow();
  const receipt={operationId,inputDigest:autonomyDigest({job:request.job,input,policy:paid.policy}),receiptId:'genuine-fixture-receipt',microUsd:7,evidence:{provider:'fixture'}};
  await paid.reconcile(receipt);
  expect((await f.engine.query('SELECT state,receipt FROM autonomous_paid_app.operations WHERE operation_id=$1',[operationId])).rows[0]).toMatchObject({state:'settled',receipt:{microUsd:7}});
  const calls=verified.mock.calls.length;
  f.state.authorized=false;
  await expect(paid.reconcile(receipt)).rejects.toThrow();
  expect(verified).toHaveBeenCalledTimes(calls);
  reconciled=true;
  return {status:'pending'} as never;
 }catch(error){console.error('DIAGNOSTIC_EVALUATOR_ERROR',error);throw error;}
 });
 h.run.mockImplementation(async(_r:CompanyRequest,p:CompanyPorts)=>{await p.evaluate('eval','b'.repeat(64));return {state:'pending',reason:'fixture',policyVersion:'v1',founderInterventions:0,costStatus:'unknown'};});
 await startup.advanceDueJobs();
 expect(reconciled).toBe(true);expect(transport).toHaveBeenCalledTimes(1);
},60000);
