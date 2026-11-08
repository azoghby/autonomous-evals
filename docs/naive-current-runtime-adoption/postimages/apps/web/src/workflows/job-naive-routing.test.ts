import { beforeEach, describe, expect, it, vi } from 'vitest';
const p = vi.hoisted(() => ({
  selectedFixes:vi.fn(),fixPolicy:vi.fn(),gap:vi.fn(), design: vi.fn(), branch: vi.fn(), run: vi.fn(), expert: vi.fn(), gate: vi.fn(), fail: vi.fn(), cancel: vi.fn(), sleep: vi.fn(), next: vi.fn(), policy:vi.fn(),genericReport:vi.fn(),deliveryGate:vi.fn(),fix:vi.fn(),deliver:vi.fn(),settle:vi.fn(),receipt:vi.fn(),notify:vi.fn(),snapshot:vi.fn(),plan:vi.fn(),progress:vi.fn(),
}));
vi.mock('workflow', () => ({FatalError: class FatalError extends Error {}, sleep: p.sleep, createHook: () => ({[Symbol.dispose]() {}, [Symbol.asyncIterator]: () => ({next: p.next})})}));
vi.mock('@/workflows/decisions', () => ({decideResumePlan: p.plan, selectFindingsForFix: p.selectedFixes, needsConnectionCheck: () => false}));
vi.mock('@/workflows/steps/expert-data', () => ({expertDataGateStep: p.gate, expertDataHoldStep: vi.fn()}));
vi.mock('@/workflows/steps/expert-text', () => ({expertTextEvaluationStep: p.expert, expertTextReportStep: async () => ({status:'ok'})}));
vi.mock('@/workflows/steps/resume', () => ({loadResumeSnapshotStep:p.snapshot, discardPartialEvaluationStep: vi.fn()}));
vi.mock('@/workflows/steps/evaluate', () => ({factualGapEntryStep:p.gap,createBranchStep:p.branch, designSuiteStep:p.design, runSuiteStep:p.run, investigateStep:async () => ({status:'ok',data:[]}), renderReportStep:async () => ({status:'ok',data:{}}), persistReportStep:vi.fn(), proposeFixStep:p.fix,genericTextExecutionPolicyStep:p.policy,genericTextRemediationPolicyStep:p.fixPolicy,genericTextReportStep:p.genericReport,genericTextCommittedReceiptStep:p.receipt,genericTextNotifyStep:p.notify, auditTraceStep:vi.fn()}));
vi.mock('@/workflows/steps/lifecycle', () => ({setStateStep:async () => true, progressStep:p.progress, deliverStep:p.deliver, neonDeliverySafetyStep:vi.fn(), failStep:p.fail, cancelStep:p.cancel}));
vi.mock('@/workflows/steps/quote', () => ({connectionCheckStep:vi.fn(), createQuoteStep:vi.fn(), qualifyStep:vi.fn()}));
vi.mock('@/workflows/steps/notify', () => ({notifyCustomerStep:vi.fn()}));
vi.mock('@/workflows/steps/billing', () => ({settlePaymentStep:p.settle, flagSettlementFailureStep:vi.fn()}));
import { TrackBBlockedError } from '@ae/core/integration/eval-services';
import { routeNaiveMethods,readRoutingSelection } from '@/server/naive-method-routing';
import { jobWorkflow } from '@/workflows/job';
describe('actual candidate Workflow caller', () => {
 beforeEach(() => {vi.clearAllMocks();p.selectedFixes.mockReturnValue([]);p.fixPolicy.mockResolvedValue(false);p.fix.mockResolvedValue({status:"ok",data:{}});p.gap.mockReset().mockResolvedValue('absent');p.gate.mockResolvedValue('legacy');p.snapshot.mockResolvedValue({package:'text_eval',receivedRecorded:true});p.plan.mockReturnValue({phase:'execute',quoteVersion:1});p.receipt.mockResolvedValue(null);p.notify.mockResolvedValue(true);p.policy.mockResolvedValue(false);p.genericReport.mockResolvedValue({status:'ok',data:{assessed:true,deliveredAtIso:'2026-11-08T00:00:00.000Z'}});p.deliver.mockResolvedValue({deliveredAtIso:''});p.branch.mockResolvedValue({});p.design.mockResolvedValue({status:'ok',data:{scenarios:[]}});p.run.mockResolvedValue({status:'ok',data:{results:[]}});p.next.mockImplementation(() => new Promise(() => {}));p.sleep.mockResolvedValue(undefined);});
 it('durably waits for admission then resumes generic evaluation', async () => {
  p.design.mockRejectedValueOnce(new Error('NAIVE_ADMISSION_PENDING: review'));
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.sleep).toHaveBeenCalledWith('30m');expect(p.design).toHaveBeenCalledTimes(2);expect(p.fail).not.toHaveBeenCalled();
 });
 it('cancels while waiting without another design dispatch', async () => {
  p.design.mockRejectedValueOnce(new Error('NAIVE_ADMISSION_PENDING: review'));p.sleep.mockImplementation(() => new Promise(() => {}));p.next.mockResolvedValueOnce({done:false,value:{type:'cancel',reason:'owner cancelled'}});
  expect((await jobWorkflow('job')).status).toBe('cancelled');expect(p.design).toHaveBeenCalledOnce();expect(p.cancel).toHaveBeenCalled();
 });
 it('durably resumes provider operations separately from admission', async () => {
  p.design.mockRejectedValueOnce(new Error('NAIVE_OPERATION_PENDING: provider operation'));
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.sleep).toHaveBeenCalledWith('30s');expect(p.design).toHaveBeenCalledTimes(2);
 });
 it('preserves expert route isolation before generic steps', async () => {
  p.gate.mockResolvedValue('ready');p.expert.mockResolvedValue({status:'ok',data:{findings:[],suite:{}}});
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.design).not.toHaveBeenCalled();expect(p.branch).not.toHaveBeenCalled();expect(p.run).not.toHaveBeenCalled();
 });
 it('holds all-unassessed generic baselines before delivery or settlement',async()=>{
  p.policy.mockResolvedValue(true);p.genericReport.mockResolvedValue({status:'ok',data:{assessed:false}});
  expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.deliver).not.toHaveBeenCalled();expect(p.settle).not.toHaveBeenCalled();expect(p.fix).not.toHaveBeenCalled();
 });
 it('generic rich reporting skips unselected fix verification',async()=>{
  p.policy.mockResolvedValue(true);
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.genericReport).toHaveBeenCalledOnce();expect(p.fix).not.toHaveBeenCalled();expect(p.deliver).not.toHaveBeenCalled();
 });

 it('routes selected generic fixes before retained-evidence publication',async()=>{
  p.policy.mockResolvedValue(true);p.fixPolicy.mockResolvedValue(true);p.selectedFixes.mockReturnValue([{id:'canonical-finding'}]);
  expect((await jobWorkflow('job')).status).toBe('delivered');
  expect(p.fix).toHaveBeenCalledWith('job',{id:'canonical-finding'},{scenarios:[]});
  expect(p.fix.mock.invocationCallOrder[0]).toBeLessThan(p.genericReport.mock.invocationCallOrder[0]);
 });
 it('holds ambiguous selected generic fixes without publishing',async()=>{
  p.policy.mockResolvedValue(true);p.fixPolicy.mockResolvedValue(true);p.selectedFixes.mockReturnValue([{id:'canonical-finding'}]);p.fix.mockRejectedValue(Error('NAIVE_RECONCILIATION_REQUIRED'));
  expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.genericReport).not.toHaveBeenCalled();expect(p.deliver).not.toHaveBeenCalled();expect(p.fail).not.toHaveBeenCalled();
 });
 it('recovers an acknowledged committed publication without overwriting delivered state',async()=>{
  p.policy.mockResolvedValue(true);p.genericReport.mockRejectedValueOnce(new Error('commit_ack_lost'));p.receipt.mockResolvedValue({deliveredAtIso:'2026-11-08T00:00:00.000Z'});
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.fail).not.toHaveBeenCalled();expect(p.deliver).not.toHaveBeenCalled();expect(p.notify).toHaveBeenCalledOnce();
 });
 it('holds an ambiguous notification claim without dispatching legacy notifications',async()=>{
  p.policy.mockResolvedValue(true);p.notify.mockResolvedValue(false);
  expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.fail).not.toHaveBeenCalled();
 });
 it('reconciles an existing receipt before a delivered text resume returns finished',async()=>{
  p.plan.mockReturnValue({phase:'finished'});p.snapshot.mockResolvedValue({package:'text_eval',state:'delivered'});p.receipt.mockResolvedValue({deliveredAtIso:'2026-11-08T00:00:00.000Z'});
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.notify).toHaveBeenCalledOnce();expect(p.design).not.toHaveBeenCalled();expect(p.deliver).not.toHaveBeenCalled();
 });
 it('preserves a delivered state when reconciliation cannot establish a receipt outcome',async()=>{
  p.policy.mockResolvedValue(true);p.genericReport.mockRejectedValueOnce(new Error('commit_unknown'));p.receipt.mockRejectedValueOnce(new Error('database_unavailable'));
  expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.fail).not.toHaveBeenCalled();expect(p.notify).not.toHaveBeenCalled();
 });


