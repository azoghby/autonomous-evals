import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), advance: vi.fn() }));
vi.mock('@/server/automated-expert-owner', () => ({ expertOwnerDatabase: () => ({ query: m.query }) }));
vi.mock('@/server/expert-data-production', () => ({ advanceExpertProductionData: m.advance }));
import { advanceJobExpertData } from '@/server/expert-workflow';
import { reviewDigest } from '@ae/core/evals/data/binding';
const input = { task: { jobId: 'job' }, initial: {}, context: {} };
function row() { return { input, input_digest: reviewDigest(input), topic: 'Refund policy', enabled: true,
  before_deadline: true, state: 'planning', package: 'text_eval', is_mock: false, customer_id: 'customer', tenant_id: 'customer' }; }
beforeEach(() => vi.resetAllMocks());
it('actual plan lookup returns legacy only when the trusted plan is absent', async () => {
  m.query.mockResolvedValue({ rows: [] });
  expect(await advanceJobExpertData('job')).toBe('legacy');
  expect(m.advance).not.toHaveBeenCalled();
});
it('reloads plan authorization on each invocation, blocking a newly revoked plan', async () => {
  m.query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ ...row(), enabled: false }] });
  m.advance.mockResolvedValue({ status: 'pending' });
  expect(await advanceJobExpertData('job')).toBe('pending');
  expect(await advanceJobExpertData('job')).toBe('stopped');
  expect(m.advance).toHaveBeenCalledTimes(1);
});
it('holds a modified plan input before calling the producer', async () => {
  m.query.mockResolvedValue({ rows: [{ ...row(), input_digest: 'tampered' }] });
  expect(await advanceJobExpertData('job')).toBe('pending'); expect(m.advance).not.toHaveBeenCalled();
});
it('publishes only the ready tag and stores the full private result in SQL', async () => {
  const advanced = { status: 'ready', frozen: { private: 'corpus' } };
  m.query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [] });
  m.query.mockReset().mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [{ job_id: 'job' }] });
  m.advance.mockResolvedValue(advanced);
  expect(await advanceJobExpertData('job')).toBe('ready_consumer_required');
  expect(m.query.mock.calls[1][1]).toEqual(['job', JSON.stringify(advanced), reviewDigest(input)]);
});
it('ready result remains pending when authorization is revoked before publication', async () => {
  m.query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [] });
  m.advance.mockResolvedValue({ status: 'ready', frozen: { private: 'corpus' } });
  expect(await advanceJobExpertData('job')).toBe('pending');
});
