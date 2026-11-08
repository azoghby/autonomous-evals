import { beforeEach, describe, expect, it, vi } from 'vitest';
const p = vi.hoisted(() => ({
  design: vi.fn(), branch: vi.fn(), run: vi.fn(), expert: vi.fn(), gate: vi.fn(), fail: vi.fn(), cancel: vi.fn(), sleep: vi.fn(), next: vi.fn(), policy:vi.fn(),genericReport:vi.fn(),deliveryGate:vi.fn(),fix:vi.fn(),deliver:vi.fn(),settle:vi.fn(),receipt:vi.fn(),notify:vi.fn(),snapshot:vi.fn(),plan:vi.fn(),
}));
vi.mock('workflow', () => ({FatalError: class FatalError extends Error {}, sleep: p.sleep, createHook: () => ({[Symbol.dispose]() {}, [Symbol.asyncIterator]: () => ({next: p.next})})}));
vi.mock('@/workflows/decisions', () => ({decideResumePlan: p.plan, selectFindingsForFix: () => [], needsConnectionCheck: () => false}));
vi.mock('@/workflows/steps/expert-data', () => ({expertDataGateStep: p.gate, expertDataHoldStep: vi.fn()}));
vi.mock('@/workflows/steps/expert-text', () => ({expertTextEvaluationStep: p.expert, expertTextReportStep: async () => ({status:'ok'})}));
vi.mock('@/workflows/steps/resume', () => ({loadResumeSnapshotStep:p.snapshot, discardPartialEvaluationStep: vi.fn()}));
vi.mock('@/workflows/steps/evaluate', () => ({createBranchStep:p.branch, designSuiteStep:p.design, runSuiteStep:p.run, investigateStep:async () => ({status:'ok',data:[]}), renderReportStep:async () => ({status:'ok',data:{}}), persistReportStep:vi.fn(), proposeFixStep:p.fix,genericTextExecutionPolicyStep:p.policy,genericTextReportStep:p.genericReport,genericTextCommittedReceiptStep:p.receipt,genericTextNotifyStep:p.notify, auditTraceStep:vi.fn()}));
vi.mock('@/workflows/steps/lifecycle', () => ({setStateStep:async () => true, progressStep:vi.fn(), deliverStep:p.deliver, neonDeliverySafetyStep:vi.fn(), failStep:p.fail, cancelStep:p.cancel}));
vi.mock('@/workflows/steps/quote', () => ({connectionCheckStep:vi.fn(), createQuoteStep:vi.fn(), qualifyStep:vi.fn()}));
vi.mock('@/workflows/steps/notify', () => ({notifyCustomerStep:vi.fn()}));
vi.mock('@/workflows/steps/billing', () => ({settlePaymentStep:p.settle, flagSettlementFailureStep:vi.fn()}));
import { jobWorkflow } from '@/workflows/job';
describe('actual candidate Workflow caller', () => {
 beforeEach(() => {vi.clearAllMocks();p.gate.mockResolvedValue('legacy');p.snapshot.mockResolvedValue({package:'text_eval',receivedRecorded:true});p.plan.mockReturnValue({phase:'execute',quoteVersion:1});p.receipt.mockResolvedValue(null);p.notify.mockResolvedValue(true);p.policy.mockResolvedValue(false);p.genericReport.mockResolvedValue({status:'ok',data:{assessed:true,deliveredAtIso:'2026-11-08T00:00:00.000Z'}});p.deliver.mockResolvedValue({deliveredAtIso:''});p.branch.mockResolvedValue({});p.design.mockResolvedValue({status:'ok',data:{scenarios:[]}});p.run.mockResolvedValue({status:'ok',data:{results:[]}});p.next.mockImplementation(() => new Promise(() => {}));p.sleep.mockResolvedValue(undefined);});
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
 it('generic rich reporting skips legacy automatic fix verification',async()=>{
  p.policy.mockResolvedValue(true);
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.genericReport).toHaveBeenCalledOnce();expect(p.fix).not.toHaveBeenCalled();expect(p.deliver).not.toHaveBeenCalled();
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

});
