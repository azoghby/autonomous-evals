import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../contracts/services';
import { fixtureJob, fixtureTask } from '../data/adapters/fixtures';
import { frozenDataReference, mapApprovedDataToTextDesign } from '../data/adapters/mapping';
import { makeSuite } from '../text/__tests__/fixtures';
import { createApprovedSuiteAdmission, type AuthorizedApprovedSuite } from './approved-suite';

const ctx: ServiceContext = { jobId: fixtureJob.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordCost: async () => {}, recordProgress: async () => {} };
function record(): AuthorizedApprovedSuite {
  const task = fixtureTask();
  const context = { versionLabel: 'fixture-v1', systemPrompt: null };
  const mapping = mapApprovedDataToTextDesign(task, { job: fixtureJob, ...context });
  if (mapping.status !== 'ready') throw new Error(mapping.reason);
  const suite = makeSuite({ jobId: fixtureJob.jobId, systemPrompt: null, referenceText: mapping.designInput.referenceText });
  return { job: structuredClone(fixtureJob), context, result: { status: 'ready', task,
    progress: { outcome: 'ready', factualCorrectness: 'assessed', message: 'fixture' },
    frozen: { suite, provenance: frozenDataReference(task, suite, { job: fixtureJob, ...context }).provenance } } };
}
const digest = (r: AuthorizedApprovedSuite) => r.result.frozen!.suite.digest;

describe('approved frozen suite admission', () => {
  it('returns exact frozen suite and full sidecar without mutating trusted records', async () => {
    const r = record(); const before = structuredClone(r);
    const resolve = vi.fn(async () => r);
    const api = createApprovedSuiteAdmission({ resolve });
    expect(await api.resolveApprovedSuite(ctx, digest(r))).toEqual(r.result.frozen!.suite);
    const artifact = await api.get(ctx, digest(r));
    expect(artifact).toEqual(r.result.frozen);
    artifact!.provenance.sources[0]!.content = 'local edit';
    artifact!.suite.scenarios[0]!.title = 'local edit';
    expect(r).toEqual(before);
    expect(resolve).toHaveBeenCalledWith(ctx, digest(r));
  });
  it('supports authorized absence and propagates authorization refusal', async () => {
    const r = record();
    expect(await createApprovedSuiteAdmission({ resolve: async () => null }).resolveApprovedSuite(ctx, digest(r))).toBeNull();
    await expect(createApprovedSuiteAdmission({ resolve: async () => { throw new Error('authorization_denied'); } }).get(ctx, digest(r))).rejects.toThrow('authorization_denied');
  });
  it.each(['waiting_for_data', 'waiting_for_review', 'reconciliation_required', 'cost_delivery_pending', 'mapping_blocked'] as const)('fences %s even with a stale frozen field', async status => {
    const r = record(); r.result.status = status;
    await expect(createApprovedSuiteAdmission({ resolve: async () => r }).resolveApprovedSuite(ctx, digest(r))).rejects.toThrow('incomplete');
  });
  it('refuses missing frozen evidence, digest edits, provenance edits and unapproved data', async () => {
    for (const edit of [
      (r: AuthorizedApprovedSuite) => { delete r.result.frozen; },
      (r: AuthorizedApprovedSuite) => { r.result.frozen!.suite.scenarios[0]!.title = 'tampered'; },
      (r: AuthorizedApprovedSuite) => { r.result.frozen!.provenance.caseIds = []; },
      (r: AuthorizedApprovedSuite) => { r.result.task.cases[0]!.expectedAnswer = 'forged'; },
    ]) {
      const r = record(); const id = digest(r); edit(r);
      await expect(createApprovedSuiteAdmission({ resolve: async () => r }).get(ctx, id)).rejects.toThrow();
    }
  });
  it('refuses other job, environment, package, version and current known-secret content', async () => {
    for (const edit of [
      (r: AuthorizedApprovedSuite) => { r.job.jobId = 'other'; },
      (r: AuthorizedApprovedSuite) => { r.job.environment = 'live'; },
      (r: AuthorizedApprovedSuite) => { r.job.package = 'workflow_eval'; },
      (r: AuthorizedApprovedSuite) => { r.context.versionLabel = 'different'; },
      (r: AuthorizedApprovedSuite) => { r.knownSecrets = ['hostile source data']; },
    ]) {
      const r = record(); edit(r);
      await expect(createApprovedSuiteAdmission({ resolve: async () => r }).get(ctx, digest(r))).rejects.toThrow();
    }
  });
  it('does not resolve an invalid digest or substitute a different suite', async () => {
    const r = record(); const resolve = vi.fn(async () => r); const api = createApprovedSuiteAdmission({ resolve });
    await expect(api.get(ctx, 'invalid')).rejects.toThrow(); expect(resolve).not.toHaveBeenCalled();
    await expect(api.get(ctx, 'f'.repeat(64))).rejects.toThrow();
  });
});
