import { beforeEach, describe, expect, it, vi } from 'vitest';
const p = vi.hoisted(() => ({
  design: vi.fn(), branch: vi.fn(), run: vi.fn(), expert: vi.fn(), gate: vi.fn(), fail: vi.fn(), cancel: vi.fn(), sleep: vi.fn(), next: vi.fn(),
}));
vi.mock('workflow', () => ({FatalError: class FatalError extends Error {}, sleep: p.sleep, createHook: () => ({[Symbol.dispose]() {}, [Symbol.asyncIterator]: () => ({next: p.next})})}));
vi.mock('@/workflows/decisions', () => ({decideResumePlan: () => ({phase:'execute', quoteVersion:1}), selectFindingsForFix: () => [], needsConnectionCheck: () => false}));
vi.mock('@/workflows/steps/expert-data', () => ({expertDataGateStep: p.gate, expertDataHoldStep: vi.fn()}));
vi.mock('@/workflows/steps/expert-text', () => ({expertTextEvaluationStep: p.expert, expertTextReportStep: async () => ({status:'ok'})}));
vi.mock('@/workflows/steps/resume', () => ({loadResumeSnapshotStep: async () => ({package:'text_eval', receivedRecorded:true}), discardPartialEvaluationStep: vi.fn()}));
vi.mock('@/workflows/steps/evaluate', () => ({createBranchStep:p.branch, designSuiteStep:p.design, runSuiteStep:p.run, investigateStep:async () => ({status:'ok',data:[]}), renderReportStep:async () => ({status:'ok',data:{}}), persistReportStep:vi.fn(), proposeFixStep:vi.fn(), auditTraceStep:vi.fn()}));
vi.mock('@/workflows/steps/lifecycle', () => ({setStateStep:async () => true, progressStep:vi.fn(), deliverStep:async () => ({deliveredAtIso:''}), neonDeliverySafetyStep:vi.fn(), failStep:p.fail, cancelStep:p.cancel}));
vi.mock('@/workflows/steps/quote', () => ({connectionCheckStep:vi.fn(), createQuoteStep:vi.fn(), qualifyStep:vi.fn()}));
vi.mock('@/workflows/steps/notify', () => ({notifyCustomerStep:vi.fn()}));
vi.mock('@/workflows/steps/billing', () => ({settlePaymentStep:vi.fn(), flagSettlementFailureStep:vi.fn()}));
import { jobWorkflow } from '@/workflows/job';
describe('actual candidate Workflow caller', () => {
 beforeEach(() => {vi.clearAllMocks();p.gate.mockResolvedValue('legacy');p.branch.mockResolvedValue({});p.design.mockResolvedValue({status:'ok',data:{scenarios:[]}});p.run.mockResolvedValue({status:'ok',data:{results:[]}});p.next.mockImplementation(() => new Promise(() => {}));p.sleep.mockResolvedValue(undefined);});
 it('durably waits for admission then resumes generic evaluation', async () => {
  p.design.mockRejectedValueOnce(new Error('NAIVE_ADMISSION_PENDING: review'));
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.sleep).toHaveBeenCalledWith('30m');expect(p.design).toHaveBeenCalledTimes(2);expect(p.fail).not.toHaveBeenCalled();
 });
 it('cancels while waiting without another design dispatch', async () => {
  p.design.mockRejectedValueOnce(new Error('NAIVE_ADMISSION_PENDING: review'));p.sleep.mockImplementation(() => new Promise(() => {}));p.next.mockResolvedValueOnce({done:false,value:{type:'cancel',reason:'owner cancelled'}});
  expect((await jobWorkflow('job')).status).toBe('cancelled');expect(p.design).toHaveBeenCalledOnce();expect(p.cancel).toHaveBeenCalled();
 });
 it('does not classify provider pending as admission wait', async () => {
  p.design.mockRejectedValueOnce(new Error('Track B task pending: provider operation'));
  expect((await jobWorkflow('job')).status).toBe('failed');expect(p.sleep).not.toHaveBeenCalled();
 });
 it('preserves expert route isolation before generic steps', async () => {
  p.gate.mockResolvedValue('ready');p.expert.mockResolvedValue({status:'ok',data:{findings:[],suite:{}}});
  expect((await jobWorkflow('job')).status).toBe('delivered');expect(p.design).not.toHaveBeenCalled();expect(p.branch).not.toHaveBeenCalled();expect(p.run).not.toHaveBeenCalled();
 });
});
