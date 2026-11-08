import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ cancel: vi.fn(), next: vi.fn(), advance: vi.fn(), progress: vi.fn(), sleep: vi.fn(), snapshot: vi.fn(), discard: vi.fn(),
  fail: vi.fn(), deliver: vi.fn(), settle: vi.fn(), notify: vi.fn(), branch: vi.fn(), design: vi.fn(), run: vi.fn(),
  investigate: vi.fn(), render: vi.fn(), persist: vi.fn(), state: vi.fn() }));
vi.mock('workflow', () => ({ FatalError: class extends Error {}, sleep: m.sleep,
  createHook: () => ({ [Symbol.dispose]() {}, [Symbol.asyncIterator]: () => ({ next: m.next }) }) }));
vi.mock('@/server/expert-workflow', () => ({ advanceJobExpertData: m.advance }));
vi.mock('@/server/job-store', () => ({ recordProgress: m.progress }));
vi.mock('@workflow-test/steps/lifecycle', () => ({ cancelStep: m.cancel, commercialMessageStep: vi.fn(), declineStep: vi.fn(),
  deliverStep: m.deliver, failStep: m.fail, neonDeliverySafetyStep: vi.fn(), pauseBudgetStep: vi.fn(), progressStep: vi.fn(), setStateStep: m.state }));
vi.mock('@workflow-test/steps/quote', () => ({ connectionCheckStep: vi.fn(), createQuoteStep: vi.fn(), qualifyStep: vi.fn() }));
vi.mock('@workflow-test/steps/evaluate', () => ({ auditTraceStep: vi.fn(), createBranchStep: m.branch, designSuiteStep: m.design,
  investigateStep: m.investigate, persistReportStep: m.persist, proposeFixStep: vi.fn(), renderReportStep: m.render, runSuiteStep: m.run }));
vi.mock('@workflow-test/steps/notify', () => ({ notifyCustomerStep: m.notify }));
vi.mock('@workflow-test/steps/billing', () => ({ flagSettlementFailureStep: vi.fn(), settlePaymentStep: m.settle }));
vi.mock('@workflow-test/steps/resume', () => ({ discardPartialEvaluationStep: m.discard, loadResumeSnapshotStep: m.snapshot }));
import { jobWorkflow } from '@workflow-test/job';

beforeEach(() => {
  vi.resetAllMocks();
  m.next.mockImplementation(() => new Promise(() => {}));
  m.sleep.mockResolvedValue(undefined);
  m.snapshot.mockResolvedValue({ state: 'planning', package: 'text_eval', reportStored: false,
    latestQuote: { version: 1, accepted: true, pricingMode: 'fixed', priceCents: 500, capCents: 1500 },
    payments: [{ id: 'payment', quoteVersion: 1, status: 'paid', kind: 'one_time', amountCents: 500, currency: 'usd' }],
    clarificationAnswers: [], qualifyCount: 1, connectionCheckFailures: 0, receivedRecorded: true, findingsCount: 1, remediationsCount: 0 });
  m.state.mockResolvedValue(true); m.branch.mockResolvedValue({ branchId: 'branch' });
  m.design.mockResolvedValue({ status: 'ok', data: {} }); m.run.mockResolvedValue({ status: 'ok', data: {} });
  m.investigate.mockResolvedValue({ status: 'ok', data: [] }); m.render.mockResolvedValue({ status: 'ok', data: {} });
  m.deliver.mockResolvedValue({ deliveredAtIso: '2026-11-08T00:00:00Z' });
});
function expectHeld() {
  for (const fn of [m.discard, m.branch, m.design, m.run, m.investigate, m.render, m.persist, m.deliver, m.settle, m.notify, m.fail]) expect(fn).not.toHaveBeenCalled();
}
describe('actual adopted jobWorkflow with actual expert-data step', () => {
  it('waits durably then holds ready data before evaluation, settlement, and delivery', async () => {
    m.advance.mockResolvedValueOnce('pending').mockResolvedValueOnce('ready_consumer_required');
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'on_hold' });
    expect(m.sleep).toHaveBeenCalledExactlyOnceWith('30m');
    expect(m.advance).toHaveBeenCalledTimes(2); expectHeld();
    expect(m.progress).toHaveBeenCalledWith('job', 'expert_data_consumer_required', expect.any(String));
  });
  it('bounds persistent pending to 336 half-hour polls and holds', async () => {
    m.advance.mockResolvedValue('pending');
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'on_hold' });
    expect(m.sleep).toHaveBeenCalledTimes(336); expect(m.sleep.mock.calls.every(([duration]) => duration === '30m')).toBe(true);
    expect(m.advance).toHaveBeenCalledTimes(337); expectHeld();
    expect(m.progress).toHaveBeenCalledWith('job', 'expert_data_pending', expect.any(String));
  });
  it('gate exceptions stay pending rather than failing the job or executing lite', async () => {
    m.advance.mockRejectedValue(new Error('migration unavailable'));
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'on_hold' });
    expect(m.advance).toHaveBeenCalledTimes(337); expectHeld();
  });
  it('no-plan legacy tag preserves the existing evaluation and delivery path', async () => {
    m.advance.mockResolvedValue('legacy');
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'delivered' });
    expect(m.sleep).not.toHaveBeenCalled(); expect(m.discard).toHaveBeenCalledOnce();
    for (const fn of [m.branch, m.design, m.run, m.investigate, m.render, m.persist, m.deliver, m.settle, m.notify]) expect(fn).toHaveBeenCalledOnce();
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('cancels during pending without waiting for another poll or evaluating', async () => {
    m.advance.mockResolvedValue('pending');
    m.sleep.mockImplementation(() => new Promise(() => {}));
    m.next.mockResolvedValue({ done: false, value: { type: 'cancel', reason: 'Customer cancelled' } });
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'cancelled' });
    expect(m.cancel).toHaveBeenCalledExactlyOnceWith('job', 'Customer cancelled');
    expect(m.advance).toHaveBeenCalledTimes(1); expectHeld();
  });
  it('revoked plan holds without polling or evaluation', async () => {
    m.advance.mockResolvedValue('stopped');
    expect(await jobWorkflow('job')).toEqual({ jobId: 'job', status: 'on_hold' });
    expect(m.sleep).not.toHaveBeenCalled(); expectHeld();
  });
});