it('actual selected typed reconciliation holds the Workflow without another dispatch, failure or delivery',async()=>{
 p.policy.mockResolvedValue(true);
 const dispatch=vi.fn(async()=>{throw new TrackBBlockedError('needs_operator','ambiguous retained provider state');});
 const routed=routeNaiveMethods({} as never,{} as never,readRoutingSelection({EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:'designSuite'}),async()=>({designSuite:dispatch}));
 p.design.mockImplementationOnce(()=>routed.designSuite({budgetMicroUsd:1} as never,{} as never));
 expect((await jobWorkflow('job')).status).toBe('on_hold');expect(dispatch).toHaveBeenCalledOnce();expect(p.design).toHaveBeenCalledOnce();
 expect(p.progress).toHaveBeenCalledWith('job','naive_reconciliation_required',expect.any(String));
 for(const fn of [p.fail,p.deliver,p.settle,p.notify,p.run,p.sleep])expect(fn).not.toHaveBeenCalled();
});

it('unselected legacy reconciliation-like text retains the existing failure path',async()=>{
 p.policy.mockResolvedValue(false);p.design.mockRejectedValueOnce(new Error('NAIVE_RECONCILIATION_REQUIRED'));
 expect((await jobWorkflow('job')).status).toBe('failed');expect(p.fail).toHaveBeenCalledWith('job','NAIVE_RECONCILIATION_REQUIRED');expect(p.sleep).not.toHaveBeenCalled();
});


