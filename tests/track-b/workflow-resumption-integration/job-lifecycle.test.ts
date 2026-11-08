import { beforeEach, expect, it, vi } from 'vitest';
// Scripted external Workflow SDK boundary. This executes applied job.ts control flow;
// it is not a hosted Workflow replay or a Workflow compiler acceptance test.
const calls=vi.hoisted(()=>({rich:vi.fn(),wake:vi.fn(),sleep:vi.fn(),deliver:vi.fn(),discard:vi.fn(),fail:vi.fn(),progress:vi.fn(),snapshot:vi.fn()}));
vi.mock('workflow',()=>({
 createHook:()=>({[Symbol.dispose](){},[Symbol.asyncIterator](){return{next:async()=>({done:true})};}}),
 getWorkflowMetadata:()=>({workflowRunId:'workflow-original'}),sleep:calls.sleep,FatalError:class extends Error{},
}));
vi.mock('@/workflows/steps/resume',()=>({discardPartialEvaluationStep:calls.discard,loadResumeSnapshotStep:calls.snapshot}));
vi.mock('@/workflows/steps/rich-evaluation',()=>({richEvaluationStep:calls.rich}));
vi.mock('@/workflows/steps/review-wake',()=>({reviewWakeStep:calls.wake}));
vi.mock('@/workflows/steps/rich-mode',()=>({richModeStep:async()=>true}));
vi.mock('@/workflows/steps/rich-inventory-refresh',()=>({refreshRichInventoryStep:vi.fn()}));
vi.mock('@/workflows/steps/lifecycle',()=>({cancelStep:vi.fn(),commercialMessageStep:vi.fn(),declineStep:vi.fn(),deliverStep:calls.deliver,failStep:calls.fail,neonDeliverySafetyStep:vi.fn(),pauseBudgetStep:vi.fn(),progressStep:calls.progress,setStateStep:vi.fn(async()=>true)}));
vi.mock('@/workflows/steps/quote',()=>({connectionCheckStep:vi.fn(),createQuoteStep:vi.fn(),qualifyStep:vi.fn()}));
vi.mock('@/workflows/steps/evaluate',()=>({auditTraceStep:vi.fn(),createBranchStep:vi.fn(),designSuiteStep:vi.fn(),investigateStep:vi.fn(),persistReportStep:vi.fn(),proposeFixStep:vi.fn(),renderReportStep:vi.fn(),runSuiteStep:vi.fn()}));
vi.mock('@/workflows/steps/notify',()=>({notifyCustomerStep:vi.fn()}));
vi.mock('@/workflows/steps/billing',()=>({flagSettlementFailureStep:vi.fn(),settlePaymentStep:vi.fn()}));
import { jobWorkflow } from '@/workflows/job';
beforeEach(()=>{
 vi.resetAllMocks();calls.snapshot.mockResolvedValue({state:'running',package:'text_eval',reportStored:false,latestQuote:{version:1,accepted:true,pricingMode:'fixed',priceCents:100,capCents:null},payments:[{id:'payment',quoteVersion:1,status:'paid',kind:'one_time',amountCents:100,currency:'usd'}],clarificationAnswers:[],qualifyCount:1,connectionCheckFailures:0,receivedRecorded:true,findingsCount:1,remediationsCount:1});
 calls.sleep.mockResolvedValue(undefined);calls.deliver.mockResolvedValue({deliveredAtIso:'2026-11-07T00:00:00Z'});
});
it('review suspension keeps the same physical run alive and eventually executes approved evaluation',async()=>{
 calls.rich.mockResolvedValueOnce('review_pending').mockResolvedValueOnce('complete');calls.wake.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 expect(await jobWorkflow('job')).toEqual({jobId:'job',status:'delivered'});
 expect(calls.sleep).toHaveBeenCalled();expect(calls.wake).toHaveBeenCalledWith('job','workflow-original');
 expect(calls.rich).toHaveBeenCalledTimes(2);for(const args of calls.rich.mock.calls)expect(args).toEqual(['job','workflow-original']);
 expect(calls.deliver).toHaveBeenCalledOnce();expect(calls.discard).not.toHaveBeenCalled();expect(calls.fail).not.toHaveBeenCalled();
});
it.each(['agent_pending','cost_delivery_pending','pending','paused_budget'])('does not confuse %s with reviewed-data readiness',async status=>{
 calls.rich.mockResolvedValue(status);expect((await jobWorkflow('job')).status).toBe(status==='paused_budget'?'paused_budget':'on_hold');
 expect(calls.rich).toHaveBeenCalledOnce();expect(calls.wake).not.toHaveBeenCalled();expect(calls.sleep).not.toHaveBeenCalled();expect(calls.deliver).not.toHaveBeenCalled();
});
it('already complete jobs never execute evaluation or await another review',async()=>{
 calls.snapshot.mockResolvedValue({state:'delivered'});expect(await jobWorkflow('job')).toEqual({jobId:'job',status:'already_finished'});
 expect(calls.rich).not.toHaveBeenCalled();expect(calls.wake).not.toHaveBeenCalled();expect(calls.sleep).not.toHaveBeenCalled();
});

it('revoked scope stops a suspended original worker before another evaluation or delivery',async()=>{
 calls.rich.mockResolvedValue('review_pending');calls.wake.mockResolvedValue('stop');
 expect(await jobWorkflow('job')).toEqual({jobId:'job',status:'on_hold'});
 expect(calls.rich).toHaveBeenCalledOnce();expect(calls.deliver).not.toHaveBeenCalled();expect(calls.discard).not.toHaveBeenCalled();
});