it('routes a newly discovered factual gap into expert acquisition and reviewed evaluation',async()=>{
 p.policy.mockResolvedValue(true);p.design.mockResolvedValue({status:'factual_gap'});
 p.gap.mockResolvedValueOnce('absent').mockResolvedValue('installed');p.gate.mockResolvedValueOnce('legacy').mockResolvedValue('ready');
 p.expert.mockResolvedValue({status:'ok',data:{findings:[],suite:{}}});
 expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.design).toHaveBeenCalledOnce();expect(p.expert).toHaveBeenCalledOnce();expect(p.run).not.toHaveBeenCalled();expect(p.genericReport).not.toHaveBeenCalled();
});
it('retained proposal missing owner prerequisites cannot fall through to design or lite',async()=>{
 p.gap.mockResolvedValue('pending');p.sleep.mockResolvedValue(undefined);p.next.mockReturnValue(new Promise(()=>{}));
 expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.design).not.toHaveBeenCalled();expect(p.run).not.toHaveBeenCalled();expect(p.next).toHaveBeenCalledOnce();
});
it('shares the pending event read when expert execution transitions into outer admission wait',async()=>{
 let cancel!:(value:unknown)=>void;p.next.mockImplementation(()=>new Promise(resolve=>{cancel=resolve;}));
 p.gap.mockResolvedValue('installed');p.gate.mockResolvedValueOnce('pending').mockResolvedValue('ready');
 p.sleep.mockImplementationOnce(async()=>{}).mockImplementation(()=>new Promise(()=>{}));
 p.expert.mockImplementation(async()=>{cancel({done:false,value:{type:'cancel',reason:'stop'}});throw Error('NAIVE_OPERATION_PENDING: waiting');});
 expect((await jobWorkflow('job')).status).toBe('cancelled');expect(p.next).toHaveBeenCalledOnce();expect(p.cancel).toHaveBeenCalledWith('job','stop');expect(p.fail).not.toHaveBeenCalled();
});

it('holds a retained policy rollback before the selected-policy step can complete',async()=>{
 p.gap.mockRejectedValueOnce(Error('NAIVE_EXECUTION_SELECTION_HOLD'));
 expect((await jobWorkflow('job')).status).toBe('on_hold');expect(p.design).not.toHaveBeenCalled();expect(p.fail).not.toHaveBeenCalled();
});

it('unrelated hook events do not exhaust the expert execution timer budget',async()=>{
 p.gap.mockResolvedValue('installed');p.gate.mockResolvedValue('ready');p.expert.mockResolvedValue({status:'pending'});p.sleep.mockReturnValue(new Promise(()=>{}));
 let count=0;p.next.mockImplementation(async()=>({done:false,value:++count<=340?{type:'clarification_answer',answer:'noise'}:{type:'cancel',reason:'stop'}}));
 expect((await jobWorkflow('job')).status).toBe('cancelled');expect(p.next).toHaveBeenCalledTimes(341);expect(p.expert).toHaveBeenCalledOnce();
});

});

it('preserves terminal cancellation when an execution failure races cancellation', async () => {
 p.snapshot.mockResolvedValue({package:'text_eval',receivedRecorded:true});
 p.plan.mockReturnValue({phase:'execute',quoteVersion:1});
 p.gap.mockResolvedValue('absent');p.gate.mockResolvedValue('legacy');
 p.policy.mockResolvedValue(false);p.branch.mockResolvedValue({});
 p.design.mockRejectedValueOnce(new Error('execution failed after cancel'));
 p.fail.mockResolvedValueOnce('cancelled');
 expect(await jobWorkflow('job')).toEqual({jobId:'job',status:'cancelled'});
 expect(p.fail).toHaveBeenCalledWith('job','execution failed after cancel');
});
